"""resume-check: whether a native Pair run can continue past a stop the user answered.

The native workflow replays every turn before an answered stop from the session's cache, so the
repository, the author's worktree and the last snapshot must still be as they were at the stop.
--record keeps that state at the stop; a check compares it with the present. Neither changes the
repository, its index, the worktrees or refs: both only read them and write <run>/stops/.
"""

import hashlib
import json
import os
import re
import sys

from . import common
from .common import CouncilError, git, load_run, read, seat_tree, write_json
from .delivery import checkout_matches_setup


def worktree_state(wt):
    """wt/A's HEAD and a digest of every tracked or untracked, not ignored, file in it."""
    head = git('rev-parse', 'HEAD', cwd=wt).strip()
    files = {}
    for rel in sorted({p for p in git('ls-files', '-z', '--cached', '--others', '--exclude-standard', cwd=wt).split('\0') if p}):
        path = os.path.join(wt, rel)
        if os.path.islink(path):
            files[rel] = 'link:' + os.readlink(path)
        elif os.path.isfile(path):
            with open(path, 'rb') as f:
                files[rel] = hashlib.sha256(f.read()).hexdigest()
        else:
            files[rel] = 'absent' if not os.path.lexists(path) else 'directory'
    return {'head': head, 'files': files}


def snapshot_commit(run, ref):
    return git('rev-parse', '--verify', '--quiet', ref + '^{commit}', cwd=run['repoRoot'], check=False).strip()


def refuse(reason):
    common.emit({'status': 'refused', 'reason': reason})
    sys.exit(1)


def cmd_resume_check(a):
    if not re.fullmatch(r'Q[1-9][0-9]*', a.stop or ''):
        raise CouncilError(f'invalid stop: {a.stop}')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', a.snapshot or ''):
        raise CouncilError(f'invalid snapshot label: {a.snapshot}')
    run = load_run(a.run_dir)
    path = os.path.join(run['runDir'], 'stops', a.stop + '.json')
    ref = f'refs/council/{run["runId"]}/A-{a.snapshot}'
    wt = seat_tree(run, 'A')
    if a.record:
        # The record from the original stop stays: at a resume this replayed turn must not move it.
        if not os.path.exists(path):
            commit = snapshot_commit(run, ref)
            if not commit:
                refuse(f'snapshot ref {ref} is missing, so stop {a.stop} cannot be recorded')
            write_json(path, {'stop': a.stop, 'snapshot': {'ref': ref, 'commit': commit}, 'worktree': worktree_state(wt)})
        common.emit({'status': 'ok', 'reason': ''})
        return
    if not os.path.exists(path):
        refuse(f'stop {a.stop} has no record in this run, so it cannot continue in place')
    record = json.loads(read(path))
    try:
        checkout_matches_setup(run, 'resume')
    except CouncilError as e:
        refuse(str(e))
    if record['snapshot']['ref'] != ref:
        refuse(f'stop {a.stop} was recorded at snapshot {record["snapshot"]["ref"]}, not {ref}')
    commit = snapshot_commit(run, ref)
    if not commit:
        refuse(f'snapshot ref {ref} is missing')
    if commit != record['snapshot']['commit']:
        refuse(f'snapshot ref {ref} points at {commit}, not {record["snapshot"]["commit"]} as at stop {a.stop}')
    now, then = worktree_state(wt), record['worktree']
    if now['head'] != then['head']:
        refuse(f'wt/A HEAD changed since stop {a.stop}: {then["head"]} is now {now["head"]}')
    changed = sorted(p for p in set(now['files']) | set(then['files']) if now['files'].get(p) != then['files'].get(p))
    if changed:
        refuse(f'wt/A changed since stop {a.stop}: {", ".join(changed[:5])}{" and others" if len(changed) > 5 else ""}')
    if record.get('answers') not in (None, a.answers):
        refuse(f'stop {a.stop} already continued with other answers; answer it differently in a new run')
    if record.get('answers') is None:
        write_json(path, {**record, 'answers': a.answers})
    common.emit({'status': 'ok', 'reason': ''})
