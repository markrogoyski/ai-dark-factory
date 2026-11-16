#!/usr/bin/env python3
"""A stand-in for `claude -p` in the OpenRouter seat tests. It opens no socket and calls no model.

It records each call as one JSON line in $STUB_LOG, outside the run, with what it saw: its argv, the
endpoint variables (the token only as a sha256), what a Bash child sees after sourcing
$CLAUDE_ENV_FILE, and, mid-run, whether its own stdout and stderr reached the job directory redacted.

What it does is chosen per job by $STUB_PLAN, a JSON object {job: mode}, with 'success' the default:
  success         a success envelope with structured output, usage and Claude Code's dollar figure
  fixture:<path>  print that envelope file, with this turn's session ID, and exit 1
  auth-leak       the recorded 401 envelope ($STUB_FIXTURES/auth-401.stdout.json) with the token in
                  its result, as an endpoint that echoes it would; exit 1
  sleep           sleep past any deadline
  crash           exit 3 with nothing on stdout
  config-leak     write the token into $CLAUDE_CONFIG_DIR/projects/x/s.jsonl, as Claude would in its
                  own transcript, then succeed
  worktree-leak   write the token into leak.txt in the cwd, then succeed
With $STUB_PROBE set, stdout and stderr are written with the token split across two flushed writes.
"""

import hashlib
import json
import os
import subprocess
import sys
import time

MASK = b'[OPENROUTER_API_KEY]'

if '--version' in sys.argv:
    print('2.1.325 (Claude Code)')
    sys.exit(0)

token = os.environ.get('ANTHROPIC_AUTH_TOKEN') or os.environ.get('STUB_TOKEN', '')
cache = os.environ.get('XDG_CACHE_HOME', '')
job_tmp = os.path.dirname(cache)
job = os.path.basename(job_tmp)[len('claude-'):]
run_dir = os.path.dirname(os.path.dirname(job_tmp))
jd = os.path.join(run_dir, 'jobs', job)
mode = json.loads(os.environ.get('STUB_PLAN') or '{}').get(job, 'success')
argv = sys.argv[1:]
prompt = sys.stdin.read()
session = argv[argv.index('--resume') + 1] if '--resume' in argv else argv[argv.index('--session-id') + 1] if '--session-id' in argv else 'none'
record = {'job': job, 'mode': mode, 'argv': argv, 'cwd': os.getcwd(), 'promptBytes': len(prompt),
          'tokenSha256': hashlib.sha256(token.encode()).hexdigest() if token else None,
          'env': {k: os.environ.get(k) for k in (
              'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
              'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
              'CLAUDE_CONFIG_DIR', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'XDG_CACHE_HOME')},
          'hasOpenrouterKey': 'OPENROUTER_API_KEY' in os.environ, 'hasAuthToken': 'ANTHROPIC_AUTH_TOKEN' in os.environ}
config = os.environ.get('CLAUDE_CONFIG_DIR')
if config:
    record['configExists'] = os.path.isdir(config)
    record['configMode'] = oct(os.stat(config).st_mode & 0o777) if os.path.isdir(config) else None

# What the seat's Bash tool sees: Claude sources CLAUDE_ENV_FILE before each command.
env_file = os.environ.get('CLAUDE_ENV_FILE')
if env_file:
    seen = subprocess.run(['bash', '-c', 'source "$CLAUDE_ENV_FILE"; env'], capture_output=True, text=True).stdout
    names = {line.split('=', 1)[0] for line in seen.split('\n') if '=' in line}
    record['bashEnv'] = {k: k in names for k in ('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY')}
    record['bashSawToken'] = bool(token) and token in seen


def log():
    with open(os.environ['STUB_LOG'], 'a') as f:
        f.write(json.dumps(record) + '\n')


def landed(path, before):
    """Wait until the bytes written after `before` reached `path`; then whether it holds the token or the mask."""
    deadline = time.time() + 5
    data = b''
    while time.time() < deadline:
        try:
            with open(path, 'rb') as f:
                data = f.read()
        except OSError:
            data = b''
        if len(data) > before and (MASK in data or (token and token.encode() in data)):
            break
        time.sleep(0.02)
    return {'secret': bool(token) and token.encode() in data, 'mask': MASK in data}


def emit(stream, name, data):
    """Write `data`, split inside the token when it holds one, the first part flushed and given time
    to land before the rest; then note what the job directory's copy holds."""
    out = getattr(sys, stream).buffer
    secret = token.encode()
    cut = data.find(secret) + len(secret) // 2 if os.environ.get('STUB_PROBE') and secret and secret in data else -1
    if cut < 0:
        out.write(data)
        out.flush()
        return
    out.write(data[:cut])
    out.flush()
    time.sleep(0.2)
    out.write(data[cut:])
    out.flush()
    record['mid' + name] = landed(os.path.join(jd, 'out.json' if stream == 'stdout' else 'stderr.txt'), 0)


if mode == 'crash':
    log()
    sys.exit(3)
if mode == 'sleep':
    log()
    time.sleep(600)

err = b'[claude-code:unrecognized_model] {"model":"stub"}\n'
if os.environ.get('STUB_PROBE') and token:
    err += b'debug ' + token.encode() + b' ' + b'.' * 200 + b'\n'
if mode == 'config-leak':
    os.makedirs(os.path.join(config, 'projects', 'x'), exist_ok=True)
    with open(os.path.join(config, 'projects', 'x', 's.jsonl'), 'w') as f:
        f.write(json.dumps({'type': 'assistant', 'text': f'the endpoint said {token}'}) + '\n')
if mode == 'worktree-leak':
    with open('leak.txt', 'w') as f:
        f.write(f'echoed {token}\n')

code = 0
if mode.startswith('fixture:'):
    # The envelope as given, with this turn's session, as Claude echoes the --session-id it was given.
    with open(mode[len('fixture:'):]) as f:
        envelope = json.load(f)
    envelope['session_id'] = session
    body = (json.dumps(envelope) + '\n').encode()
    code = 1
elif mode == 'auth-leak':
    with open(os.path.join(os.environ['STUB_FIXTURES'], 'auth-401.stdout.json')) as f:
        envelope = json.load(f)
    envelope['result'] = f'{envelope["result"]} (key {token})'
    envelope['session_id'] = session
    body = (json.dumps(envelope) + ' ' * 200 + '\n').encode()
    code = 1
else:
    schema = json.loads(argv[argv.index('--json-schema') + 1]) if '--json-schema' in argv else None
    turn = (schema or {}).get('properties', {}).get('turn', {}).get('enum', [None])[0]
    output = {'ok': True, **({'turn': turn} if turn else {})}
    envelope = {'type': 'result', 'subtype': 'success', 'is_error': False, 'terminal_reason': 'completed',
                'session_id': session, 'result': 'done', 'total_cost_usd': 0.35,
                'usage': {'input_tokens': 120, 'output_tokens': 30}, 'permission_denials': [],
                **({'structured_output': output} if schema else {}),
                **({'debug': token} if os.environ.get('STUB_PROBE') and token else {})}
    body = (json.dumps(envelope) + ' ' * 200 + '\n').encode()
emit('stderr', 'Err', err)
emit('stdout', 'Out', body)
record['stdoutSha256'] = hashlib.sha256(body).hexdigest()
record['stderrSha256'] = hashlib.sha256(err).hexdigest()
log()
sys.exit(code)
