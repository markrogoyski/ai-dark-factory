"""Delivery inspection, verify-delivery and apply."""

import hashlib
import json
import os
import re
import subprocess

from . import common, jobs
from .common import CouncilError, git, git_env, load_run, read, write_json
from .jobs import job_dir, register_job_runner, settle_existing_job, start_job
from .pinning import pin_guard
from .snapshots import worktree_tree
from .verification import inspect_evidence, safe_relative, suite, verification_settings


def checkout_changes(repo):
    return sorted(set(git('diff', '--name-only', '-z', 'HEAD', cwd=repo).split('\0')[:-1] +
                      git('ls-files', '--others', '--exclude-standard', '-z', cwd=repo).split('\0')[:-1]))


def checkout_file(repo, rel):
    # A leaf symlink is a Git blob; parent symlinks must never escape the checkout.
    parent, name = os.path.split(rel)
    path = os.path.join(safe_relative(repo, parent) if parent else repo, name)
    if not name or name in ('.', '..') or os.path.isabs(rel) or rel.split('/')[0] in ('.git', '.council'):
        raise CouncilError(f'invalid checkout path: {rel}')
    if not os.path.lexists(path):
        return None
    if os.path.islink(path):
        data, mode = os.readlink(path).encode(), '120000'
    elif os.path.isfile(path):
        with open(path, 'rb') as f:
            data = f.read()
        mode = '100755' if os.stat(path).st_mode & 0o111 else '100644'
    else:
        raise CouncilError(f'delivery does not support directory/submodule changes: {rel}')
    blob = subprocess.run(['git', 'hash-object', '--stdin'], cwd=repo, env=git_env(), input=data, capture_output=True, check=True, close_fds=True)
    return {'mode': mode, 'blob': blob.stdout.decode().strip(), 'sha256': hashlib.sha256(data).hexdigest()}


def tree_files(repo, ref):
    result = {}
    for row in git('ls-tree', '-r', '-z', ref, cwd=repo).split('\0'):
        if not row:
            continue
        meta, path = row.split('\t', 1)
        mode, kind, blob = meta.split()
        result[path] = {'mode': mode, 'blob': blob}
    return result


def delivery_entries(manifest):
    if not isinstance(manifest, dict) or set(manifest) != {'adjustments', 'handoffs'}:
        raise CouncilError('delivery manifest requires adjustments and handoffs arrays')
    seen = set()
    for kind in ('adjustments', 'handoffs'):
        if not isinstance(manifest[kind], list):
            raise CouncilError(f'delivery {kind} must be an array')
        for item in manifest[kind]:
            if not isinstance(item, dict) or set(item) != {'path', 'reason', 'sha256'}:
                raise CouncilError('delivery entries require path, reason and sha256 (or "absent" for deletion)')
            if not all(isinstance(v, str) and v.strip() for v in item.values()) or item['path'] in seen:
                raise CouncilError('delivery entries must be nonempty and paths unique')
            if not re.fullmatch(r'[0-9a-f]{64}|absent', item['sha256']):
                raise CouncilError('delivery sha256 must be a SHA-256 digest or "absent"')
            seen.add(item['path'])
    return {item['path']: item for kind in ('adjustments', 'handoffs') for item in manifest[kind]}


def delivery_snapshot(run, final, diagnostic=False):
    repo = run['repoRoot']
    ref = final.get('snapshotRef', '')
    match = re.fullmatch(re.escape(f'refs/council/{run["runId"]}/') + r'([A-Z])-([A-Za-z0-9][A-Za-z0-9._-]*)', ref) if isinstance(ref, str) else None
    if not match:
        raise CouncilError('delivery requires this run\'s final snapshotRef')
    tree = git('rev-parse', f'{ref}^{{tree}}', cwd=repo).strip()
    if final.get('snapshotTree') != tree:
        raise CouncilError('snapshot no longer matches the tree in the factory result')
    ready = final.get('readiness', {})
    if not diagnostic and (ready.get('state') != 'ready' or ready.get('blocked') or ready.get('incomplete')):
        raise CouncilError('factory readiness has not passed; delivery cannot be verified')
    inspect_evidence(run, *match.groups())
    return ref


def inspect_delivery(run, final, manifest, diagnostic=False):
    repo = run['repoRoot']
    ref = delivery_snapshot(run, final, diagnostic)
    head = git('rev-parse', 'HEAD', cwd=repo).strip()
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', run['head'], head], cwd=repo, env=git_env(),
                              stdin=subprocess.DEVNULL, capture_output=True, close_fds=True)
    if ancestor.returncode != 0:
        raise CouncilError('main HEAD no longer descends from the setup commit')
    if 'deliveryBaseline' not in run:
        raise CouncilError('run has no delivery baseline; use a factory run initialized with --factory')
    declared = delivery_entries(manifest)
    expected = tree_files(repo, ref)
    before = tree_files(repo, run['head'])
    changed = git('diff', '--no-renames', '--name-only', '-z', run['head'], ref, cwd=repo).split('\0')[:-1]
    committed = git('diff', '--no-renames', '--name-only', '-z', run['head'], head, cwd=repo).split('\0')[:-1]
    paths = sorted(set(changed) | set(committed) | set(checkout_changes(repo)) | set(run['deliveryBaseline']) | set(declared))
    matches, problems, states = [], [], {}
    for path in paths:
        actual = checkout_file(repo, path)
        states[path] = actual
        if path in declared:
            digest = actual['sha256'] if actual else 'absent'
            if digest != declared[path]['sha256']:
                problems.append(f'declared delivery bytes do not match: {path}')
            continue
        want = expected.get(path) if path in changed else run['deliveryBaseline'].get(path, before.get(path))
        same = actual is None and want is None or actual and want and all(actual[k] == want[k] for k in ('mode', 'blob'))
        if not same:
            problems.append(f'{"reviewed snapshot differs" if path in changed else "unrelated file changed"}: {path}')
        elif path in changed:
            matches.append(path)
    return {'snapshot': git('rev-parse', ref, cwd=repo).strip(), 'snapshotRef': ref, 'base': run['head'], 'mainHead': head,
            'reviewedFilesMatch': matches, 'problems': problems, 'files': states}


def run_delivery_job(jd, spec):
    run = load_run(spec['runDir'])
    reason = spec.get('diagnosticReason', '')
    before = inspect_delivery(run, spec['final'], spec['manifest'], bool(reason))
    result = {'status': 'incomplete', 'factoryReadiness': spec['final']['readiness'],
              'manifest': spec['manifest'], **({'diagnosticReason': reason} if reason else {}), **before}
    if not before['problems']:
        result['validation'] = suite(run, run['repoRoot'], 'delivery', 'main', spec['suiteTimeout'], spec['verification'])
        after = inspect_delivery(run, spec['final'], spec['manifest'], bool(reason))
        result['problems'] = after['problems']
        if after['files'] != before['files'] or after['mainHead'] != before['mainHead'] or after['snapshot'] != before['snapshot']:
            result['problems'].append('project checks changed delivery files')
        gate_ok = result['validation'].get('passed') or not spec['verification']['command']
        if gate_ok and not result['problems']:
            result['status'] = 'verified-diagnostic' if reason else 'delivered'
    checked = pin_guard(run['runDir'], repo=run['repoRoot'], final=spec['final'])
    if checked:
        candidate = checked['candidate']
        candidate['baseCommit'] = run['head']
        candidate['baseTree'] = git('rev-parse', run['head'] + '^{tree}', cwd=run['repoRoot']).strip()
        candidate['deliveredTree'] = worktree_tree(run, run['repoRoot'], 'index-delivery-provenance', result['mainHead']) if result['status'] == 'delivered' else None
        candidate['deliveredCommit'] = result['mainHead'] if candidate['deliveredTree'] == git('rev-parse', 'HEAD^{tree}', cwd=run['repoRoot']).strip() else None
        result['provenance'] = {'version': 1, 'executor': checked['executor'], 'evaluator': {'packageDigest': checked['executor']['packageDigest'], 'entrypoint': 'bin/dark-factory'}, 'candidate': candidate}
    write_json(os.path.join(run['runDir'], 'delivery-diagnostic.json' if reason else 'delivery.json'), result)
    return result


def load_result(run, path):
    """The full result from a saved file, RUN/result.json, or a native workflow's task output,
    which wraps the result under "result"."""
    report = json.loads(read(path or os.path.join(run['runDir'], 'result.json')))
    if isinstance(report, dict) and report.get('artifactType') is None and isinstance(report.get('result'), dict):
        report = report['result']
    if not isinstance(report, dict) or report.get('artifactType') == 'dark-factory-summary':
        raise CouncilError('delivery requires the full result; summary.json is informational only')
    if os.path.realpath(report.get('runDir', '')) != os.path.realpath(run['runDir']):
        raise CouncilError('result belongs to a different run')
    return report


def cmd_verify_delivery(a):
    run = load_run(a.run_dir)
    report = load_result(run, a.result)
    manifest = json.loads(read(a.manifest)) if a.manifest else {'adjustments': [], 'handoffs': []}
    final = report.get('final', {})
    reason = (a.diagnostic_reason or '').strip()
    if a.diagnostic_reason is not None and not reason:
        raise CouncilError('--diagnostic-reason requires a nonempty explanation')
    output = os.path.join(run['runDir'], 'delivery-diagnostic.json' if reason else 'delivery.json')
    try:
        inspect_delivery(run, final, manifest, bool(reason))
    except (CouncilError, OSError, ValueError, KeyError) as e:
        write_json(output, {'status': 'incomplete', 'problems': [str(e)], **({'diagnosticReason': reason} if reason else {})})
        raise
    key = 'verify-delivery-diagnostic' if reason else 'verify-delivery'
    jd = job_dir(a.run_dir, key)
    spec = {'kind': 'delivery', 'job': key, 'runDir': run['runDir'], 'final': final,
            'manifest': manifest, 'verification': verification_settings(run), 'suiteTimeout': a.suite_timeout, 'diagnosticReason': reason}
    def decide(old, state):
        if state and state.get('status') == 'running':
            if old != spec:
                raise CouncilError('delivery verification is already running with different inputs')
            return 'wait'
        return None
    if settle_existing_job(jd, key, a.max_wait, decide):
        return
    write_json(output, {'status': 'pending', 'job': key})
    start_job(jd, spec)
    common.emit(jobs.wait_job(jd, key, a.max_wait))


def cmd_apply(a):
    run = load_run(a.run_dir)
    report = load_result(run, a.result)
    if report.get('artifactType') != 'dark-factory-result' or report.get('artifactVersion') != 1:
        raise CouncilError('apply requires a full dark-factory-result v1; summary.json is informational only')
    final, repo = report.get('final', {}), run['repoRoot']
    ref = delivery_snapshot(run, final)
    if git('rev-parse', 'HEAD', cwd=repo).strip() != run['head']:
        raise CouncilError('HEAD changed since setup; apply requires the original base')
    status = [row for row in git('status', '--porcelain', '--untracked-files=no', cwd=repo).split('\n') if row]
    if status and 'deliveryBaseline' not in run:
        raise CouncilError('apply requires a clean tracked checkout and index; existing changes were preserved')
    # The applied index is compared with the snapshot tree, so it must start as HEAD's: staged or
    # unmerged changes are refused, while unstaged edits recorded at setup may stay.
    staged = [row[3:] for row in status if row[0] != ' ']
    if staged:
        raise CouncilError('apply requires an index matching HEAD; staged changes were preserved: ' + ', '.join(staged))
    baseline = run.get('deliveryBaseline', {})
    before = tree_files(repo, run['head'])
    # Tracked changes outside the baseline are reported first, as the clean-checkout refusal was.
    for path in sorted(set(checkout_changes(repo)) | set(baseline), key=lambda p: (p in baseline or p not in before, p)):
        actual, want = checkout_file(repo, path), baseline.get(path, before.get(path))
        if not (actual is None and want is None or actual and want and all(actual[k] == want[k] for k in ('mode', 'blob'))):
            if path in before and path not in baseline:
                raise CouncilError(f'tracked file changed since setup: {path}; apply requires a clean tracked checkout apart from '
                                   'the edits recorded at setup (run.json deliveryBaseline); existing changes were preserved')
            raise CouncilError(f'local file changed since setup and would not pass delivery verification: {path}')
    paths = git('diff', '--no-renames', '--name-only', '-z', run['head'], ref, cwd=repo).split('\0')[:-1]
    # Refuse collisions with untracked/ignored local files, including a parent path.
    for path in paths:
        if path not in before and os.path.lexists(os.path.join(repo, path)):
            raise CouncilError(f'local file would be overwritten: {path}')
        parent = os.path.dirname(path)
        if parent:
            safe_relative(repo, parent)
    # A local edit kept from setup may not share a path, or a parent directory, with the reviewed
    # change: applying would overwrite it (git apply itself says only "does not match index").
    for path in paths:
        for kept in sorted(baseline):
            if path == kept or path.startswith(kept + '/') or kept.startswith(path + '/'):
                raise CouncilError(f'the reviewed change touches {path}, which overlaps the local edit to {kept} recorded at setup '
                                   '(run.json deliveryBaseline); nothing was applied, and that edit must be committed, '
                                   'moved or reverted before apply')
    patch = subprocess.check_output(['git', 'diff', '--binary', '--no-ext-diff', run['head'], ref], cwd=repo, env=git_env(), close_fds=True)
    if patch:
        for flags in (['--check', '--index'], ['--index']):
            r = subprocess.run(['git', 'apply', *flags, '-'], input=patch, cwd=repo, env=git_env(), capture_output=True, close_fds=True)
            if r.returncode:
                raise CouncilError(r.stderr.decode(errors='replace').strip())
    tree = git('write-tree', cwd=repo).strip()
    if tree != final['snapshotTree']:
        raise CouncilError('applied index differs from reviewed snapshot; changes retained for inspection')
    result = inspect_delivery(run, final, {'adjustments': [], 'handoffs': []})
    if result['problems']:
        raise CouncilError('applied checkout differs: ' + '; '.join(result['problems']))
    common.emit({'status': 'applied', 'snapshotRef': ref, 'snapshotTree': tree, 'runDir': run['runDir'],
          'next': 'Run dark-factory verify-delivery before committing.'})


register_job_runner('delivery', lambda jd, spec: run_delivery_job(jd, spec))
