"""Pinned gates resolve the candidate's helpers, not the frozen export's; no models."""

import json
import os
import tempfile
import unittest
from unittest import mock

from test_council import council


class GateEnvironment(unittest.TestCase):
    def test_pinned_gate_drops_frozen_bin_unless_the_gate_sets_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = os.path.join(directory, 'plugin')
            frozen = os.path.join(root, 'bin')
            os.makedirs(frozen)
            alias = os.path.join(directory, 'alias')
            os.symlink(frozen, alias)
            original = os.pathsep.join([alias, '/usr/bin', frozen])
            base = {'PATH': original, 'DARK_FACTORY_PIN': '{}'}
            self.assertEqual(council.verification_environment({'baseEnv': base, 'env': {}})['PATH'], original)
            with mock.patch.dict(os.environ, {'DARK_FACTORY_PIN': json.dumps({'mode': 'pinned', 'root': root})}):
                gate = council.verification_environment({'baseEnv': base, 'env': {}})
                self.assertEqual(gate['PATH'], '/usr/bin')
                self.assertNotIn('DARK_FACTORY_PIN', gate)
                explicit = council.verification_environment({'baseEnv': base, 'env': {'PATH': original}})
                self.assertEqual(explicit['PATH'], original)


if __name__ == '__main__':
    unittest.main()
