"""Seat turns: launching Codex, Claude and Gemini (agy), and Claude against OpenRouter, and recording their usage (seat-run)."""

import json
import os
import re
import shlex
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid

from . import common, jobs, sandbox, transcripts
from .common import CouncilError, git, load_run, normalize, oneline, prompt_hash, read, split_schema, tail, subject_environment, write, write_json
from .jobs import job_dir, register_job_runner, settle_existing_job, start_job
from .pinning import pin_guard, turn_pin_identity
from .sandbox import ENDPOINTS, VENDOR_EXE, claude_blocked, codex_blocked, ensure_agy_grant, gemini_blocked
from .snapshots import checkout_snapshot


class Provider:
    """What one vendor CLI is to the helper. A provider's job function (run_codex_job and the
    others) builds its command, then goes through the shared steps below: saved_session,
    run_cli, numeric_usage, record_usage and turn_done."""

    def __init__(self, kind, session_file, pid_file, blocked):
        self.kind = kind                    # the job kind and seat-run --vendor value
        self.exe = VENDOR_EXE[kind]         # the CLI on PATH
        self.session_file = session_file    # in seats/<seat>/: the session a later turn resumes
        self.pid_file = pid_file            # in the job dir, while the CLI runs
        self.blocked = blocked              # why the CLI cannot run from here (a sandbox), or None


CODEX = Provider('codex', 'thread', 'codex.pid', codex_blocked)
CLAUDE = Provider('claude', 'claude-session', 'claude.pid', claude_blocked)
GEMINI = Provider('gemini', 'conversation', 'agy.pid', gemini_blocked)
# The Claude CLI against OpenRouter's Anthropic-compatible endpoint: the Claude provider's command
# and session handling, with an environment and a configuration directory of its own (see run_openrouter_job).
OPENROUTER = Provider('openrouter', 'claude-session', 'claude.pid', claude_blocked)
PROVIDERS = {p.kind: p for p in (CODEX, CLAUDE, GEMINI, OPENROUTER)}


def saved_session(provider, spec):
    """The seat's session file and the session it holds; None for a fresh turn or a first one."""
    path = os.path.join(spec['runDir'], 'seats', spec['seat'], provider.session_file)
    return path, None if spec['fresh'] or not os.path.exists(path) else read(path).strip()


def run_cli(provider, jd, cmd, cwd, stdin, stdout, stderr, env, timeout, redact=None):
    """Run one vendor CLI in its own process group, its pid in the job dir, and wait. On the
    deadline the whole group is killed. Returns (exit code, timed out).

    With `redact` (a secret, as bytes), the CLI's stdout and stderr go through pipes, and every copy
    of the secret is replaced before a byte reaches the binary files `stdout` and `stderr`."""
    pipe = subprocess.PIPE if redact else None
    p = subprocess.Popen(cmd, cwd=cwd, stdin=stdin, stdout=pipe or stdout, stderr=pipe or stderr, start_new_session=True, env=env, close_fds=True)
    write(os.path.join(jd, provider.pid_file), str(p.pid))
    pumps = [threading.Thread(target=redacting_pump, args=(src, dst, redact), daemon=True)
             for src, dst in ((p.stdout, stdout), (p.stderr, stderr))] if redact else []
    for t in pumps:
        t.start()
    try:
        code, timed_out = p.wait(timeout=timeout), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        code, timed_out = p.wait(), True
    for t in pumps:
        t.join(10)
    return code, timed_out


REDACTED = b'[OPENROUTER_API_KEY]'


def redacting_pump(src, dst, secret):
    """Copy a pipe to a file as it arrives, with every copy of `secret` replaced. The last
    len(secret) - 1 bytes wait for the next chunk, so a copy split across two reads is caught too."""
    keep, held = len(secret) - 1, b''
    try:
        while True:
            chunk = os.read(src.fileno(), 65536)
            if not chunk:
                break
            held = (held + chunk).replace(secret, REDACTED)
            if len(held) > keep:
                dst.write(held[:len(held) - keep])
                dst.flush()
                held = held[len(held) - keep:]
    finally:
        dst.write(held.replace(secret, REDACTED))
        dst.flush()
        src.close()


def numeric_usage(reported, bools=True):
    """The numeric counters of a usage record. Claude's envelope is checked strictly (bools=False);
    the others have always kept a JSON true or false, which Python counts as a number."""
    return {k: v for k, v in (reported or {}).items() if isinstance(v, (int, float)) and (bools or not isinstance(v, bool))}


def turn_done(spec, thread, started, usage, result, **extra):
    return {'status': 'done', 'job': spec['job'], 'seat': spec['seat'], 'thread': thread,
            'elapsedSec': round(time.time() - started, 1), 'usage': usage, 'result': result, **extra}


def make_run_roots(run_dir, roots):
    """Create the writable roots inside the run directory that don't exist yet (a reviewer's
    room/review-<label>, for one), here, outside the vendor's sandbox, so the vendor starts with
    every root it was granted. Roots outside the run directory are left alone."""
    if not run_dir:
        return
    base = os.path.realpath(run_dir) + os.sep
    for root in roots or []:
        if os.path.realpath(root).startswith(base):
            os.makedirs(root, exist_ok=True)


def cmd_seat_run(a):
    # An OpenRouter seat's key and configuration directory are checked, and the directory made,
    # before anything else: the pinned bounds below name the directory.
    endpoint = {}
    if a.vendor == 'openrouter':
        endpoint = {'endpoint': ENDPOINTS['openrouter']['baseUrl'], 'claudeConfigDir': openrouter_config(a)}
    checked = pin_guard(getattr(a, 'run_dir', None))
    if checked:
        bounds = {'kind': a.vendor, 'cwd': os.path.abspath(a.cwd), 'writable': [os.path.abspath(w) for w in (a.writable or [])],
                  'runDir': os.path.abspath(a.run_dir), 'job': a.job, 'sandbox': a.sandbox, **endpoint}
        bounds['gitRoots'] = seat_git_dirs(bounds)
        if a.vendor in ('claude', 'openrouter'):
            bounds['writable'] += [claude_tmp_dir(bounds)]
        elif a.vendor == 'gemini':
            bounds['writable'] += [os.path.join(tempfile.gettempdir(), 'council-agy')]
        checked = pin_guard(a.run_dir, bounds)
    blocked = PROVIDERS[a.vendor].blocked()   # first: inside the sandbox, the transcripts may be unreadable too
    if blocked:
        common.emit({'status': 'sandboxed', 'error': blocked})
        return
    if a.vendor == 'gemini' and not checked:
        ensure_agy_grant(os.path.dirname(os.path.abspath(a.run_dir)))   # fails now, not inside the job
    make_run_roots(getattr(a, 'run_dir', None), getattr(a, 'writable', None))
    if a.checkout:
        # An auditor works in a checkout of the version under review, made here, outside the
        # vendor's sandbox, which can't write the repository's worktree records.
        seat, _, label = a.checkout.partition('-')
        checkout_snapshot(load_run(a.run_dir), seat, label, os.path.abspath(a.cwd))
    text = read(a.prompt_file) if os.path.exists(a.prompt_file) else None
    got = prompt_hash(text) if text is not None else None
    if a.expect and got != a.expect:
        found = None if getattr(a, 'no_transcript', False) else transcripts.payload_from_transcripts(a.expect, a.transcript_wait)
        if found is not None:
            write(a.prompt_file, found)
            text, got = found, a.expect
        elif text is None:
            common.emit({'status': 'need-file', 'expected': a.expect,
                  'hint': 'The payload could not be read from the saved prompt. Write it to the prompt file exactly and retry.'})
            return
        else:
            common.emit({'status': 'hash-mismatch', 'expected': a.expect, 'got': got,
                  'hint': 'The prompt file is not an exact copy of the payload. Rewrite it exactly and retry.'})
            return
    if text is None:
        raise CouncilError(f'no prompt file: {a.prompt_file}')
    prompt, schema = split_schema(normalize(text))

    spec = {
        'kind': a.vendor, 'runDir': os.path.abspath(a.run_dir), 'seat': a.seat, 'job': a.job,
        'hash': got, 'model': a.model, 'effort': a.effort, 'sandbox': a.sandbox,
        'cwd': os.path.abspath(a.cwd), 'writable': [os.path.abspath(w) for w in (a.writable or [])],
        'fresh': bool(a.fresh), 'timeout': a.timeout_min * 60, 'schema': schema is not None,
        'resumeSession': getattr(a, 'resume_session', None), **endpoint,
    }
    if checked:
        spec.update(writable=bounds['writable'], gitRoots=bounds['gitRoots'], settingsVersion=checked['settings']['settingsVersion'], settingsHash=checked['settings']['settingsHash'], settingsSources=checked['settings']['sources'], pin=checked['executor'])
    jd = job_dir(a.run_dir, a.job)

    def decide(old, state):
        if checked and old.get('pin') and old.get('settingsHash') != spec.get('settingsHash'):
            raise CouncilError('ENGINE_DRIFT: Admitted provider settings changed; preserve this job and start a new run')
        same = (all(old.get(k) == spec.get(k) for k in TURN_IDENTITY)
                and turn_pin_identity(old.get('pin')) == turn_pin_identity(spec.get('pin')))
        status = state and state.get('status')
        if same and status in ('running', 'done'):
            return 'wait'                                # the same turn: reuse the result or keep waiting
        if same and status == 'error' and recently_failed_twice(jd, got):
            # A relay that reruns a failed turn again and again only repeats the failure (Gemini's
            # B-r1 ran four times, four minutes each). One rerun is allowed; then the error stands.
            return dict(state, repeated=True, hint='This exact turn has already failed twice. Return this error; do not run it again.')
        return None                                      # failed before, or same key with a new prompt

    if settle_existing_job(jd, a.job, a.max_wait, decide):
        return

    os.makedirs(jd, exist_ok=True)
    write(os.path.join(jd, 'prompt.md'), prompt)
    if schema is not None:
        write_json(os.path.join(jd, 'schema.json'), schema)
    start_job(jd, spec)
    common.emit(jobs.wait_job(jd, a.job, a.max_wait))


# What makes two seat-run calls the same turn: a job is reused only when all of these match.
TURN_IDENTITY = ('kind', 'hash', 'model', 'effort', 'sandbox', 'cwd', 'writable', 'fresh', 'schema', 'resumeSession', 'settingsHash',
                 'endpoint', 'claudeConfigDir')
RERUN_WINDOW = 1800      # a failure older than this may be retried again (after a quota reset, say)


def recently_failed_twice(jd, got):
    """Whether this turn (same prompt hash) already failed, was rerun, and failed again, within the
    last half hour. The current job is the latest failure; an archived one is the earlier."""
    status = os.path.join(jd, 'status.json')
    if not os.path.exists(status) or time.time() - os.path.getmtime(status) > RERUN_WINDOW:
        return False
    n = 1
    while os.path.exists(f'{jd}.old{n}'):
        old = f'{jd}.old{n}'
        n += 1
        try:
            if (json.loads(read(os.path.join(old, 'spec.json'))).get('hash') == got
                    and json.loads(read(os.path.join(old, 'status.json'))).get('status') == 'error'):
                return True
        except (OSError, ValueError):
            continue
    return False


def utc_iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t)) + f'.{int(t % 1 * 1000):03d}Z'


def record_usage(run_dir, spec, usage, thread_total, started, thread=None, missing=None):
    """Append one vendor turn to the run's usage.jsonl: this turn's share, and the thread's running total.
    Every turn whose CLI ran gets a record. When the CLI reported no usage (a timeout, a missing
    envelope or event), `missing` says why, and the accountant (lib/usage.mjs) reads the turn from
    the vendor's own session log by `thread` and the turn's window, or counts it as missing: never
    as zero."""
    ended = time.time()
    rec = {'job': spec['job'], 'seat': spec['seat'], 'model': spec['model'], 'vendor': spec.get('kind'),
           'usage': usage, 'threadTotal': thread_total, 'seconds': round(ended - started, 1),
           'startedAt': utc_iso(started), 'endedAt': utc_iso(ended)}
    if thread:
        rec['thread'] = thread
    if missing:
        rec['missing'] = missing
    with open(os.path.join(run_dir, 'usage.jsonl'), 'a') as f:
        f.write(json.dumps(rec) + '\n')


def turn_usage(seat_dir, thread_id, reported):
    """This turn's share of a thread's usage. On `codex exec resume`, turn.completed reports the
    whole thread's running total, so subtract the total recorded after the previous turn."""
    if not reported or not thread_id:
        return reported
    path = os.path.join(seat_dir, 'usage-total.json')
    prev = {}
    if os.path.exists(path):
        rec = json.loads(read(path))
        if rec.get('thread') == thread_id:
            prev = rec.get('usage', {})
    turn = {k: v - prev.get(k, 0) for k, v in reported.items()}
    if any(v < 0 for v in turn.values()):                 # a total that went down isn't a running total
        turn = dict(reported)
    write_json(path, {'thread': thread_id, 'usage': reported})
    return turn


def seat_git_dirs(spec):
    """The git data a commit in a seat's worktree writes: its own git dir (HEAD, index, reflog) and
    the shared object store. Codex's sandbox keeps both read-only unless they are writable roots;
    the rest of .git (config, refs, hooks) stays read-only. Only for a seat worktree under wt/."""
    cwd = os.path.realpath(spec['cwd'])
    if not cwd.startswith(os.path.realpath(os.path.join(spec['runDir'], 'wt')) + os.sep):
        return []
    out = git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', cwd=cwd, check=False).split('\n')
    if len(out) < 2 or not out[0] or out[0] == out[1]:
        return []
    return [out[0], os.path.join(out[1], 'objects')]


def codex_command(jd, spec, thread):
    """The `codex exec` command for a job, and the directory it runs in (the prompt goes on stdin)."""
    run_dir = spec['runDir']
    # A read-only turn (panel, spec review) must not change the repository, but Codex's read-only
    # sandbox also forbids temp files, which zsh heredocs and Rscript need. So it runs in
    # workspace-write from an empty scratch directory: it can read everything, and write only
    # there and to the temp directories.
    sandbox, cwd = spec['sandbox'], spec['cwd']
    # Output recovery needs no shell probes or temp files, and must drop the seat's write access.
    if sandbox == 'read-only' and not spec.get('resumeSession'):
        sandbox, cwd = 'workspace-write', os.path.join(run_dir, 'scratch', f'codex-{spec["job"]}')
        os.makedirs(cwd, exist_ok=True)

    out_path = os.path.join(jd, 'out.json')
    cmd = ['codex', 'exec']
    if thread:
        cmd.append('resume')
    cmd += ['--json', '-o', out_path, '--skip-git-repo-check', '-m', spec['model'],
            '-c', f'model_reasoning_effort="{spec["effort"]}"',
            '-c', f'sandbox_mode="{sandbox}"']
    if spec.get('pin'):
        cmd += ['-c', 'approval_policy="never"']
    if spec['schema']:
        cmd += ['--output-schema', os.path.join(jd, 'schema.json')]
    writable = spec['writable'] + seat_git_dirs(spec) if spec['sandbox'] == 'workspace-write' else []
    if writable:
        cmd += ['-c', 'sandbox_workspace_write.writable_roots=' + json.dumps(writable)]
    if thread:
        cmd.append(thread)
    else:
        cmd += ['-C', cwd]
    return cmd + ['-'], cwd


def run_codex_job(jd, spec):
    started = time.time()
    run_dir = spec['runDir']
    thread_file, thread = saved_session(CODEX, spec)

    out_path = os.path.join(jd, 'out.json')
    cmd, cwd = codex_command(jd, spec, thread)                # prompt on stdin — never leave stdin open

    events_path, err_path = os.path.join(jd, 'events.jsonl'), os.path.join(jd, 'stderr.txt')
    with open(os.path.join(jd, 'prompt.md'), 'rb') as stdin, open(events_path, 'w') as so, open(err_path, 'w') as se:
        code, timed_out = run_cli(CODEX, jd, cmd, cwd, stdin, so, se, subject_environment(), spec['timeout'])

    new_thread, usage, errors = None, {}, []
    for line in read(events_path).split('\n'):
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get('type')
        if t == 'thread.started':
            new_thread = ev.get('thread_id')
        elif t == 'turn.completed' and isinstance(ev.get('usage'), dict):
            usage = numeric_usage(ev['usage'])
        elif t in ('error', 'turn.failed'):
            errors.append(json.dumps(ev.get('error') or ev.get('message') or ev)[:500])
    if new_thread and not thread:
        write(thread_file, new_thread)
    if thread and new_thread and thread != new_thread:
        return {'status': 'error', 'error': f'codex did not resume thread {thread} (it started {new_thread})'}

    thread_total = usage
    usage = turn_usage(os.path.dirname(thread_file), thread or new_thread, thread_total)
    record_usage(run_dir, spec, usage, thread_total, started, thread=thread or new_thread,
                 missing=None if usage else ('timed out before turn.completed' if timed_out else 'no turn.completed usage event'))

    if timed_out:
        return {'status': 'error', 'thread': thread or new_thread,
                'error': f'codex timed out after {spec["timeout"] // 60} min'}

    if code != 0 or not os.path.exists(out_path):
        stderr = read(err_path) if os.path.exists(err_path) else ''
        stderr = '\n'.join(l for l in stderr.split('\n') if 'Reading additional input from stdin' not in l)
        return {'status': 'error', 'thread': thread or new_thread,
                'error': (' | '.join(errors) or tail(stderr, 15) or f'codex exited {code}')[:2000]}
    raw = read(out_path)
    if not spec['schema']:
        result = raw
    else:
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            return {'status': 'error', 'thread': thread or new_thread,
                    'error': 'codex final message was not valid JSON: ' + raw[:500]}
    return turn_done(spec, thread or new_thread, started, usage, result)


def fits_schema(schema, result):
    """Whether a structured output has this turn's shape. A resumed agy turn that answers in plain
    text leaves the previous turn's structured_output in place, still with status SUCCESS. Shape
    alone can't tell two debate rounds apart, so the workflow also pins a per-turn tag as a
    one-value enum (`turn`), and a top-level enum must hold."""
    props = schema.get('properties', {})
    return (isinstance(result, dict) and all(k in result for k in schema.get('required', []))
            and (schema.get('additionalProperties', True) is not False or set(result) <= set(props))
            and all(result.get(k) in p['enum'] for k, p in props.items()
                    if isinstance(p, dict) and 'enum' in p and k in result))


CLAUDE_HEADLESS = (
    'This is a headless factory turn: nobody can approve new permissions. Keep the existing permission controls. '
    'When Write/Edit and Bash are available, write probe source in your allowed workspace, then execute it in a separate Bash call. '
    'Use one simple operation per command; avoid combining source heredocs, execution, pipelines and unrelated checks. '
    'Edit files with Edit, not sed -i, perl -pi or Python heredocs (python3 - <<EOF). Use Write for new files. '
    'Do not use background jobs or sleep polling. Run commands in the foreground; use the helper wait command for its running jobs. '
    'If a tool is denied, do not bypass the restriction. Continue with permitted work and explicitly report '
    'the denied check and any missing evidence in your answer. Never claim that an unrun check passed. '
    'Finish in the requested output format even when an optional probe was denied.'
)


def claude_tmp_dir(spec):
    """A writable cache directory for one Claude job. Tools that default to ~/.cache (Psalm,
    pip) are otherwise denied by the sandbox. TMPDIR isn't set: Claude's Bash sandbox replaces it
    with its own writable temp directory."""
    return os.path.join(spec['runDir'], 'tmp', f'claude-{spec["job"]}')


def claude_env(spec):
    cache = os.path.join(claude_tmp_dir(spec), 'cache')
    os.makedirs(cache, exist_ok=True)
    # Worktrees share project auto-memory. Disable it for this process, including resumes.
    # https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory
    return {**subject_environment(), 'XDG_CACHE_HOME': cache, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '1'}


def claude_command(jd, spec, session):
    """One headless Claude turn, with explicit workspace access and no permission bypass.

    Read-only reviewers have no shell or edit tools. Implementers can edit their working
    directories and run commands in Claude's Bash sandbox; an action requiring a new approval
    is denied and surfaced by run_claude_job. Existing managed/user deny rules still apply.
    """
    effort = 'max' if spec['effort'] == 'ultra' else spec['effort']
    if effort not in ('low', 'medium', 'high', 'xhigh', 'max'):
        raise CouncilError(f'unsupported Claude effort: {spec["effort"]}')
    readonly = spec['sandbox'] == 'read-only'
    cmd = ['claude', '--print', '--output-format', 'json', '--model', spec['model'], '--effort', effort,
           '--permission-mode', 'plan' if readonly else 'acceptEdits', '--permission-prompts', 'none',
           '--append-system-prompt', CLAUDE_HEADLESS,
           '--tools', 'Read,Glob,Grep' if readonly else 'Bash,Read,Glob,Grep,Edit,Write']
    # The run's reference files and its room (the diffs, stats and posts a prompt names) are
    # readable for every seat, including a reviewer whose cwd is a snapshot checkout outside the
    # room. A permission rule rather than --add-dir, which under acceptEdits would also make them
    # editable. Seats that may write to the room get it as a writable root below.
    settings = {'permissions': {'allow': [f'Read(/{os.path.join(spec["runDir"], d)}/**)' for d in ('refs', 'room')]}}
    if not readonly:
        roots = list(dict.fromkeys(spec['writable'] + seat_git_dirs(spec) + [claude_tmp_dir(spec)]))
        for root in roots:
            cmd += ['--add-dir', root]
        settings['sandbox'] = {
            'enabled': True, 'failIfUnavailable': True,
            'autoAllowBashIfSandboxed': True, 'allowUnsandboxedCommands': False,
            'filesystem': {'disabled': False, 'allowWrite': roots},
        }
    if spec.get('pin'):
        guard = shlex.join(['node', os.path.join(spec['pin']['root'], 'lib', 'engine.mjs'), 'hook', os.path.join(jd, 'spec.json')]) + ' || exit 2'
        settings['statusLine'] = {'type': 'command', 'command': 'true'}
        settings['hooks'] = {
            'PreToolUse': [{'matcher': 'Bash|Edit|Write', 'hooks': [{'type': 'command', 'command': guard}]}],
            'ConfigChange': [{'hooks': [{'type': 'command', 'command': guard}]}],
        }
        cmd += ['--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
    cmd += ['--settings', json.dumps(settings)]
    if spec['schema']:
        cmd += ['--json-schema', read(os.path.join(jd, 'schema.json'))]
    if session:
        cmd += ['--resume', session]
    return cmd, spec['cwd']


def claude_usage_total(seat_dir, session, usage):
    """Claude's result usage is per invocation. Keep a separate accumulated session total."""
    path = os.path.join(seat_dir, 'claude-usage-total.json')
    previous = {}
    if os.path.exists(path):
        rec = json.loads(read(path))
        if rec.get('session') == session:
            previous = rec.get('usage', {})
    total = dict(previous)
    for key, value in usage.items():
        total[key] = total.get(key, 0) + value
    if session:
        write_json(path, {'session': session, 'usage': total})
    return total


def run_claude_job(jd, spec, env=None, redact=None):
    """Drive Claude directly from prompt.md; its JSON envelope is never the model's result.
    `env` replaces claude_env(spec), and `redact` (bytes) is kept out of out.json and stderr.txt:
    both only for an endpoint seat (run_openrouter_job)."""
    started = time.time()
    seat_dir = os.path.join(spec['runDir'], 'seats', spec['seat'])
    session_file, session = saved_session(CLAUDE, spec)
    cmd, cwd = claude_command(jd, spec, session)
    if not session:
        # Allocate before launch: JSON output may never arrive if the turn times out.
        session = str(uuid.uuid4())
        cmd += ['--session-id', session]
    out_path, err_path = os.path.join(jd, 'out.json'), os.path.join(jd, 'stderr.txt')
    mode = 'wb' if redact else 'w'
    with open(os.path.join(jd, 'prompt.md'), 'rb') as stdin, open(out_path, mode) as so, open(err_path, mode) as se:
        if redact:
            code, timed_out = run_cli(CLAUDE, jd, cmd, cwd, stdin, so, se, env, spec['timeout'], redact=redact)
        else:
            code, timed_out = run_cli(CLAUDE, jd, cmd, cwd, stdin, so, se, claude_env(spec) if env is None else env, spec['timeout'])
        if timed_out:
            write(session_file, session)
            record_usage(spec['runDir'], spec, {}, {}, started, thread=session, missing='timed out before its result envelope')
            return {'status': 'error', 'thread': session, 'error': f'claude timed out after {spec["timeout"] // 60} min'}
    stderr = read(err_path)
    try:
        out = json.loads(read(out_path))
    except (ValueError, OSError):
        record_usage(spec['runDir'], spec, {}, {}, started, thread=session, missing='no valid result envelope')
        return {'status': 'error', 'thread': session, 'error': (tail(stderr, 15) or f'claude exited {code} with no valid JSON')[:2000]}
    if not isinstance(out, dict):
        record_usage(spec['runDir'], spec, {}, {}, started, thread=session, missing='no valid result envelope')
        return {'status': 'error', 'thread': session, 'error': 'claude returned an invalid result envelope'}
    # Denials describe tool attempts, not the outcome of the entire turn. Keep the raw
    # commands in out.json and carry a compact diagnostic through validation and reporting.
    denials = out.get('permission_denials') or []
    diagnostics = {'permissionDenials': {
        'count': len(denials),
        'tools': list(dict.fromkeys(str(d.get('tool_name', '?')) if isinstance(d, dict) else '?' for d in denials)),
        'source': out_path,
    }} if denials else {}

    def failed(message):
        return {'status': 'error', 'thread': session, 'error': message, **diagnostics}

    new_session = out.get('session_id') if isinstance(out.get('session_id'), str) else None
    if session and new_session and session != new_session:
        return {**failed(f'claude did not resume session {session} (it started {new_session}): the seat lost its memory'), 'thread': None}
    if new_session:
        write(session_file, new_session)
    usage = numeric_usage(out.get('usage') if isinstance(out.get('usage'), dict) else {}, bools=False)
    total = claude_usage_total(seat_dir, session, usage)
    record_usage(spec['runDir'], spec, usage, total, started, thread=new_session or session,
                 missing=None if usage else 'the result envelope has no usage')
    if code != 0 or out.get('is_error') or out.get('subtype') not in (None, 'success'):
        errors = out.get('errors') or out.get('result') or stderr or f'claude exited {code}'
        return failed(oneline(errors, 2000))
    if out.get('terminal_reason') not in (None, 'completed') or (denials and out.get('subtype') != 'success'):
        return failed(f'claude did not complete the turn (terminal_reason={out.get("terminal_reason")}, subtype={out.get("subtype")})')
    if not new_session:
        return failed('claude returned no session_id; the seat cannot retain its memory')
    result = out.get('structured_output') if spec['schema'] else out.get('result')
    if spec['schema']:
        schema = json.loads(read(os.path.join(jd, 'schema.json')))
        if not fits_schema(schema, result):
            return failed('claude returned structured output that does not match this turn\'s schema')
    elif result is None or result == '':
        return failed('claude returned no result')
    return turn_done(spec, session, started, usage, result, **diagnostics)


# ---------------------------------------------------------------- OpenRouter seats
#
# An OpenRouter seat is `claude -p` with ANTHROPIC_BASE_URL pointing at OpenRouter and the key in
# ANTHROPIC_AUTH_TOKEN, for that one process. The key lives only in the helper's environment and that
# process's: it is read at turn time, kept out of argv and every file the helper writes, unset for the
# seat's Bash tool, and searched for after every turn (leak_scan).

OPENROUTER_ENV_UNSET = 'unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL OPENROUTER_API_KEY\n'
CONFIG_KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,119}')
KEY_MISSING = 'OPENROUTER_API_KEY is not set: an OpenRouter seat reads its key from the helper\'s environment'
def overlaps(a, b):
    a, b = os.path.realpath(a), os.path.realpath(b)
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep) or b.startswith(a.rstrip(os.sep) + os.sep)


def openrouter_config(a):
    """Check an OpenRouter turn before anything else runs, and make its seat's configuration directory,
    here, outside the vendor's sandbox: <root>/openrouter/<config key>/config (CLAUDE_CONFIG_DIR, mode
    0700) and bash-env.sh beside it (CLAUDE_ENV_FILE). The same key gives the same directory on every turn,
    so resumes find their sessions. Returns the configuration directory."""
    if not os.environ.get(ENDPOINTS['openrouter']['keyEnv']):
        raise CouncilError(KEY_MISSING)
    roots = sandbox.openrouter_roots(a.run_dir)
    root = os.path.realpath(a.config_root) if getattr(a, 'config_root', None) else roots[0]
    if root not in roots:
        raise CouncilError('--config-root must be the run directory or its Codex host run directory')
    key = getattr(a, 'config_key', None) or a.seat
    if not CONFIG_KEY.fullmatch(key):
        raise CouncilError(f'invalid --config-key: {key}')
    seat_dir = os.path.join(root, 'openrouter', key)
    spec = {'runDir': os.path.abspath(a.run_dir), 'job': a.job, 'cwd': os.path.abspath(a.cwd)}
    writable = [os.path.abspath(w) for w in (a.writable or [])] + seat_git_dirs(spec) + [claude_tmp_dir(spec)]
    if a.sandbox == 'workspace-write':
        writable.append(spec['cwd'])
    writable += [os.path.join(spec['runDir'], 'room'), os.path.join(spec['runDir'], 'wt')]

    config, env_file = os.path.join(seat_dir, 'config'), os.path.join(seat_dir, 'bash-env.sh')

    def refuse_overlap():
        for w in writable:
            for d in (seat_dir, config):
                if overlaps(d, w):
                    raise CouncilError(f"an OpenRouter seat's Claude configuration directory {seat_dir} overlaps a directory the seat can write ({w})")
    # A link anywhere in <root>/openrouter/<key>/config would let makedirs, chmod and the env file
    # follow it out of the run, past the overlap check and cleanup; only real directories are used.
    refuse_links(seat_dir)
    refuse_overlap()
    os.makedirs(config, mode=0o700, exist_ok=True)
    refuse_links(seat_dir)
    for d in (seat_dir, config):
        os.chmod(d, 0o700)
    refuse_overlap()          # again, now that the directories exist and resolve
    if not os.path.isfile(env_file) or read(env_file) != OPENROUTER_ENV_UNSET:
        write(env_file, OPENROUTER_ENV_UNSET)
    return config


def refuse_links(seat_dir):
    """Refuse a seat configuration directory reached through a symbolic link: <root>/openrouter, the
    seat's directory, its config directory and bash-env.sh must each be the real path itself."""
    for path in (os.path.dirname(seat_dir), seat_dir, os.path.join(seat_dir, 'config'), os.path.join(seat_dir, 'bash-env.sh')):
        if os.path.islink(path) or (os.path.lexists(path) and os.path.realpath(path) != path):
            raise CouncilError(f"an OpenRouter seat's Claude configuration path {path} is a symbolic link or is reached through one")


def endpoint_env(spec, key):
    """The environment of one endpoint seat's Claude process: claude_env without the helper's key
    variable, plus the endpoint, the key as a bearer token, the model for every Claude alias (so no
    background call reaches a Claude model), and the seat's own configuration directory."""
    endpoint, model, config = ENDPOINTS[spec['kind']], spec['model'], spec['claudeConfigDir']
    env = claude_env(spec)
    env.pop(endpoint['keyEnv'], None)
    env.update({'ANTHROPIC_BASE_URL': endpoint['baseUrl'], 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': '',
                'ANTHROPIC_DEFAULT_OPUS_MODEL': model, 'ANTHROPIC_DEFAULT_SONNET_MODEL': model,
                'ANTHROPIC_DEFAULT_HAIKU_MODEL': model, 'CLAUDE_CODE_SUBAGENT_MODEL': model,
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'CLAUDE_CONFIG_DIR': config,
                'CLAUDE_ENV_FILE': os.path.join(os.path.dirname(config), 'bash-env.sh')})
    return env


def scrub(value, key):
    """`value` with every copy of the key replaced, in every string it holds."""
    if not key:
        return value
    if isinstance(value, str):
        return value.replace(key, REDACTED.decode())
    if isinstance(value, dict):
        return {scrub(k, key): scrub(v, key) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, key) for v in value]
    return value


def scrub_openrouter(result):
    """jobs.run_job_spec applies this to an OpenRouter job's status before writing it, on every path."""
    return scrub(result, os.environ.get(ENDPOINTS['openrouter']['keyEnv'], ''))


def leak_scan(jd, spec, secret, since):
    """Search what an OpenRouter turn could have written for the key, and redact every copy in place:
    the seat's whole configuration directory (Claude's own transcripts), the job directory, and the
    files changed during the turn in the seat's writable roots, its cwd and its cache. Git's object
    store is skipped: it is compressed, and the Bash unset is what keeps the key out of a commit.

    A file or directory this process owns but cannot read or write (a transcript left read-only, a
    directory without search permission) is opened up for the scan and given its mode back afterwards.
    Returns (the files that held the key, the paths that could not be read, redacted or restored): a
    turn with any of the latter cannot be shown to be clean."""
    hits, unresolved = set(), []

    def miss(path):
        if path not in unresolved:
            unresolved.append(path)

    def opened(path, st, bits):
        """Give the owner `bits` on `path` if it lacks them and this process owns it; True if changed."""
        mode = stat.S_IMODE(os.lstat(path).st_mode)
        if mode & bits == bits or st.st_uid != os.geteuid():
            return False
        os.chmod(path, mode | bits)
        return True

    def restore(path, st, changed):
        if changed:
            try:
                os.chmod(path, stat.S_IMODE(st.st_mode))
            except OSError:
                miss(path)

    def check(path, st):
        changed = False
        try:
            changed = opened(path, st, stat.S_IRUSR)
            with open(path, 'rb') as f:
                data = f.read()
            if secret in data:
                hits.add(os.path.realpath(path))
                changed = opened(path, st, stat.S_IWUSR) or changed
                with open(path, 'wb') as f:
                    f.write(data.replace(secret, REDACTED))
        except OSError:
            miss(path)
        finally:
            restore(path, st, changed)

    def walk(root, changed_only):
        try:
            st = os.lstat(root)
        except FileNotFoundError:
            return
        except OSError:
            return miss(root)
        if not stat.S_ISDIR(st.st_mode):      # a link, or not a directory: nothing of the turn's
            return
        changed = False
        try:
            changed = opened(root, st, stat.S_IRUSR | stat.S_IXUSR)
            with os.scandir(root) as it:
                entries = list(it)
            for e in entries:
                path = e.path
                try:
                    est = os.lstat(path)
                except FileNotFoundError:
                    continue
                if stat.S_ISDIR(est.st_mode):
                    if e.name != '.git':
                        walk(path, changed_only)
                elif stat.S_ISREG(est.st_mode) and not (changed_only and est.st_mtime < since):
                    check(path, est)
        except OSError:
            miss(root)
        finally:
            restore(root, st, changed)

    walk(spec['claudeConfigDir'], False)
    walk(jd, False)
    roots = list(spec.get('writable') or []) + [claude_tmp_dir(spec)]
    if spec['sandbox'] == 'workspace-write':
        roots.append(spec['cwd'])
    for root in dict.fromkeys(roots):
        walk(root, True)
    return hits, unresolved


# OpenRouter's HTTP status, from the envelope Claude prints on an API error, decides the class:
# out of credits, a refused key and an unknown model end the seat; capacity errors are retried once.
def endpoint_error_class(status, kind):
    if status == 429 or 500 <= status <= 599:
        return 'transient'
    if status == 401:
        return 'auth'
    if status == 402:
        return 'quota'
    if status == 400 and kind == 'invalid_request_error':
        return 'model'
    return 'vendor'


def run_openrouter_job(jd, spec):
    """One OpenRouter turn: the Claude provider with the endpoint environment, the key kept out of
    out.json and stderr.txt, the failure classified on the envelope's api_error_status, and the leak
    scan after it on every path. Claude Code's total_cost_usd is never read: usage is tokens only."""
    endpoint = ENDPOINTS[spec['kind']]
    key = os.environ.get(endpoint['keyEnv'], '')
    if not key:
        return {'status': 'error', 'error': KEY_MISSING, 'errorClass': 'auth'}
    # The configuration directory was checked when the turn was started; check it again before the
    # CLI (and the scan) use it.
    refuse_links(os.path.dirname(spec['claudeConfigDir']))
    secret, since = key.encode(), time.time() - 2
    result, hits, unresolved, failure = None, set(), [], None
    try:
        result = run_claude_job(jd, spec, env=endpoint_env(spec, key), redact=secret)
        if result.get('status') == 'error':
            try:
                out = json.loads(read(os.path.join(jd, 'out.json')))
            except (ValueError, OSError):
                out = None
            status = out.get('api_error_status') if isinstance(out, dict) else None
            if isinstance(status, int) and not isinstance(status, bool):
                kind = out.get('api_error_type') if isinstance(out.get('api_error_type'), str) else ''
                text = out.get('result') if isinstance(out.get('result'), str) else ''
                result = {**result, 'errorClass': endpoint_error_class(status, kind),
                          'error': f'{endpoint["name"]} answered {status} ({kind}): {oneline(text, 1500)}'}
    except Exception as e:      # an interrupt still propagates, after the scan
        failure = e
    finally:
        try:
            hits, unresolved = leak_scan(jd, spec, secret, since)
        except Exception as e:      # a scan that did not finish proves nothing
            unresolved = [f'the scan stopped: {type(e).__name__}']
    # A leak, or a scan that could not finish, decides the turn's outcome even when the runner also
    # failed; neither is retried.
    thread = (result or {}).get('thread')
    if unresolved:
        shown = ', '.join(unresolved[:3]) + (', ...' if len(unresolved) > 3 else '')
        redacted = len(hits - {os.path.realpath(p) for p in unresolved})
        also = f'; {redacted} other file(s) held the key and were redacted' if redacted else ''
        result = {'status': 'error', 'errorClass': 'leak', 'thread': thread,
                  'error': f'the {endpoint["name"]} key scan could not read or redact {len(unresolved)} path(s) the turn could have written ({shown}){also}; the turn\'s result was discarded'}
    elif hits:
        result = {'status': 'error', 'errorClass': 'leak', 'thread': thread,
                  'error': f'the {endpoint["name"]} key appeared in {len(hits)} file(s) the turn wrote; they were redacted and the turn\'s result was discarded'}
    elif failure is not None:
        raise failure
    return scrub(result, key)


def run_gemini_job(jd, spec):
    """One agy turn. agy reports SUCCESS with exit 0 in several failures (a tool it couldn't ask
    about was denied and ended the turn, an unknown conversation id silently started a new one, a
    resumed turn answered in text and the previous turn's structured output came back), so every
    result is checked here rather than trusted."""
    started = time.time()
    run_dir = spec['runDir']
    seat_dir = os.path.join(run_dir, 'seats', spec['seat'])
    conv_file, conv = saved_session(GEMINI, spec)

    # Where agy starts decides what its sandbox lets shell commands touch: nothing under the start
    # directory can be written, even with a grant, and from anywhere inside the repository nothing
    # under .council can even be read. So it starts in an empty directory outside the repository,
    # and the prompt names the worktree by absolute path; the grant on <repo>/.council (added by
    # seat-run) covers the worktrees and the room.
    run_tag = f"{os.path.basename(run_dir)}-{prompt_hash(run_dir).split('-')[1]}"
    cwd = os.path.join(tempfile.gettempdir(), 'council-agy', run_tag, re.sub(r'[^A-Za-z0-9._-]', '-', spec['seat']))
    os.makedirs(cwd, exist_ok=True)

    schema = json.loads(read(os.path.join(jd, 'schema.json'))) if spec['schema'] else None
    out_path, err_path = os.path.join(jd, 'out.json'), os.path.join(jd, 'stderr.txt')

    def call(prompt, conversation):
        cmd = ['agy', '-p', prompt, '--model', spec['model'], '--output-format', 'json', '--sandbox']
        if schema is not None:
            cmd += ['--json-schema', os.path.join(jd, 'schema.json')]
        if conversation:
            cmd += ['--conversation', conversation]
        with open(out_path, 'w') as so, open(err_path, 'a') as se:
            code, timed_out = run_cli(GEMINI, jd, cmd, cwd, subprocess.DEVNULL, so, se, subject_environment(),
                                      max(60, spec['timeout'] - (time.time() - started)))
            if timed_out:
                return None, f'agy timed out after {spec["timeout"] // 60} min'
        try:
            return json.loads(read(out_path)), None
        except (json.JSONDecodeError, OSError):
            return None, (tail(read(err_path), 15) or f'agy exited {code} with no JSON')

    def fits(result):
        return fits_schema(schema, result)

    def account(answer, thread, missing=None):
        """Record the turn's usage from agy's last answer (its usage is the conversation's running
        total), or as missing when no answer came back."""
        reported = numeric_usage(answer.get('usage')) if answer else {}
        if answer and answer.get('status') != 'SUCCESS' and not any(reported.values()):
            reported, missing = {}, missing or f'agy status {answer.get("status")} with zero usage'
        usage = turn_usage(seat_dir, thread, reported) if reported else {}
        record_usage(run_dir, spec, usage, reported, started, thread=thread, missing=missing or (None if usage else 'agy reported no usage'))
        return usage

    out, err = call(read(os.path.join(jd, 'prompt.md')), conv)
    if out is None:
        account(None, conv, f'no answer from agy: {err[:200]}')
        return {'status': 'error', 'thread': conv, 'error': err[:2000]}
    new_conv = out.get('conversation_id') or None
    if new_conv and conv and new_conv != conv:
        account(out, new_conv)
        return {'status': 'error', 'error': f'agy did not resume conversation {conv} (it started {new_conv}): '
                f'the seat lost its memory. {tail(read(err_path), 5)}'[:2000]}
    if new_conv and not conv:
        write(conv_file, new_conv)
    thread = conv or new_conv

    # A permission request ends a headless turn, but the conversation keeps its work: the seat asked
    # to run a command outside the sandbox (git, which can't read the repository's data from inside
    # it). Resume once, saying so, rather than lose the seat.
    resumed = ''
    if out.get('status') == 'SUCCESS' and out.get('denied_actions') and thread and not spec.get('resumeSession'):
        resumed = ', '.join(d.get('action', '?') for d in out['denied_actions'])
        write(os.path.join(jd, 'out-denied.json'), json.dumps(out))
        first, (out, err) = out, call(DENIED_NUDGE.format(denied=resumed), thread)
        if out is None:
            account(first, thread, 'the resumed call after a denial returned nothing; only the first call is counted')
            return {'status': 'error', 'error': f'agy denied {resumed}, and resuming after it failed: {err}'[:2000]}
    nudged = False
    if (schema is not None and out.get('status') == 'SUCCESS' and not out.get('denied_actions')
            and not fits(out.get('structured_output')) and thread and not spec.get('resumeSession')):
        nudged = True
        write(os.path.join(jd, 'out-first.json'), json.dumps(out))
        first, (out, err) = out, call('You answered in text, not as structured output. Return your answer to my previous '
                                      'message now as structured output that matches the JSON schema. Change nothing else.', thread)
        if out is None:
            account(first, thread, 'the follow-up call asking for structured output returned nothing; only the first call is counted')
            return {'status': 'error', 'error': err[:2000]}

    usage = account(out, thread)

    stderr = read(err_path) if os.path.exists(err_path) else ''
    if out.get('status') != 'SUCCESS':
        return {'status': 'error', 'error': (out.get('error') or tail(stderr, 15) or f'agy status {out.get("status")}')[:2000]}
    denied = ', '.join(d.get('action', '?') for d in out.get('denied_actions') or [])
    result = out.get('structured_output') if schema is not None else out.get('response')
    if schema is not None and result is not None and not fits(result):
        return {'status': 'error', 'error': 'agy returned structured output that does not match this turn\'s schema'
                + (' (also after a follow-up asking for it)' if nudged else '') + f'. Its text: {oneline(out.get("response"))}'[:2000]}
    if result is None or result == '':
        why = (f'agy denied {denied}, which ended the turn early' + (' (also after resuming once)' if resumed else '') if denied
               else 'agy returned no output' + (' (no structured_output)' if schema is not None else ''))
        return {'status': 'error', 'error': f'{why}. {tail(stderr, 5)}'.strip()[:2000]}
    return turn_done(spec, thread, started, usage, result,
                     **({'denied': denied} if denied else {}), **({'resumedAfter': resumed} if resumed else {}),
                     **({'nudged': True} if nudged else {}))


DENIED_NUDGE = ('Your last request ({denied}) needed a permission that nobody can grant in this run, so it was denied and your turn '
                'stopped there. Your work so far is kept. Don\'t ask to run anything outside the sandbox again: git commands fail '
                'inside it, so read and compare files directly. Carry on with the task from where you stopped, and finish as the '
                'task asks, with your answer as structured output if it asks for one.')


# Looked up at call time, so a replaced runner (a test's patch) is the one a job runs.
register_job_runner('codex', lambda jd, spec: run_codex_job(jd, spec), CODEX.session_file)
register_job_runner('gemini', lambda jd, spec: run_gemini_job(jd, spec), GEMINI.session_file)
register_job_runner('claude', lambda jd, spec: run_claude_job(jd, spec), CLAUDE.session_file)
register_job_runner('openrouter', lambda jd, spec: run_openrouter_job(jd, spec), OPENROUTER.session_file)
jobs.register_job_scrubber('openrouter', scrub_openrouter)
