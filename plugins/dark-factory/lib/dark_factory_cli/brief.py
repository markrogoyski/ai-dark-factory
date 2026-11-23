"""Publish a small goal brief without creating seats or worktrees."""
import json
import os
from pathlib import Path
import tempfile

from .common import CouncilError, emit, git


def cmd_brief(a):
    if a.reuse:
        document = json.loads(Path(a.reuse).read_bytes())
        if not isinstance(document, dict) or document.get('state') != 'settled':
            raise CouncilError('Reuse requires a settled brief.')
    elif a.document:
        document = json.loads(a.document)
    else:
        document = {'version': 1, 'state': a.state, 'brief': json.loads(Path(a.content).read_bytes()),
                    'decisions': json.loads(a.decisions)}
    if not isinstance(document, dict) or document.get('version') != 1 or document.get('state') not in ('settled', 'provisional'):
        raise CouncilError('Expected a version 1 goal brief.')
    parent = Path(git('rev-parse', '--show-toplevel', cwd=a.repo or os.getcwd()).strip()) / '.council'
    parent.mkdir(exist_ok=True)
    if parent.is_symlink():
        raise CouncilError('The brief directory must be inside the repository.')
    if a.host_dir:
        directory = Path(a.host_dir)
        if directory.resolve().parent != parent or not directory.name.startswith('host-') or directory.is_symlink():
            raise CouncilError('Invalid host brief directory.')
    else:
        directory = Path(tempfile.mkdtemp(prefix='brief-', dir=parent))
    target = directory / ('BRIEF.json' if document['state'] == 'settled' else 'BRIEF.provisional.json')
    with tempfile.NamedTemporaryFile(dir=directory, mode='w', encoding='utf-8', delete=False) as stream:
        json.dump(document, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.replace(stream.name, target)
    emit({'status': 'ok', 'briefFile': str(target), 'document': document})
