"""Pinned-engine guard: checks the executing package against DARK_FACTORY_PIN and derives subject environments."""

import json
import os
import subprocess
import sys

from .common import CouncilError, SELF, read


def pin_guard(run_dir=None, spec=None, repo=None, final=None):
    """Every process, including detached jobs, validates its own shipped executor."""
    pin = json.loads(os.environ['DARK_FACTORY_PIN']) if os.environ.get('DARK_FACTORY_PIN') else None
    if spec and spec.get('pin'):
        saved = spec['pin']
        if pin and any(pin.get(k) != saved.get(k) for k in ('packageDigest', 'sourceRevision', 'algorithm')):
            raise CouncilError('ENGINE_DRIFT: job executor differs from environment')
        pin = pin or saved
    if run_dir and os.path.isfile(os.path.join(run_dir, 'run.json')):
        metadata = json.loads(read(os.path.join(run_dir, 'run.json')))
        saved = metadata.get('pin')
        repo = repo or metadata.get('repoRoot')
        if saved:
            if pin and any(pin.get(k) != saved.get(k) for k in ('packageDigest', 'sourceRevision', 'algorithm')):
                raise CouncilError('ENGINE_DRIFT: run executor differs from environment')
            pin = pin or saved
    own_root = os.path.realpath(os.path.join(os.path.dirname(SELF), '..'))
    own_export = os.path.basename(own_root) == 'plugin' and os.path.isfile(os.path.join(os.path.dirname(own_root), 'manifest.json'))
    if not pin and not own_export:
        return None
    if pin and own_export:
        pin = dict(pin, root=own_root)
    adapter = os.path.join(os.path.dirname(SELF), '..', 'lib', 'engine.mjs')
    request = {'pin': pin, 'executable': SELF, 'spec': spec, 'repo': repo, 'final': final}
    r = subprocess.run(['node', adapter, 'guard'], input=json.dumps(request), text=True, capture_output=True, close_fds=True)
    if r.stderr:
        sys.stderr.write(r.stderr)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise CouncilError('ENGINE_DRIFT: executor validator did not return a result: ' + r.stderr[-1000:])
    if r.returncode or out.get('status') == 'error':
        raise CouncilError('ENGINE_DRIFT: ' + out.get('error', 'executor validation failed'))
    os.environ['DARK_FACTORY_PIN'] = json.dumps(out['executor'])
    os.environ['PATH'] = os.path.join(out['executor']['root'], 'bin') + os.pathsep + os.environ.get('PATH', '')
    return out


def turn_pin_identity(pin):
    return {k: v for k, v in (pin or {}).items() if k not in ('root', 'locations')}
