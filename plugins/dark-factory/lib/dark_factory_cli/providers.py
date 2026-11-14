"""Seat turns: launching Codex, Claude and Gemini (agy) and recording their usage (seat-run)."""

import json
import os
import re
import shlex
import signal
import subprocess
import tempfile
import time
import uuid

from . import common, jobs, transcripts
from .common import CouncilError, git, load_run, normalize, oneline, prompt_hash, read, split_schema, tail, subject_environment, write, write_json
from .jobs import job_dir, register_job_runner, settle_existing_job, start_job
from .pinning import pin_guard, turn_pin_identity
from .sandbox import VENDOR_EXE, claude_blocked, codex_blocked, ensure_agy_grant, gemini_blocked
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
PROVIDERS = {p.kind: p for p in (CODEX, CLAUDE, GEMINI)}


def saved_session(provider, spec):
    """The seat's session file and the session it holds; None for a fresh turn or a first one."""
    path = os.path.join(spec['runDir'], 'seats', spec['seat'], provider.session_file)
    return path, None if spec['fresh'] or not os.path.exists(path) else read(path).strip()


def run_cli(provider, jd, cmd, cwd, stdin, stdout, stderr, env, timeout):
    """Run one vendor CLI in its own process group, its pid in the job dir, and wait. On the
    deadline the whole group is killed. Returns (exit code, timed out)."""
    p = subprocess.Popen(cmd, cwd=cwd, stdin=stdin, stdout=stdout, stderr=stderr, start_new_session=True, env=env, close_fds=True)
    write(os.path.join(jd, provider.pid_file), str(p.pid))
    try:
        return p.wait(timeout=timeout), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return p.wait(), True


def numeric_usage(reported, bools=True):
    """The numeric counters of a usage record. Claude's envelope is checked strictly (bools=False);
    the others have always kept a JSON true or false, which Python counts as a number."""
    return {k: v for k, v in (reported or {}).items() if isinstance(v, (int, float)) and (bools or not isinstance(v, bool))}


def turn_done(spec, thread, started, usage, result, **extra):
    return {'status': 'done', 'job': spec['job'], 'seat': spec['seat'], 'thread': thread,
            'elapsedSec': round(time.time() - started, 1), 'usage': usage, 'result': result, **extra}


def cmd_seat_run(a):
    checked = pin_guard(getattr(a, 'run_dir', None))
    if checked:
        bounds = {'kind': a.vendor, 'cwd': os.path.abspath(a.cwd), 'writable': [os.path.abspath(w) for w in (a.writable or [])],
                  'runDir': os.path.abspath(a.run_dir), 'job': a.job, 'sandbox': a.sandbox}
        bounds['gitRoots'] = seat_git_dirs(bounds)
        if a.vendor == 'claude':
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
        'resumeSession': getattr(a, 'resume_session', None),
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
TURN_IDENTITY = ('kind', 'hash', 'model', 'effort', 'sandbox', 'cwd', 'writable', 'fresh', 'schema', 'resumeSession', 'settingsHash')
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


def record_usage(run_dir, spec, usage, thread_total, started):
    """Append one vendor turn to the run's usage.jsonl: this turn's share, and the thread's running total."""
    with open(os.path.join(run_dir, 'usage.jsonl'), 'a') as f:
        f.write(json.dumps({'job': spec['job'], 'seat': spec['seat'], 'model': spec['model'],
                            'usage': usage, 'threadTotal': thread_total,
                            'seconds': round(time.time() - started, 1)}) + '\n')


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
    record_usage(run_dir, spec, usage, thread_total, started)

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


def run_claude_job(jd, spec):
    """Drive Claude directly from prompt.md; its JSON envelope is never the model's result."""
    started = time.time()
    seat_dir = os.path.join(spec['runDir'], 'seats', spec['seat'])
    session_file, session = saved_session(CLAUDE, spec)
    cmd, cwd = claude_command(jd, spec, session)
    if not session:
        # Allocate before launch: JSON output may never arrive if the turn times out.
        session = str(uuid.uuid4())
        cmd += ['--session-id', session]
    out_path, err_path = os.path.join(jd, 'out.json'), os.path.join(jd, 'stderr.txt')
    with open(os.path.join(jd, 'prompt.md'), 'rb') as stdin, open(out_path, 'w') as so, open(err_path, 'w') as se:
        code, timed_out = run_cli(CLAUDE, jd, cmd, cwd, stdin, so, se, claude_env(spec), spec['timeout'])
        if timed_out:
            write(session_file, session)
            return {'status': 'error', 'thread': session, 'error': f'claude timed out after {spec["timeout"] // 60} min'}
    stderr = read(err_path)
    try:
        out = json.loads(read(out_path))
    except (ValueError, OSError):
        return {'status': 'error', 'thread': session, 'error': (tail(stderr, 15) or f'claude exited {code} with no valid JSON')[:2000]}
    if not isinstance(out, dict):
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
    record_usage(spec['runDir'], spec, usage, total, started)
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

    out, err = call(read(os.path.join(jd, 'prompt.md')), conv)
    if out is None:
        return {'status': 'error', 'thread': conv, 'error': err[:2000]}
    new_conv = out.get('conversation_id') or None
    if new_conv and conv and new_conv != conv:
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
        out, err = call(DENIED_NUDGE.format(denied=resumed), thread)
        if out is None:
            return {'status': 'error', 'error': f'agy denied {resumed}, and resuming after it failed: {err}'[:2000]}
    nudged = False
    if (schema is not None and out.get('status') == 'SUCCESS' and not out.get('denied_actions')
            and not fits(out.get('structured_output')) and thread and not spec.get('resumeSession')):
        nudged = True
        write(os.path.join(jd, 'out-first.json'), json.dumps(out))
        out, err = call('You answered in text, not as structured output. Return your answer to my previous '
                        'message now as structured output that matches the JSON schema. Change nothing else.', thread)
        if out is None:
            return {'status': 'error', 'error': err[:2000]}

    reported = numeric_usage(out.get('usage'))
    usage = turn_usage(seat_dir, thread, reported)
    record_usage(run_dir, spec, usage, reported, started)

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
