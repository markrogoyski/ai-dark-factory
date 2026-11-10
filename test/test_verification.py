"""Factory verification and delivery through real processes in temporary repositories; no models."""

import hashlib
import json
import os
import subprocess
import unittest
from unittest import mock

from test_council import CLI, TmpDirCase, council


class Verification(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.repo = self.path('repo with spaces and $literal')
        os.makedirs(self.repo)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Factory test')
        self.git('config', 'user.email', 'factory@example.invalid')
        self.put('value', 'broken\n')
        self.put('unchanged', 'preserve\n')
        self.put('tests/changed.py', 'from pathlib import Path\nassert Path("value").read_text() == "broken\\n"\n')
        self.put('tests/preserved.py', 'from pathlib import Path\nassert Path("unchanged").read_text() == "preserve\\n"\nassert not Path("leaked").exists()\n')
        self.put('.gitignore', 'local-only\nvendor/\n')
        self.put('gate.py', 'import os\nfrom pathlib import Path\n'
                 'assert os.environ.get("FACTORY_GATE") == "serial"\n'
                 'assert Path("value").read_text() == "fixed\\n"\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial fixture')
        self.put('PLAN.md', 'local plan\n')
        self.run = self.cli('init', '--repo', self.repo, '--seats', 'A,B', '--run-id', 'test', '--factory')
        self.rd = self.run['runDir']
        self.wt = self.run['worktrees']['A']
        council.write(os.path.join(self.rd, 'verify.sh'), 'python3 gate.py')
        self.config({'FACTORY_GATE': 'serial'})
        council.write(os.path.join(self.wt, 'value'), 'fixed\n')

    def git(self, *args):
        return council.git(*args, cwd=self.repo)

    def put(self, path, text):
        council.write(os.path.join(self.repo, path), text)

    def config(self, env):
        council.write_json(os.path.join(self.rd, 'verification.json'), {'env': env})

    def cli(self, *args, error=False):
        env = dict(os.environ, COUNCIL_JOB_POLL='0.01', FACTORY_GATE='wrong inherited value')
        r = subprocess.run([CLI, *args], cwd=self.repo, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 1 if error else 0, r.stdout + r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def measure(self, label='r0'):
        return self.cli('measure', '--run-dir', self.rd, '--seat', 'A', '--label', label, '--max-wait', '20')

    def report(self):
        measured = self.measure()
        final = {'snapshotRef': measured['snapshot']['ref'], 'snapshotTree': measured['snapshot']['tree'],
                 'readiness': {'state': 'ready', 'blocked': [], 'incomplete': []}}
        report = os.path.join(self.rd, 'result.json')
        council.write_json(report, {'artifactType': 'dark-factory-result', 'artifactVersion': 1,
                                   'runDir': self.rd, 'final': final})
        return report

    def replay_mapping(self):
        return [{'file': 'tests/changed.py', 'command': 'python3 tests/changed.py', 'checkIds': ['T1'], 'fixtures': []},
                {'file': 'tests/preserved.py', 'command': 'python3 tests/preserved.py', 'checkIds': ['T2'], 'fixtures': []}]

    def replay_measure(self, mapping=None, roots=None, label='replay', timeout=5):
        request = {'testRoots': ['tests'] if roots is None else roots,
                   'mapping': self.replay_mapping() if mapping is None else mapping}
        return self.cli('measure', '--run-dir', self.rd, '--seat', 'A', '--label', label,
                        '--replay-json', json.dumps(request), '--test-timeout', str(timeout), '--max-wait', '20')

    def test_replay_modified_tests_fixtures_preserved_signal_and_cache(self):
        council.write(os.path.join(self.wt, 'tests/changed.py'),
                      'from pathlib import Path\nimport os\nassert os.environ["FACTORY_GATE"] == "serial"\n'
                      'assert Path("tests/fixture").read_bytes() == b"fixed\\n"\n'
                      'assert Path("value").read_bytes() == Path("tests/fixture").read_bytes()\n')
        council.write(os.path.join(self.wt, 'tests/fixture'), 'fixed\n')
        mapping = self.replay_mapping()
        mapping[0]['fixtures'] = ['tests/fixture']
        result = self.replay_measure(mapping)
        replay = result['replay']
        self.assertEqual(replay['base'], self.run['head'])
        self.assertEqual(replay['snapshotTree'], result['snapshot']['tree'])
        self.assertEqual([(r['side'], r['passed']) for r in replay['records']],
                         [('base', False), ('final', True), ('base', True), ('final', True)])
        self.assertTrue(result['suite']['passed'])
        for record in replay['records']:
            self.assertTrue(os.path.isfile(record['log']))
            self.assertFalse(os.path.exists(record['cwd']))
            self.assertTrue(record['attempted'])
        self.assertTrue(self.replay_measure(mapping)['reused'])
        council.write(replay['records'][0]['log'], 'tampered')
        self.assertFalse(self.replay_measure(mapping).get('reused', False))
        roots = None
        for change in ('command', 'mapping', 'roots', 'bytes', 'environment'):
            if change == 'command': mapping[0]['command'] += ' # same command, different input'
            if change == 'mapping': mapping[0]['checkIds'].append('T3')
            if change == 'roots': roots = ['tests', 'missing-tests']
            if change == 'bytes': council.write(os.path.join(self.wt, 'tests/fixture'), 'different\n')
            if change == 'environment': self.config({'FACTORY_GATE': 'different'})
            self.assertFalse(self.replay_measure(mapping, roots).get('reused', False), change)

    def test_replay_uses_snapshot_bytes_and_original_base_after_author_commits(self):
        council.write(os.path.join(self.wt, 'tests/changed.py'),
                      'from pathlib import Path\nassert Path("value").read_text() == "fixed\\n"\n')
        council.git('add', '.', cwd=self.wt)
        council.git('commit', '-qm', 'Author implementation', cwd=self.wt)
        original = council.snapshot

        def capture(*args, **kwargs):
            result = original(*args, **kwargs)
            council.write(os.path.join(self.wt, 'tests/changed.py'), 'raise RuntimeError("mutable live bytes")\n')
            return result

        with mock.patch.object(council, 'snapshot', side_effect=capture):
            result = council.run_measure_job('', {'runDir': self.rd, 'seat': 'A', 'label': 'frozen', 'job': 'frozen',
                'suiteTimeout': 5, 'testTimeout': 5, 'tests': [], 'replay': {'testRoots': ['tests'], 'mapping': self.replay_mapping()}})
        self.assertEqual(result['replay']['base'], self.run['head'])
        self.assertFalse(result['replay']['records'][0]['passed'])
        self.assertTrue(result['replay']['records'][1]['passed'])
        self.assertNotIn('mutable live bytes', result['replay']['records'][1]['tail'])

    def test_replay_fatal_and_timeout_do_not_suppress_later_files(self):
        council.write(os.path.join(self.wt, 'api.py'), 'available = True\n')
        council.write(os.path.join(self.wt, 'tests/api.py'),
                      'from pathlib import Path\nif not Path("api.py").exists(): raise RuntimeError("new API missing during load")\n')
        council.write(os.path.join(self.wt, 'tests/timeout.py'), 'import time\ntime.sleep(30)\n')
        mapping = [{'file': 'tests/api.py', 'command': 'python3 tests/api.py', 'checkIds': ['NEW1', 'NEW2'], 'fixtures': []},
                   {'file': 'tests/timeout.py', 'command': 'python3 tests/timeout.py', 'checkIds': ['SLOW'], 'fixtures': []},
                   self.replay_mapping()[1]]
        result = self.replay_measure(mapping, timeout=1)
        records = result['replay']['records']
        self.assertEqual(len(records), 6)
        self.assertIn('new API missing during load', records[0]['tail'])
        self.assertEqual(records[0]['checkIds'], ['NEW1', 'NEW2'])
        self.assertNotIn('testResults', records[0], 'no invented individual outcomes')
        self.assertTrue(records[1]['passed'])
        self.assertTrue(records[2]['timedOut'])
        self.assertEqual(records[2]['signal'], 9)
        self.assertTrue(records[4]['passed'])
        self.assertTrue(records[5]['passed'])
        self.assertTrue(result['suite']['passed'])

    def test_replay_mutations_cannot_contaminate_later_checks_or_author(self):
        council.write(os.path.join(self.wt, 'tests/mutate.py'),
                      'from pathlib import Path\nPath("unchanged").write_text("corrupt")\nPath("leaked").write_text("leaked")\n')
        mapping = [{'file': 'tests/mutate.py', 'command': 'python3 tests/mutate.py', 'checkIds': ['M'], 'fixtures': []}, self.replay_mapping()[1]]
        result = self.replay_measure(mapping)
        records = result['replay']['records']
        self.assertFalse(records[1]['passed'])
        self.assertIn('unchanged', records[1]['mutated'])
        self.assertTrue(all(r['passed'] for r in records[2:]))
        self.assertTrue(result['suite']['passed'])
        self.assertEqual(council.read(os.path.join(self.wt, 'unchanged')), 'preserve\n')
        self.assertFalse(os.path.exists(os.path.join(self.wt, 'leaked')))

    def test_replay_excludes_production_config_symlinks_and_traversal(self):
        council.write(os.path.join(self.wt, 'config.json'), 'production configuration')
        os.symlink('../value', os.path.join(self.wt, 'tests/link'))
        os.symlink('..', os.path.join(self.wt, 'tests/escape'))
        invalid = ['value', 'config.json', '../value', '/tmp/value', 'tests/../value', 'tests/link', 'tests/escape/value']
        mapping = [{'file': p, 'command': 'touch MUST_NOT_RUN', 'checkIds': [f'T{i}'], 'fixtures': []} for i, p in enumerate(invalid)]
        result = self.replay_measure(mapping)
        self.assertEqual(result['replay']['records'], [])
        paths = {e['path'] for e in result['replay']['exclusions']}
        self.assertTrue(set(invalid) <= paths)
        self.assertFalse(os.path.exists(os.path.join(self.wt, 'MUST_NOT_RUN')))
        for roots in [['.'], ['../tests'], ['tests/escape'], ['new-tests']]:
            self.assertEqual(self.replay_measure(roots=roots)['replay']['records'], [])
        # A production fixture request must not drag the production fix onto base.
        mapping = self.replay_mapping(); mapping[0]['fixtures'] = ['value']
        records = self.replay_measure(mapping)['replay']['records']
        self.assertTrue(all(r['checkIds'] == ['T2'] for r in records))

    def test_replay_reports_renames_deletions_and_unchanged_files_explicitly(self):
        council.git('mv', 'tests/changed.py', 'tests/renamed.py', cwd=self.wt)
        os.remove(os.path.join(self.wt, 'tests/preserved.py'))
        mapping = [{'file': 'tests/renamed.py', 'command': 'python3 tests/renamed.py', 'checkIds': ['T1'], 'fixtures': []}, self.replay_mapping()[1]]
        replay = self.replay_measure(mapping)['replay']
        self.assertTrue(any(c['status'].startswith('R') and c['previousPath'] == 'tests/changed.py' for c in replay['changes']))
        self.assertTrue(any(c['status'] == 'D' for c in replay['changes']))
        self.assertEqual([(r['side'], r['file']) for r in replay['records']], [('final', 'tests/renamed.py')])
        self.assertTrue(any('unsupported overlay' in e['reason'] for e in replay['exclusions']))

    def test_replay_launch_error_is_raw_evidence_and_does_not_stop_other_files(self):
        original = council.run_shell
        def launch(command, *args, **kwargs):
            if command == 'unlaunchable': raise OSError('simulated launch failure')
            return original(command, *args, **kwargs)
        mapping = self.replay_mapping(); mapping[0]['command'] = 'unlaunchable'
        with mock.patch.object(council, 'run_shell', side_effect=launch):
            result = council.run_measure_job('', {'runDir': self.rd, 'seat': 'A', 'label': 'launch', 'job': 'launch',
                'suiteTimeout': 5, 'testTimeout': 5, 'tests': [], 'replay': {'testRoots': ['tests'], 'mapping': mapping}})
        records = result['replay']['records']
        self.assertTrue(records[0]['attempted'])
        self.assertFalse(records[0]['ran'])
        self.assertFalse(records[0]['hasExitCode'])
        self.assertEqual(records[0]['launchError'], 'simulated launch failure')
        self.assertTrue(records[-1]['passed'])

    def test_replay_accepts_reviewed_configured_roots_without_existing_test_files(self):
        council.write(os.path.join(self.wt, 'spec/new.py'), 'print("configured test root")\n')
        mapping = [{'file': 'spec/new.py', 'command': 'python3 spec/new.py', 'checkIds': ['T1'], 'fixtures': []}]
        result = self.replay_measure(mapping, roots=['spec'])
        self.assertEqual(len(result['replay']['records']), 2)
        self.assertTrue(all(r['passed'] for r in result['replay']['records']))

    def test_replay_uses_original_base_dependencies_and_author_final_dependencies(self):
        self.put('vendor/marker', 'original dependency')
        council.write(os.path.join(self.wt, 'vendor/marker'), 'author dependency change')
        council.write(os.path.join(self.wt, 'tests/deps.py'),
                      'from pathlib import Path\nassert Path("vendor/marker").read_text() == "author dependency change"\n'
                      'Path("vendor/marker").write_text("mutation must not leak")\n')
        council.write(os.path.join(self.wt, 'gate.py'),
                      council.read(os.path.join(self.wt, 'gate.py')) +
                      'assert Path("vendor/marker").read_text() == "author dependency change"\n')
        mapping = [{'file': 'tests/deps.py', 'command': 'python3 tests/deps.py', 'checkIds': ['T1'], 'fixtures': []}]
        result = self.replay_measure(mapping)
        self.assertEqual([r['passed'] for r in result['replay']['records']], [False, True])
        self.assertTrue(result['suite']['passed'])
        self.assertTrue(any(e['path'] == 'vendor' for e in result['replay']['exclusions']))
        self.assertEqual(council.read(os.path.join(self.wt, 'vendor/marker')), 'author dependency change')
        self.assertEqual(council.read(os.path.join(self.repo, 'vendor/marker')), 'original dependency')

    def delivery(self, report, manifest=None):
        return self.cli('verify-delivery', '--run-dir', self.rd, '--result', report, '--max-wait', '20',
                        *(['--manifest', manifest] if manifest else []))

    def test_same_environment_for_builder_measurement_auditor_and_delivery(self):
        built = self.cli('verify', '--run-dir', self.rd, '--path', self.wt, '--label', 'builder', '--max-wait', '20')
        measured = self.measure()
        audit = self.cli('materialize', '--run-dir', self.rd, '--seat', 'A', '--label', 'r0', '--name', 'audit')
        audited = self.cli('verify', '--run-dir', self.rd, '--path', audit['path'], '--label', 'auditor', '--max-wait', '20')
        self.put('value', 'fixed\n')
        delivered = self.delivery(self.report())
        self.assertEqual(delivered['status'], 'delivered')
        for result in (built['suite'], measured['suite'], audited['suite'], delivered['validation']):
            self.assertTrue(result['passed'], result)
            self.assertEqual(result['env'], {'FACTORY_GATE': 'serial'})
            self.assertEqual(result['command'], 'python3 gate.py')
        self.assertEqual(delivered['validation']['cwd'], self.repo)
        self.assertEqual(council.read(os.path.join(self.repo, 'PLAN.md')), 'local plan\n')

    def test_environment_and_evidence_changes_invalidate_measurement_cache(self):
        first = self.measure()
        self.assertTrue(first['suite']['passed'])
        self.assertTrue(self.measure()['reused'])
        self.config({'FACTORY_GATE': 'wrong'})
        changed = self.measure()
        self.assertFalse(changed.get('reused', False))
        self.assertFalse(changed['suite']['passed'])
        self.config({'FACTORY_GATE': 'serial'})
        self.evidence('red command and exit 1\n')
        changed = self.measure()
        self.assertFalse(changed.get('reused', False))
        self.assertTrue(changed['suite']['passed'])
        self.evidence('corrected red command and exit 1\n')
        self.assertFalse(self.measure().get('reused', False))

    def test_queued_verification_uses_captured_settings(self):
        settings = council.verification_settings(self.run)
        self.config({'FACTORY_GATE': 'changed after scheduling'})
        result = council.run_verify_job('', {'runDir': self.rd, 'job': 'verify-frozen', 'path': self.wt,
                                            'label': 'frozen', 'suiteTimeout': 10, 'verification': settings})
        self.assertTrue(result['suite']['passed'])

    def test_shell_local_exports_do_not_change_factory_verification(self):
        self.config({})
        with mock.patch.dict(os.environ, {'FACTORY_GATE': 'serial'}):
            result = council.suite(self.run, self.wt, 'local-export', 'A', 10)
        self.assertFalse(result['passed'], 'a shell-local workaround must not count as a reproducible gate')

    def test_snapshot_failure_cannot_be_replaced_by_a_live_pass(self):
        council.write(os.path.join(self.wt, 'local-only'), 'ignored input')
        council.write(os.path.join(self.rd, 'verify.sh'), 'test -f local-only')
        self.assertTrue(council.suite(self.run, self.wt, 'live', 'A', 10)['passed'])
        result = self.measure()
        self.assertTrue(result['scratch'])
        self.assertFalse(result['suite']['passed'])
        self.assertNotIn('scratchFailed', result['suite'])

    def test_gate_cannot_repair_the_snapshot_and_claim_it_passed(self):
        council.write(os.path.join(self.wt, 'value'), 'broken\n')
        council.write(os.path.join(self.rd, 'verify.sh'), 'printf "fixed\\n" > value; python3 gate.py')
        result = self.measure()
        self.assertEqual(result['suite']['exitCode'], 0)
        self.assertFalse(result['suite']['passed'])
        self.assertIn('value', result['suite']['mutated'])
        self.assertEqual(council.read(os.path.join(self.wt, 'value')), 'broken\n')

    def evidence(self, text):
        root = os.path.join(self.run['room'], 'evidence', 'A')
        council.write(os.path.join(root, 'inc1/red.log'), text)
        council.write_json(os.path.join(root, 'manifest.json'), [
            {'path': 'inc1/red.log', 'criterion': 'C5', 'stage': 'inc1-red'}])
        return root

    def test_evidence_is_frozen_without_discussion_and_tampering_is_detected(self):
        source = self.evidence('red: exit 1\n')
        council.write(os.path.join(self.run['room'], 'r0', 'A.md'), 'debate must remain private')
        result = self.measure()
        published = self.cli('evidence', '--run-dir', self.rd, '--seat', 'A', '--label', 'r0')
        root = os.path.dirname(published['index'])
        self.assertEqual(published['snapshot'], result['snapshot']['commit'])
        self.assertEqual(set(os.listdir(root)), {'files', 'suite.log', 'index.json'})
        council.write(os.path.join(source, 'inc1/red.log'), 'later edit')
        self.assertEqual(council.read(os.path.join(root, 'files/inc1/red.log')), 'red: exit 1\n')
        council.write(os.path.join(root, 'files/inc1/red.log'), 'tampered')
        rejected = self.cli('evidence', '--run-dir', self.rd, '--seat', 'A', '--label', 'r0', error=True)
        self.assertIn('hash mismatch', rejected['error'])

    def test_evidence_rejects_paths_into_the_debate_or_symlinks(self):
        root = self.evidence('raw')
        for rel in ('../../r0/A.md', '/tmp/outside'):
            council.write_json(os.path.join(root, 'manifest.json'), [{'path': rel, 'criterion': 'C5', 'stage': 'red'}])
            with self.assertRaises(council.CouncilError):
                council.evidence_inputs(self.run, 'A')
        os.symlink(os.path.join(self.repo, 'PLAN.md'), os.path.join(root, 'link'))
        council.write_json(os.path.join(root, 'manifest.json'), [{'path': 'link', 'criterion': 'C5', 'stage': 'red'}])
        with self.assertRaises(council.CouncilError):
            council.evidence_inputs(self.run, 'A')

    def test_delivery_rejects_missing_application_and_unrelated_edits(self):
        report = self.report()
        missing = self.delivery(report)
        self.assertEqual(missing['status'], 'incomplete')
        self.assertIn('reviewed snapshot differs: value', missing['problems'])
        self.put('value', 'fixed\n')
        self.put('unchanged', 'unexpected')
        self.assertIn('unrelated file changed: unchanged', self.delivery(report)['problems'])

    def test_delivery_without_a_configured_gate_records_that_it_was_not_run(self):
        council.write(os.path.join(self.rd, 'verify.sh'), '')
        report = self.report()
        self.put('value', 'fixed\n')
        result = self.delivery(report)
        self.assertEqual(result['status'], 'delivered')
        self.assertFalse(result['validation']['ran'])

    def test_delivery_checks_actual_main_checkout_and_declared_handoff_bytes(self):
        # A broad scanner can pass in the isolated checkout and fail beside factory scratch.
        council.write(os.path.join(self.wt, 'gate.py'), council.read(os.path.join(self.wt, 'gate.py')) +
                      '\nassert not Path(".council").exists() or Path("SCAN_SCOPE").read_text() == "project only"\n')
        report = self.report()
        for name in ('value', 'gate.py'):
            self.put(name, council.read(os.path.join(self.wt, name)))
        self.assertEqual(self.delivery(report)['status'], 'incomplete')
        self.put('SCAN_SCOPE', 'project only')
        self.put('PLAN.md', 'next milestone\n')
        manifest = {'adjustments': [{'path': 'SCAN_SCOPE', 'reason': 'Exclude factory scratch; project coverage checked',
                                    'sha256': hashlib.sha256(b'project only').hexdigest()}],
                    'handoffs': [{'path': 'PLAN.md', 'reason': 'Advance original local plan',
                                 'sha256': hashlib.sha256(b'next milestone\n').hexdigest()}]}
        path = os.path.join(self.rd, 'delivery-manifest.json')
        council.write_json(path, manifest)
        delivered = self.delivery(report, path)
        self.assertEqual(delivered['status'], 'delivered', delivered)
        self.put('PLAN.md', 'changed after review')
        self.assertEqual(self.delivery(report, path)['status'], 'incomplete')

    def test_delivery_detects_gate_mutations_and_preserves_deletions_and_modes(self):
        os.remove(os.path.join(self.wt, 'unchanged'))
        os.chmod(os.path.join(self.wt, 'value'), 0o755)
        report = self.report()
        self.put('value', 'fixed\n')
        self.assertEqual(self.delivery(report)['status'], 'incomplete')
        os.remove(os.path.join(self.repo, 'unchanged'))
        os.chmod(os.path.join(self.repo, 'value'), 0o755)
        self.assertEqual(self.delivery(report)['status'], 'delivered')
        # A gate that mutates only the actual delivery must also be caught after it exits 0.
        council.write(os.path.join(self.wt, 'gate.py'), council.read(os.path.join(self.wt, 'gate.py')) +
                      '\nif Path(".council").exists(): Path("PLAN.md").write_text("changed")\n')
        report = self.report()
        self.put('gate.py', council.read(os.path.join(self.wt, 'gate.py')))
        mutated = self.delivery(report)
        self.assertEqual(mutated['status'], 'incomplete')
        self.assertIn('project checks changed delivery files', mutated['problems'])

    def test_invalid_verification_profiles_fail_clearly(self):
        for bad in ({'env': {'INVALID-NAME': 'x'}}, {'env': {'X': False}}, {'other': {}}, []):
            council.write_json(os.path.join(self.rd, 'verification.json'), bad)
            with self.assertRaises(council.CouncilError):
                council.verification_settings(self.run)

    def test_delivery_refuses_changed_settings_or_replaced_snapshot_and_clears_old_success(self):
        report = self.report()
        self.put('value', 'fixed\n')
        self.assertEqual(self.delivery(report)['status'], 'delivered')
        self.config({'FACTORY_GATE': 'other'})
        refused = self.cli('verify-delivery', '--run-dir', self.rd, '--result', report, error=True)
        self.assertIn('settings changed', refused['error'])
        self.assertEqual(json.loads(council.read(os.path.join(self.rd, 'delivery.json')))['status'], 'incomplete')
        self.config({'FACTORY_GATE': 'serial'})
        council.write(os.path.join(self.wt, 'value'), 'unreviewed change')
        self.measure()
        refused = self.cli('verify-delivery', '--run-dir', self.rd, '--result', report, error=True)
        self.assertIn('snapshot no longer matches', refused['error'])

    def test_evidence_root_cannot_redirect_to_the_debate(self):
        os.makedirs(os.path.join(self.run['room'], 'evidence'), exist_ok=True)
        os.symlink(os.path.join(self.run['room'], 'r0'), os.path.join(self.run['room'], 'evidence', 'A'))
        with self.assertRaises(council.CouncilError):
            council.evidence_inputs(self.run, 'A')


    def test_short_private_temp_directories_retry_owned_socket_failure_and_keep_logs(self):
        marker = self.path('ipc-attempt')
        unrelated = self.path('amp-parallel-ipc-unrelated')
        council.write(unrelated, 'keep')
        council.write(os.path.join(self.wt, 'ipc.py'),
                      'import os, pathlib, sys\n'
                      'tmp = os.environ["TMPDIR"]\n'
                      'assert len(tmp.encode()) < 40\n'
                      'assert tmp == os.environ["TMP"] == os.environ["TEMP"]\n'
                      f'marker = pathlib.Path({marker!r})\n'
                      'if not marker.exists():\n'
                      '    marker.write_text(tmp)\n'
                      '    pathlib.Path(tmp, "amp-parallel-ipc-stale").touch()\n'
                      '    print("SocketException: Could not create server unix://" + tmp + "/test.sock")\n'
                      '    sys.exit(1)\n'
                      'assert marker.read_text() != tmp\n'
                      'assert not pathlib.Path(marker.read_text()).exists()\n'
                      'print("recovered")\n')
        council.write(os.path.join(self.rd, 'verify.sh'), 'python3 ipc.py')
        self.config({'TMPDIR': self.path('very-long-' * 15)})
        result = self.measure()['suite']
        self.assertTrue(result['passed'])
        self.assertEqual(len(result['attempts']), 2)
        self.assertEqual(result['attempts'][0]['failureKind'], 'infrastructure')
        self.assertIn('recovered', result['tail'])
        for attempt in result['attempts']:
            self.assertTrue(os.path.exists(attempt['log']))
            self.assertFalse(os.path.exists(attempt['env']['TMPDIR']))
        self.assertEqual(council.read(unrelated), 'keep')

    def test_socket_failure_classification_is_narrow_and_retry_is_bounded(self):
        for message, count, kind in [('SocketException: application TCP failure', 1, ''),
                                     ('AF_UNIX path too long', 1, ''),
                                     ('test expects socket path too long at $TMPDIR/test.sock', 1, ''),
                                     ('SocketException: Could not create server unix:///unrelated/test.sock', 1, ''),
                                     ('test expects SocketException: Could not create server unix://$TMPDIR/test.sock', 1, ''),
                                     ('OSError: AF_UNIX path too long: $TMPDIR/test.sock', 2, 'infrastructure'),
                                     ('Uncaught Amp\\Socket\\SocketException: Could not create server unix://$TMPDIR/test.sock', 2, 'infrastructure')]:
            council.write(os.path.join(self.rd, 'verify.sh'), f'echo "{message}"; exit 1')
            result = self.measure()['suite']
            self.assertFalse(result['passed'])
            self.assertEqual(len(result['attempts']), count)
            self.assertEqual(result['failureKind'], kind)

    def test_verification_falls_back_to_writable_sandbox_temp_and_cleans_only_its_directory(self):
        # Both current sandbox TMPDIR and explicit verification roots can be the
        # only writable location. No live host/model invocation is needed to test it.
        temporary = council.tempfile.TemporaryDirectory
        for source in ('sandbox', 'configured'):
            root = self.path(source + '-long-root-' * 8)
            os.makedirs(root)
            council.write(os.path.join(root, 'keep'), 'unrelated')
            calls = []

            def create(*args, **kwargs):
                calls.append(kwargs['dir'])
                if kwargs['dir'] != root:
                    raise PermissionError(13, 'sandbox denied')
                return temporary(*args, **kwargs)

            self.config({'FACTORY_GATE': 'serial', **({'TMPDIR': root} if source == 'configured' else {})})
            with mock.patch.dict(os.environ, {'TMPDIR': root if source == 'sandbox' else '/unwritable'}), \
                    mock.patch.object(council.tempfile, 'TemporaryDirectory', side_effect=create):
                result = council.suite(self.run, self.wt, source, 'A', 10)
            self.assertTrue(result['passed'], result)
            actual = result['attempts'][0]['env']['TMPDIR']
            self.assertEqual(os.path.dirname(actual), root)
            self.assertFalse(os.path.exists(actual))
            self.assertEqual(os.listdir(root), ['keep'])
            self.assertIn('/tmp', calls)

    def test_no_writable_temp_root_is_infrastructure_without_executing_the_gate(self):
        with mock.patch.object(council.tempfile, 'TemporaryDirectory', side_effect=PermissionError(13, 'sandbox denied')), \
                mock.patch.object(council, 'run_shell') as execute:
            result = council.suite(self.run, self.wt, 'denied', 'A', 10)
        execute.assert_not_called()
        self.assertFalse(result['ran'])
        self.assertFalse(result['passed'])
        self.assertEqual(result['failureKind'], 'infrastructure')
        self.assertIn('No writable verification temporary root', council.read(result['log']))

    def test_apply_checks_snapshot_hash_and_preserves_untracked_baseline(self):
        report = self.report()
        result = self.cli('apply', '--run-dir', self.rd)
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(council.git('write-tree', cwd=self.repo).strip(), result['snapshotTree'])
        self.assertEqual(council.read(os.path.join(self.repo, 'value')), 'fixed\n')
        self.assertEqual(self.delivery(report)['status'], 'delivered')

    def test_delivery_helpers_refuse_a_summary_even_when_named_result_json(self):
        report = self.report()
        summary = json.loads(council.read(report))
        summary['artifactType'] = 'dark-factory-summary'
        council.write_json(report, summary)
        for command in ('apply', 'verify-delivery'):
            rejected = self.cli(command, '--run-dir', self.rd, '--result', report, error=True)
            self.assertIn('informational only', rejected['error'])
        self.assertEqual(council.read(os.path.join(self.repo, 'value')), 'broken\n')
        self.assertFalse(self.git('diff', '--cached'))

    def test_apply_refuses_dirty_checkout_and_untracked_collisions_before_mutation(self):
        council.write(os.path.join(self.wt, 'new.txt'), 'reviewed')
        self.report()
        self.put('new.txt', 'local user file')
        refused = self.cli('apply', '--run-dir', self.rd, error=True)
        self.assertIn('local file', refused['error'])
        self.assertEqual(council.read(os.path.join(self.repo, 'value')), 'broken\n')
        self.put('value', 'user edits')
        refused = self.cli('apply', '--run-dir', self.rd, error=True)
        self.assertIn('clean tracked checkout', refused['error'])
        self.assertEqual(council.read(os.path.join(self.repo, 'new.txt')), 'local user file')

    def test_diagnostic_delivery_runs_gate_without_promoting_incomplete_readiness(self):
        report = self.report()
        value = json.loads(council.read(report))
        value['final']['readiness'] = {'state': 'incomplete', 'blocked': [], 'incomplete': ['Replay evidence missing.']}
        council.write_json(report, value)
        self.put('value', 'fixed\n')
        result = self.cli('verify-delivery', '--run-dir', self.rd, '--result', report,
                          '--diagnostic-reason', 'Investigate missing replay evidence.', '--max-wait', '20')
        self.assertEqual(result['status'], 'verified-diagnostic')
        self.assertTrue(result['validation']['passed'])
        self.assertEqual(result['factoryReadiness']['state'], 'incomplete')
        self.assertFalse(os.path.exists(os.path.join(self.rd, 'delivery.json')))
        self.assertTrue(os.path.exists(os.path.join(self.rd, 'delivery-diagnostic.json')))
        self.assertIn('readiness has not passed', self.cli('verify-delivery', '--run-dir', self.rd, '--result', report, error=True)['error'])


    def test_shared_file_replays_separate_changed_and_preserved_selections(self):
        council.write(os.path.join(self.wt, 'tests/changed.py'),
                      'import sys\nfrom pathlib import Path\n'
                      'if sys.argv[1] == "changed": assert Path("value").read_text() == "fixed\\n"\n'
                      'else: assert Path("unchanged").read_text() == "preserve\\n"\n')
        mapping = [{'file': 'tests/changed.py', 'command': 'python3 tests/changed.py ' + purpose,
                    'checkIds': [purpose], 'fixtures': []} for purpose in ('changed', 'preserved')]
        records = self.replay_measure(mapping)['replay']['records']
        self.assertEqual([(r['side'], r['checkIds'][0], r['passed']) for r in records],
                         [('base', 'changed', False), ('final', 'changed', True),
                          ('base', 'preserved', True), ('final', 'preserved', True)])

    def test_infrastructure_retry_cannot_hide_gate_mutation(self):
        council.write(os.path.join(self.rd, 'verify.sh'),
                      'echo corrupt > value; echo "OSError: AF_UNIX path too long: $TMPDIR/test.sock"; exit 1')
        result = self.measure()['suite']
        self.assertFalse(result['passed'])
        self.assertEqual(len(result['attempts']), 1)
        self.assertIn('value', result['mutated'])


if __name__ == '__main__':
    unittest.main()
