"""`dark-factory cleanup` on a run without OpenRouter seats: worktrees, snapshots and refs go, the
room stays unless --all, and the output has exactly the keys it has always had."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from test_council import CLI, council  # noqa: E402


class CleanupPreserved(unittest.TestCase):
    def make(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = os.path.join(os.path.realpath(tmp.name), 'repo')
        os.makedirs(repo)
        for args in (['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']):
            subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True)
        council.write(os.path.join(repo, 'a.txt'), 'a\n')
        subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-qm', 'base'], cwd=repo, check=True, capture_output=True)
        env = {k: v for k, v in os.environ.items() if k != 'DARK_FACTORY_PIN'}
        cli = lambda *a: json.loads(subprocess.run([sys.executable, CLI, *a], env=env, capture_output=True, text=True, cwd=repo).stdout.strip().split('\n')[-1])
        run = cli('init', '--repo', repo, '--seats', 'A,B', '--run-id', 'r1')
        os.makedirs(os.path.join(run['runDir'], 'snap', 'A-r0'))
        subprocess.run(['git', 'update-ref', 'refs/council/r1/A-r0', 'HEAD'], cwd=repo, check=True)
        return repo, run, cli

    def test_without_all(self):
        repo, run, cli = self.make()
        out = cli('cleanup', '--run-dir', run['runDir'])
        self.assertEqual(out, {'status': 'ok', 'worktreesRemoved': 3, 'refsDeleted': 1, 'kept': run['room']})
        for sub in ('wt/A', 'wt/B', 'snap/A-r0'):
            self.assertFalse(os.path.exists(os.path.join(run['runDir'], sub)), sub)
        self.assertTrue(os.path.isfile(os.path.join(run['runDir'], 'run.json')) and os.path.isdir(run['room']))
        refs = subprocess.run(['git', 'for-each-ref', 'refs/council/'], cwd=repo, capture_output=True, text=True).stdout
        self.assertEqual(refs, '')

    def test_with_all(self):
        _, run, cli = self.make()
        out = cli('cleanup', '--run-dir', run['runDir'], '--all')
        self.assertEqual(out, {'status': 'ok', 'worktreesRemoved': 3, 'refsDeleted': 1, 'kept': None})
        self.assertFalse(os.path.exists(run['runDir']))


if __name__ == '__main__':
    unittest.main()
