"""Claude provider and file-based payload integration, using a fake CLI (no models)."""

import argparse
import concurrent.futures
import importlib.machinery
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


CLI = os.path.join(os.path.dirname(__file__), '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
loader = importlib.machinery.SourceFileLoader('provider_cli', CLI)
module_spec = importlib.util.spec_from_loader('provider_cli', loader)
council = importlib.util.module_from_spec(module_spec)
loader.exec_module(council)


class ClaudeProvider(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.realpath(self.tmp.name)
        self.bin = os.path.join(self.root, 'bin')
        self.cwd = os.path.join(self.root, 'repo')
        os.makedirs(self.bin)
        os.makedirs(self.cwd)
        self.log = os.path.join(self.root, 'calls.jsonl')
        fake = os.path.join(self.bin, 'claude')
        council.write(fake, f'#!{sys.executable}\n' + '''import json, os, sys, time
if '--version' in sys.argv:
    print('Claude fake-test')
    sys.exit(0)
with open(os.environ['CLAUDE_TEST_LOG'], 'a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd(), 'prompt': sys.stdin.read(),
                        'autoMemory': os.environ.get('CLAUDE_CODE_DISABLE_AUTO_MEMORY')}) + '\\n')
time.sleep(float(os.environ.get('CLAUDE_TEST_SLEEP', '0')))
out = json.loads(os.environ['CLAUDE_TEST_RESULT'])
if isinstance(out, dict) and out.get('session_id') in ('session-1', 'session-cli'):
    flag = '--resume' if '--resume' in sys.argv else '--session-id'
    out['session_id'] = sys.argv[sys.argv.index(flag) + 1]
print(json.dumps(out))
sys.exit(int(os.environ.get('CLAUDE_TEST_EXIT', '0')))
''')
        os.chmod(fake, 0o755)
        env = mock.patch.dict(os.environ, {'PATH': self.bin + os.pathsep + os.environ.get('PATH', ''),
                                         'CLAUDE_CONFIG_DIR': os.path.join(self.root, 'claude-home'),
                                         'CLAUDE_TEST_LOG': self.log})
        env.start()
        self.addCleanup(env.stop)
        self.schema = {'type': 'object', 'properties': {'answer': {'type': 'string'}, 'turn': {'enum': ['r0-A']}},
                       'required': ['answer', 'turn'], 'additionalProperties': False}

    def spec(self, job='r0-A', **extra):
        return dict({'kind': 'claude', 'runDir': self.root, 'seat': 'A', 'job': job, 'model': 'sonnet',
                     'effort': 'high', 'sandbox': 'workspace-write', 'cwd': self.cwd,
                     'writable': [os.path.join(self.root, 'room')], 'fresh': False, 'timeout': 5, 'schema': True}, **extra)

    def run_turn(self, out=None, job='r0-A', **extra):
        if out is None:
            out = {'type': 'result', 'subtype': 'success', 'session_id': 'session-1',
                   'structured_output': {'answer': 'done', 'turn': 'r0-A'}, 'usage': {'input_tokens': 10}}
        os.environ['CLAUDE_TEST_RESULT'] = json.dumps(out)
        jd = os.path.join(self.root, 'jobs', job)
        council.write(os.path.join(jd, 'prompt.md'), 'Exact prompt\nwith a second line.\n')
        council.write_json(os.path.join(jd, 'schema.json'), self.schema)
        return council.run_claude_job(jd, self.spec(job, **extra))

    def calls(self):
        return [json.loads(line) for line in council.read(self.log).splitlines()]

    def test_structured_result_prompt_and_workspace(self):
        result = self.run_turn()
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['result'], {'answer': 'done', 'turn': 'r0-A'})
        call = self.calls()[0]
        self.assertEqual(call['cwd'], self.cwd)
        self.assertEqual(call['prompt'], 'Exact prompt\nwith a second line.\n')
        args = call['args']
        self.assertEqual(args[args.index('--add-dir') + 1], os.path.join(self.root, 'room'))
        settings = json.loads(args[args.index('--settings') + 1])
        self.assertTrue(settings['sandbox']['enabled'])
        self.assertFalse(settings['sandbox']['allowUnsandboxedCommands'])
        self.assertEqual(args[args.index('--permission-prompts') + 1], 'none')
        guidance = args[args.index('--append-system-prompt') + 1]
        self.assertIn('one simple operation per command', guidance)
        self.assertIn('Edit files with Edit, not sed -i, perl -pi or Python heredocs', guidance)
        self.assertIn('Do not use background jobs or sleep polling', guidance)
        self.assertIn('Never claim that an unrun check passed', guidance)
        self.assertFalse(any('bypass' in x.lower() or 'skip-permissions' in x for x in args if x.startswith('--')))
        self.assertEqual(json.loads(args[args.index('--json-schema') + 1]), self.schema)

    def test_read_only_has_no_shell_or_edit_tools(self):
        self.assertEqual(self.run_turn(sandbox='read-only')['status'], 'done')
        args = self.calls()[0]['args']
        self.assertEqual(args[args.index('--tools') + 1], 'Read,Glob,Grep')
        self.assertEqual(args[args.index('--permission-mode') + 1], 'plan')
        self.assertNotIn('--add-dir', args)

    def test_resume_and_fresh_contexts(self):
        self.run_turn()
        self.run_turn(job='r1-A')
        self.run_turn(job='audit-A', fresh=True)
        calls = self.calls()
        self.assertNotIn('--resume', calls[0]['args'])
        session = calls[0]['args'][calls[0]['args'].index('--session-id') + 1]
        self.assertEqual(calls[1]['args'][-2:], ['--resume', session])
        self.assertNotIn('--resume', calls[2]['args'])
        self.assertNotEqual(calls[2]['args'][-1], session, 'a fresh reviewer gets its own session')

    def test_auto_memory_is_disabled_for_new_resumed_and_read_only_turns(self):
        with mock.patch.dict(os.environ, {'CLAUDE_CODE_DISABLE_AUTO_MEMORY': '0'}):
            self.run_turn()
            self.run_turn(job='r1-A')
            self.run_turn(job='audit-A', fresh=True, sandbox='read-only')
            self.assertEqual(os.environ['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '0')
        self.assertEqual([c['autoMemory'] for c in self.calls()], ['1', '1', '1'])
        self.assertFalse(os.path.exists(os.path.join(self.root, 'claude-home', 'settings.json')))

    def test_session_change_is_an_error(self):
        session = self.run_turn()['thread']
        out = {'subtype': 'success', 'session_id': 'different', 'structured_output': {'answer': 'done', 'turn': 'r0-A'}}
        self.assertIn('did not resume', self.run_turn(out, job='r1-A')['error'])
        self.assertEqual(council.read(os.path.join(self.root, 'seats', 'A', 'claude-session')), session)

    def test_per_turn_usage_is_not_subtracted(self):
        self.run_turn()
        out = {'subtype': 'success', 'session_id': 'session-1', 'structured_output': {'answer': 'done', 'turn': 'r0-A'},
               'usage': {'input_tokens': 7, 'output_tokens': 2}}
        result = self.run_turn(out, job='r1-A')
        self.assertEqual(result['usage'], {'input_tokens': 7, 'output_tokens': 2})
        records = [json.loads(line) for line in council.read(os.path.join(self.root, 'usage.jsonl')).splitlines()]
        self.assertEqual(records[-1]['threadTotal'], {'input_tokens': 17, 'output_tokens': 2})

    def test_completed_turn_retains_denials_without_discarding_the_submission(self):
        denial = {'tool_name': 'Bash', 'tool_input': {'command': 'php probe.php; echo status'}}
        out = {'subtype': 'success', 'terminal_reason': 'completed', 'is_error': False,
               'session_id': 'session-1', 'permission_denials': [denial, denial],
               'structured_output': {'answer': 'Probe denied; result unverified.', 'turn': 'r0-A'}}
        result = self.run_turn(out)
        self.assertEqual(result['status'], 'done')
        self.assertEqual(result['result'], out['structured_output'])
        self.assertEqual(result['permissionDenials']['count'], 2)
        self.assertEqual(result['permissionDenials']['tools'], ['Bash'])
        self.assertEqual(json.loads(council.read(result['permissionDenials']['source'])), dict(out, session_id=result['thread']))
        self.assertEqual(len(self.calls()), 1, 'a denied optional probe does not trigger a retry')

    def test_denials_do_not_rescue_interrupted_stale_or_missing_outputs(self):
        good = {'subtype': 'success', 'terminal_reason': 'completed', 'session_id': 'session-1',
                'permission_denials': [{'tool_name': 'Bash'}],
                'structured_output': {'answer': 'done', 'turn': 'r0-A'}}
        cases = [
            (dict(good, terminal_reason='interrupted'), 'did not complete'),
            (dict(good, subtype='error_max_turns', errors=['turn limit']), 'turn limit'),
            (dict(good, subtype=None), 'did not complete'),
            (dict(good, structured_output={'answer': 'old', 'turn': 'stale'}), 'schema'),
            (dict(good, structured_output=None), 'schema'),
            (dict(good, session_id=None), 'session_id'),
        ]
        for index, (out, expected) in enumerate(cases):
            with self.subTest(expected=expected):
                result = self.run_turn(out, job=f'denied-{index}', fresh=True)
                self.assertEqual(result['status'], 'error')
                self.assertIn(expected, result['error'])
                self.assertEqual(result['permissionDenials']['tools'], ['Bash'])
        with mock.patch.dict(os.environ, {'CLAUDE_TEST_EXIT': '1'}):
            self.assertEqual(self.run_turn(good)['status'], 'error')

    def test_invalid_outputs_are_errors(self):
        good = {'subtype': 'success', 'session_id': 'session-1', 'structured_output': {'answer': 'done', 'turn': 'r0-A'}}
        cases = [
            (dict(good, structured_output={'answer': 'old', 'turn': 'stale'}), 'schema'),
            (dict(good, structured_output=None, result='plain text'), 'schema'),
            (dict(good, is_error=True, errors=['Not logged in']), 'Not logged in'),
            ({'result': 'missing envelope'}, 'session_id'),
            ([], 'invalid result envelope'),
        ]
        for index, (out, expected) in enumerate(cases):
            with self.subTest(expected=expected):
                result = self.run_turn(out, job=f'bad-{index}', fresh=True)
                self.assertEqual(result['status'], 'error')
                self.assertIn(expected, result['error'])

    def test_failure_before_a_session_starts_does_not_poison_the_next_attempt(self):
        self.run_turn({'is_error': True, 'errors': ['temporarily unavailable']})
        self.assertFalse(os.path.exists(os.path.join(self.root, 'seats', 'A', 'claude-session')))
        self.assertEqual(self.run_turn(job='retry')['status'], 'done')
        self.assertNotIn('--resume', self.calls()[-1]['args'])

    def test_timeout_stops_child(self):
        with mock.patch.dict(os.environ, {'CLAUDE_TEST_SLEEP': '10'}):
            result = self.run_turn(timeout=0.2)
        self.assertIn('timed out', result['error'])
        session = result['thread']
        council.uuid.UUID(session)
        self.assertEqual(council.read(os.path.join(self.root, 'seats', 'A', 'claude-session')), session)
        self.assertEqual(self.run_turn(job='recover')['thread'], session)
        self.assertEqual(self.calls()[-1]['args'][-2:], ['--resume', session])

    def test_recovery_requires_the_original_session_and_never_retries(self):
        jd = os.path.join(self.root, 'jobs', 'recover')
        spec = self.spec('recover', resumeSession='expected')
        council.write_json(os.path.join(jd, 'spec.json'), spec)
        session_file = os.path.join(self.root, 'seats', 'A', 'claude-session')
        for saved in (None, 'wrong', 'expected'):
            if saved:
                council.write(session_file, saved)
            with mock.patch.object(council, 'run_claude_job', return_value={
                    'status': 'error', 'error': 'temporarily unavailable'}) as run, \
                    mock.patch.object(council.time, 'sleep', side_effect=AssertionError('recovery retried')):
                council.cmd_job(jd)
            result = json.loads(council.read(os.path.join(jd, 'status.json')))
            self.assertEqual(result['status'], 'error')
            self.assertEqual(run.call_count, 1 if saved == 'expected' else 0)
            if saved != 'expected':
                self.assertIn('refusing to start a fresh turn', result['error'])

    def test_effort_and_plain_text_output(self):
        result = self.run_turn({'subtype': 'success', 'session_id': 'session-1', 'result': 'plain result'},
                               schema=False, effort='ultra')
        self.assertEqual(result['result'], 'plain result')
        args = self.calls()[0]['args']
        self.assertEqual(args[args.index('--effort') + 1], 'max')
        self.assertNotIn('--json-schema', args)

    def test_claude_preflight_uses_its_own_home(self):
        with mock.patch.object(council, 'emit') as emit:
            council.cmd_preflight(argparse.Namespace(vendors='claude'))
        self.assertEqual(emit.call_args.args[0]['status'], 'ok')
        self.assertEqual(emit.call_args.args[0]['vendors']['claude']['exe'], 'claude')

    def test_job_dispatch_retries_transient_failure_once(self):
        jd = os.path.join(self.root, 'jobs', 'retry')
        council.write_json(os.path.join(jd, 'spec.json'), self.spec('retry'))
        with mock.patch.object(council, 'run_claude_job', side_effect=[
            {'status': 'error', 'error': 'temporarily unavailable'}, {'status': 'done', 'result': {'answer': 'done'}},
        ]) as run, mock.patch.dict(os.environ, {'COUNCIL_RETRY_WAIT': '0'}):
            council.cmd_job(jd)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(json.loads(council.read(os.path.join(jd, 'status.json')))['status'], 'done')

    def test_prompt_file_hash_mismatch_does_not_read_transcripts(self):
        prompt = os.path.join(self.root, 'direct.md')
        council.write(prompt, 'changed')
        args = argparse.Namespace(vendor='claude', checkout=None, prompt_file=prompt, expect=council.prompt_hash('original'),
                                  no_transcript=True, transcript_wait=10)
        with mock.patch.object(council, 'payload_from_transcripts', side_effect=AssertionError('transcript access')), \
                mock.patch.object(council, 'emit') as emit:
            council.cmd_seat_run(args)
        self.assertEqual(emit.call_args.args[0]['status'], 'hash-mismatch')

    def test_retro_file_is_checked_and_saved_without_transcripts(self):
        council.write_json(os.path.join(self.root, 'run.json'), {'runDir': self.root, 'runId': 'run-1', 'repoRoot': self.cwd})
        payload = '## Run facts (data)\n\n```json\n' + json.dumps({'tier': 'simple'}) + '\n```'
        payload_file = os.path.join(self.root, 'payload.md')
        council.write(payload_file, payload)
        args = argparse.Namespace(summary=False, run_dir=self.root, facts_only=True, payload_file=payload_file,
                                  expect=council.prompt_hash(payload), transcript_wait=10, out_dir=os.path.join(self.root, 'retros'))
        with mock.patch.object(council, 'payload_from_transcripts', side_effect=AssertionError('transcript access')), \
                mock.patch.object(council, 'emit') as emit:
            council.cmd_retro(args)
        self.assertTrue(emit.call_args.args[0]['facts'])
        args.expect = 'wrong'
        with self.assertRaisesRegex(council.CouncilError, 'does not match'):
            council.cmd_retro(args)

    def test_retro_facts_preserve_unknown_elapsed_and_use_evaluator_token_shape(self):
        council.write_json(os.path.join(self.root, 'run.json'), {'runDir': self.root, 'runId': 'run-2', 'repoRoot': self.cwd})
        council.write(os.path.join(self.root, 'usage.jsonl'), '\n'.join(json.dumps(r) for r in [
            {'job': 'a', 'seat': 'a', 'model': 'gpt-6-astra', 'usage': {'input_tokens': 10, 'output_tokens': 2}},
            {'job': 'b', 'seat': 'b', 'model': 'gpt-6-astra', 'usage': {'input_tokens': 5, 'output_tokens': 1}},
        ]) + '\n')
        facts = {'tier': 'simple', 'metrics': {'elapsedMs': None, 'tokens': None, 'cost': None}}
        payload = '## Run facts (data)\n\n```json\n' + json.dumps(facts) + '\n```'
        payload_file = os.path.join(self.root, 'payload2.md')
        council.write(payload_file, payload)
        out_dir = os.path.join(self.root, 'retros2')
        args = argparse.Namespace(summary=False, run_dir=self.root, facts_only=True, payload_file=payload_file,
                                  expect=council.prompt_hash(payload), transcript_wait=10, out_dir=out_dir)
        with mock.patch.object(council, 'claude_usage', return_value={'byModel': {'claude-opus': {'messages': 3}}}), \
                mock.patch.object(council, 'emit'):
            council.cmd_retro(args)
        saved = json.loads(council.read(os.path.join(out_dir, 'run-2-' + os.path.basename(self.cwd) + '.facts.json')))['metrics']
        self.assertIsNone(saved['elapsedMs'])
        self.assertNotIn('elapsedFrom', saved)
        self.assertEqual(saved['tokens'], {'records': 5, 'byModel': {'gpt-6-astra': {'input_tokens': 15, 'output_tokens': 3}, 'claude-opus': {}}})
        self.assertIsNone(saved['cost'])

    def test_seat_run_cli_completes_and_reuses_the_same_job(self):
        out = {'type': 'result', 'subtype': 'success', 'session_id': 'session-cli',
               'structured_output': {'answer': 'done', 'turn': 'r0-A'}}
        payload = 'Do the task.\n<<<OUTPUT_SCHEMA\n' + json.dumps(self.schema) + '\nOUTPUT_SCHEMA>>>\n'
        prompt = os.path.join(self.root, 'cli-prompt.md')
        council.write(prompt, payload)
        cmd = [sys.executable, CLI, 'seat-run', '--vendor', 'claude', '--run-dir', self.root,
               '--seat', 'A', '--job', 'cli-job', '--model', 'sonnet', '--cwd', self.cwd,
               '--prompt-file', prompt, '--expect', council.prompt_hash(payload), '--no-transcript', '--max-wait', '10']
        with mock.patch.dict(os.environ, {'CLAUDE_TEST_RESULT': json.dumps(out), 'COUNCIL_JOB_POLL': '0.01'}):
            for _ in range(2):
                process = subprocess.run(cmd, text=True, capture_output=True, timeout=15)
                self.assertEqual(process.returncode, 0, process.stderr)
                result = json.loads(process.stdout)
                self.assertEqual(result['status'], 'done', result)
                self.assertEqual(result['result']['turn'], 'r0-A')
        self.assertEqual(len(self.calls()), 1)


class CodexRecovery(unittest.TestCase):
    def test_first_turn_timeout_keeps_the_streamed_thread_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.realpath(tmp)
            bin_dir = os.path.join(root, 'bin')
            os.makedirs(bin_dir)
            fake = os.path.join(bin_dir, 'codex')
            council.write(fake, f'#!{sys.executable}\n' + '''import json, sys, time
sys.stdin.read()
print(json.dumps({'type': 'thread.started', 'thread_id': 'thread-A'}), flush=True)
if 'resume' not in sys.argv:
    time.sleep(10)
with open(sys.argv[sys.argv.index('-o') + 1], 'w') as f:
    f.write('recovered')
print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 7}}))
''')
            os.chmod(fake, 0o755)
            spec = {'kind': 'codex', 'runDir': root, 'seat': 'A', 'job': 'A-r0', 'model': 'test',
                    'effort': 'high', 'sandbox': 'workspace-write', 'cwd': root,
                    'writable': [], 'fresh': False, 'timeout': 0.2, 'schema': False}
            jd = os.path.join(root, 'jobs', spec['job'])
            council.write(os.path.join(jd, 'prompt.md'), 'solve')
            with mock.patch.dict(os.environ, {'PATH': bin_dir + os.pathsep + os.environ.get('PATH', '')}):
                result = council.run_codex_job(jd, spec)
                self.assertIn('timed out', result['error'])
                self.assertEqual(result['thread'], 'thread-A')
                self.assertEqual(council.read(os.path.join(root, 'seats', 'A', 'thread')), 'thread-A')
                pid = int(council.read(os.path.join(jd, 'codex.pid')))
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
                spec.update(job='A-r0-recover', resumeSession='thread-A', sandbox='read-only', timeout=5)
                jd = os.path.join(root, 'jobs', spec['job'])
                council.write(os.path.join(jd, 'prompt.md'), 'return structured output')
                recovered = council.run_codex_job(jd, spec)
                self.assertEqual(recovered['status'], 'done')
                self.assertEqual(recovered['thread'], 'thread-A')
                self.assertEqual(recovered['result'], 'recovered')


class MeasurementProcesses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = os.path.join(self.tmp.name, 'logs', 'suite-A-r0.log')
        self.pid_path = self.log + '.pid'

    def command(self, code):
        return shlex.quote(sys.executable) + ' -c ' + shlex.quote(code)

    def test_pid_is_available_while_running_and_removed_after_completion(self):
        release = os.path.join(self.tmp.name, 'release')
        command = self.command(f'import os, time\nwhile not os.path.exists({release!r}): time.sleep(0.01)\nprint("verified")')
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(council.run_shell, command, self.tmp.name, 5, self.log)
            try:
                deadline = time.monotonic() + 3
                while not os.path.exists(self.pid_path) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(os.path.isfile(self.pid_path))
                pid = int(council.read(self.pid_path))
                self.assertTrue(council.pid_alive(pid))
                self.assertFalse(result.done())
            finally:
                council.write(release, 'continue')
            completed = result.result(timeout=5)
        self.assertEqual(completed['exitCode'], 0)
        self.assertEqual(completed['tail'], 'verified')
        self.assertFalse(os.path.exists(self.pid_path))

    def test_timeout_removes_pid_and_stops_process_group(self):
        command = self.command('import time; time.sleep(10)')
        result = council.run_shell(command, self.tmp.name, 0.05, self.log)
        self.assertTrue(result['timedOut'])
        self.assertNotEqual(result['exitCode'], 0)
        self.assertFalse(os.path.exists(self.pid_path))

    def test_wait_error_still_stops_child_and_removes_pid(self):
        child = mock.Mock(pid=123456789)
        child.wait.side_effect = [RuntimeError('wait failed'), 0]
        child.poll.return_value = None
        with mock.patch.object(council.subprocess, 'Popen', return_value=child), \
                mock.patch.object(council.os, 'killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'wait failed'):
                council.run_shell('ignored', self.tmp.name, 1, self.log)
        kill.assert_called_once_with(child.pid, council.signal.SIGKILL)
        self.assertFalse(os.path.exists(self.pid_path))


if __name__ == '__main__':
    unittest.main()
