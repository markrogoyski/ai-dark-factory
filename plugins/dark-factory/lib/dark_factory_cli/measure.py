"""Replay and measurement of a snapshot (measure)."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import shutil
import subprocess
import time

from .common import CouncilError, DEPS, emit, git, load_run, prompt_hash, read, run_shell, seat_tree, tail, write, write_json


def replay_request(value):
    """Structural validation only; paths are independently checked against Git trees below."""
    if not isinstance(value, dict) or set(value) != {'testRoots', 'mapping'}:
        raise CouncilError('replay requires testRoots and mapping')
    if not isinstance(value['testRoots'], list) or any(not isinstance(p, str) for p in value['testRoots']):
        raise CouncilError('replay testRoots must be strings')
    if not isinstance(value['mapping'], list):
        raise CouncilError('replay mapping must be an array')
    for entry in value['mapping']:
        if not isinstance(entry, dict) or set(entry) != {'file', 'command', 'checkIds', 'fixtures'}:
            raise CouncilError('replay entries require file, command, checkIds and fixtures')
        if any(not isinstance(entry[k], str) or not entry[k].strip() or '\0' in entry[k] for k in ('file', 'command')):
            raise CouncilError('replay requires a nonempty file and command without NUL')
        for key in ('checkIds', 'fixtures'):
            if not isinstance(entry[key], list) or any(not isinstance(v, str) for v in entry[key]):
                raise CouncilError(f'replay {key} must be strings')
        if not entry['checkIds'] or len(set(entry['checkIds'])) != len(entry['checkIds']):
            raise CouncilError('replay requires distinct check IDs per command')
    return value


def replay_path(path):
    return (isinstance(path, str) and bool(path) and '\\' not in path and '\0' not in path
            and not re.match(r'^[A-Za-z]:', path)
            and all(p not in ('', '.', '..') for p in path.split('/')))


def replay_tree(run, revision):
    entries = {}
    for row in git('ls-tree', '-r', '-t', '-z', revision, cwd=run['repoRoot']).split('\0'):
        if row:
            meta, path = row.split('\t', 1)
            mode, kind, oid = meta.split()
            entries[path] = (mode, kind, oid)
    return entries


def replay_file_error(path, roots, tree):
    if not replay_path(path):
        return 'invalid relative path'
    if not any(path.startswith(root + '/') for root in roots):
        return 'outside accepted test roots'
    parts = path.split('/')
    for i in range(1, len(parts)):
        parent = tree.get('/'.join(parts[:i]))
        if parent and parent[1] != 'tree':
            return 'ancestor is a symlink or non-directory'
    entry = tree.get(path)
    if not entry:
        return 'file absent from revision'
    if entry[0] not in ('100644', '100755'):
        return 'not a regular file (symlink/submodule excluded)'
    return None


REPLAY_CACHE_FIELDS = ('exitCode', 'timedOut', 'seconds', 'tail', 'signal', 'passed', 'mutated')


def replay_cache_get(run, key):
    path = os.path.join(run['runDir'], 'cache', 'replay-base', key + '.json')
    try:
        cached = json.loads(read(path))
        if file_sha256(cached['log']) == cached['logSha256'] and set(cached['record']) == set(REPLAY_CACHE_FIELDS):
            return cached
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def replay_cache_put(run, key, record):
    folder = os.path.join(run['runDir'], 'cache', 'replay-base')
    os.makedirs(folder, exist_ok=True)
    log = os.path.join(folder, key + '.log')
    shutil.copyfile(record['log'], log)
    write_json(os.path.join(folder, key + '.json'), {'log': log, 'logSha256': file_sha256(log),
                                                     'record': {k: record[k] for k in REPLAY_CACHE_FIELDS}})


def run_replay(run, spec, snapshot_info, live, settings):
    """Pair file-level raw evidence; no interpretation of red/green or test assertions."""
    started = time.time()
    request = spec['replay']
    base, final = run['head'], snapshot_info['commit']
    trees = {side: replay_tree(run, revision) for side, revision in [('base', base), ('final', final)]}
    out = {'base': base, 'snapshot': final, 'snapshotTree': snapshot_info['tree'],
           **request, 'changes': [], 'exclusions': [], 'records': []}

    def exclude(path, reason):
        item = {'path': path, 'reason': reason}
        if item not in out['exclusions']:
            out['exclusions'].append(item)

    for dependency in DEPS:
        if os.path.isdir(os.path.join(live, dependency)):
            exclude(dependency, 'author dependency changes are not overlaid onto base; base uses the original run repository copy, final uses author dependencies like the full gate')
    roots = []
    for root in request['testRoots']:
        # The reviewer checks base layout/configuration. A configured test directory may not
        # exist yet; Git independently rejects non-directory roots and unsafe ancestors.
        if not replay_path(root) or trees['base'].get(root, ('', 'tree'))[1] != 'tree':
            exclude(root, 'test root is invalid or is not a regular base directory')
        elif any(trees['base'].get('/'.join(root.split('/')[:i]), ('', 'tree'))[1] != 'tree'
                 for i in range(1, len(root.split('/')))):
            exclude(root, 'test root has a symlink/non-directory ancestor')
        else:
            roots.append(root)
    raw = git('diff', '--name-status', '-z', '-M', base, final, cwd=run['repoRoot']).split('\0')
    changes = {}
    i = 0
    while i < len(raw) and raw[i]:
        status, path = raw[i:i + 2]
        i += 2
        previous = ''
        if status[0] in ('R', 'C'):
            previous, path = path, raw[i]
            i += 1
        changes[path] = status[0]
        out['changes'].append({'status': status, 'path': path, 'previousPath': previous})
        if previous:
            exclude(previous, f'rename/copy source for {path}; no deletion or rename is overlaid')
    requested = {path for e in request['mapping'] for path in [e['file'], *e['fixtures']]}
    overlays = set()
    for path in sorted(set(changes) | requested):
        error = replay_file_error(path, roots, trees['final'])
        status = changes.get(path)
        if error:
            exclude(path, error)
        elif status not in ('A', 'M'):
            exclude(path, 'unchanged; use original base file without overlay' if status is None
                    else f'unsupported overlay change {status}; renames/deletions/type changes are not copied')
        elif path not in requested:
            exclude(path, 'changed test file not requested in current replay mapping')
        else:
            # Even a safe final file cannot overwrite a base symlink or cross one.
            base_error = replay_file_error(path, roots, trees['base'])
            if base_error and base_error != 'file absent from revision':
                exclude(path, 'base destination: ' + base_error)
            else:
                overlays.add(path)
    def execute(n, entry, side, revision):
        """One (entry, side) execution in its own checkout and TMPDIR. Returns its exclusions and
        record, so results merge in mapping order whatever order the executions finish in."""
        excluded, paths = [], list(dict.fromkeys([entry['file'], *entry['fixtures']]))
        invalid = []
        for path in paths:
            error = replay_file_error(path, roots, trees['final'])
            if not error and side == 'base' and path not in overlays:
                if path in changes:
                    error = 'changed file cannot be overlaid'
                else:
                    error = replay_file_error(path, roots, trees['base'])
            if error:
                invalid.append(path)
                excluded.append((path, f'{side} execution not scheduled: {error}'))
        if invalid:
            return excluded, None
        label = f'{spec["label"]}-replay-{n}-{side}'
        log = os.path.join(run['runDir'], 'logs', f'replay-{spec["seat"]}-{label}.log')
        cwd = os.path.join(run['runDir'], 'scratch', f'{spec["seat"]}-{label}-{os.getpid()}')
        record = {'side': side, 'revision': revision,
                  'tree': git('rev-parse', f'{revision}^{{tree}}', cwd=run['repoRoot']).strip(),
                  'file': entry['file'], 'command': entry['command'], 'checkIds': entry['checkIds'],
                  'cwd': cwd, 'attempted': False, 'ran': False, 'passed': False,
                  'hasExitCode': False, 'exitCode': 0, 'signal': 0, 'timedOut': False,
                  'seconds': 0, 'log': log, 'logSha256': '', 'tail': '', 'launchError': '', 'mutated': [], 'reused': False}
        key = None
        if side == 'base':
            # The base commit never changes within a run, so an execution whose inputs are the same
            # bytes is the same execution: reuse it rather than spend another checkout and run.
            inputs = sorted((path, trees['final' if path in overlays else 'base'][path][2]) for path in paths)
            key = hashlib.sha256(json.dumps([base, entry['command'], inputs, spec['testTimeout'], settings],
                                            sort_keys=True).encode()).hexdigest()
            cached = replay_cache_get(run, key)
            if cached:
                shutil.copyfile(cached['log'], log)
                record.update(cached['record'], attempted=True, ran=True, hasExitCode=True, reused=True,
                              logSha256=file_sha256(log))
                return excluded, record
        cwd, error = scratch_checkout(run, spec['seat'], label, revision, run['repoRoot'] if side == 'base' else live)
        if error:
            return excluded + [(entry['file'], f'{side} checkout failed; execution not scheduled: {error}')], None
        try:
            if side == 'base':
                for path in paths:
                    if path not in overlays:
                        continue
                    dst = safe_relative(cwd, path)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    mode, _, oid = trees['final'][path]
                    data = subprocess.check_output(['git', 'cat-file', 'blob', oid], cwd=run['repoRoot'], close_fds=True)
                    with open(dst, 'wb') as f:
                        f.write(data)
                    os.chmod(dst, 0o755 if mode == '100755' else 0o644)
            record['attempted'] = True
            try:
                with verification_temp(run, settings) as env:
                    result = run_shell(entry['command'], cwd, spec['testTimeout'], log, env=env)
                record.update(result, ran=True, hasExitCode=True)
                record['signal'] = -result['exitCode'] if result['exitCode'] < 0 else 0
                record['mutated'] = tracked_changes(cwd) if side == 'final' else []
                record['passed'] = result['exitCode'] == 0 and not result['timedOut'] and not record['mutated']
            except (OSError, VerificationInfrastructureError) as e:
                record['launchError'] = str(e)
                record['tail'] = str(e)
                write(log, str(e) + '\n')
            record['logSha256'] = file_sha256(log)
            if key and record['ran'] and not record['launchError'] and not record['timedOut']:
                replay_cache_put(run, key, record)
            return excluded, record
        except (CouncilError, OSError, subprocess.CalledProcessError) as e:
            return excluded + [(entry['file'], f'{side} preparation failed; execution not scheduled: {e}')], None
        finally:
            drop_checkout(run, cwd)

    tasks = [(n, entry, side, revision) for n, entry in enumerate(request['mapping'])
             for side, revision in [('base', base), ('final', final)]]
    with ThreadPoolExecutor(max_workers=verification_concurrency(run)) as pool:
        results = [f.result() for f in [pool.submit(execute, *t) for t in tasks]]
    for excluded, record in results:
        for path, reason in excluded:
            exclude(path, reason)
        if record:
            out['records'].append(record)
    out['elapsedSec'] = round(time.time() - started, 1)
    return out


def run_measure_job(jd, spec):
    started = time.time()
    run = load_run(spec['runDir'])
    live = spec.get('path') or seat_tree(run, spec['seat'])
    out = {'status': 'done', 'job': spec['job'], 'seat': spec['seat'], 'label': spec['label'], 'tree': live}
    settings = spec['verification'] if 'verification' in spec else verification_settings(run)
    out['verification'] = settings
    cwd, scratch = live, None
    if spec.get('snapshot', True):
        out['snapshot'] = snapshot(run, spec['seat'], spec['label'], spec.get('path'), spec.get('since'))
        scratch, err = scratch_checkout(run, spec['seat'], spec['label'], out['snapshot']['commit'], live)
        out['scratch'] = bool(scratch)
        if scratch:
            cwd = scratch
            out['checkout'] = 'standalone' if os.path.isdir(scratch + '.gitdir') else 'worktree'
        else:
            out['scratchError'] = f'ran in the live worktree instead: {err}'
            if run.get('factory'):
                # The environment failed, not the snapshot: failureKind tells Pair to stop rather
                # than send unchanged bytes through more review.
                out['scratchError'] = err
                out['suite'] = {'ran': False, 'passed': False, 'command': settings['command'], 'failureKind': 'infrastructure',
                                'log': '', 'tail': 'Disposable verification checkout failed: ' + err}
                out['crossTests'] = []
                return out
    post = os.path.join(run['room'], spec['label'], f'{spec["seat"]}.md')
    out['postWords'] = len(read(post).split()) if os.path.exists(post) else None
    try:
        replay = None
        if spec.get('replay') is not None:
            # The replay uses its own checkouts, so it runs beside the suite unless the repository's
            # tests must run one at a time.
            serial = verification_concurrency(run) == 1
            replay = ThreadPoolExecutor(max_workers=1)
            pending = replay.submit(run_replay, run, spec, out['snapshot'], live, settings)
            if serial:
                out['replay'] = pending.result()
        try:
            out['suite'] = suite(run, cwd, spec['label'], spec['seat'], spec['suiteTimeout'], settings)
        finally:
            if replay:
                out['replay'] = pending.result()
                replay.shutdown()
        if scratch:
            # The suite must not change tracked files; reset them so cross-tests start from the snapshot.
            mutated = tracked_changes(scratch)
            if mutated:
                out['suite']['mutated'] = mutated[:20]
                if run.get('factory'):
                    out['suite']['passed'] = False
                    out['suite']['tail'] += '\nVerification changed tracked snapshot files: ' + ', '.join(mutated[:20])
                git('checkout', '-q', '--', '.', cwd=scratch, check=False)
            if not run.get('factory') and out['suite'].get('ran') and not out['suite'].get('passed') and not out['suite'].get('timedOut'):
                # The checkout has only the tracked files and the dependency dirs. A suite that also
                # needs some other ignored file (a local .env or phpunit.xml) fails here and not in the
                # seat's tree; that must not disqualify the seat, so the live tree's result stands.
                live_run = suite(run, live, f'{spec["label"]}-live', spec['seat'], spec['suiteTimeout'], settings)
                if live_run.get('passed'):
                    out['suite'] = dict(live_run, scratchFailed=tail(out['suite'].get('tail', ''), 15))
        out['crossTests'] = crosstest(run, cwd, spec['label'], spec['seat'], spec['tests'], spec['testTimeout'],
                                      reset=scratch is not None, env=verification_environment(settings))
    finally:
        if scratch:
            drop_checkout(run, scratch)
    out['elapsedSec'] = round(time.time() - started, 1)
    if run.get('factory') and out.get('snapshot'):
        try:
            out['evidence'] = publish_evidence(run, spec['seat'], spec['label'], out)
        except (CouncilError, OSError, ValueError) as e:
            out['evidence'] = {'status': 'error', 'error': str(e)}
            # Never leave the previous publication discoverable as evidence for a new tree.
            pointer = os.path.join(run['runDir'], 'evidence', f'{spec["seat"]}-{spec["label"]}.json')
            if os.path.exists(pointer):
                os.remove(pointer)
    return out


def input_digest(run, seat, label, path, tests, replay=None):
    """Everything a measurement's result depends on: the seat's tree as it is now (written with a
    throwaway index, as snapshot does) and the commits under it, its post, the verification command
    and the published tests.
    A finished measurement is reused only when all of it is unchanged."""
    wt = path or seat_tree(run, seat)
    base = seat_head(run, wt)
    tree = worktree_tree(run, wt, f'index-digest-{seat}-{label}-{os.getpid()}', base)

    def digest_of(p):
        if os.path.isfile(p):
            return prompt_hash(read(p))
        if os.path.isdir(p):
            files = sorted(os.path.relpath(os.path.join(b, n), p) for b, _, ns in os.walk(p) for n in ns)
            return prompt_hash('\n'.join(f'{f} {prompt_hash(read(os.path.join(p, f)))}' for f in files))
        return None
    return {'tree': tree, 'head': base,
            'post': digest_of(os.path.join(run['room'], label, f'{seat}.md')),
            'verify': digest_of(os.path.join(run['runDir'], 'verify.sh')),
            'verification': verification_settings(run),
            **({'replay': replay, 'originalBase': run['head']} if replay is not None else {}),
            **({'evidence': evidence_inputs(run, seat)} if run.get('factory') else {}),
            'tests': {t: digest_of(os.path.join(run['room'], 'tests', t)) for t in tests}}


# What Pair's engine reads from a measurement, each field with the value it takes when missing. A
# native Claude transport retypes this into its structured output, so it leaves out each execution's
# output tail, checkout path and log digest; the job's status.json keeps the full record. Must match
# PAIR_MEASURE_SCHEMA in src/pair-schemas.js (test/pair.mjs compares them).
PAIR_BRIEF = {
    'status': '', 'error': '', 'scratchError': '',
    'snapshot': {'ref': '', 'tree': '', 'diff': ''},
    'suite': {'ran': False, 'passed': False, 'command': '', 'failureKind': '', 'log': ''},
    'replay': {
        'base': '', 'snapshot': '', 'snapshotTree': '', 'testRoots': [''],
        'mapping': [{'file': '', 'command': '', 'checkIds': [''], 'fixtures': ['']}],
        'changes': [{'status': '', 'path': '', 'previousPath': ''}],
        'exclusions': [{'path': '', 'reason': ''}],
        'records': [{'side': '', 'revision': '', 'tree': '', 'file': '', 'command': '', 'checkIds': [''],
                     'attempted': False, 'ran': False, 'passed': False, 'hasExitCode': False, 'exitCode': 0,
                     'signal': 0, 'timedOut': False, 'seconds': 0, 'log': '', 'launchError': '',
                     'mutated': [''], 'reused': False}],
        'elapsedSec': 0,
    },
}


def brief_pick(value, shape):
    if isinstance(shape, dict):
        value = value if isinstance(value, dict) else {}
        return {k: brief_pick(value.get(k), s) for k, s in shape.items()}
    if isinstance(shape, list):
        return [brief_pick(v, shape[0]) for v in value] if isinstance(value, list) else []
    return shape if value is None else value


def measurement_brief(state):
    """A finished measurement in the shape of PAIR_BRIEF; a running job's answer is unchanged."""
    if state.get('status') == 'running':
        return state
    return dict(brief_pick(state, PAIR_BRIEF), status='done' if state.get('status') == 'done' else 'error')


def cmd_measure(a):
    run = load_run(a.run_dir)
    tests = [t for t in (a.tests or '').split(',') if t]
    key = f'measure-{a.seat}-{a.label}'
    jd = job_dir(a.run_dir, key)
    path = os.path.abspath(a.path) if a.path else None
    replay = replay_request(json.loads(a.replay_json)) if a.replay_json is not None else None
    if replay is not None and a.no_snapshot:
        raise CouncilError('replay requires a snapshot')
    spec = {'kind': 'measure', 'runDir': run['runDir'], 'seat': a.seat, 'label': a.label, 'job': key,
            'tests': tests, 'path': path, 'since': a.since,
            'snapshot': not a.no_snapshot, 'suiteTimeout': a.suite_timeout, 'testTimeout': a.test_timeout,
            'inputs': input_digest(run, a.seat, a.label, path, tests, replay), 'verification': verification_settings(run),
            **({'replay': replay} if replay is not None else {})}

    def decide(old, state):
        status = state and state.get('status')
        if status == 'running':
            if old != spec:
                raise CouncilError('measurement is running with different inputs; wait, then measure again')
            return 'wait'
        if old == spec and status == 'done':
            if replay is not None:
                for record in (state.get('replay') or {}).get('records', []):
                    try:
                        if file_sha256(record['log']) != record['logSha256']:
                            return None
                    except (OSError, KeyError):
                        return None
            if run.get('factory') and spec['snapshot']:
                try:
                    inspect_evidence(run, a.seat, a.label)
                except (CouncilError, OSError, ValueError, KeyError):
                    return None
            return dict(state, reused=True)
        return None                                      # failed, or something it depends on changed

    show = (lambda state: emit(measurement_brief(state))) if a.brief else (lambda state: emit(state))
    if settle_existing_job(jd, key, a.max_wait, decide, show):
        return
    if run.get('factory'):
        pointer = os.path.join(run['runDir'], 'evidence', f'{a.seat}-{a.label}.json')
        if os.path.exists(pointer):
            os.remove(pointer)
    start_job(jd, spec)
    show(wait_job(jd, key, a.max_wait))

# Imported last: these modules import names from this one, and each name below is used only at call time.
from .jobs import job_dir, settle_existing_job, start_job, wait_job
from .snapshots import drop_checkout, scratch_checkout, seat_head, snapshot, tracked_changes, worktree_tree
from .verification import VerificationInfrastructureError, crosstest, evidence_inputs, file_sha256, inspect_evidence, publish_evidence, safe_relative, suite, verification_concurrency, verification_environment, verification_settings, verification_temp
