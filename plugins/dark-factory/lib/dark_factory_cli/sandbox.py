"""Provider sandbox detection and CLI preflight."""

import json
import os
import re
import shutil
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request

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
    # An OpenRouter seat is the Claude CLI, so it is stuck exactly when Claude is.
    return {'codex': codex_blocked, 'gemini': gemini_blocked, 'claude': claude_blocked, 'openrouter': claude_blocked}[vendor]()


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


VENDOR_EXE = {'codex': 'codex', 'gemini': 'agy', 'claude': 'claude', 'openrouter': 'claude'}

# Anthropic-compatible endpoints the Claude CLI can run a seat against: the base URL and the helper
# environment variable that holds the key. Another endpoint is another entry here.
ENDPOINTS = {'openrouter': {'name': 'OpenRouter', 'baseUrl': 'https://openrouter.ai/api', 'keyEnv': 'OPENROUTER_API_KEY'}}


# A Codex-host run directory: <host run id>-<tier or workflow>, beside the host run's own directory.
HOST_RUN = re.compile(r'(host-[A-Za-z0-9_]+)-[A-Za-z0-9._-]+')


def openrouter_roots(run_dir):
    """The directories whose openrouter/ may hold this run's seat configuration: the run directory and,
    for a run the Codex host started, the host run's directory (its roles' configuration). seat-run
    accepts no other --config-root, and cleanup empties exactly these."""
    real = os.path.realpath(run_dir)
    roots = [real]
    m = HOST_RUN.fullmatch(os.path.basename(real))
    if m:
        host = os.path.join(os.path.dirname(real), m.group(1))
        meta = os.path.join(host, 'host.json')
        if os.path.isfile(meta) and not os.path.islink(meta):
            roots.append(os.path.realpath(host))
    return roots


# Where a platform keeps its trusted roots: macOS, then Debian/Ubuntu/Alpine, then Fedora/RHEL.
SYSTEM_CA_BUNDLES = ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt')


def tls_context(bundles=SYSTEM_CA_BUNDLES):
    """A verifying TLS context. python.org's macOS Python ships an OpenSSL whose default store is
    empty until its Install Certificates script runs, so every HTTPS call fails verification; when
    the default store holds no CA certificate, the first system bundle that exists is loaded.
    Verification is never turned off."""
    context = ssl.create_default_context()
    if not context.cert_store_stats()['x509_ca']:
        for path in bundles:
            if os.path.isfile(path):
                context.load_verify_locations(cafile=path)
                break
    return context


def http_get(url, token=None, timeout=20):
    """The helper's only network call, made by the OpenRouter preflight: one GET. Returns (HTTP status,
    body text); raises OSError when the server can't be reached."""
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=tls_context()) as response:
            return response.status, response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''


def endpoint_checks(endpoint, models):
    """An endpoint's own checks, once for every entry that names it: the key is set, the endpoint accepts
    it (GET /v1/key answers 200), and it lists every model asked for (GET /v1/models). Returns the error
    for the key and one per model (None when it passes). The key is never in any of them."""
    key = os.environ.get(endpoint['keyEnv'], '')
    name, var = endpoint['name'], endpoint['keyEnv']
    if not key:
        return f'{var} is not set', {}
    url = endpoint['baseUrl'] + '/v1/key'
    try:
        status, _ = http_get(url, key)
    except (OSError, ValueError) as e:
        reason = getattr(e, 'reason', None) or e
        return f'{name} could not be reached (GET {url}: {str(reason).replace(key, "[" + var + "]")})', {}
    if status != 200:
        return f'{name} did not accept {var} (GET {url} answered {status})', {}
    if not models:
        return None, {}
    url = endpoint['baseUrl'] + '/v1/models'
    try:
        status, body = http_get(url)
    except (OSError, ValueError) as e:
        reason = getattr(e, 'reason', None) or e
        return None, {m: f'{name} could not be reached (GET {url}: {str(reason).replace(key, "[" + var + "]")})' for m in models}
    try:
        listed = {m.get('id') for m in json.loads(body).get('data', []) if isinstance(m, dict)} if status == 200 else None
    except (ValueError, AttributeError):
        listed = None
    if listed is None:
        return None, {m: f'{name} did not list its models (GET {url} answered {status})' for m in models}
    return None, {m: None if m in listed else f'{name} has no model {m} (GET {url})' for m in models}


def cmd_preflight(a):
    """Check, before any seat starts, that each external vendor's CLI can run from here: it is on
    PATH, answers --version, and isn't stuck inside Claude Code's sandbox (the same probe seat-run
    makes). Gemini also needs agy's proceed-in-sandbox mode. Costs no model turn."""
    vendors = [v for v in (a.vendors or '').split(',') if v]
    # An endpoint entry is the endpoint's name, optionally with a model ID: openrouter:deepseek/deepseek-v4-pro.
    base = {v: v.split(':', 1)[0] if v.split(':', 1)[0] in ENDPOINTS and (':' not in v or v.split(':', 1)[1]) else v for v in vendors}
    unknown = [v for v in vendors if base[v] not in VENDOR_EXE]
    if unknown:
        raise CouncilError(f'unknown vendor(s): {", ".join(unknown)}')
    endpoints = {}       # endpoint -> (key error, {model: error}), checked once for all its entries
    checks = {}
    for v in vendors:
        exe = VENDOR_EXE[base[v]]
        c = {'ok': False, 'exe': exe}
        checks[v] = c
        if not shutil.which(exe):
            c['error'] = f'{exe} is not on PATH'
            continue
        try:
            blocked = vendor_blocked(base[v])
        except CouncilError as e:
            c['error'] = str(e)
            continue
        if blocked:
            c.update(sandboxed=True, error=blocked)
            continue
        endpoint = ENDPOINTS.get(base[v])
        if endpoint and not os.environ.get(endpoint['keyEnv']):
            c['error'] = f'{endpoint["keyEnv"]} is not set'
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
        if endpoint:
            if base[v] not in endpoints:
                models = [x.split(':', 1)[1] for x in vendors if base[x] == base[v] and ':' in x]
                endpoints[base[v]] = endpoint_checks(endpoint, list(dict.fromkeys(models)))
            key_error, model_errors = endpoints[base[v]]
            error = key_error or (model_errors.get(v.split(':', 1)[1]) if ':' in v else None)
            if error:
                c.update(version=oneline(r.stdout, 80), error=error)
                continue
        c.update(ok=True, version=oneline(r.stdout, 80))
    bad = {v: c for v, c in checks.items() if not c['ok']}
    status = 'ok' if not bad else 'sandboxed' if all(c.get('sandboxed') for c in bad.values()) else 'error'
    common.emit({'status': status, 'vendors': checks})
