"""An ordinary Claude seat's handling of OpenRouter's failure envelopes, recorded and derived.

These are what `claude -p` prints when an endpoint answers 400, 401, 402, 429, 502 or 503. A Claude
seat classifies them from the message text, as it always has; only an OpenRouter seat reads their
structured fields (test_openrouter.py). Uses only the helper's long-standing Claude provider.
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

from test_council import council  # noqa: E402
import openrouter_fixtures as fx  # noqa: E402

STUB = f'''#!{sys.executable}
import json, os, sys
sys.stdin.read()
with open(os.environ['ENVELOPE_CALLS'], 'a') as f:
    f.write('call\\n')
# The envelope as recorded, with this turn's session (Claude echoes the --session-id it was given).
with open(os.environ['ENVELOPE_FILE']) as f:
    envelope = json.load(f)
envelope['session_id'] = sys.argv[sys.argv.index('--session-id') + 1]
print(json.dumps(envelope))
sys.stderr.write('[claude-code:unrecognized_model] {{"model":"x"}}\\n')
sys.exit(1)
'''


class ClaudeSeatEnvelopes(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = os.path.realpath(tmp.name)
        self.bin = os.path.join(self.root, 'bin')
        os.makedirs(self.bin)
        os.makedirs(os.path.join(self.root, 'cwd'))
        council.write(os.path.join(self.bin, 'claude'), STUB)
        os.chmod(os.path.join(self.bin, 'claude'), 0o755)
        self.calls = os.path.join(self.root, 'calls')
        self.envelope = os.path.join(self.root, 'envelope.json')
        env = mock.patch.dict(os.environ, {'PATH': self.bin + os.pathsep + os.environ.get('PATH', ''), 'COUNCIL_RETRY_WAIT': '0',
                                           'ENVELOPE_CALLS': self.calls, 'ENVELOPE_FILE': self.envelope,
                                           'CLAUDE_CONFIG_DIR': os.path.join(self.root, 'claude-home')})
        env.start()
        self.addCleanup(env.stop)

    def run_envelope(self, status):
        council.write(self.envelope, fx.envelope(status).decode())
        if os.path.exists(self.calls):
            os.unlink(self.calls)
        job = f'r0-A-{status}'
        jd = os.path.join(self.root, 'jobs', job)
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'Do it')
        spec = {'kind': 'claude', 'runDir': self.root, 'seat': f'A{status}', 'job': job, 'model': 'sonnet', 'effort': 'high',
                'sandbox': 'read-only', 'cwd': os.path.join(self.root, 'cwd'), 'writable': [], 'fresh': True, 'timeout': 30, 'schema': False}
        council.write_json(os.path.join(jd, 'spec.json'), spec)
        council.run_job_spec(jd, spec)
        result = json.loads(council.read(os.path.join(jd, 'status.json')))
        return result, len(council.read(self.calls).split('\n')) - 1

    def test_recorded_envelopes(self):
        result, calls = self.run_envelope(401)
        self.assertEqual((result['status'], result['errorClass'], result['error'], calls, 'retried' in result),
                         ('error', 'auth', 'Failed to authenticate. API Error: 401 User not found.', 1, False))
        result, calls = self.run_envelope(400)
        self.assertEqual((result['errorClass'], result['error'], calls),
                         ('vendor', 'API Error: 400 deepseek/no-such-model-xyz is not a valid model ID', 1))

    def test_derived_envelopes(self):
        # Derived, not recorded: see openrouter_fixtures.
        for status, cls, calls in ((402, 'vendor', 1), (429, 'transient', 2), (502, 'vendor', 1), (503, 'transient', 2)):
            with self.subTest(status=status, label=fx.derived(status)['label']):
                result, n = self.run_envelope(status)
                self.assertEqual((result['status'], result['errorClass'], n), ('error', cls, calls))
                self.assertEqual(result['error'], fx.DERIVED[status][1])
                self.assertEqual('retried' in result, calls == 2)


if __name__ == '__main__':
    unittest.main()
