"""Seat snapshots, numstat, scratch and detached checkouts (materialize), and the dependency and agent-doc copies a checkout gets."""

import os
import re
import shutil
import subprocess
import sys
import threading

from .common import CouncilError, DEPS, SNAPSHOT_EXCLUDES, emit, git, load_run, oneline, seat_tree, write


def clone_deps(src_root, dst_root):
    """Copy ignored dependency dirs (vendor/, node_modules/) into a fresh worktree.

    A real copy, not a symlink: Composer's autoloader resolves __DIR__ through symlinks, so a
    symlinked vendor/ would silently autoload the *main* tree's classes. On APFS `cp -c` clones
    copy-on-write, so this is near-instant and costs no disk.
    """
    cloned = []
    for d in DEPS:
        src, dst = os.path.join(src_root, d), os.path.join(dst_root, d)
        if not os.path.isdir(src) or os.path.exists(dst):
            continue
        ignored = subprocess.run(['git', 'check-ignore', '-q', d], cwd=src_root,
                                 stdin=subprocess.DEVNULL, close_fds=True).returncode == 0
        if not ignored:
            continue
        r = subprocess.run(['cp', '-cR', src, dst], stdin=subprocess.DEVNULL, capture_output=True, close_fds=True)
        if r.returncode != 0:
            shutil.rmtree(dst, ignore_errors=True)
            r = subprocess.run(['cp', '-R', src, dst], stdin=subprocess.DEVNULL, capture_output=True, close_fds=True)
        if r.returncode != 0:
            shutil.rmtree(dst, ignore_errors=True)
            copy_skipping_protected(src, dst)
        cloned.append(d)
    return cloned


# Claude Code's sandbox always denies writing files with these names, wherever they are, so a
# Claude setup turn on the standalone runner can't copy them (vendor/amphp/serialization ships a
# .gitmodules). None of them is loaded by a dependency at run time.
SANDBOX_PROTECTED = frozenset(('.gitmodules', '.gitconfig', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'))


def copy_skipping_protected(src, dst):
    """Copy a dependency tree, leaving out the sandbox-protected files the copy is refused."""
    skipped = []

    def copy(a, b):
        try:
            return shutil.copy2(a, b)
        except PermissionError:
            if os.path.basename(a) not in SANDBOX_PROTECTED:
                raise
            skipped.append(os.path.relpath(a, src))
            return b

    shutil.copytree(src, dst, symlinks=True, copy_function=copy)
    for rel in skipped:
        print(f'dark-factory: skipped sandbox-protected {os.path.join(os.path.basename(src), rel)}', file=sys.stderr)
    return skipped


AGENT_DOCS = ('CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md')


def copy_agent_docs(root, wt, untracked=False):
    """Copy ignored instructions, and untracked ones for Factory, into isolated checkouts.
    Snapshot exclusions keep these local instructions out of the delivered change."""
    copied = []
    for name in AGENT_DOCS:
        src, dst = os.path.join(root, name), os.path.join(wt, name)
        if not os.path.isfile(src) or os.path.exists(dst):
            continue
        ignored = subprocess.run(['git', 'check-ignore', '-q', name], cwd=root, stdin=subprocess.DEVNULL,
                                 capture_output=True, close_fds=True).returncode == 0
        if ignored or (untracked and not git('ls-files', '--', name, cwd=root).strip()):
            shutil.copy2(src, dst)
            copied.append(name)
    return copied


def parse_numstat(text):
    """(files, added, removed) from `git diff --numstat` output; binary files ('-') count as no lines."""
    files, added, removed = [], 0, 0
    for line in text.split('\n'):
        parts = line.split('\t')
        if len(parts) == 3:
            files.append(parts[2])
            added += int(parts[0]) if parts[0].isdigit() else 0
            removed += int(parts[1]) if parts[1].isdigit() else 0
    return files, added, removed


def numstat(wt, a, b):
    return parse_numstat(git('diff', '--numstat', a, b, cwd=wt))


def worktree_tree(run, wt, index_name, base=None):
    """The tree object for a worktree's current files (tracked or not, minus SNAPSHOT_EXCLUDES; a
    file committed on `base` is kept), written through a throwaway index so the worktree's own
    index is never touched."""
    idx = os.path.join(run['runDir'], 'tmp', index_name)
    excludes = os.path.join(run['runDir'], 'tmp', 'snapshot-excludes')
    if not os.path.exists(excludes):
        write(excludes, '\n'.join(SNAPSHOT_EXCLUDES) + '\n')
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    if os.path.exists(idx):
        os.remove(idx)
    try:
        git('read-tree', base or run['head'], cwd=wt, env=env)
        git('-c', f'core.excludesFile={excludes}', 'add', '-A', cwd=wt, env=env)
        return git('write-tree', cwd=wt, env=env).strip()
    finally:
        if os.path.exists(idx):
            os.remove(idx)


def seat_head(run, wt):
    """The worktree's HEAD when it is the base commit or a descendant of it (the seat committed
    there); otherwise the base commit, so a seat that moved HEAD elsewhere is still measured
    against the base."""
    head = git('rev-parse', '--verify', '--quiet', 'HEAD', cwd=wt, check=False).strip()
    if head and subprocess.run(['git', 'merge-base', '--is-ancestor', run['head'], head], cwd=wt,
                               stdin=subprocess.DEVNULL, capture_output=True, close_fds=True).returncode == 0:
        return head
    return run['head']


def snapshot(run, seat, label, path=None, since=None):
    """Record the seat's current tree as a commit under refs/council/<run>/<seat>-<label>, and
    write to room/<label>/: <seat>.diff against the base commit, <seat>.stat (per-file counts),
    and, with `since`, <seat>.delta.diff against the seat's <since> snapshot, so readers can see
    what changed since they last looked. Uses a throwaway index, so the worktree's own index is
    never touched. Commits the seat made on top of the base commit are kept: the snapshot is the
    seat's HEAD, plus one council commit on top for whatever it left uncommitted."""
    wt = path or seat_tree(run, seat)
    base = seat_head(run, wt)
    tree = worktree_tree(run, wt, f'index-{seat}-{label}', base)
    if base != run['head'] and tree == git('rev-parse', f'{base}^{{tree}}', cwd=wt).strip():
        commit = base
    else:
        ident = dict(os.environ, GIT_AUTHOR_NAME='council', GIT_AUTHOR_EMAIL='council@localhost',
                     GIT_COMMITTER_NAME='council', GIT_COMMITTER_EMAIL='council@localhost')
        message = f'council {run["runId"]} {seat} {label}' + ('' if base == run['head'] else ': uncommitted changes')
        commit = git('commit-tree', tree, '-p', base, '-m', message, cwd=wt, env=ident).strip()
    ref = f'refs/council/{run["runId"]}/{seat}-{label}'
    git('update-ref', ref, commit, cwd=wt)
    diff_path = os.path.join(run['room'], label, f'{seat}.diff')
    write(diff_path, git('diff', '--binary', run['head'], commit, cwd=wt))
    stat_path = os.path.join(run['room'], label, f'{seat}.stat')
    write(stat_path, git('diff', '--stat=200,160', run['head'], commit, cwd=wt))
    files, added, removed = numstat(wt, run['head'], commit)
    out = {'ref': ref, 'commit': commit, 'tree': tree, 'diff': diff_path, 'stat': stat_path, 'files': len(files),
           'fileList': files[:50], 'added': added, 'removed': removed, 'delta': None,
           'seatCommits': int(git('rev-list', '--count', f'{run["head"]}..{base}', cwd=wt).strip())}
    prev = since and git('rev-parse', '--verify', '--quiet', f'refs/council/{run["runId"]}/{seat}-{since}',
                         cwd=wt, check=False).strip()
    if prev:
        delta_path = os.path.join(run['room'], label, f'{seat}.delta.diff')
        write(delta_path, git('diff', '--binary', prev, commit, cwd=wt))
        dfiles, dadded, dremoved = numstat(wt, prev, commit)
        out['delta'] = {'since': since, 'diff': delta_path, 'files': len(dfiles), 'added': dadded, 'removed': dremoved}
    return out


# Concurrent replays share one repository's worktree metadata; Git locks it per command.
WORKTREE_LOCK = threading.Lock()


def scratch_checkout(run, seat, label, commit, live):
    """A disposable checkout of a snapshot commit, where the suite and the cross-tests run: the
    seat's live worktree can change while they run (or a test can change it), and then the result
    would describe bytes nobody snapshotted. Dependencies are cloned from the live worktree, so a
    dependency the seat installed is there too. Returns (path, error)."""
    path = os.path.join(run['runDir'], 'scratch', f'{seat}-{label}-{os.getpid()}')
    try:
        shutil.rmtree(path, ignore_errors=True)
        detached_checkout(run, path, commit)
        clone_deps(live, path)
        if run.get('factory'):
            copy_agent_docs(run['repoRoot'], path, untracked=True)
        return path, None
    except (CouncilError, OSError, subprocess.CalledProcessError) as e:
        drop_checkout(run, path)
        return None, oneline(str(e), 300)


def detached_checkout(run, path, commit):
    """Check `commit` out at `path` as a git worktree, or, where the worktree records can't be
    written, as a standalone repository that borrows the main repository's objects.

    A sandbox (Claude Code's Bash tool's among them) can refuse `git worktree add` with "could not
    create directory of '.git/worktrees/…'" while allowing writes to the run directory. The
    fallback writes nothing under the repository's .git: its git dir is <path>.gitdir, beside the
    checkout, and its objects come from the main repository through objects/info/alternates. Git
    commands in the checkout (status, diff, checkout -- .) still work. Returns 'worktree' or
    'standalone'."""
    root = run['repoRoot']
    with WORKTREE_LOCK:
        try:
            git('worktree', 'add', '--detach', path, commit, cwd=root)
            return 'worktree'
        except CouncilError as e:
            refused = e
            git('worktree', 'prune', cwd=root, check=False)
    gitdir = path + '.gitdir'
    shutil.rmtree(path, ignore_errors=True)
    shutil.rmtree(gitdir, ignore_errors=True)
    common = os.path.normpath(os.path.join(root, git('rev-parse', '--git-common-dir', cwd=root).strip()))
    sha = git('rev-parse', '--verify', f'{commit}^{{commit}}', cwd=root).strip()
    try:
        os.makedirs(path)
        git('init', '-q', f'--separate-git-dir={gitdir}', path)
        with open(os.path.join(gitdir, 'objects', 'info', 'alternates'), 'w', encoding='utf-8') as f:
            f.write(os.path.join(common, 'objects') + '\n')
        git('checkout', '-q', '--detach', sha, cwd=path)
    except (CouncilError, OSError) as e:
        shutil.rmtree(path, ignore_errors=True)
        shutil.rmtree(gitdir, ignore_errors=True)
        raise CouncilError(f'{refused}; standalone checkout also failed: {e}')
    return 'standalone'


def drop_checkout(run, path):
    with WORKTREE_LOCK:
        if not os.path.isdir(path + '.gitdir'):
            git('worktree', 'remove', '--force', path, cwd=run['repoRoot'], check=False)
    shutil.rmtree(path, ignore_errors=True)
    shutil.rmtree(path + '.gitdir', ignore_errors=True)


def tracked_changes(path):
    """Tracked files a command changed in a scratch checkout. Ignored outputs (caches, builds) don't count."""
    return [l[3:] for l in git('status', '--porcelain', '--untracked-files=no', cwd=path).split('\n') if l]


def checkout_snapshot(run, seat, label, path):
    """A checkout of the seat's <label> snapshot at `path`, created once and reused after."""
    ref = f'refs/council/{run["runId"]}/{seat}-{label}'
    if not git('rev-parse', '--verify', '--quiet', ref, cwd=run['repoRoot'], check=False).strip():
        raise CouncilError(f'no snapshot {seat}-{label} (it is taken when that round is measured)')
    if not os.path.exists(path):
        detached_checkout(run, path, ref)
        clone_deps(run['repoRoot'], path)
        if run.get('factory'):
            copy_agent_docs(run['repoRoot'], path, untracked=True)
    return ref


def cmd_materialize(a):
    run = load_run(a.run_dir)
    name = a.name or f'{a.seat}-{a.label}'
    if not re.fullmatch(r'[A-Za-z0-9._-]+', name):
        raise CouncilError(f'invalid checkout name: {name}')
    path = os.path.join(run['runDir'], 'snap', name)
    ref = checkout_snapshot(run, a.seat, a.label, path)
    emit({'status': 'ok', 'path': path, 'ref': ref})
