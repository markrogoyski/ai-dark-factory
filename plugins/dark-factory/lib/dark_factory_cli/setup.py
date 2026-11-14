"""Run setup and teardown: worktrees and reference copies (init, cleanup)."""

import json
import os
import re
import shutil
import subprocess
import time

from .common import CouncilError, ROOM_DIRS, SELF, VERIFICATION_BASE_ENV, emit, git, load_run, read, write_json
from .delivery import checkout_changes, checkout_file
from .retro import setup_started, timeline_event
from .snapshots import clone_deps, copy_agent_docs


REF_MAX_BYTES = 5 * 1024 * 1024


def resolve_refs(root, refs):
    """Absolute paths of the reference documents (a plan, a checklist, a spec): ~ expanded, relative
    paths tried against the repo root, then the current directory. Raises before anything is created."""
    out = []
    for ref in refs or []:
        p = os.path.expanduser(ref)
        tries = [p] if os.path.isabs(p) else [os.path.join(root, p), os.path.abspath(p)]
        found = next((t for t in tries if os.path.exists(t)), None)
        if not found:
            raise CouncilError(f'reference document not found: {ref}')
        if not os.path.isfile(found):
            raise CouncilError(f'reference document is not a file (pass files, not directories): {ref}')
        if os.path.getsize(found) > REF_MAX_BYTES:
            raise CouncilError(f'reference document is over {REF_MAX_BYTES // (1024 * 1024)} MB: {ref}')
        out.append(os.path.realpath(found))
    return out


def in_worktrees(root, path):
    """Whether a seat's worktree has this file as it is now: committed at HEAD and unmodified."""
    rel = os.path.relpath(path, os.path.realpath(root))
    if rel.startswith('..'):
        return False
    tracked = git('ls-files', '--error-unmatch', '--', rel, cwd=root, check=False)
    if not tracked.strip():
        return False
    return subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', rel], cwd=root, stdin=subprocess.DEVNULL,
                          capture_output=True, close_fds=True).returncode == 0


def copy_refs(root, run_dir, paths):
    """Snapshot the reference documents into <run>/refs/, where every seat can read them: worktrees
    check out HEAD, so an uncommitted plan is invisible there. Copied by the CLI, not by a model."""
    dest_dir = os.path.join(run_dir, 'refs')
    os.makedirs(dest_dir, exist_ok=True)
    out, used = [], set()
    for src in paths:
        base, ext = os.path.splitext(os.path.basename(src))
        name, n = base + ext, 2
        while name in used:
            name, n = f'{base}-{n}{ext}', n + 1
        used.add(name)
        dest = os.path.join(dest_dir, name)
        shutil.copyfile(src, dest)
        out.append({'source': src, 'path': dest, 'bytes': os.path.getsize(dest), 'inWorktrees': in_worktrees(root, src)})
    return out


def cmd_init(a):
    repo = os.path.abspath(a.repo or os.getcwd())
    root = git('rev-parse', '--show-toplevel', cwd=repo).strip()
    head = git('rev-parse', '--verify', '--quiet', 'HEAD', cwd=root, check=False).strip()
    if not head:
        raise CouncilError('the repository has no commits yet; council worktrees branch from HEAD')
    ref_paths = resolve_refs(root, a.ref)
    common = git('rev-parse', '--git-common-dir', cwd=root).strip()
    if not os.path.isabs(common):
        common = os.path.normpath(os.path.join(root, common))

    run_id = a.run_id or time.strftime('%Y%m%d-%H%M%S')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', run_id):
        raise CouncilError(f'invalid run id: {run_id}')
    run_dir = os.path.join(root, '.council', run_id)
    seats = [s for s in a.seats.split(',') if s]
    if not seats or any(not re.fullmatch(r'[A-Z]', s) for s in seats):
        raise CouncilError('--seats must be single capital letters, e.g. A,B,C,D')

    # Keep .council/ out of `git status` and out of ripgrep, locally, without touching .gitignore.
    exclude = os.path.join(common, 'info', 'exclude')
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    existing = read(exclude) if os.path.exists(exclude) else ''
    if '/.council/' not in existing.split('\n'):
        with open(exclude, 'a', encoding='utf-8') as f:
            f.write(('' if existing.endswith('\n') or not existing else '\n') + '/.council/\n')

    created = not os.path.exists(run_dir)
    for d in ('jobs', 'logs', 'seats', 'wt', 'snap', 'tmp', 'scratch'):
        os.makedirs(os.path.join(run_dir, d), exist_ok=True)
    for d in ROOM_DIRS:
        os.makedirs(os.path.join(run_dir, 'room', d), exist_ok=True)

    worktrees, deps, docs = {}, [], []
    for s in seats:
        path = os.path.join(run_dir, 'wt', s)
        if not os.path.exists(path):
            try:
                git('worktree', 'add', '--detach', path, head, cwd=root)
            except CouncilError as e:
                # Seats commit in their worktrees, so a seat has no standalone fallback. Leave no
                # half-made run behind for the retry to trip over.
                if created:
                    for added in worktrees.values():
                        git('worktree', 'remove', '--force', added, cwd=root, check=False)
                    shutil.rmtree(run_dir, ignore_errors=True)
                    git('worktree', 'prune', cwd=root, check=False)
                hint = (' A sandbox refused to write the worktree records: run init again with the sandbox disabled.'
                        if 'Operation not permitted' in str(e) or 'Permission denied' in str(e) else '')
                raise CouncilError(f'{e}.{hint}')
        deps = clone_deps(root, path) or deps
        docs = copy_agent_docs(root, path, untracked=getattr(a, 'factory', False))
        worktrees[s] = path

    dirty = [l for l in git('status', '--porcelain', '--untracked-files=no', cwd=root).split('\n') if l]
    untracked = [l for l in git('status', '--porcelain', cwd=root).split('\n') if l.startswith('??')]

    refs = copy_refs(root, run_dir, ref_paths)

    run = {'runId': run_id, 'runDir': run_dir, 'repoRoot': root, 'head': head, 'seats': seats,
           'room': os.path.join(run_dir, 'room'), 'cli': SELF, 'refs': refs}
    if os.environ.get('DARK_FACTORY_PIN'):
        run['pin'] = json.loads(os.environ['DARK_FACTORY_PIN'])
    if getattr(a, 'factory', False):
        run['factory'] = True
        run['verificationBaseEnv'] = {k: os.environ[k] for k in VERIFICATION_BASE_ENV if k in os.environ}
        run['deliveryBaseline'] = {p: checkout_file(root, p) for p in checkout_changes(root)}
        config = os.path.join(run_dir, 'verification.json')
        if not os.path.exists(config):
            write_json(config, {'env': {}})
    run_path = os.path.join(run_dir, 'run.json')
    if not os.path.exists(run_path):
        write_json(run_path, dict(run, created=time.strftime('%Y-%m-%dT%H:%M:%S')))
    started = setup_started(getattr(a, 'started_at', None))
    if started:
        timeline_event(run_dir, 'setup-start', at=started)
    timeline_event(run_dir, 'init')
    emit(dict(run, status='ok', worktrees=worktrees, depsCloned=deps, agentDocs=docs,
              dirty=dirty, untrackedCount=len(untracked)))


def cmd_cleanup(a):
    run = load_run(a.run_dir)
    root, removed = run['repoRoot'], []
    for sub in ('wt', 'snap'):
        base = os.path.join(run['runDir'], sub)
        for name in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            path = os.path.join(base, name)
            git('worktree', 'remove', '--force', path, cwd=root, check=False)
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path)
    git('worktree', 'prune', cwd=root, check=False)
    refs = [r for r in git('for-each-ref', '--format=%(refname)', f'refs/council/{run["runId"]}/',
                           cwd=root).split('\n') if r]
    for r in refs:
        git('update-ref', '-d', r, cwd=root, check=False)
    if a.all:
        shutil.rmtree(run['runDir'], ignore_errors=True)
    emit({'status': 'ok', 'worktreesRemoved': len(removed), 'refsDeleted': len(refs),
          'kept': None if a.all else run['room']})
