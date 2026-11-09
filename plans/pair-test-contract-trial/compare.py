"""Offline trial extraction and frozen probes; never invokes a model or delivers changes."""
import hashlib
import json
import pathlib
import shutil
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
manifest = json.loads((HERE / 'manifest.json').read_text())
probe = HERE / 'outcome-probe.php'
assert hashlib.sha256(probe.read_bytes()).hexdigest() == manifest['outcomeProbeSha256']
rows, outcomes, results, preflights = [], {}, [], []

for task in manifest['tasks']:
    for run in task['runs']:
        source = pathlib.Path(run['result'])
        if not source.exists():
            rows.append({'taskId': task['id'], 'variant': run['variant'], 'status': 'not-run'})
            continue
        result = json.loads(source.read_text())
        dest = HERE / 'results' / task['id'] / run['variant']
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest / 'result.json')
        results.append(str(dest / 'result.json'))
        for suffix in ['result.json.sandbox-preflight', 'log.sandbox-preflight']:
            saved = source.with_name(source.name.replace('result.json', suffix))
            if saved.exists():
                shutil.copy2(saved, dest / suffix)
                if suffix.startswith('result'):
                    preflights.append(str(dest / suffix))
        if result.get('hostEvents'):
            shutil.copy2(result['hostEvents'], dest / 'events.jsonl')
        final, metrics = result.get('final', {}), result.get('metrics', {})
        measured = []
        if result.get('runDir'):
            for path in sorted(pathlib.Path(result['runDir']).glob('jobs/measure-A-pair-code-*/status.json')):
                data = json.loads(path.read_text())
                measured.append(data)
                label = path.parent.name
                shutil.copy2(path, dest / (label + '.json'))
                for i, record in enumerate(data.get('replay', {}).get('records', [])):
                    if record.get('log') and pathlib.Path(record['log']).exists():
                        shutil.copy2(record['log'], dest / f'{label}-{i}-{record["side"]}.log')
        outcome = {'status': 'unresolved', 'reason': 'No final snapshot was returned.'}
        if final.get('snapshotRef'):
            engine = manifest['controlEngine'] if run['variant'] == 'pair-control' else manifest['candidateEngine']
            helper = str(pathlib.Path(engine) / 'plugins/dark-factory/bin/dark-factory')
            label = final['snapshotRef'].split('/A-', 1)[1]
            raw = subprocess.check_output([helper, 'materialize', '--run-dir', result['runDir'], '--seat', 'A',
                                           '--label', label, '--name', 'trial-independent-outcome'], text=True)
            checkout = json.loads(raw.strip().splitlines()[-1])['path']
            tree = subprocess.check_output(['git', '-C', checkout, 'rev-parse', 'HEAD^{tree}'], text=True).strip()
            assert tree == final['snapshotTree']
            completed = subprocess.run(['php', str(probe), checkout, task['id']], capture_output=True, text=True, timeout=60)
            log = dest / 'outcome.json'
            log.write_text(completed.stdout)
            (dest / 'outcome.stderr').write_text(completed.stderr)
            checks = json.loads(completed.stdout)
            outcome = {'status': 'passed' if completed.returncode == 0 else 'regression', 'exitCode': completed.returncode,
                       'evidence': str(log.relative_to(REPO)), 'snapshotTree': tree, 'checks': checks}
            shutil.copy2(final['diff'], dest / 'final.diff')
        if outcome['status'] in ('passed', 'regression'):
            outcomes[result.get('hostRunDir', result.get('runDir'))] = {k: v for k, v in outcome.items() if k in ('status', 'evidence')}
        replays = [m['replay'] for m in measured if 'replay' in m]
        records = [r for replay in replays for r in replay['records']]
        row = {'taskId': task['id'], 'variant': run['variant'], 'startingCommit': task['startingCommit'],
               'status': result['status'], 'readiness': final.get('readiness'), 'stopReason': result.get('stopReason'),
               'result': str((dest / 'result.json').relative_to(REPO)), 'hostRunDir': result.get('hostRunDir'),
               'designReviews': sum(r['stage'] == 'design' for r in result.get('reviews', [])),
               'codeReviews': sum(r['stage'] == 'code' for r in result.get('reviews', [])),
               'turns': metrics.get('turns'), 'failedTurns': metrics.get('failedTurns'),
               'elapsedMs': metrics.get('elapsedMs'), 'tokens': metrics.get('tokens'), 'cost': metrics.get('cost'),
               'findings': result.get('findings'), 'outcome': outcome,
               'replay': {'measurements': len(replays), 'elapsedSec': sum(r['elapsedSec'] for r in replays),
                          'records': len(records), 'timeouts': sum(r['timedOut'] for r in records),
                          'launchErrors': sum(bool(r['launchError']) for r in records),
                          'nonzeroBaseCommands': sum(r['side'] == 'base' and r['hasExitCode'] and r['exitCode'] != 0 for r in records),
                          'exclusions': [e for r in replays for e in r['exclusions']]}}
        rows.append(row)

(HERE / 'comparison.json').write_text(json.dumps({'runs': rows, 'preflightResults': preflights}, indent=2) + '\n')
(HERE / 'outcomes.json').write_text(json.dumps(outcomes, indent=2) + '\n')
subprocess.run(['node', str(REPO / 'plugins/dark-factory/bin/dark-factory-evaluate'), '--output', str(HERE / 'evaluation.json'),
                '--outcomes', str(HERE / 'outcomes.json'), *results, *preflights], check=True, stdout=subprocess.DEVNULL)
print(json.dumps([{k: r.get(k) for k in ['taskId', 'variant', 'status', 'designReviews', 'codeReviews', 'turns', 'elapsedMs', 'replay']}
                  for r in rows], indent=2))
