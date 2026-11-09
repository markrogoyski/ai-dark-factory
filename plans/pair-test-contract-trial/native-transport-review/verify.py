"""Recheck archived native transport evidence; no processes, models, or network."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


def main():
    helper = read('helper-result.json')
    returned = read('returned.json')
    request = read('request.json')
    metadata = read('metadata.json')
    journal = [json.loads(line) for line in (ROOT / 'native-journal.jsonl').read_text().splitlines()]
    native_results = [entry['result'] for entry in journal if entry['type'] == 'result']
    assert native_results == [returned], 'Native journal differs from archived returned result'
    expected = {
        'status': helper['status'],
        'error': helper.get('error', ''),
        'snapshot': {k: helper['snapshot'][k] for k in ('ref', 'tree', 'diff')},
        'suite': {k: helper['suite'][k] for k in ('ran', 'passed', 'command', 'tail')},
        'replay': helper['replay'],
    }
    assert returned == expected, 'Native result differs from the helper projection'
    replay = returned['replay']
    assert replay['base'] == metadata['base'], 'Wrong original base'
    assert replay['mapping'] == request['mapping'], 'Mapping drift'
    assert replay['testRoots'] == request['testRoots'], 'Test root drift'
    assert len(replay['records']) == 2 * len(request['mapping']), 'Missing base/final records'
    assert returned['status'] == 'done' and returned['suite']['passed'], 'Measurement/gate failed'
    for record in replay['records']:
        data = (ROOT / 'logs' / Path(record['log']).name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == record['logSha256'], 'Raw log hash mismatch'
        assert record['attempted'] and record['ran'] and record['hasExitCode'], 'No execution'
        if record['side'] == 'final':
            assert record['passed'] and record['exitCode'] == 0 and not record['mutated'], 'Final replay failed'
    comparison = {
        'nativeJournalMatchesReturned': True,
        'helperProjectionEqual': True,
        'entireReplayEqual': True,
        'mappingAndRootsEqual': True,
        'originalBaseEqual': True,
        'rawLogHashesVerified': len(replay['records']),
        'baseRecords': sum(r['side'] == 'base' for r in replay['records']),
        'baseFailures': sum(r['side'] == 'base' and not r['passed'] for r in replay['records']),
        'finalRecordsPassed': sum(r['side'] == 'final' and r['passed'] for r in replay['records']),
        'fullGatePassed': returned['suite']['passed'],
        'differences': [],
    }
    print(json.dumps(comparison, indent=2))


if __name__ == '__main__':
    main()
