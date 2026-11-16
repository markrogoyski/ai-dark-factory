"""OpenRouter seats in the helper: the endpoint environment, the seat's own Claude configuration
directory, the key kept out of every file, cleanup, preflight and failure classes. The Claude CLI is
a stub (fixtures/openrouter_claude_stub.py) and HTTP is patched: nothing here opens a socket.
"""

import contextlib
import hashlib
import io
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.request
from unittest import mock

from test_council import CLI, council  # noqa: E402
import openrouter_fixtures as fx  # noqa: E402
from dark_factory_cli import jobs, providers, retro, sandbox  # noqa: E402
from dark_factory_cli import setup as df_setup  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
STUB = os.path.join(HERE, 'fixtures', 'openrouter_claude_stub.py')
SENTINEL = 'sk-or-v1-SENTINEL0123456789abcdef'
MODEL = 'deepseek/deepseek-v4-pro'
UNSET = 'unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL OPENROUTER_API_KEY\n'
SCHEMA = {'type': 'object', 'properties': {'ok': {'type': 'boolean'}}, 'required': ['ok']}
ENDPOINT_VARS = ('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
                 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
                 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'CLAUDE_ENV_FILE')


class Rig(unittest.TestCase):
    """A git repository with an initialised run, the stub as `claude` on PATH, and the key set."""
    run_id = '20261116-000000'

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = os.path.realpath(tmp.name)
        self.repo = os.path.join(self.root, 'repo')
        self.bin = os.path.join(self.root, 'bin')
        os.makedirs(self.repo)
        os.makedirs(self.bin)
        shutil.copy(STUB, os.path.join(self.bin, 'claude'))
        os.chmod(os.path.join(self.bin, 'claude'), 0o755)
        self.log = os.path.join(self.root, 'stub.jsonl')
        self.env = {**os.environ, 'PATH': self.bin + os.pathsep + os.environ.get('PATH', ''), 'OPENROUTER_API_KEY': SENTINEL,
                    'CLAUDE_CONFIG_DIR': os.path.join(self.root, 'parent-claude'), 'STUB_LOG': self.log,
                    'STUB_FIXTURES': fx.FIXTURES, 'COUNCIL_RETRY_WAIT': '0', 'COUNCIL_JOB_POLL': '0.02',
                    'COUNCIL_TRANSCRIPT_WAIT': '0', 'DARK_FACTORY_KEEP_AWAKE': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
        self.env.pop('DARK_FACTORY_PIN', None)
        for args in (['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']):
            subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True)
        council.write(os.path.join(self.repo, 'a.txt'), 'a\n')
        subprocess.run(['git', 'add', '.'], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-qm', 'base'], cwd=self.repo, check=True, capture_output=True)
        self.run = self.cli('init', '--repo', self.repo, '--seats', 'A,B', '--run-id', self.run_id)
        self.run_dir = self.run['runDir']
        self.prompt = os.path.join(self.root, 'prompt.md')
        council.write(self.prompt, f'Check it\n<<<OUTPUT_SCHEMA\n{json.dumps(SCHEMA)}\nOUTPUT_SCHEMA>>>\n')

    def cli(self, *argv, env=None):
        r = subprocess.run([sys.executable, CLI, *argv], env=env or self.env, capture_output=True, text=True, timeout=120)
        self.outputs.append(r.stdout + r.stderr)
        return json.loads(r.stdout.strip().split('\n')[-1])

    @property
    def outputs(self):
        if not hasattr(self, '_outputs'):
            self._outputs = []
        return self._outputs

    def seat_run(self, job, seat='A', vendor='openrouter', extra=(), env=None, cwd=None, fresh=False, writable=None):
        argv = ['seat-run', '--run-dir', self.run_dir, '--vendor', vendor, '--seat', seat, '--job', job, '--model', MODEL if vendor == 'openrouter' else 'sonnet',
                '--effort', 'high', '--sandbox', 'workspace-write', '--cwd', cwd or self.run['worktrees']['A'],
                *[x for w in (writable if writable is not None else [self.run['room']]) for x in ('--writable', w)],
                '--prompt-file', self.prompt, '--no-transcript', '--max-wait', '30', *(['--fresh'] if fresh else []), *extra]
        result = self.cli(*argv, env=env)
        while result.get('status') == 'running':
            result = self.cli('wait', '--run-dir', self.run_dir, '--job', job, '--max-wait', '30', env=env)
        return result

    def calls(self):
        return [json.loads(l) for l in council.read(self.log).split('\n') if l] if os.path.exists(self.log) else []

    def seat_dir(self, key, root=None):
        return os.path.join(root or self.run_dir, 'openrouter', key)


class OpenRouterEnvironment(Rig):
    def test_child_environment_and_stable_config_dir(self):
        for job, extra in (('r0-A', ['--config-key', 'A']), ('r1-A', ['--config-key', 'A']), ('final2-A', ['--config-key', 'A']),
                           ('r2-A', ['--config-key', 'A', '--config-root', self.run_dir]),
                           ('panel-or1-x-r1', ['--config-key', 'panel-or1-x']), ('panel-or1-x-r2', ['--config-key', 'panel-or1-x']),
                           ('r0-B', ['--config-key', 'B'])):
            seat = 'B' if job == 'r0-B' else job if job.startswith('panel') else 'A'
            result = self.seat_run(job, seat=seat, extra=extra, fresh=job.startswith('panel'))
            self.assertEqual(result['status'], 'done', result)
        calls = {c['job']: c for c in self.calls()}
        a = self.seat_dir('A')
        for job in ('r0-A', 'r1-A', 'final2-A', 'r2-A'):
            env = calls[job]['env']
            self.assertEqual(env['ANTHROPIC_BASE_URL'], 'https://openrouter.ai/api')
            self.assertEqual(env['ANTHROPIC_API_KEY'], '')
            for var in ('ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'):
                self.assertEqual(env[var], MODEL)
            self.assertEqual(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], '1')
            self.assertEqual(env['CLAUDE_CONFIG_DIR'], os.path.join(a, 'config'), job)
            self.assertEqual(env['CLAUDE_ENV_FILE'], os.path.join(a, 'bash-env.sh'))
            self.assertEqual(calls[job]['tokenSha256'], hashlib.sha256(SENTINEL.encode()).hexdigest())
            self.assertFalse(calls[job]['hasOpenrouterKey'])
            self.assertTrue(calls[job]['configExists'])
            self.assertEqual(calls[job]['configMode'], '0o700')
            argv = calls[job]['argv']
            self.assertEqual(argv[argv.index('--model') + 1], MODEL)
        self.assertIn('--resume', calls['r1-A']['argv'], 'the second turn resumes the seat session in the same directory')
        self.assertEqual(council.read(os.path.join(a, 'bash-env.sh')), UNSET)
        panel = {calls[j]['env']['CLAUDE_CONFIG_DIR'] for j in ('panel-or1-x-r1', 'panel-or1-x-r2')}
        self.assertEqual(panel, {os.path.join(self.seat_dir('panel-or1-x'), 'config')})
        self.assertEqual(calls['r0-B']['env']['CLAUDE_CONFIG_DIR'], os.path.join(self.seat_dir('B'), 'config'))
        for writable in (self.run['room'], os.path.join(self.run_dir, 'wt'), self.run['worktrees']['A'], os.path.join(self.run_dir, 'tmp', 'claude-r0-A')):
            self.assertFalse(providers.overlaps(a, writable), writable)
        for line in council.read(os.path.join(self.run_dir, 'jobs', 'r0-A', 'spec.json')).split('\n'):
            self.assertNotIn(SENTINEL, line)

    def test_host_config_root(self):
        host = os.path.join(self.repo, '.council', 'host-abc123')
        os.makedirs(host)
        self.run_dir = os.path.join(self.repo, '.council', 'host-abc123-council')
        os.makedirs(os.path.join(self.run_dir, 'jobs'))
        council.write(os.path.join(host, 'host.json'), '{}')
        cwd = os.path.join(host, 'scratch', 'x')
        os.makedirs(cwd)
        result = self.seat_run('host-1-checker', seat='host-1-checker', cwd=cwd, writable=[], fresh=True,
                               extra=['--config-key', 'role-checker', '--config-root', host])
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.calls()[-1]['env']['CLAUDE_CONFIG_DIR'], os.path.join(host, 'openrouter', 'role-checker', 'config'))
        os.unlink(os.path.join(host, 'host.json'))
        refused = self.seat_run('host-2-checker', seat='host-2-checker', cwd=cwd, writable=[], fresh=True,
                                extra=['--config-key', 'role-checker', '--config-root', host])
        self.assertEqual(refused, {'status': 'error', 'error': '--config-root must be the run directory or its Codex host run directory'})

    def test_refusals(self):
        bad_root = self.seat_run('r0-A', extra=['--config-root', os.path.join(self.root, 'elsewhere')])
        self.assertEqual(bad_root['error'], '--config-root must be the run directory or its Codex host run directory')
        bad_key = self.seat_run('r0-A', extra=['--config-key', '../x'])
        self.assertEqual((bad_key['status'], bad_key['error']), ('error', 'invalid --config-key: ../x'))
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, 'openrouter')), 'nothing is made for a refused key')
        for writable, cwd in (([self.run_dir], None), ([], self.run_dir)):
            r = self.seat_run('r0-A', writable=writable, cwd=cwd)
            self.assertEqual(r['error'], f"an OpenRouter seat's Claude configuration directory {self.seat_dir('A')} overlaps a directory the seat can write ({self.run_dir})")
        for value in (None, ''):
            env = dict(self.env)
            env.pop('OPENROUTER_API_KEY')
            if value is not None:
                env['OPENROUTER_API_KEY'] = value
            r = self.seat_run('r0-A', env=env)
            self.assertEqual(r, {'status': 'error', 'error': "OPENROUTER_API_KEY is not set: an OpenRouter seat reads its key from the helper's environment"})
        self.assertEqual(self.calls(), [], 'no refused turn started Claude')

    def test_link_refusals(self):
        """A configuration path that is a symbolic link, or is reached through one, is refused before
        anything is created or changed through it, at seat-run and again when the job starts."""
        work = self.run['worktrees']['A']
        outside = os.path.join(self.root, 'outside')
        os.makedirs(outside)
        council.write(os.path.join(outside, 'kept.sh'), 'echo kept\n')
        os.chmod(outside, 0o755)
        a = self.seat_dir('A')
        cases = (
            ('config', os.path.join(a, 'config'), work),
            ('seat', a, work),
            ('openrouter', os.path.dirname(a), outside),
            ('env file', os.path.join(a, 'bash-env.sh'), os.path.join(outside, 'kept.sh')),
        )
        for name, link, target in cases:
            shutil.rmtree(os.path.dirname(a), ignore_errors=True)
            if os.path.islink(os.path.dirname(a)):
                os.unlink(os.path.dirname(a))
            os.makedirs(os.path.dirname(link), exist_ok=True)
            os.symlink(target, link)
            before = sorted(os.listdir(work)), sorted(os.listdir(outside)), oct(os.stat(work).st_mode), oct(os.stat(outside).st_mode)
            r = self.seat_run('r0-A', extra=['--config-key', 'A'])
            reached = link if name != 'openrouter' else link
            self.assertEqual(r['status'], 'error', name)
            self.assertIn("an OpenRouter seat's Claude configuration path ", r['error'], name)
            self.assertIn(' is a symbolic link or is reached through one', r['error'], name)
            self.assertTrue(r['error'].split('path ', 1)[1].startswith(reached), (name, r['error']))
            self.assertEqual((sorted(os.listdir(work)), sorted(os.listdir(outside)), oct(os.stat(work).st_mode), oct(os.stat(outside).st_mode)), before, name)
            self.assertEqual(council.read(os.path.join(outside, 'kept.sh')), 'echo kept\n')
            os.unlink(link)
        self.assertEqual(self.calls(), [], 'no refused turn started Claude')
        # Swapped for a link after seat-run accepted it: the job refuses before Claude starts.
        shutil.rmtree(os.path.dirname(a), ignore_errors=True)
        self.assertEqual(self.seat_run('r0-A', extra=['--config-key', 'A'])['status'], 'done')
        spec = json.loads(council.read(os.path.join(self.run_dir, 'jobs', 'r0-A', 'spec.json')))
        shutil.rmtree(spec['claudeConfigDir'])
        os.symlink(work, spec['claudeConfigDir'])
        jd = os.path.join(self.run_dir, 'jobs', 'r9-A')
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'p')
        spec.update(job='r9-A')
        with mock.patch.dict(os.environ, self.env):
            jobs.run_job_spec(jd, spec)
        status = json.loads(council.read(os.path.join(jd, 'status.json')))
        self.assertEqual(status['status'], 'error')
        self.assertIn(f"configuration path {spec['claudeConfigDir']} is a symbolic link", status['error'])
        self.assertEqual(len(self.calls()), 1, 'Claude did not start for the swapped directory')


class OpenRouterMirrorsClaude(unittest.TestCase):
    """The same spec as an ordinary Claude seat and as an OpenRouter seat: the same command, and
    the environment differs by exactly the endpoint variables."""

    def test_command_and_environment(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        jd = os.path.join(root, 'jobs', 'r0-A')
        os.makedirs(jd)
        council.write_json(os.path.join(jd, 'schema.json'), SCHEMA)
        config = os.path.join(root, 'openrouter', 'A', 'config')
        parent = {'CLAUDE_CONFIG_DIR': '/parent/claude', 'OPENROUTER_API_KEY': SENTINEL, 'PATH': os.environ.get('PATH', '')}
        with mock.patch.dict(os.environ, parent, clear=True):
            for sandbox_mode in ('read-only', 'workspace-write'):
                for session in (None, 'session-1'):
                    for schema in (True, False):
                        for pin in (None, {'root': '/pin'}):
                            base = {'runDir': root, 'seat': 'A', 'job': 'r0-A', 'effort': 'high', 'sandbox': sandbox_mode, 'cwd': root,
                                    'writable': [os.path.join(root, 'room')], 'fresh': False, 'timeout': 5, 'schema': schema, **({'pin': pin} if pin else {})}
                            claude = dict(base, kind='claude', model='sonnet')
                            routed = dict(base, kind='openrouter', model=MODEL, endpoint='https://openrouter.ai/api', claudeConfigDir=config)
                            c_cmd, c_cwd = providers.claude_command(jd, claude, session)
                            o_cmd, o_cwd = providers.claude_command(jd, routed, session)
                            i = c_cmd.index('--model')
                            self.assertEqual(c_cmd[:i + 1] + c_cmd[i + 2:], o_cmd[:i + 1] + o_cmd[i + 2:])
                            self.assertEqual((c_cmd[i + 1], o_cmd[i + 1], c_cwd), ('sonnet', MODEL, o_cwd))
                            plain = providers.claude_env(claude)
                            self.assertEqual(plain['CLAUDE_CONFIG_DIR'], '/parent/claude')
                            self.assertFalse(any(k.startswith('ANTHROPIC_') for k in plain))
                            routed_env = providers.endpoint_env(routed, SENTINEL)
                            expect = {k: v for k, v in plain.items() if k != 'OPENROUTER_API_KEY'}
                            self.assertEqual({k: v for k, v in routed_env.items() if k not in ENDPOINT_VARS},
                                             {k: v for k, v in expect.items() if k not in ENDPOINT_VARS})
                            self.assertEqual(set(routed_env) - set(expect), set(ENDPOINT_VARS) - {'CLAUDE_CONFIG_DIR'})
                            self.assertEqual(routed_env['CLAUDE_CONFIG_DIR'], config)

    def test_claude_runs_without_redaction(self):
        seen = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        jd = os.path.join(root, 'jobs', 'r0-A')
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'p')

        def fake(provider, jd_, cmd, cwd, stdin, stdout, stderr, env, timeout, **kw):
            seen.append((kw.get('redact'), stdout.mode, stderr.mode, env.get('ANTHROPIC_BASE_URL')))
            return 1, False
        spec = {'kind': 'claude', 'runDir': root, 'seat': 'A', 'job': 'r0-A', 'model': 'sonnet', 'effort': 'high', 'sandbox': 'read-only',
                'cwd': root, 'writable': [], 'fresh': True, 'timeout': 5, 'schema': False}
        with mock.patch.object(providers, 'run_cli', fake):
            providers.run_claude_job(jd, spec)
        self.assertEqual(seen, [(None, 'w', 'w', None)])


class OpenRouterKeyNeverLeaks(Rig):
    PLAN = {'r1-A': 'auth-leak', 'r3-A': 'crash', 'r4-A': 'config-leak', 'r5-A': 'worktree-leak'}

    def test_key_stays_out_of_every_file(self):
        env = dict(self.env, STUB_PROBE='1', STUB_PLAN=json.dumps(self.PLAN))
        results = {job: self.seat_run(job, extra=['--config-key', 'A'], env=env) for job in ('r0-A', 'r1-A', 'r3-A', 'r4-A', 'r5-A')}
        self.assertEqual(results['r0-A']['status'], 'done', results['r0-A'])
        calls = self.calls()
        for c in calls:
            if c['mode'] == 'crash':
                continue
            self.assertEqual(c['tokenSha256'], hashlib.sha256(SENTINEL.encode()).hexdigest())
            self.assertEqual(c['bashEnv'], dict.fromkeys(('ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENROUTER_API_KEY'), False), c['job'])
            self.assertFalse(c['bashSawToken'])
            for mid in ('midOut', 'midErr'):
                self.assertEqual(c[mid], {'secret': False, 'mask': True}, (c['job'], mid))
        self.assertEqual((results['r1-A']['errorClass'], results['r1-A']['status']), ('auth', 'error'))
        self.assertIn('[OPENROUTER_API_KEY]', results['r1-A']['error'])
        self.assertEqual(results['r3-A']['status'], 'error')
        leak = "the OpenRouter key appeared in 1 file(s) the turn wrote; they were redacted and the turn's result was discarded"
        for job, path in (('r4-A', os.path.join(self.seat_dir('A'), 'config', 'projects', 'x', 's.jsonl')),
                          ('r5-A', os.path.join(self.run['worktrees']['A'], 'leak.txt'))):
            self.assertEqual((results[job]['status'], results[job]['errorClass'], results[job]['error']), ('error', 'leak', leak), job)
            self.assertNotIn('retried', results[job])
            self.assertEqual(sum(1 for c in calls if c['job'] == job), 1, f'{job} ran once')
            self.assertIn('[OPENROUTER_API_KEY]', council.read(path))
        # A turn past its deadline, run as the job child runs it (a 1-second deadline instead of minutes).
        jd = os.path.join(self.run_dir, 'jobs', 'r2-A')
        spec = json.loads(council.read(os.path.join(self.run_dir, 'jobs', 'r0-A', 'spec.json')))
        spec.update(job='r2-A', timeout=1)
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'p')
        shutil.copy(os.path.join(self.run_dir, 'jobs', 'r0-A', 'schema.json'), jd)
        with mock.patch.dict(os.environ, dict(env, STUB_PLAN=json.dumps({'r2-A': 'sleep'}))):
            jobs.run_job_spec(jd, spec)
        timed = json.loads(council.read(os.path.join(jd, 'status.json')))
        self.assertEqual((timed['status'], timed.get('errorClass')), ('error', 'timeout'), timed)
        usage = self.cli('usage', '--run-dir', self.run_dir, '--no-claude')
        metrics = retro.fill_metrics(council.load_run(self.run_dir), {'metrics': {'tokens': None, 'elapsedMs': 1}})
        texts = [json.dumps(results), json.dumps(usage), json.dumps(metrics), json.dumps(timed), *self.outputs]
        for c in calls:
            texts.append(json.dumps(c['argv']))
        for text in texts:
            self.assertNotIn(SENTINEL, text)
        for base in (self.run_dir, self.run['worktrees']['A']):
            for d, _, files in os.walk(base):
                for name in files:
                    path = os.path.join(d, name)
                    if os.path.islink(path):
                        continue
                    with open(path, 'rb') as f:
                        self.assertNotIn(SENTINEL.encode(), f.read(), path)

    def test_leak_wins_over_runner_failure(self):
        """The runner raising after Claude wrote the key into its transcript still ends the turn as a
        leak, with the copy redacted; the same failure without a leak is reported as before."""
        seat = os.path.join(self.run_dir, 'seats', 'A')
        os.makedirs(seat, exist_ok=True)
        leak = "the OpenRouter key appeared in 1 file(s) the turn wrote; they were redacted and the turn's result was discarded"
        for job, leaks in (('r6-A', True), ('r7-A', False)):
            jd = os.path.join(self.run_dir, 'jobs', job)
            os.makedirs(jd)
            council.write(os.path.join(jd, 'prompt.md'), 'p')
            config = os.path.join(self.seat_dir('A'), 'config')
            os.makedirs(config, exist_ok=True)
            os.chmod(config, 0o700)
            transcript = os.path.join(config, 'projects', 'x', f'{job}.jsonl')
            council.write(os.path.join(seat, 'claude-usage-total.json'), '{')   # an interrupted write: invalid JSON

            def fake(provider, jd_, cmd, cwd, stdin, stdout, stderr, env, timeout, **kw):
                if leaks:
                    council.write(transcript, json.dumps({'token': env['ANTHROPIC_AUTH_TOKEN']}))
                sid = cmd[cmd.index('--session-id') + 1]
                stdout.write(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': sid, 'result': 'done', 'usage': {}}).encode())
                stdout.flush()
                return 0, False
            spec = {'kind': 'openrouter', 'runDir': self.run_dir, 'seat': 'A', 'job': job, 'model': MODEL, 'effort': 'high', 'sandbox': 'read-only',
                    'cwd': self.run_dir, 'writable': [], 'fresh': True, 'timeout': 5, 'schema': False, 'endpoint': 'https://openrouter.ai/api', 'claudeConfigDir': config}
            with mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': SENTINEL}), mock.patch.object(providers, 'run_cli', fake):
                jobs.run_job_spec(jd, spec)
            text = council.read(os.path.join(jd, 'status.json'))
            status = json.loads(text)
            self.assertNotIn(SENTINEL, text)
            if leaks:
                self.assertEqual((status['status'], status['errorClass'], status['error']), ('error', 'leak', leak))
                self.assertNotIn('retried', status)
                self.assertEqual(council.read(transcript), json.dumps({'token': '[OPENROUTER_API_KEY]'}))
            else:
                self.assertEqual(status['status'], 'error')
                self.assertTrue(status['error'].startswith('JSONDecodeError: '), status)
                self.assertNotEqual(status.get('errorClass'), 'leak')

    def scan_turn(self, job, files, dir_modes=None, owned=True, scan_error=None):
        """One successful in-process turn whose fake CLI writes `files` ({path: (text, mode)}) and then sets
        `dir_modes` ({dir: mode}). owned=False makes the scan see every file as another user's. Returns
        the status, the fake's call count and each path's (text, mode) afterwards, read as the owner."""
        dir_modes = dir_modes or {}
        jd = os.path.join(self.run_dir, 'jobs', job)
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'p')
        config = os.path.join(self.seat_dir('A'), 'config')
        os.makedirs(config, exist_ok=True)
        os.chmod(config, 0o700)
        calls = []

        def fake(provider, jd_, cmd, cwd, stdin, stdout, stderr, env, timeout, **kw):
            calls.append(1)
            for path, (text, mode) in files.items():
                os.makedirs(os.path.dirname(path), exist_ok=True)
                council.write(path, text.replace('{key}', env['ANTHROPIC_AUTH_TOKEN']))
                os.chmod(path, mode)
            for d, mode in dir_modes.items():
                os.chmod(d, mode)
            sid = cmd[cmd.index('--session-id') + 1]
            stdout.write(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': sid, 'result': 'done', 'usage': {}}).encode())
            stdout.flush()
            return 0, False
        spec = {'kind': 'openrouter', 'runDir': self.run_dir, 'seat': 'A', 'job': job, 'model': MODEL, 'effort': 'high', 'sandbox': 'read-only',
                'cwd': self.run_dir, 'writable': [], 'fresh': True, 'timeout': 5, 'schema': False, 'endpoint': 'https://openrouter.ai/api', 'claudeConfigDir': config}
        patches = [mock.patch.dict(os.environ, {'OPENROUTER_API_KEY': SENTINEL}), mock.patch.object(providers, 'run_cli', fake)]
        if not owned:
            patches.append(mock.patch.object(providers.os, 'geteuid', lambda: os.getuid() + 1))
        if scan_error:
            patches.append(mock.patch.object(providers, 'leak_scan', side_effect=scan_error))
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            jobs.run_job_spec(jd, spec)
        modes = {}
        for d, mode in dir_modes.items():
            modes[d] = stat.S_IMODE(os.stat(d).st_mode)
            os.chmod(d, 0o700)
        after = {}
        for path in files:
            mode = stat.S_IMODE(os.stat(path).st_mode)
            os.chmod(path, 0o600)
            after[path] = (council.read(path), mode)
        text = council.read(os.path.join(jd, 'status.json'))
        self.assertNotIn(SENTINEL, text)
        return json.loads(text), len(calls), after, modes

    def test_unwritable_and_unreadable_copies(self):
        """A copy the scan cannot read or rewrite at first is still found and redacted, with the file's
        and directory's modes given back; one it cannot reach at all fails the turn, never passes it."""
        config = os.path.join(self.seat_dir('A'), 'config')
        leak = "the OpenRouter key appeared in 1 file(s) the turn wrote; they were redacted and the turn's result was discarded"
        redacted = json.dumps({'token': '[OPENROUTER_API_KEY]'})
        leaked = json.dumps({'token': '{key}'})
        for i, mode in enumerate((0o400, 0o200, 0o000)):
            path = os.path.join(config, 'projects', f'm{i}', 's.jsonl')
            status, n, after, _ = self.scan_turn(f'm{i}-A', {path: (leaked, mode)})
            self.assertEqual((status['status'], status['errorClass'], status['error'], n), ('error', 'leak', leak, 1), oct(mode))
            self.assertNotIn('retried', status)
            self.assertEqual(after[path], (redacted, mode), oct(mode))
        # A directory the turn left without read or search permission.
        d = os.path.join(config, 'projects', 'locked')
        path = os.path.join(d, 's.jsonl')
        status, n, after, modes = self.scan_turn('d0-A', {path: (leaked, 0o600)}, {d: 0o000})
        self.assertEqual((status['status'], status['errorClass'], status['error'], n), ('error', 'leak', leak, 1))
        self.assertEqual((after[path], modes[d]), ((redacted, 0o600), 0o000))
        # Read-only and clean: the turn passes and the mode is unchanged.
        path = os.path.join(config, 'projects', 'clean', 's.jsonl')
        status, n, after, _ = self.scan_turn('c0-A', {path: ('{"token": "none"}', 0o400)})
        self.assertEqual((status['status'], status.get('errorClass')), ('done', None), status)
        self.assertEqual(after[path], ('{"token": "none"}', 0o400))
        # Not this process's: a read-only copy cannot be redacted, an unreadable file cannot be checked,
        # and both fail the turn; a writable copy beside them is still redacted and counted.
        ro, hidden, rw = (os.path.join(config, 'projects', 'foreign', n_) for n_ in ('ro.jsonl', 'hidden.jsonl', 'rw.jsonl'))
        status, n, after, _ = self.scan_turn('f0-A', {ro: (leaked, 0o400)}, owned=False)
        self.assertEqual((status['status'], status['errorClass'], n), ('error', 'leak', 1))
        self.assertEqual(status['error'], f"the OpenRouter key scan could not read or redact 1 path(s) the turn could have written ({ro}); the turn's result was discarded")
        self.assertEqual(after[ro], (json.dumps({'token': SENTINEL}), 0o400))
        os.remove(ro)
        status, n, after, _ = self.scan_turn('f1-A', {hidden: ('{"token": "none"}', 0o000), rw: (leaked, 0o600)}, owned=False)
        self.assertEqual((status['status'], status['errorClass'], n), ('error', 'leak', 1))
        self.assertEqual(status['error'], f"the OpenRouter key scan could not read or redact 1 path(s) the turn could have written ({hidden}); 1 other file(s) held the key and were redacted; the turn's result was discarded")
        self.assertEqual(after[rw], (redacted, 0o600))
        self.assertNotIn('retried', status)
        # A scan that stops part-way proves nothing either.
        status, n, _, _ = self.scan_turn('s0-A', {}, scan_error=RuntimeError('stopped'))
        self.assertEqual((status['status'], status['errorClass'], n), ('error', 'leak', 1))
        self.assertEqual(status['error'], "the OpenRouter key scan could not read or redact 1 path(s) the turn could have written (the scan stopped: RuntimeError); the turn's result was discarded")

    def test_claude_control_keeps_bytes(self):
        env = dict(self.env, STUB_PROBE='1', STUB_TOKEN=SENTINEL)
        result = self.seat_run('r0-A', vendor='claude', env=env)
        self.assertEqual(result['status'], 'done', result)
        call = self.calls()[-1]
        jd = os.path.join(self.run_dir, 'jobs', 'r0-A')
        for name, key in (('out.json', 'stdoutSha256'), ('stderr.txt', 'stderrSha256')):
            with open(os.path.join(jd, name), 'rb') as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), call[key], name)


class OpenRouterCleanup(unittest.TestCase):
    def make(self, run_id, host=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        repo = os.path.join(root, 'repo')
        os.makedirs(repo)
        for args in (['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']):
            subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True)
        council.write(os.path.join(repo, 'a.txt'), 'a\n')
        subprocess.run(['git', 'add', '.'], cwd=repo, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-qm', 'base'], cwd=repo, check=True, capture_output=True)
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
        env.pop('DARK_FACTORY_PIN', None)
        cli = lambda *a: json.loads(subprocess.run([sys.executable, CLI, *a], env=env, capture_output=True, text=True, cwd=repo).stdout.strip().split('\n')[-1])
        run = cli('init', '--repo', repo, '--seats', 'A,B', '--run-id', run_id)
        subprocess.run(['git', 'update-ref', f'refs/council/{run_id}/A-r0', 'HEAD'], cwd=repo, check=True)
        council_dir = os.path.join(repo, '.council')
        for path in ('openrouter/A/config/projects/x/s.jsonl', 'openrouter/panel-or1-x/config/a.json'):
            council.write(os.path.join(run['runDir'], path), 'transcript\n')
        if host:
            for name in ('host.json', 'events.jsonl', 'openrouter/role-setup/config/projects/y/t.jsonl'):
                council.write(os.path.join(council_dir, host, name), '{}\n')
            council.write(os.path.join(council_dir, 'host-abc', 'host.json'), '{}')
            council.write(os.path.join(council_dir, 'host-abc', 'openrouter', 'k'), 'x')
            council.write(os.path.join(council_dir, 'host-abc123-feature', 'run.json'), '{}')
            council.write(os.path.join(council_dir, 'host-abc123-feature', 'openrouter', 'k'), 'x')
            council.write(os.path.join(council_dir, 'host-zzz999', 'openrouter', 'k'), 'x')
        return run, council_dir, cli

    def test_host_run(self):
        for all_ in (False, True):
            run, council_dir, cli = self.make('host-abc123-council', host='host-abc123')
            out = cli('cleanup', '--run-dir', run['runDir'], *(['--all'] if all_ else []))
            self.assertEqual(out, {'status': 'ok', 'worktreesRemoved': 2, 'refsDeleted': 1, 'kept': None if all_ else run['room'], 'openrouterConfigsRemoved': 2})
            host = os.path.join(council_dir, 'host-abc123')
            self.assertFalse(os.path.exists(os.path.join(run['runDir'], 'openrouter')))
            self.assertFalse(os.path.exists(os.path.join(host, 'openrouter')))
            self.assertTrue(os.path.isfile(os.path.join(host, 'host.json')) and os.path.isfile(os.path.join(host, 'events.jsonl')))
            self.assertEqual(os.path.exists(run['runDir']), not all_)
            if not all_:
                self.assertTrue(os.path.isdir(run['room']) and os.path.isfile(os.path.join(run['runDir'], 'run.json')))
            for decoy in ('host-abc', 'host-abc123-feature', 'host-zzz999'):
                self.assertTrue(os.path.isdir(os.path.join(council_dir, decoy, 'openrouter')), decoy)

    def test_claude_host_run(self):
        for all_ in (False, True):
            run, _, cli = self.make('20261116-000000')
            council.write(os.path.join(run['runDir'], 'openrouter', 'A', 'config', 'x'), 'x')
            shutil.rmtree(os.path.join(run['runDir'], 'openrouter', 'panel-or1-x'))
            out = cli('cleanup', '--run-dir', run['runDir'], *(['--all'] if all_ else []))
            self.assertEqual(out['openrouterConfigsRemoved'], 1)
            self.assertFalse(os.path.exists(os.path.join(run['runDir'], 'openrouter')))

    def restore(self, *dirs):
        """Give the test's own directories back their owner bits so the temporary tree can go."""
        def undo():
            for d in dirs:
                if os.path.isdir(d) and not os.path.islink(d):
                    os.chmod(d, 0o700)
        self.addCleanup(undo)

    def test_restrictive_modes(self):
        # The key search hands a directory its mode back, so a seat's 0500 or 0000 directory is what
        # cleanup meets; it must still be deleted, not reported deleted.
        for all_ in (False, True):
            for mode in (0o500, 0o000):
                run, council_dir, cli = self.make('host-abc123-council', host='host-abc123')
                config = os.path.join(run['runDir'], 'openrouter', 'A', 'config')
                locked = [os.path.join(config, 'projects', 'x'), os.path.join(config, 'projects'),
                          os.path.join(run['runDir'], 'openrouter', 'panel-or1-x', 'config'),
                          os.path.join(council_dir, 'host-abc123', 'openrouter', 'role-setup', 'config', 'projects', 'y')]
                self.restore(*locked)
                for d in locked:
                    os.chmod(d, mode)
                out = cli('cleanup', '--run-dir', run['runDir'], *(['--all'] if all_ else []))
                self.assertEqual(out, {'status': 'ok', 'worktreesRemoved': 2, 'refsDeleted': 1,
                                       'kept': None if all_ else run['room'], 'openrouterConfigsRemoved': 2}, (all_, oct(mode)))
                self.assertFalse(os.path.lexists(os.path.join(run['runDir'], 'openrouter')), (all_, oct(mode)))
                self.assertFalse(os.path.lexists(os.path.join(council_dir, 'host-abc123', 'openrouter')), (all_, oct(mode)))
                self.assertTrue(os.path.isfile(os.path.join(council_dir, 'host-abc123', 'host.json')))

    def test_undeletable_reported(self):
        # A configuration directory that can't be deleted (here its parent is read-only) fails the
        # cleanup and is named, while the rest of the cleanup still happens.
        for all_ in (False, True):
            run, council_dir, _ = self.make('host-abc123-council', host='host-abc123')
            self.restore(run['runDir'])
            os.chmod(run['runDir'], 0o500)
            env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
            env.pop('DARK_FACTORY_PIN', None)
            p = subprocess.run([sys.executable, CLI, 'cleanup', '--run-dir', run['runDir'], *(['--all'] if all_ else [])],
                               env=env, capture_output=True, text=True, cwd=os.path.dirname(council_dir))
            out = json.loads(p.stdout.strip().split('\n')[-1])
            left = os.path.join(run['runDir'], 'openrouter')
            self.assertEqual(p.returncode, 1)
            self.assertEqual(out, {'status': 'error', 'worktreesRemoved': 2, 'refsDeleted': 1, 'kept': None if all_ else run['room'],
                                   'openrouterConfigsRemoved': 1, 'openrouterConfigsRemaining': [left],
                                   'error': f'could not delete 1 OpenRouter configuration directory ({left})'})
            self.assertTrue(os.path.isdir(left))
            self.assertEqual(os.listdir(left), [])
            self.assertFalse(os.path.lexists(os.path.join(council_dir, 'host-abc123', 'openrouter')))

    def test_remove_owned_tree(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        outside = os.path.join(root, 'outside')
        council.write(os.path.join(outside, 'keep.txt'), 'keep')
        os.chmod(outside, 0o500)
        tree = os.path.join(root, 'openrouter')
        locked = os.path.join(tree, 'A', 'config', 'projects', 'x')
        council.write(os.path.join(locked, 's.jsonl'), 'transcript')
        os.symlink(outside, os.path.join(tree, 'A', 'link'))
        self.restore(outside, locked)
        os.chmod(locked, 0o000)
        # A directory another user owns is never touched: deletion fails and is reported.
        with mock.patch.object(df_setup.os, 'geteuid', return_value=os.geteuid() + 1):
            self.assertFalse(df_setup.remove_owned_tree(tree))
        self.assertEqual(stat.S_IMODE(os.lstat(locked).st_mode), 0o000)
        self.assertTrue(df_setup.remove_owned_tree(tree))
        self.assertFalse(os.path.lexists(tree))
        # The symlink went, not what it pointed to, and the target's mode is unchanged.
        self.assertTrue(os.path.isfile(os.path.join(outside, 'keep.txt')))
        self.assertEqual(stat.S_IMODE(os.lstat(outside).st_mode), 0o500)


class OpenRouterConfigRoots(Rig):
    """seat-run accepts a configuration root exactly when cleanup empties it for that run."""
    run_id = 'host-abc123-council'

    def test_roots_match_cleanup(self):
        council_dir = os.path.join(self.repo, '.council')
        host = os.path.join(council_dir, 'host-abc123')
        cases = {}
        for run_id in ('host-abc123-council', 'host-abc123', '20261116-000000', 'host-abc123-feature'):
            run_dir = os.path.join(council_dir, run_id)
            os.makedirs(os.path.join(run_dir, 'jobs'), exist_ok=True)
            cases[run_id] = run_dir
        os.symlink(host, os.path.join(self.root, 'link'))
        n = 0
        for state in ('host.json', 'none', 'dir'):
            meta = os.path.join(host, 'host.json')
            if os.path.isdir(meta):
                os.rmdir(meta)
            elif os.path.exists(meta):
                os.unlink(meta)
            if state == 'host.json':
                council.write(meta, '{}')
            elif state == 'dir':
                os.makedirs(meta)
            for run_id, run_dir in cases.items():
                emptied = sandbox.openrouter_roots(run_dir)
                candidates = [None, run_dir, host, os.path.join(council_dir, 'host-abc'), os.path.join(council_dir, 'host'),
                              os.path.join(self.root, 'link'), council_dir, os.path.join(run_dir, 'jobs')]
                for root in candidates:
                    n += 1
                    self.run_dir = run_dir
                    cwd = os.path.join(self.root, f'cwd{n}')
                    os.makedirs(cwd)
                    r = self.seat_run(f'j{n}', seat=f's{n}', cwd=cwd, writable=[], fresh=True,
                                      extra=['--config-key', 'A', *(['--config-root', root] if root else [])])
                    accepted = r['status'] == 'done'
                    real = os.path.realpath(root or run_dir)
                    self.assertEqual(accepted, real in emptied, (state, run_id, root, r))
                    if not accepted:
                        self.assertEqual(r['error'], '--config-root must be the run directory or its Codex host run directory')
                want = {os.path.realpath(run_dir)} | ({os.path.realpath(host)} if state == 'host.json' and run_id.startswith('host-abc123-') else set())
                self.assertEqual(set(emptied), want, (state, run_id))


class OpenRouterPreflightChecks(unittest.TestCase):
    def preflight(self, vendors, key=SENTINEL, key_status=200, models=(MODEL, 'moonshotai/kimi-k2'), boom=False, claude=True):
        calls = []

        def http_get(url, token=None, timeout=20):
            calls.append((url, token))
            if boom:
                raise OSError('boom')
            if url.endswith('/v1/key'):
                return key_status, '{}'
            return 200, json.dumps({'data': [{'id': m} for m in models]})
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bin_dir = os.path.join(tmp.name, 'bin')
        os.makedirs(bin_dir)
        if claude:
            council.write(os.path.join(bin_dir, 'claude'), '#!/bin/sh\necho "2.1.325 (Claude Code)"\n')
            os.chmod(os.path.join(bin_dir, 'claude'), 0o755)
        env = {'PATH': bin_dir + os.pathsep + '/usr/bin:/bin', 'CLAUDE_CONFIG_DIR': os.path.join(tmp.name, 'claude'), 'CODEX_HOME': os.path.join(tmp.name, 'codex')}
        if key is not None:
            env['OPENROUTER_API_KEY'] = key
        out = io.StringIO()
        refuse = mock.Mock(side_effect=AssertionError('network'))
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sandbox, 'http_get', http_get), \
                mock.patch.object(urllib.request, 'urlopen', refuse), mock.patch.object(socket.socket, 'connect', refuse), \
                contextlib.redirect_stdout(out):
            sandbox.cmd_preflight(types.SimpleNamespace(vendors=vendors))
        text = out.getvalue()
        self.assertNotIn(SENTINEL, text)
        return json.loads(text.strip().split('\n')[-1]), calls

    def test_checks(self):
        both = f'openrouter:{MODEL},openrouter:moonshotai/kimi-k2'
        ok, calls = self.preflight(both)
        self.assertEqual(ok['status'], 'ok')
        self.assertEqual(calls, [('https://openrouter.ai/api/v1/key', SENTINEL), ('https://openrouter.ai/api/v1/models', None)])
        err = lambda r, entry=f'openrouter:{MODEL}': (r[0]['status'], r[0]['vendors'][entry]['error'])
        self.assertEqual(err(self.preflight(both, claude=False)), ('error', 'claude is not on PATH'))
        self.assertEqual(err(self.preflight(both, key=None)), ('error', 'OPENROUTER_API_KEY is not set'))
        self.assertEqual(err(self.preflight(both, key='')), ('error', 'OPENROUTER_API_KEY is not set'))
        self.assertEqual(err(self.preflight(both, key_status=401)),
                         ('error', 'OpenRouter did not accept OPENROUTER_API_KEY (GET https://openrouter.ai/api/v1/key answered 401)'))
        self.assertEqual(err(self.preflight(both, key_status=500)),
                         ('error', 'OpenRouter did not accept OPENROUTER_API_KEY (GET https://openrouter.ai/api/v1/key answered 500)'))
        self.assertEqual(err(self.preflight('openrouter:deepseek/no-such-model-xyz'), 'openrouter:deepseek/no-such-model-xyz'),
                         ('error', 'OpenRouter has no model deepseek/no-such-model-xyz (GET https://openrouter.ai/api/v1/models)'))
        self.assertEqual(err(self.preflight(both, boom=True)),
                         ('error', 'OpenRouter could not be reached (GET https://openrouter.ai/api/v1/key: boom)'))
        codex_only, calls = self.preflight('codex')
        self.assertEqual(calls, [])
        with self.assertRaisesRegex(council.CouncilError, r'unknown vendor\(s\): openrouterx, openrouter:'):
            self.preflight('openrouterx,openrouter:')


class PreflightTLS(unittest.TestCase):
    """python.org's macOS Python has an empty default CA store: the preflight loads a system bundle
    instead, and never turns verification off."""

    class Store:
        def __init__(self, cas):
            self.cas, self.loaded = cas, []

        def cert_store_stats(self):
            return {'x509_ca': self.cas}

        def load_verify_locations(self, cafile=None):
            self.loaded.append(cafile)

    def context(self, cas, bundles):
        store = self.Store(cas)
        with mock.patch.object(sandbox.ssl, 'create_default_context', return_value=store):
            self.assertIs(sandbox.tls_context(bundles), store)
        return store.loaded

    def test_system_bundle_only_when_the_default_store_is_empty(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        first, second = os.path.join(tmp.name, 'a.pem'), os.path.join(tmp.name, 'b.pem')
        for path in (first, second):
            council.write(path, '')
        missing = os.path.join(tmp.name, 'missing.pem')
        self.assertEqual(self.context(0, (missing, first, second)), [first])
        self.assertEqual(self.context(140, (first,)), [])
        self.assertEqual(self.context(0, (missing,)), [])

    def test_http_get_verifies(self):
        seen = []

        class Response(io.BytesIO):
            status = 200

        def urlopen(request, timeout=None, context=None):
            seen.append(context)
            return Response(b'{}')
        with mock.patch.object(urllib.request, 'urlopen', urlopen):
            self.assertEqual(sandbox.http_get('https://openrouter.ai/api/v1/models'), (200, '{}'))
        self.assertEqual(seen[0].verify_mode, sandbox.ssl.CERT_REQUIRED)
        self.assertTrue(seen[0].check_hostname)


class OpenRouterPreflightMirror(unittest.TestCase):
    def test_claude_and_openrouter_agree(self):
        for condition in ('present', 'absent', 'version-fails', 'sandboxed'):
            with self.subTest(condition=condition):
                tmp = tempfile.TemporaryDirectory()
                self.addCleanup(tmp.cleanup)
                bin_dir = os.path.join(tmp.name, 'bin')
                os.makedirs(bin_dir)
                if condition != 'absent':
                    council.write(os.path.join(bin_dir, 'claude'), '#!/bin/sh\n' + ('exit 2\n' if condition == 'version-fails' else 'echo "2.1.325 (Claude Code)"\n'))
                    os.chmod(os.path.join(bin_dir, 'claude'), 0o755)
                env = {'PATH': bin_dir + os.pathsep + '/usr/bin:/bin', 'CLAUDE_CONFIG_DIR': os.path.join(tmp.name, 'claude'), 'OPENROUTER_API_KEY': SENTINEL}
                blocked = (lambda: 'cannot write to ~/.claude (Operation not permitted).') if condition == 'sandboxed' else (lambda: None)
                got = {}
                for entry in ('claude', 'openrouter:x'):
                    out = io.StringIO()
                    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sandbox, 'claude_blocked', blocked), \
                            mock.patch.object(sandbox, 'http_get', lambda url, token=None, timeout=20: (200, '{"data":[{"id":"x"}]}')), \
                            contextlib.redirect_stdout(out):
                        sandbox.cmd_preflight(types.SimpleNamespace(vendors=entry))
                    got[entry] = json.loads(out.getvalue().strip().split('\n')[-1])
                self.assertEqual(got['claude']['status'], got['openrouter:x']['status'])
                self.assertEqual(got['claude']['vendors']['claude'], got['openrouter:x']['vendors']['openrouter:x'])


class OpenRouterFailures(unittest.TestCase):
    """The class of an OpenRouter failure comes from the envelope's api_error_status."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = os.path.realpath(tmp.name)
        self.bin = os.path.join(self.root, 'bin')
        os.makedirs(self.bin)
        shutil.copy(STUB, os.path.join(self.bin, 'claude'))
        os.chmod(os.path.join(self.bin, 'claude'), 0o755)
        self.log = os.path.join(self.root, 'stub.jsonl')
        env = mock.patch.dict(os.environ, {'PATH': self.bin + os.pathsep + os.environ.get('PATH', ''), 'OPENROUTER_API_KEY': SENTINEL,
                                           'COUNCIL_RETRY_WAIT': '0', 'STUB_LOG': self.log, 'STUB_FIXTURES': fx.FIXTURES})
        env.start()
        self.addCleanup(env.stop)
        self.n = 0

    def run_envelope(self, data):
        self.n += 1
        job = f'r{self.n}-A'
        path = os.path.join(self.root, f'{job}.json')
        if data is not None:
            with open(path, 'wb') as f:
                f.write(data)
        jd = os.path.join(self.root, 'jobs', job)
        os.makedirs(jd)
        council.write(os.path.join(jd, 'prompt.md'), 'p')
        config = os.path.join(self.root, 'openrouter', job, 'config')
        os.makedirs(config)
        spec = {'kind': 'openrouter', 'runDir': self.root, 'seat': job, 'job': job, 'model': MODEL, 'effort': 'high', 'sandbox': 'read-only',
                'cwd': self.root, 'writable': [], 'fresh': True, 'timeout': 30, 'schema': False,
                'endpoint': 'https://openrouter.ai/api', 'claudeConfigDir': config}
        with mock.patch.dict(os.environ, {'STUB_PLAN': json.dumps({job: f'fixture:{path}' if data is not None else 'success'})}):
            jobs.run_job_spec(jd, spec)
        result = json.loads(council.read(os.path.join(jd, 'status.json')))
        calls = sum(1 for l in council.read(self.log).split('\n') if l and json.loads(l)['job'] == job)
        return result, calls

    def test_recorded(self):
        self.assertEqual(hashlib.sha256(fx.recorded(401)).hexdigest(), fx.RECORDED_SHA256[401])
        self.assertEqual(hashlib.sha256(fx.recorded(400)).hexdigest(), fx.RECORDED_SHA256[400])
        r, calls = self.run_envelope(fx.recorded(401))
        self.assertEqual((r['errorClass'], r['error'], calls, 'retried' in r),
                         ('auth', 'OpenRouter answered 401 (authentication_error): Failed to authenticate. API Error: 401 User not found.', 1, False))
        r, calls = self.run_envelope(fx.recorded(400))
        self.assertEqual((r['errorClass'], r['error'], calls),
                         ('model', 'OpenRouter answered 400 (invalid_request_error): API Error: 400 deepseek/no-such-model-xyz is not a valid model ID', 1))

    def test_derived(self):
        base = json.loads(fx.recorded(fx.DERIVED_FROM))
        for status in fx.DERIVED:
            d = fx.derived(status)
            self.assertTrue(d['label'].startswith('derived'))
            self.assertEqual({k for k in base if base[k] != d['envelope'].get(k)}, set(fx.DERIVED_FIELDS))
            self.assertEqual(set(base), set(d['envelope']))
        r, calls = self.run_envelope(fx.envelope(402))
        self.assertEqual((r['errorClass'], r['error'], calls),
                         ('quota', 'OpenRouter answered 402 (billing_error): API Error: 402 Insufficient credits. Add more using https://openrouter.ai/settings/credits', 1))
        for status in (429, 502, 503):
            r, calls = self.run_envelope(fx.envelope(status))
            self.assertEqual((r['errorClass'], calls, 'retried' in r), ('transient', 2, True), status)

    def test_status_decides_over_text(self):
        def cross(status, text):
            e = dict(json.loads(fx.recorded(401)), api_error_status=status, result=text)
            return self.run_envelope(json.dumps(e).encode())[0]['errorClass']
        self.assertEqual(cross(401, 'rate limit 429 overloaded'), 'auth')
        self.assertEqual(cross(429, 'quota exceeded'), 'transient')
        # Without an integer status, the text decides, as for any Claude seat.
        e = dict(json.loads(fx.recorded(401)))
        del e['api_error_status']
        self.assertEqual(self.run_envelope(json.dumps(e).encode())[0]['errorClass'], 'auth')

    def test_unrecognized_model_line_is_not_a_failure(self):
        r, calls = self.run_envelope(None)
        self.assertEqual((r['status'], calls), ('done', 1))


class OpenRouterUsage(Rig):
    def test_tokens_only(self):
        result = self.seat_run('r0-A', extra=['--config-key', 'A'])
        self.assertEqual(result['status'], 'done', result)
        records = [json.loads(l) for l in council.read(os.path.join(self.run_dir, 'usage.jsonl')).split('\n') if l]
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual((rec['job'], rec['seat'], rec['model'], rec['usage']), ('r0-A', 'A', MODEL, {'input_tokens': 120, 'output_tokens': 30}))
        self.assertIn('threadTotal', rec)
        self.assertIn('seconds', rec)
        usage = self.cli('usage', '--run-dir', self.run_dir, '--no-claude')
        self.assertEqual(usage['byModel'][MODEL]['input_tokens'], 120)
        metrics = retro.fill_metrics(council.load_run(self.run_dir), {'metrics': {'tokens': None, 'elapsedMs': 1}})
        self.assertEqual(metrics['metrics']['tokens']['byModel'][MODEL]['output_tokens'], 30)
        for text in (council.read(os.path.join(self.run_dir, 'usage.jsonl')), json.dumps(result), json.dumps(usage), json.dumps(metrics)):
            for word in ('cost', 'total_cost_usd', '0.35'):
                self.assertNotIn(word, text)


if __name__ == '__main__':
    unittest.main()
