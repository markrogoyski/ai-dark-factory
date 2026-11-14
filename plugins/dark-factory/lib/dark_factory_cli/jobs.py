"""Detached job control: start, poll, wait, archive, and the _job child that runs a saved spec."""

import json
import os
import re
import shutil
import subprocess
import sys
import time

from . import common
from .common import CouncilError, JOB_POLL_SEC, SELF, oneline, read, tail, write, write_json
from .pinning import pin_guard
from .retro import timeline_event


# What each job kind runs, filled in by the modules that own the work (providers, measure,
# verification, delivery) as they are imported; the package's __init__ imports all of them.
JOB_RUNNERS = {}
VENDOR_KINDS = ('codex', 'gemini', 'claude')
# The --brief form of a job's result, by job-key prefix.
JOB_BRIEFS = {}


def register_job_runner(kind, run):
    """`run(jd, spec)` returns the job's result for a spec of this kind."""
    JOB_RUNNERS[kind] = run


def register_job_brief(prefix, brief):
    JOB_BRIEFS[prefix] = brief


def job_dir(run_dir, key):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', key):
        raise CouncilError(f'invalid job key: {key}')
    return os.path.join(run_dir, 'jobs', key)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:                  # exists, but we may not signal it (e.g. from inside a sandbox)
        return True


def job_state(jd):
    status = os.path.join(jd, 'status.json')
    if os.path.exists(status):
        return json.loads(read(status))
    pid_file = os.path.join(jd, 'pid')
    if os.path.exists(pid_file) and pid_alive(int(read(pid_file).strip() or 0)):
        return {'status': 'running'}
    if os.path.exists(os.path.join(jd, 'spec.json')):
        err = os.path.join(jd, 'runner.err')
        return {'status': 'error', 'error': 'job runner died: ' + (tail(read(err), 10) if os.path.exists(err) else 'no output')}
    return None


def start_job(jd, spec):
    checked = pin_guard(spec.get('runDir'))
    if checked:
        spec['pin'] = checked['executor']
    os.makedirs(jd, exist_ok=True)
    write_json(os.path.join(jd, 'spec.json'), spec)
    with open(os.path.join(jd, 'runner.err'), 'w') as err:
        p = subprocess.Popen([sys.executable, SELF, '_job', jd], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=err, start_new_session=True, close_fds=True)
    write(os.path.join(jd, 'pid'), str(p.pid))
    keep_awake(p.pid)


def keep_awake(pid):
    """Idle sleep on a Mac stalls a long measurement or CLI turn. `caffeinate -w` exits by itself
    when the job does. -i prevents idle sleep only: closing the lid still sleeps the machine."""
    if sys.platform != 'darwin' or os.environ.get('DARK_FACTORY_KEEP_AWAKE') == '0':
        return
    tool = shutil.which('caffeinate')
    if not tool:
        return
    try:
        subprocess.Popen([tool, '-i', '-w', str(pid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    except OSError:
        pass


def wait_job(jd, key, max_wait):
    deadline = time.time() + max_wait
    while True:
        state = job_state(jd)
        if state and state.get('status') != 'running':
            return state
        if time.time() >= deadline:
            return {'status': 'running', 'job': key,
                    'hint': 'still working; poll again with `dark-factory wait --run-dir ... --job ' + key + '`'}
        time.sleep(JOB_POLL_SEC)


def archive_job(jd):
    n = 1
    while os.path.exists(f'{jd}.old{n}'):
        n += 1
    os.replace(jd, f'{jd}.old{n}')


def settle_existing_job(jd, key, max_wait, decide, show=None):
    """A job directory for this key may already exist. `decide(old_spec, state)` says what to do with
    it: 'wait' (it is this work, running or done: wait for it and return its result), a dict (emit
    that, e.g. a reused result), or None (it is stale or failed: archive it). True when the request
    was answered from the existing job; False when the caller should start a new one. `show` prints
    the answer (default emit)."""
    if not os.path.isdir(jd):
        return False
    spec_path = os.path.join(jd, 'spec.json')
    old = json.loads(read(spec_path)) if os.path.exists(spec_path) else {}
    action = decide(old, job_state(jd))
    if action is None:
        archive_job(jd)
        return False
    (show or common.emit)(wait_job(jd, key, max_wait) if action == 'wait' else action)
    return True


def cmd_wait(a):
    jd = job_dir(a.run_dir, a.job)
    if not os.path.isdir(jd):
        raise CouncilError(f'no such job: {a.job}')
    brief = next((fn for prefix, fn in JOB_BRIEFS.items() if a.job.startswith(prefix)), None)
    if a.brief and not brief:
        raise CouncilError('--brief applies only to measurement jobs')
    state = wait_job(jd, a.job, a.max_wait)
    common.emit(brief(state) if a.brief else state)


def cmd_jobs(a):
    root = os.path.join(a.run_dir, 'jobs')
    rows = []
    for key in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        jd = os.path.join(root, key)
        if os.path.isdir(jd) and '.old' not in key:
            st = job_state(jd) or {'status': 'empty'}
            rows.append({'job': key, 'status': st.get('status'), 'seconds': st.get('elapsedSec'),
                         'error': (st.get('error') or '')[:200]})
    common.emit({'status': 'ok', 'jobs': rows})


# A model at capacity or a short rate limit clears up within a minute or two, so a vendor turn that
# fails that way is retried once, here, instead of costing the relay a second agent. So is a
# malformed tool call by the vendor's own model (agy passes Gemini's "Malformed function call"
# through as the turn's error; the model usually gets it right on a second try). A used-up quota
# doesn't clear up, and a turn that hit its deadline would only hit it again: neither is retried.
TRANSIENT = re.compile(r'at capacity|overloaded|rate.?limit|too many requests|\b(429|503)\b|'
                       r'temporarily unavailable|try again later|RESOURCE_EXHAUSTED|'
                       r'malformed function call|improperly formatted function call', re.I)


def error_class(err):
    """What kind of failure a vendor turn's error is, so callers act on a field, not on free text."""
    err = err or ''
    if re.search(r'timed out', err, re.I):
        return 'timeout'
    if re.search(r'quota', err, re.I):
        return 'quota'
    if TRANSIENT.search(err):
        return 'transient'
    if re.search(r'not logged in|log ?in again|unauthori[sz]ed|authenticat|\b401\b', err, re.I):
        return 'auth'
    return 'vendor'


def transient(result):
    return result.get('status') == 'error' and error_class(result.get('error')) == 'transient'


def cmd_job(jd):
    spec = json.loads(read(os.path.join(jd, 'spec.json')))
    run_dir = spec.get('runDir')
    if run_dir:
        timeline_event(run_dir, 'job-start', os.path.basename(jd))
    try:
        run_job_spec(jd, spec)
    finally:
        if run_dir:
            timeline_event(run_dir, 'job-end', os.path.basename(jd))


def run_job_spec(jd, spec):
    try:
        if spec.get('pin') and not os.environ.get('DARK_FACTORY_PIN'):
            os.environ['DARK_FACTORY_PIN'] = json.dumps(spec['pin'])
        pin_guard(spec.get('runDir'), spec if spec['kind'] in VENDOR_KINDS else None)
        if spec['kind'] in VENDOR_KINDS:
            if spec.get('resumeSession'):
                session_name = {'claude': 'claude-session', 'codex': 'thread', 'gemini': 'conversation'}[spec['kind']]
                path = os.path.join(spec['runDir'], 'seats', spec['seat'], session_name)
                if spec['fresh'] or not os.path.isfile(path) or read(path).strip() != spec['resumeSession']:
                    raise CouncilError('recovery session is missing or changed; refusing to start a fresh turn')
            run = JOB_RUNNERS[spec['kind']]
            result = run(jd, spec)
            if transient(result) and not spec.get('resumeSession'):
                first = result['error']
                time.sleep(float(os.environ.get('COUNCIL_RETRY_WAIT', '90')))
                pin_guard(spec.get('runDir'), spec)
                result = run(jd, spec)
                result['retried'] = oneline(first)[:300]
            if result.get('status') == 'error':
                result['errorClass'] = error_class(result.get('error'))
        elif spec['kind'] in JOB_RUNNERS:
            result = JOB_RUNNERS[spec['kind']](jd, spec)
        else:
            result = {'status': 'error', 'error': f'unknown job kind {spec["kind"]}'}
        checked = pin_guard(spec.get('runDir'), spec if spec['kind'] in VENDOR_KINDS else None)
        if checked:
            result['executor'] = checked['executor']
            if checked.get('settings'):
                result['settingsHash'] = checked['settings']['settingsHash']
    except Exception as e:                                # the status file must always get written
        result = {'status': 'error', 'error': f'{type(e).__name__}: {e}', **({'code': 'ENGINE_DRIFT', 'errorClass': 'engine'} if 'ENGINE_DRIFT:' in str(e) else {})}
        if spec['kind'] == 'delivery':
            write_json(os.path.join(spec['runDir'], 'delivery.json'), result)
    write_json(os.path.join(jd, 'status.json'), result)
