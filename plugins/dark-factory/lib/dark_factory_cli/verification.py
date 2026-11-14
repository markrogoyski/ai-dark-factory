"""Gate runs, verification settings and environment, and evidence bundles (verify, evidence)."""

from contextlib import contextmanager
import hashlib
import json
import os
import re
import shutil
import tempfile
import time

from . import common, jobs
from .common import CouncilError, git, load_run, read, subject_environment, tail, write, write_json
from .jobs import job_dir, register_job_runner, settle_existing_job, start_job
from .snapshots import tracked_changes


def verification_config(run):
    path = os.path.join(run['runDir'], 'verification.json')
    config = json.loads(read(path)) if os.path.exists(path) else {'env': {}}
    if not isinstance(config, dict) or 'env' not in config or not set(config) <= {'env', 'concurrency'} or not isinstance(config['env'], dict):
        raise CouncilError('verification.json must contain an env object and optionally concurrency')
    if 'concurrency' in config and (type(config['concurrency']) is not int or not 1 <= config['concurrency'] <= 64):
        raise CouncilError('verification concurrency must be an integer from 1 to 64')
    return config


def verification_concurrency(run):
    """How many replay executions (and the suite beside them) run at once. 1 is fully serial, for
    tests that share a fixed port, database or global cache."""
    return verification_config(run).get('concurrency', min(4, max(1, (os.cpu_count() or 2) // 2)))


def verification_settings(run):
    """Capture only explicit run overrides, never serialize the caller's environment."""
    path = os.path.join(run['runDir'], 'verification.json')
    config = verification_config(run)
    for key, value in config['env'].items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or not isinstance(value, str) or '\0' in value:
            raise CouncilError('verification env requires valid variable names and string values without NUL')
    verify = os.path.join(run['runDir'], 'verify.sh')
    return {'command': read(verify).strip() if os.path.exists(verify) else '', 'env': config['env'],
            **({'baseEnv': run['verificationBaseEnv']} if run.get('factory') else {})}


def verification_environment(settings):
    env = dict(settings.get('baseEnv', os.environ))
    pin = os.environ.get('DARK_FACTORY_PIN')
    if pin and 'PATH' in env:
        # A pinned gate tests the candidate, so it must not resolve the frozen export's helpers.
        frozen = os.path.realpath(os.path.join(json.loads(pin)['root'], 'bin'))
        env['PATH'] = os.pathsep.join(e for e in env['PATH'].split(os.pathsep) if not os.path.isabs(e) or os.path.realpath(e) != frozen)
    return subject_environment(dict(env, **settings['env']))


class VerificationInfrastructureError(CouncilError):
    pass


@contextmanager
def verification_temp(run, settings):
    env = verification_environment(settings)
    if not run.get('factory'):
        yield env
        return
    # Prefer short roots for Unix sockets, but probe creation rather than assuming
    # /tmp is writable inside every host sandbox. Never clean another job's files.
    candidates = []
    for source in (settings['env'], os.environ, env, {'TMPDIR': '/tmp', 'TMP': '/var/tmp'}):
        for key in ('TMPDIR', 'TMP', 'TEMP'):
            root = source.get(key)
            if root and os.path.isabs(root) and root not in candidates:
                candidates.append(root)
    candidates.sort(key=lambda root: len(os.fsencode(os.path.realpath(root))) > 40)
    failures = []
    for root in candidates:
        try:
            temporary = tempfile.TemporaryDirectory(prefix='df-', dir=root)
        except OSError as error:
            failures.append(f'{root}: {error.strerror or error}')
            continue
        with temporary as directory:
            yield dict(env, TMPDIR=directory, TMP=directory, TEMP=directory)
        return
    raise VerificationInfrastructureError('No writable verification temporary root: ' + '; '.join(failures))


def verification_infrastructure_failure(result, env):
    if result['exitCode'] == 0 or result['timedOut']:
        return False
    # Require an exception diagnostic referencing this execution's private temp
    # directory. A test mentioning socket limits is not an infrastructure failure.
    roots = {env['TMPDIR'], os.path.realpath(env['TMPDIR'])}
    for line in read(result['log']).splitlines():
        if not any(root.rstrip('/') + '/' in line for root in roots):
            continue
        if re.match(r'^(?:PHP Fatal error:\s*)?(?:Uncaught\s+)?[\w\\]*SocketException:\s+Could not create server unix://', line):
            return True
        if re.match(r'^OSError:\s+(?:\[Errno \d+\] )?(?:AF_UNIX path too long|sun_path exceeds (?:the )?limit)', line):
            return True
    return False


def suite(run, cwd, label, seat, timeout, settings=None):
    settings = verification_settings(run) if settings is None else settings
    if not settings['command']:
        return {'ran': False, 'passed': False, 'note': 'no verification command configured'}
    log = os.path.join(run['runDir'], 'logs', f'suite-{seat}-{label}.log')
    attempts, started = [], time.monotonic()
    original = git('diff', '--binary', 'HEAD', cwd=cwd) if run.get('factory') else None
    for attempt in range(2 if run.get('factory') else 1):
        attempt_log = log if attempt == 0 else log + '.retry'
        try:
            with verification_temp(run, settings) as env:
                r = common.run_shell(settings['command'], cwd, max(0.01, timeout - (time.monotonic() - started)), attempt_log, env=env)
                infrastructure = run.get('factory') and verification_infrastructure_failure(r, env)
                attempts.append(dict(r, env={**settings['env'], **{k: env[k] for k in ('TMPDIR', 'TMP', 'TEMP') if k in env}},
                                     failureKind='infrastructure' if infrastructure else ''))
        except VerificationInfrastructureError as error:
            write(attempt_log, str(error) + '\n')
            return dict(ran=False, passed=False, cwd=cwd, command=settings['command'], env=settings['env'],
                        log=attempt_log, tail=str(error), attempts=attempts, failureKind='infrastructure')
        if not infrastructure or time.monotonic() - started >= timeout or git('diff', '--binary', 'HEAD', cwd=cwd) != original:
            break
    return dict(r, ran=True, passed=(r['exitCode'] == 0 and not r['timedOut']),
                cwd=cwd, command=settings['command'], env=settings['env'],
                **({'attempts': attempts, 'failureKind': 'infrastructure' if infrastructure else ''} if run.get('factory') else {}))


def safe_relative(root, rel):
    """Artifact paths are relative, confined, and may not follow symlinks."""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or any(p in ('', '.', '..') for p in rel.split('/')):
        raise CouncilError(f'invalid relative artifact path: {rel!r}')
    root = os.path.realpath(root)
    path = os.path.join(root, rel)
    if os.path.commonpath([root, os.path.realpath(path)]) != root:
        raise CouncilError(f'artifact escapes its directory: {rel}')
    part = root
    for name in rel.split('/'):
        part = os.path.join(part, name)
        if os.path.islink(part):
            raise CouncilError(f'artifact is a symlink: {rel}')
    return path


def file_sha256(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(f.read()).hexdigest()


def evidence_inputs(run, seat):
    root = safe_relative(run['runDir'], f'room/evidence/{seat}')
    manifest = os.path.join(root, 'manifest.json')
    if not os.path.exists(manifest):
        return []
    data = json.loads(read(safe_relative(root, 'manifest.json')))
    if not isinstance(data, list):
        raise CouncilError('evidence manifest must be an array of {path, criterion, stage} records')
    records, seen = [], set()
    for item in data:
        if not isinstance(item, dict) or set(item) != {'path', 'criterion', 'stage'}:
            raise CouncilError('each evidence entry requires path, criterion and stage')
        if not all(isinstance(item[k], str) and item[k].strip() for k in item):
            raise CouncilError('evidence entry values must be nonempty strings')
        path = safe_relative(root, item['path'])
        if item['path'] in seen or item['path'] == 'manifest.json' or not os.path.isfile(path):
            raise CouncilError(f'duplicate, reserved or missing evidence file: {item["path"]}')
        seen.add(item['path'])
        records.append(dict(item, sha256=file_sha256(path)))
    return records


def publish_evidence(run, seat, label, measurement):
    """Freeze raw artifacts separately from the room's arguments, bound to a measured tree."""
    records = evidence_inputs(run, seat)
    index = {'snapshot': measurement['snapshot']['commit'], 'tree': measurement['snapshot']['tree'],
             'verification': measurement['verification'],
             'suite': measurement['suite'], 'artifacts': records}
    log = measurement['suite'].get('log')
    if log:
        index['suiteLogSha256'] = file_sha256(log)
    # Content-addressed bundles are never overwritten on remeasurement of the same label.
    digest = hashlib.sha256(json.dumps(index, sort_keys=True).encode()).hexdigest()
    rel = f'evidence/{seat}-{label}-{digest}'
    target = safe_relative(run['runDir'], rel)
    if not os.path.exists(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        staging = tempfile.mkdtemp(prefix='.publish-', dir=os.path.dirname(target))
        try:
            for item in records:
                src = safe_relative(os.path.join(run['room'], 'evidence', seat), item['path'])
                dst = safe_relative(staging, 'files/' + item['path'])
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
                if file_sha256(dst) != item['sha256']:
                    raise CouncilError('evidence changed while being published')
            if log:
                shutil.copyfile(log, os.path.join(staging, 'suite.log'))
                if file_sha256(os.path.join(staging, 'suite.log')) != index['suiteLogSha256']:
                    raise CouncilError('verification log changed while being published')
            write_json(os.path.join(staging, 'index.json'), index)
            os.rename(staging, target)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    elif json.loads(read(safe_relative(target, 'index.json'))) != index:
        raise CouncilError('published evidence index was modified')
    pointer = os.path.join(run['runDir'], 'evidence', f'{seat}-{label}.json')
    write_json(pointer, {'index': rel + '/index.json', 'sha256': file_sha256(os.path.join(target, 'index.json'))})
    return {'status': 'published', 'index': os.path.join(target, 'index.json'), 'pointer': pointer}


def run_verify_job(jd, spec):
    run = load_run(spec['runDir'])
    return {'status': 'done', 'job': spec['job'],
            'suite': suite(run, spec['path'], spec['label'], 'verify', spec['suiteTimeout'], spec['verification'])}


def inspect_evidence(run, seat, label):
    pointer = json.loads(read(safe_relative(run['runDir'], f'evidence/{seat}-{label}.json')))
    index_path = safe_relative(run['runDir'], pointer['index'])
    if file_sha256(index_path) != pointer['sha256']:
        raise CouncilError('evidence index hash mismatch')
    index = json.loads(read(index_path))
    ref = f'refs/council/{run["runId"]}/{seat}-{label}'
    if index['snapshot'] != git('rev-parse', ref, cwd=run['repoRoot']).strip():
        raise CouncilError('evidence does not describe the current snapshot')
    if index['verification'] != verification_settings(run):
        raise CouncilError('verification settings changed since the snapshot was measured')
    root = os.path.dirname(index_path)
    for item in index['artifacts']:
        if file_sha256(safe_relative(root, 'files/' + item['path'])) != item['sha256']:
            raise CouncilError(f'evidence file hash mismatch: {item["path"]}')
    if index.get('suiteLogSha256') and file_sha256(safe_relative(root, 'suite.log')) != index['suiteLogSha256']:
        raise CouncilError('evidence suite log hash mismatch')
    return {'status': 'ok', 'index': index_path, 'snapshot': index['snapshot'], 'artifacts': index['artifacts']}


def cmd_evidence(a):
    common.emit(inspect_evidence(load_run(a.run_dir), a.seat, a.label))


def cmd_verify(a):
    run = load_run(a.run_dir)
    key = f'verify-{a.label}'
    jd = job_dir(a.run_dir, key)
    settings = verification_settings(run)
    if a.command_file:
        settings['command'] = read(a.command_file).strip()
    path = os.path.realpath(a.path)
    spec = {'kind': 'verify', 'runDir': run['runDir'], 'job': key, 'label': a.label,
            'path': path, 'verification': settings, 'suiteTimeout': a.suite_timeout}
    # Mutable checkouts are always rerun; only join a currently running identical request.
    def decide(old, state):
        if state and state.get('status') == 'running':
            if old != spec:
                raise CouncilError('verification job is running with different inputs; use a new label')
            return 'wait'
        return None
    if settle_existing_job(jd, key, a.max_wait, decide):
        return
    start_job(jd, spec)
    common.emit(jobs.wait_job(jd, key, a.max_wait))


def crosstest(run, cwd, label, seat, test_ids, timeout, reset=False, env=None):
    """Copy each published test's files into cwd, run it, and remove them again. With `reset` (a
    scratch checkout), tracked files a test changed are restored before the next one runs."""
    results = []
    for tid in test_ids:
        tdir = os.path.join(run['room'], 'tests', tid)
        meta_path = os.path.join(tdir, 'test.json')
        if not os.path.exists(meta_path):
            results.append({'test': tid, 'outcome': 'error', 'note': 'missing test.json'})
            continue
        try:
            meta = json.loads(read(meta_path))
            command = str(meta['command'])
        except (json.JSONDecodeError, KeyError) as e:
            results.append({'test': tid, 'outcome': 'error', 'note': f'bad test.json: {e}'})
            continue
        files_root = os.path.join(tdir, 'files')
        rels = []
        for base, _, names in os.walk(files_root):
            for n in names:
                rels.append(os.path.relpath(os.path.join(base, n), files_root))
        copied, made_dirs, conflict = [], [], None
        for rel in rels:
            src, dst = os.path.join(files_root, rel), os.path.join(cwd, rel)
            if os.path.exists(dst):
                with open(src, 'rb') as f1, open(dst, 'rb') as f2:
                    if f1.read() == f2.read():
                        continue                          # already there, identical: run in place
                conflict = rel
                break
            d = os.path.dirname(dst)
            missing = []
            while d and not os.path.exists(d):
                missing.append(d)
                d = os.path.dirname(d)
            for m in reversed(missing):
                os.makedirs(m, exist_ok=True)
                made_dirs.append(m)
            shutil.copy2(src, dst)
            copied.append(dst)
        if conflict:
            results.append({'test': tid, 'outcome': 'conflict', 'note': f'{conflict} already exists with different content'})
        else:
            log = os.path.join(run['runDir'], 'logs', f'cross-{tid}-on-{seat}-{label}.log')
            r = common.run_shell(command, cwd, timeout, log, env=env)
            outcome = 'pass' if r['exitCode'] == 0 and not r['timedOut'] else 'fail'
            results.append({'test': tid, 'outcome': outcome, 'exitCode': r['exitCode'],
                            'timedOut': r['timedOut'], 'tail': tail(r['tail'], 12)})
        for f in copied:
            try:
                os.remove(f)
            except FileNotFoundError:
                pass
        for d in reversed(made_dirs):
            try:
                os.rmdir(d)
            except OSError:
                pass
        if reset:
            mutated = tracked_changes(cwd)
            if mutated:
                results[-1]['mutated'] = mutated[:20]
                git('checkout', '-q', '--', '.', cwd=cwd, check=False)
    return results


register_job_runner('verify', lambda jd, spec: run_verify_job(jd, spec))
