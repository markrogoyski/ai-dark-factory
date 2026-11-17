"""dark-factory resume-check through real processes in temporary repositories; no models.

A native Pair stop records wt/A and its snapshot ref (--record); a continuation past it checks that
nothing moved since (--answers). Every refusal leaves the repository, index, worktrees and refs
as they were.
"""

import hashlib
import json
import os
import subprocess
import unittest

from test_council import CLI, TmpDirCase, council


class Fixture(TmpDirCase):
    def make(self, name='repo'):
        """A repository with a.txt edited (unstaged) before setup, so run.json deliveryBaseline holds it."""
        repo = self.path(name)
        os.makedirs(repo)
        git = lambda *args: council.git(*args, cwd=repo)
        git('init', '-q')
        git('config', 'user.name', 'Factory test')
        git('config', 'user.email', 'factory@example.invalid')
        for path, text in (('a.txt', 'base a\n'), ('b.txt', 'base b\n'), ('c.txt', 'broken\n')):
            council.write(os.path.join(repo, path), text)
        git('add', '.')
        git('commit', '-qm', 'Initial fixture')
        council.write(os.path.join(repo, 'a.txt'), 'local edit\n')
        run = self.cli(repo, 'init', '--repo', repo, '--seats', 'A', '--run-id', 'run', '--factory')
        self.assertIn('a.txt', json.loads(council.read(os.path.join(run['runDir'], 'run.json')))['deliveryBaseline'])
        wt = run['worktrees']['A']
        council.write(os.path.join(wt, 'c.txt'), 'fixed\n')
        return repo, run['runDir'], wt, git

    def cli(self, repo, *args, code=0):
        r = subprocess.run([CLI, *args], cwd=repo, env=dict(os.environ, COUNCIL_JOB_POLL='0.01'),
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def state(self, repo, wt):
        """Everything resume-check must leave alone."""
        def files(root):
            out = {}
            for rel in council.git('ls-files', '-z', '--cached', '--others', '--exclude-standard', cwd=root).split('\0'):
                if rel and os.path.isfile(os.path.join(root, rel)):
                    with open(os.path.join(root, rel), 'rb') as f:
                        out[rel] = hashlib.sha256(f.read()).hexdigest()
            return out
        return {'head': council.git('rev-parse', 'HEAD', cwd=repo), 'index': council.git('diff', '--cached', '--binary', cwd=repo),
                'files': files(repo), 'refs': council.git('for-each-ref', cwd=repo),
                'wtHead': council.git('rev-parse', 'HEAD', cwd=wt), 'wtIndex': council.git('diff', '--cached', '--binary', cwd=wt), 'wtFiles': files(wt)}


class ResumeCheck(Fixture):
    def setUp(self):
        super().setUp()
        self.repo, self.rd, self.wt, self.git = self.make()
        self.ref = 'refs/council/run/A-base'
        self.base = self.commit_tree('base snapshot')
        self.git('update-ref', self.ref, self.base)
        self.record_path = os.path.join(self.rd, 'stops', 'Q1.json')
        self.assertEqual(self.resume('--record'), {'status': 'ok', 'reason': ''})

    def commit_tree(self, message):
        return self.git('commit-tree', 'HEAD^{tree}', '-m', message).strip()

    def resume(self, *mode, stop='Q1', snapshot='base', code=0):
        return self.cli(self.repo, 'resume-check', '--run-dir', self.rd, '--stop', stop, '--snapshot', snapshot, *mode, code=code)

    def refused(self, reason, *mode, snapshot='base'):
        before = self.state(self.repo, self.wt)
        record = council.read(self.record_path) if os.path.exists(self.record_path) else None
        result = self.resume(*(mode or ('--answers', 'h1')), snapshot=snapshot, code=1)
        self.assertEqual(result, {'status': 'refused', 'reason': reason})
        self.assertEqual(self.state(self.repo, self.wt), before, 'nothing changed')
        self.assertEqual(council.read(self.record_path) if os.path.exists(self.record_path) else None, record)

    def test_pass_and_the_record_is_kept(self):
        record = json.loads(council.read(self.record_path))
        self.assertEqual(record['snapshot'], {'ref': self.ref, 'commit': self.base})
        self.assertEqual(record['worktree']['head'], self.git('rev-parse', 'HEAD').strip())
        self.assertEqual(sorted(record['worktree']['files']), ['a.txt', 'b.txt', 'c.txt'])
        before = self.state(self.repo, self.wt)
        self.assertEqual(self.resume('--answers', 'h1'), {'status': 'ok', 'reason': ''})
        self.assertEqual(self.resume('--answers', 'h1'), {'status': 'ok', 'reason': ''}, 'the same answers again')
        self.assertEqual(self.state(self.repo, self.wt), before)
        # A replayed record turn keeps the record from the original stop, byte for byte.
        kept = council.read(self.record_path)
        council.write(os.path.join(self.wt, 'c.txt'), 'changed after the stop\n')
        self.assertEqual(self.resume('--record'), {'status': 'ok', 'reason': ''})
        self.assertEqual(council.read(self.record_path), kept)

    def test_head_moved(self):
        council.write(os.path.join(self.repo, 'b.txt'), 'committed\n')
        self.git('commit', '-qm', 'Move HEAD', '--', 'b.txt')
        self.refused('HEAD changed since setup; resume requires the original base')

    def test_tracked_change_outside_the_baseline(self):
        council.write(os.path.join(self.repo, 'b.txt'), 'edited after setup\n')
        self.refused('tracked file changed since setup: b.txt; resume requires a clean tracked checkout apart from the edits '
                     'recorded at setup (run.json deliveryBaseline); existing changes were preserved')

    def test_staged_content_with_the_working_file_as_recorded(self):
        council.write(os.path.join(self.repo, 'a.txt'), 'staged instead\n')
        self.git('add', 'a.txt')
        council.write(os.path.join(self.repo, 'a.txt'), 'local edit\n')
        self.refused('resume requires an index matching HEAD; staged changes were preserved: a.txt')

    def test_worktree_file_added(self):
        council.write(os.path.join(self.wt, 'new.txt'), 'added after the stop\n')
        self.refused('wt/A changed since stop Q1: new.txt')

    def test_worktree_file_edited(self):
        council.write(os.path.join(self.wt, 'c.txt'), 'edited after the stop\n')
        self.refused('wt/A changed since stop Q1: c.txt')

    def test_worktree_head_changed(self):
        before = council.git('rev-parse', 'HEAD', cwd=self.wt).strip()
        # The same files at a new commit: content alone would not show it.
        council.git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Commit in the worktree', cwd=self.wt)
        after = council.git('rev-parse', 'HEAD', cwd=self.wt).strip()
        self.refused(f'wt/A HEAD changed since stop Q1: {before} is now {after}')

    def test_snapshot_ref_deleted(self):
        self.git('update-ref', '-d', self.ref)
        self.refused(f'snapshot ref {self.ref} is missing')

    def test_snapshot_ref_moved_to_another_commit_with_the_same_tree(self):
        other = self.commit_tree('another snapshot of the same tree')
        self.assertEqual(self.git('rev-parse', other + '^{tree}'), self.git('rev-parse', self.base + '^{tree}'))
        self.git('update-ref', self.ref, other)
        self.refused(f'snapshot ref {self.ref} points at {other}, not {self.base} as at stop Q1')

    def test_record_at_another_snapshot(self):
        os.remove(self.record_path)
        self.git('update-ref', 'refs/council/run/A-r1', self.base)
        self.assertEqual(self.resume('--record', snapshot='r1'), {'status': 'ok', 'reason': ''})
        self.refused('stop Q1 was recorded at snapshot refs/council/run/A-r1, not refs/council/run/A-base')

    def test_other_answers_after_a_passing_check(self):
        self.assertEqual(self.resume('--answers', 'h1'), {'status': 'ok', 'reason': ''})
        self.refused('stop Q1 already continued with other answers; answer it differently in a new run', '--answers', 'h2')

    def test_record_missing(self):
        os.remove(self.record_path)
        self.refused('stop Q1 has no record in this run, so it cannot continue in place')

    def test_record_refused_without_the_snapshot_ref(self):
        os.remove(self.record_path)
        self.git('update-ref', '-d', self.ref)
        self.refused(f'snapshot ref {self.ref} is missing, so stop Q1 cannot be recorded', '--record')
        self.assertFalse(os.path.exists(self.record_path))


class ApplyParity(Fixture):
    """apply and resume-check judge the main checkout by one shared check: for the same state both
    accept or both refuse, with the same message apart from the caller's name."""

    def prepared(self, name, change):
        repo, rd, wt, git = self.make(name)
        council.write(os.path.join(rd, 'verify.sh'), 'true')
        council.write_json(os.path.join(rd, 'verification.json'), {'env': {}})
        measured = self.cli(repo, 'measure', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--max-wait', '30')
        council.write_json(os.path.join(rd, 'result.json'), {'artifactType': 'dark-factory-result', 'artifactVersion': 1, 'runDir': rd,
                                                            'final': {'snapshotRef': measured['snapshot']['ref'], 'snapshotTree': measured['snapshot']['tree'],
                                                                      'readiness': {'state': 'ready', 'blocked': [], 'incomplete': []}}})
        self.cli(repo, 'resume-check', '--run-dir', rd, '--stop', 'Q1', '--snapshot', 'r0', '--record')
        change(repo, git)
        return repo, rd

    def test_same_verdicts_and_messages(self):
        def head_moved(repo, git):
            council.write(os.path.join(repo, 'b.txt'), 'committed\n')
            git('commit', '-qm', 'Move HEAD', '--', 'b.txt')

        def staged(repo, git):
            council.write(os.path.join(repo, 'a.txt'), 'staged instead\n')
            git('add', 'a.txt')
            council.write(os.path.join(repo, 'a.txt'), 'local edit\n')

        states = {
            'clean': (lambda repo, git: None, None),
            'head': (head_moved, 'HEAD changed since setup; apply requires the original base'),
            'staged': (staged, 'apply requires an index matching HEAD; staged changes were preserved: a.txt'),
            'tracked': (lambda repo, git: council.write(os.path.join(repo, 'b.txt'), 'edited\n'),
                        'tracked file changed since setup: b.txt; apply requires a clean tracked checkout apart from the edits '
                        'recorded at setup (run.json deliveryBaseline); existing changes were preserved'),
            'baseline': (lambda repo, git: council.write(os.path.join(repo, 'a.txt'), 'edited again\n'),
                         'local file changed since setup and would not pass delivery verification: a.txt'),
        }
        for name, (change, message) in states.items():
            with self.subTest(state=name):
                repo, rd = self.prepared(f'{name}-apply', change)
                applied = self.cli(repo, 'apply', '--run-dir', rd, code=0 if message is None else 1)
                repo, rd = self.prepared(f'{name}-resume', change)
                checked = self.cli(repo, 'resume-check', '--run-dir', rd, '--stop', 'Q1', '--snapshot', 'r0', '--answers', 'h1',
                                   code=0 if message is None else 1)
                if message is None:
                    self.assertEqual(applied['status'], 'applied')
                    self.assertEqual(checked, {'status': 'ok', 'reason': ''})
                else:
                    self.assertEqual(applied, {'status': 'error', 'error': message})
                    self.assertEqual(checked, {'status': 'refused', 'reason': message.replace('apply', 'resume')})


if __name__ == '__main__':
    unittest.main()
