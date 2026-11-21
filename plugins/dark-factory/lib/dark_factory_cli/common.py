"""Constants, errors, JSON output, prompt hashing, and the file, git and shell helpers every module uses."""

import json
import os
import re
import signal
import struct
import subprocess
import sys
import time


# The bin/dark-factory entry point: detached jobs and pinned runs re-execute it, so it is the
# helper's identity, not this module.
SELF = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'bin', 'dark-factory'))
DEPS = ('vendor', 'node_modules')           # ignored dependency dirs cloned into each worktree
# Tool caches that test runs leave behind; never part of a seat's change, even when a project
# forgot to gitignore them.
SNAPSHOT_EXCLUDES = ('__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/',
                     '.phpunit.result.cache', '.phpunit.cache/', '.php-cs-fixer.cache', '.DS_Store',
                     'node_modules/', '.tox/', '.nyc_output/',
                     # agent instructions init copies in when git ignores them (perhaps only through the
                     # user's global excludes, which this file replaces); a tracked one still diffs
                     '/CLAUDE.md', '/CLAUDE.local.md', '/AGENTS.md', '/GEMINI.md')
ROOM_DIRS = ('r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'final', 'final2', 'ratify', 'audit', 'final3', 'reaudit', 'tests')
SCHEMA_OPEN, SCHEMA_CLOSE = '<<<OUTPUT_SCHEMA', 'OUTPUT_SCHEMA>>>'
DEFAULT_MAX_WAIT = 540                      # stays under the Bash tool's 600 s ceiling
# How often waits poll. Tests set these small through the environment; real runs keep the defaults.
JOB_POLL_SEC = float(os.environ.get('COUNCIL_JOB_POLL', '2'))
TRANSCRIPT_POLL_SEC = float(os.environ.get('COUNCIL_TRANSCRIPT_POLL', '1'))
TRANSCRIPT_WAIT_SEC = float(os.environ.get('COUNCIL_TRANSCRIPT_WAIT', '10'))
TAIL_LINES = 40
# Keep tool discovery, locale, identity and temporary paths stable across roles. Project-specific
# variables belong in verification.json; a builder's shell exports must not leak into a gate.
VERIFICATION_BASE_ENV = ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
                         'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT')
EXECUTOR_CONTEXT = ('DARK_FACTORY_PIN', 'DARK_FACTORY_INVOCATION', 'DARK_FACTORY_SEAT_SPEC')
# What tells git which repository, index and objects to use (`git rev-parse --local-env-vars`,
# less the `-c` config overrides). Git exports some of these to hooks: a pre-commit hook gets
# GIT_INDEX_FILE (relative, or the outer commit's index.lock), and GIT_DIR from a linked
# worktree. Every git call here names its repository by cwd, so an inherited one is never meant,
# and would turn calls in the worktrees and repositories this helper chooses into calls on the
# caller's repository.
GIT_REPO_ENV = ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
                'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
                'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_PREFIX', 'GIT_CONFIG')


class CouncilError(Exception):
    pass


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def fail(msg):
    emit({'status': 'error', 'error': msg, **({'code': 'ENGINE_DRIFT', 'errorClass': 'engine'} if str(msg).startswith('ENGINE_DRIFT:') else {})})
    sys.exit(1)


def normalize(text):
    return re.sub(r'[ \t\n]+\Z', '', text.replace('\r\n', '\n'))


def prompt_hash(text):
    t = normalize(text)
    raw = t.encode('utf-16-le')
    units = struct.unpack('<%dH' % (len(raw) // 2), raw)
    h = 0x811C9DC5
    for u in units:
        h = ((h ^ u) * 0x01000193) & 0xFFFFFFFF
    return '%d-%08x' % (len(units), h)


def split_schema(payload):
    """Pull the <<<OUTPUT_SCHEMA ... OUTPUT_SCHEMA>>> block out of a prompt payload."""
    start = payload.find(SCHEMA_OPEN)
    if start < 0:
        return payload, None
    end = payload.find(SCHEMA_CLOSE, start)
    if end < 0:
        raise CouncilError('payload has an unterminated OUTPUT_SCHEMA block')
    schema_text = payload[start + len(SCHEMA_OPEN):end].strip()
    try:
        schema = json.loads(schema_text)
    except json.JSONDecodeError as e:
        raise CouncilError(f'OUTPUT_SCHEMA block is not valid JSON: {e}')
    prompt = (payload[:start] + payload[end + len(SCHEMA_CLOSE):]).strip() + '\n'
    return prompt, schema


def git_env(env=None):
    """The environment without an inherited repository location (GIT_REPO_ENV)."""
    return {k: v for k, v in (os.environ if env is None else env).items() if k not in GIT_REPO_ENV}


def git(*args, cwd=None, env=None, check=True):
    """Run git in cwd. An explicit env is used as given, so build it from git_env()."""
    r = subprocess.run(['git', *args], cwd=cwd, env=git_env() if env is None else env, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, close_fds=True)
    if check and r.returncode != 0:
        raise CouncilError(f"git {' '.join(args)} failed: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


_FENCE = re.compile(r'^\s*(```|~~~)')
_WORD = re.compile(r'\w')


def prose_words(text):
    """Words of a post's prose, the count its length limit is measured on: fenced code blocks
    and table rows are left out, as are tokens with no letter or digit (arrows, dashes, bullets)."""
    n, fence = 0, None
    for line in text.splitlines():
        m = _FENCE.match(line)
        if m:
            if fence is None:
                fence = m.group(1)
            elif m.group(1) == fence:
                fence = None
            continue
        if fence is not None or line.lstrip().startswith('|'):
            continue
        n += sum(1 for t in line.split() if _WORD.search(t))
    return n


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def write_json(path, obj):
    write(path, json.dumps(obj, indent=2, ensure_ascii=False) + '\n')


def tail(text, n=TAIL_LINES):
    lines = text.rstrip('\n').split('\n')
    return '\n'.join(lines[-n:])


def load_run(run_dir):
    path = os.path.join(run_dir, 'run.json')
    if not os.path.exists(path):
        raise CouncilError(f'not a council run directory (no run.json): {run_dir}')
    return json.loads(read(path))


def subject_environment(env=None):
    """Executor context belongs to control processes, never the candidate under test."""
    return {k: v for k, v in (os.environ if env is None else env).items() if k not in EXECUTOR_CONTEXT}


def seat_tree(run, seat):
    return os.path.join(run['runDir'], 'wt', seat)


def run_shell(cmd, cwd, timeout, log_path, env=None):
    """Run a command in its own process group; expose its PID until it exits.

    A host runner cancelling a measurement can signal <log_path>.pid as well as the detached
    measurement job. Removing this sidecar on every exit avoids signalling an unrelated process
    after the operating system reuses its PID.
    """
    env = subject_environment(env)
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    started = time.time()
    pid_path, p = log_path + '.pid', None
    timed_out = False
    try:
        with open(log_path, 'w', encoding='utf-8', errors='replace') as log:
            p = subprocess.Popen(['/bin/bash', '-c', cmd], cwd=cwd, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=env, close_fds=True)
            write(pid_path, str(p.pid))
            try:
                code = p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = p.wait()
    finally:
        try:
            if p is not None and p.poll() is None:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                p.wait()
        finally:
            try:
                os.remove(pid_path)
            except FileNotFoundError:
                pass
    output = read(log_path) if os.path.exists(log_path) else ''
    return {'exitCode': code, 'timedOut': timed_out, 'seconds': round(time.time() - started, 1),
            'tail': tail(output), 'log': log_path}


def oneline(text, n=300):
    text = ' '.join(str(text or '').split())
    return text if len(text) <= n else text[:n] + ' […]'
