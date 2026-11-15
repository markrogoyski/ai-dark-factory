"""The helper's git calls stay in the repositories it names, whatever repository location the caller
exports, as git does to a pre-commit hook; real git and temporary repositories, no models."""

import json
import os
import re
import subprocess
import unittest
from unittest import mock

from test_council import CLI, TmpDirCase, council


class GitEnvironment(TmpDirCase):
    def setUp(self):
        super().setUp()
        self.outer = self.make_repo('outer')
        self.repo = self.make_repo('repo')
        # What a pre-commit hook in a linked worktree of `outer` exports, plus a work tree.
        self.leak = {'GIT_DIR': os.path.join(self.outer, '.git'), 'GIT_WORK_TREE': self.outer,
                     'GIT_INDEX_FILE': os.path.join(self.outer, '.git', 'index'), 'GIT_PREFIX': ''}
        self.before = self.outer_state()

    def make_repo(self, name):
        path = self.path(name)
        os.makedirs(path)
        for args in (('init', '-q'), ('config', 'user.name', 't'), ('config', 'user.email', 't@t')):
            council.git(*args, cwd=path)
        council.write(os.path.join(path, 'f'), name + '\n')
        council.git('add', 'f', cwd=path)
        council.git('commit', '-qm', 'init', cwd=path)
        return path

    def outer_state(self):
        with open(os.path.join(self.outer, '.git', 'index'), 'rb') as f:
            index = f.read()
        return index, council.git('worktree', 'list', '--porcelain', cwd=self.outer), \
            council.git('for-each-ref', cwd=self.outer)

    def tearDown(self):
        self.assertEqual(self.outer_state(), self.before, 'the outer repository was touched')

    def test_the_list_is_gits_local_variables_and_matches_the_node_runtime(self):
        local = set(council.git('rev-parse', '--local-env-vars').split())
        self.assertEqual(local - {'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'}, set(council.GIT_REPO_ENV))
        engine = council.read(os.path.join(os.path.dirname(CLI), '..', 'lib', 'engine.mjs'))
        listed = re.search(r'export const GIT_REPO_ENV = \[(.*?)\]', engine, re.S).group(1)
        self.assertEqual(re.findall(r"'(GIT_\w+)'", listed), list(council.GIT_REPO_ENV))
        makefile = council.read(os.path.join(os.path.dirname(CLI), '..', '..', '..', 'Makefile'))
        unexported = re.search(r'^unexport ((?:.*\\\n)*.*)$', makefile, re.M).group(1)
        self.assertEqual(re.findall(r'GIT_\w+', unexported), list(council.GIT_REPO_ENV))

    def test_in_process_git_ignores_an_inherited_repository(self):
        for leak in (self.leak, {'GIT_INDEX_FILE': '.git/index', 'GIT_PREFIX': ''}):
            with self.subTest(leak=sorted(leak)), mock.patch.dict(os.environ, leak):
                wt = self.path('wt-' + str(len(leak)))
                council.git('worktree', 'add', '-q', '--detach', wt, 'HEAD', cwd=self.repo)
                self.assertEqual(council.read(os.path.join(wt, 'f')), 'repo\n')
                # An explicit env built from git_env keeps its own index.
                env = dict(council.git_env(), GIT_INDEX_FILE=self.path('scratch-index'))
                council.git('read-tree', 'HEAD', cwd=wt, env=env)
                self.assertTrue(os.path.exists(self.path('scratch-index')))
                self.assertNotIn('GIT_DIR', council.git_env())

    def test_cli_and_the_processes_it_starts_ignore_an_inherited_repository(self):
        env = dict(os.environ, **self.leak, COUNCIL_JOB_POLL='0.01')
        r = subprocess.run([CLI, 'init', '--repo', self.repo, '--seats', 'A', '--run-id', 'g'],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        run = json.loads(r.stdout.strip().splitlines()[-1])
        wt = run['worktrees']['A']
        self.assertEqual(council.read(os.path.join(wt, 'f')), 'repo\n')
        # A non-factory gate inherits the helper's environment; record what git sees from there.
        council.write(os.path.join(run['runDir'], 'verify.sh'),
                      'env | grep -E "^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_PREFIX)=" > "$GATE_ENV" || true; git rev-parse --show-toplevel > "$GATE_TOP"')
        council.write(os.path.join(wt, 'f'), 'changed\n')
        gate_env, gate_top = self.path('gate-env'), self.path('gate-top')
        r = subprocess.run([CLI, 'measure', '--run-dir', run['runDir'], '--seat', 'A', '--label', 'r0', '--max-wait', '20'],
                           env=dict(env, GATE_ENV=gate_env, GATE_TOP=gate_top), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        measured = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(council.git('show', f'{measured["snapshot"]["ref"]}:f', cwd=self.repo), 'changed\n')
        self.assertEqual(council.read(gate_env), '')
        self.assertNotEqual(os.path.realpath(council.read(gate_top).strip()), self.outer)


if __name__ == '__main__':
    unittest.main()
