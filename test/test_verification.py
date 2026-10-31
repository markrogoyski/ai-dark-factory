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
        self.put('.gitignore', 'local-only\n')
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
        council.write_json(report, {'runDir': self.rd, 'final': final})
        return report

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


if __name__ == '__main__':
    unittest.main()
