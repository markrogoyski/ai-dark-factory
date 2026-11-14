"""Provider sandbox detection and CLI preflight."""

import json
import os
import shutil
import subprocess
import tempfile

from . import common
from .common import CouncilError, oneline, read, write


def home_blocked(home, who, create=False):
    """Codex and agy write to their home directory as they start, and need the network. Inside Claude
    Code's sandbox that write fails with EPERM; report it plainly now instead of as an opaque vendor
    error later. None when the directory is writable. With `create`, a missing directory is made
    (Codex makes its own); without, a missing one is an error: the CLI isn't set up."""
    try:
        if create:
            os.makedirs(home, exist_ok=True)
        fd, probe = tempfile.mkstemp(prefix='.council-probe-', dir=home)
        os.close(fd)
        os.unlink(probe)
        return None
    except OSError as e:
        if isinstance(e, FileNotFoundError) and not create:
            raise CouncilError(f'{home} does not exist: install the Antigravity CLI (agy) and log in')
        return (f'cannot write to {home} ({e.strerror}). This command is running inside a sandbox; '
                f'{who} needs to run outside it, with network access.')


def codex_blocked():
    return home_blocked(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'), 'Codex', create=True)


def claude_blocked():
    return home_blocked(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'Claude', create=True)


def vendor_blocked(vendor):
    return {'codex': codex_blocked, 'gemini': gemini_blocked, 'claude': claude_blocked}[vendor]()


def agy_home():
    return os.path.expanduser('~/.gemini/antigravity-cli')


def gemini_blocked():
    return home_blocked(agy_home(), 'agy')


def ensure_agy_grant(grant_dir):
    """A Gemini seat runs headless, where agy can't ask for anything: it needs the global
    `proceed-in-sandbox` mode, so commands run in agy's sandbox without prompting, and a write
    grant for the run's files. The grant is one per repository (<repo>/.council), added once."""
    path = os.path.join(agy_home(), 'settings.json')
    settings = json.loads(read(path)) if os.path.exists(path) else {}
    if settings.get('toolPermission') != 'proceed-in-sandbox':
        raise CouncilError(f'Gemini seats need "toolPermission": "proceed-in-sandbox" in {path} '
                           '(headless agy otherwise denies every command and file edit)')
    rule = f'write_file({grant_dir})'
    perms = settings.setdefault('permissions', {})
    allow = perms.setdefault('allow', [])
    if rule in allow:
        return
    allow.append(rule)
    tmp = f'{path}.council-{os.getpid()}'
    write(tmp, json.dumps(settings, indent=2) + '\n')
    os.replace(tmp, path)


VENDOR_EXE = {'codex': 'codex', 'gemini': 'agy', 'claude': 'claude'}


def cmd_preflight(a):
    """Check, before any seat starts, that each external vendor's CLI can run from here: it is on
    PATH, answers --version, and isn't stuck inside Claude Code's sandbox (the same probe seat-run
    makes). Gemini also needs agy's proceed-in-sandbox mode. Costs no model turn."""
    vendors = [v for v in (a.vendors or '').split(',') if v]
    unknown = [v for v in vendors if v not in VENDOR_EXE]
    if unknown:
        raise CouncilError(f'unknown vendor(s): {", ".join(unknown)}')
    checks = {}
    for v in vendors:
        exe = VENDOR_EXE[v]
        c = {'ok': False, 'exe': exe}
        checks[v] = c
        if not shutil.which(exe):
            c['error'] = f'{exe} is not on PATH'
            continue
        try:
            blocked = vendor_blocked(v)
        except CouncilError as e:
            c['error'] = str(e)
            continue
        if blocked:
            c.update(sandboxed=True, error=blocked)
            continue
        if v == 'gemini':
            path = os.path.join(agy_home(), 'settings.json')
            try:
                settings = json.loads(read(path)) if os.path.exists(path) else {}
            except ValueError:
                settings = {}
            if settings.get('toolPermission') != 'proceed-in-sandbox':
                c['error'] = f'Gemini seats need "toolPermission": "proceed-in-sandbox" in {path}'
                continue
        try:
            r = subprocess.run([exe, '--version'], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, close_fds=True)
        except (OSError, subprocess.TimeoutExpired) as e:
            c['error'] = f'{exe} --version failed: {e}'
            continue
        if r.returncode != 0:
            c['error'] = f'{exe} --version exited {r.returncode}: {oneline(r.stderr or r.stdout, 200)}'
            continue
        c.update(ok=True, version=oneline(r.stdout, 80))
    bad = {v: c for v, c in checks.items() if not c['ok']}
    status = 'ok' if not bad else 'sandboxed' if all(c.get('sandboxed') for c in bad.values()) else 'error'
    common.emit({'status': status, 'vendors': checks})
