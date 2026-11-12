"""Unit tests for the pure parts of bin/dark-factory. The scenarios in sim.mjs reach these only through
subprocess calls and a whole simulated run; here each one is a table.

    python3 -B -m unittest discover -s test -p 'test_*.py'
"""

import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')


def load():
    loader = importlib.machinery.SourceFileLoader('council_cli', CLI)
    spec = importlib.util.spec_from_loader('council_cli', loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


council = load()


class TmpDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = os.path.realpath(self._tmp.name)

    def path(self, *parts):
        return os.path.join(self.tmp, *parts)


class PromptHash(unittest.TestCase):
    def test_known_values(self):
        # The same cases as test/hash-parity.mjs, which checks them against council.js.
        for text, want in [
            ('plain ascii', '11-69939bb0'),
            ('trailing spaces and newlines   \n\n\t\n', '28-d4437e0e'),
            ('CRLF\r\nline two\r\n', '13-1acbcf20'),
            ('unicode — → … − “quotes” 中文 emoji 🎲 surrogate pair', '51-d37b6dc8'),
        ]:
            with self.subTest(text=text):
                self.assertEqual(council.prompt_hash(text), want)

    def test_length_counts_utf16_units(self):
        self.assertTrue(council.prompt_hash('🎲').startswith('2-'))     # one code point, two units

    def test_normalize(self):
        self.assertEqual(council.normalize('a\r\nb \t\n\n'), 'a\nb')
        self.assertEqual(council.normalize('  lead'), '  lead')


class SplitSchema(unittest.TestCase):
    def test_no_block(self):
        self.assertEqual(council.split_schema('just a prompt'), ('just a prompt', None))

    def test_block_is_removed_and_parsed(self):
        payload = 'before\n<<<OUTPUT_SCHEMA\n{"type": "object"}\nOUTPUT_SCHEMA>>>\nafter\n'
        prompt, schema = council.split_schema(payload)
        self.assertEqual(schema, {'type': 'object'})
        self.assertEqual(prompt, 'before\n\nafter\n')

    def test_unterminated(self):
        with self.assertRaisesRegex(council.CouncilError, 'unterminated'):
            council.split_schema('x <<<OUTPUT_SCHEMA {"a": 1}')

    def test_bad_json(self):
        with self.assertRaisesRegex(council.CouncilError, 'not valid JSON'):
            council.split_schema('<<<OUTPUT_SCHEMA\n{nope}\nOUTPUT_SCHEMA>>>')


class ExtractPayload(unittest.TestCase):
    def wrap(self, body, indent=''):
        h = council.prompt_hash(body)
        lines = [f'=====BEGIN PAYLOAD {h}=====', *body.split('\n'), f'=====END PAYLOAD {h}=====']
        return h, '\n'.join(indent + l if l else l for l in lines)

    def test_plain(self):
        h, text = self.wrap('line one\n\nline three')
        self.assertEqual(council.extract_payload('intro\n' + text + '\noutro', h), 'line one\n\nline three')

    def test_indent_is_removed(self):
        h, text = self.wrap('a\n  nested\nb', indent='    ')
        self.assertEqual(council.extract_payload(text, h), 'a\n  nested\nb')

    def test_hash_mismatch(self):
        h, text = self.wrap('the real payload')
        self.assertIsNone(council.extract_payload(text.replace('real', 'fake'), h))

    def test_missing_markers(self):
        self.assertIsNone(council.extract_payload('no markers here', '1-00000000'))

    def test_end_before_begin(self):
        h = '5-00000000'
        self.assertIsNone(council.extract_payload(f'=====END PAYLOAD {h}=====\n=====BEGIN PAYLOAD {h}=====', h))

    def test_under_indented_line(self):
        h, text = self.wrap('a\nb', indent='    ')
        self.assertIsNone(council.extract_payload(text.replace('    a', 'a'), h))


class ErrorClass(unittest.TestCase):
    def test_table(self):
        for err, want in [
            ('codex timed out after 90 min', 'timeout'),
            ('agy timed out after 5 min', 'timeout'),
            ('You exceeded your current quota', 'quota'),
            ('Selected model is at capacity right now', 'transient'),
            ('429 Too Many Requests', 'transient'),
            ('rate limit reached', 'transient'),
            ('RESOURCE_EXHAUSTED', 'transient'),
            ('Malformed function call: read_file', 'transient'),
            ('Not logged in. Please log in again', 'auth'),
            ('401 Unauthorized', 'auth'),
            ('something odd happened', 'vendor'),
            ('', 'vendor'),
            (None, 'vendor'),
        ]:
            with self.subTest(err=err):
                self.assertEqual(council.error_class(err), want)

    def test_timeout_wins_over_quota(self):
        self.assertEqual(council.error_class('timed out waiting on quota'), 'timeout')

    def test_transient_only_for_errors(self):
        self.assertTrue(council.transient({'status': 'error', 'error': 'model at capacity'}))
        self.assertFalse(council.transient({'status': 'error', 'error': 'quota used up'}))
        self.assertFalse(council.transient({'status': 'done', 'error': 'model at capacity'}))


class TurnUsage(TmpDirCase):
    def test_first_turn_is_the_whole_total(self):
        self.assertEqual(council.turn_usage(self.tmp, 't1', {'input_tokens': 100, 'output_tokens': 10}),
                         {'input_tokens': 100, 'output_tokens': 10})

    def test_resumed_turn_is_the_difference(self):
        council.turn_usage(self.tmp, 't1', {'input_tokens': 100, 'output_tokens': 10})
        self.assertEqual(council.turn_usage(self.tmp, 't1', {'input_tokens': 250, 'output_tokens': 40}),
                         {'input_tokens': 150, 'output_tokens': 30})
        self.assertEqual(council.turn_usage(self.tmp, 't1', {'input_tokens': 300, 'output_tokens': 40}),
                         {'input_tokens': 50, 'output_tokens': 0})

    def test_a_new_thread_starts_over(self):
        council.turn_usage(self.tmp, 't1', {'input_tokens': 100})
        self.assertEqual(council.turn_usage(self.tmp, 't2', {'input_tokens': 30}), {'input_tokens': 30})

    def test_a_total_that_went_down_is_not_a_running_total(self):
        council.turn_usage(self.tmp, 't1', {'input_tokens': 100})
        self.assertEqual(council.turn_usage(self.tmp, 't1', {'input_tokens': 40}), {'input_tokens': 40})

    def test_nothing_reported(self):
        self.assertEqual(council.turn_usage(self.tmp, 't1', {}), {})
        self.assertEqual(council.turn_usage(self.tmp, None, {'input_tokens': 5}), {'input_tokens': 5})
        self.assertFalse(os.path.exists(self.path('usage-total.json')))

    def test_record_usage_appends_lines(self):
        spec = {'job': 'r1-A', 'seat': 'A', 'model': 'gpt-x'}
        council.record_usage(self.tmp, spec, {'input_tokens': 3}, {'input_tokens': 9}, council.time.time())
        council.record_usage(self.tmp, spec, {'input_tokens': 4}, {'input_tokens': 13}, council.time.time())
        with open(self.path('usage.jsonl')) as f:
            rows = [json.loads(l) for l in f]
        self.assertEqual([r['usage']['input_tokens'] for r in rows], [3, 4])
        self.assertEqual(rows[1]['threadTotal'], {'input_tokens': 13})
        self.assertEqual((rows[0]['job'], rows[0]['seat'], rows[0]['model']), ('r1-A', 'A', 'gpt-x'))


class Numstat(unittest.TestCase):
    def test_counts(self):
        files, added, removed = council.parse_numstat('10\t2\tsrc/a.php\n3\t0\tREADME.md\n')
        self.assertEqual((files, added, removed), (['src/a.php', 'README.md'], 13, 2))

    def test_binary_files_count_no_lines(self):
        files, added, removed = council.parse_numstat('-\t-\timg/logo.png\n4\t1\ta.txt\n')
        self.assertEqual((files, added, removed), (['img/logo.png', 'a.txt'], 4, 1))

    def test_empty(self):
        self.assertEqual(council.parse_numstat(''), ([], 0, 0))

    def test_path_with_spaces(self):
        self.assertEqual(council.parse_numstat('1\t1\tdir/my file.txt')[0], ['dir/my file.txt'])


class AgentRole(unittest.TestCase):
    def test_table(self):
        for label, want in [
            ('setup', 'setup'), ('retro', 'retro'), ('intake', 'intake'), ('record', 'record'),
            ('audit review: astra', 'auditor'), ('check audit:A', 'checker'),
            ('check r1:A', 'checker'), ('check final2:B', 'checker'),
            ('panel r1: opus', 'panel'), ('questions r1', 'questions'),
            ('b1:A opus', 'ballot'),
            ('r0:A opus', 'seat'), ('r2:C gemini', 'seat'), ('final:B sonnet', 'seat'),
            ('final2:B sonnet', 'seat'), ('final3:B sonnet', 'seat'), ('ratify:D astra', 'seat'), ('inc2:A opus', 'seat'),
            ('audit design: opus', 'auditor'), ('reaudit correctness: astra', 'auditor'),
            ('audit correctness: astra (relay)', 'relay'),
            ('spec intent: opus', 'spec'), ('spec amend', 'spec'), ('spec coverage: astra (relay)', 'relay'), ('panel spec: opus', 'panel'),
            ('r1:A astra (relay)', 'relay'), ('panel r1: astra (relay)', 'relay'),
            ('something else', 'other'), ('', 'other'), (None, 'other'),
        ]:
            with self.subTest(label=label):
                self.assertEqual(council.agent_role(label), want)


class Facts(TmpDirCase):
    def test_facts_of(self):
        payload = '## Process notes\n\n- None\n\n## Run facts\n\n- x\n\n## Run facts (data)\n\n```json\n{"tier": "simple"}\n```'
        self.assertEqual(council.facts_of(payload), {'tier': 'simple'})
        self.assertIsNone(council.facts_of('## Run facts\n\n- x'))
        self.assertIsNone(council.facts_of('## Run facts (data)\n\n```json\n{nope}\n```'))
        self.assertIsNone(council.facts_of(None))

    def test_summary(self):
        def save(name, obj):
            with open(os.path.join(self.tmp, name), 'w') as f:
                json.dump(obj, f)
        self.assertIn('No factory facts', council.retro_summary(self.tmp))
        save('a.facts.json', {'tier': 'simple', 'chosenBy': 'intake', 'readiness': 'ready', 'turns': {'claude': 6}, 'escalation': None, 'overTierHints': []})
        save('b.facts.json', {'tier': 'feature', 'chosenBy': 'intake', 'readiness': 'ready', 'turns': {'claude': 40},
                              'escalation': {'from': 'simple', 'to': 'feature', 'trigger': 'design-finding'}, 'overTierHints': []})
        save('c.facts.json', {'tier': 'fix', 'chosenBy': 'pinned', 'readiness': 'blocked', 'turns': {'claude': 20}, 'escalation': None,
                              'overTierHints': ['every seat wrote the same change in round 0']})
        save('broken.facts.json.txt', {})
        out = council.retro_summary(self.tmp)
        self.assertIn('3 factory run(s)', out)
        self.assertIn('simple: 2 run(s), chosen by intake 2', out)
        self.assertIn('escalated: 1 (design-finding -> feature 1)', out)
        self.assertIn('fix: 1 run(s), chosen by pinned 1', out)
        self.assertIn('hints the tier was too high: every seat wrote the same change in round 0 1', out)


class FitsSchema(unittest.TestCase):
    SCHEMA = {'type': 'object', 'required': ['summary', 'turn'], 'additionalProperties': False,
              'properties': {'summary': {'type': 'string'}, 'turn': {'enum': ['r1-A-0badc0de']}, 'note': {'type': 'string'}}}

    def test_fits(self):
        self.assertTrue(council.fits_schema(self.SCHEMA, {'summary': 's', 'turn': 'r1-A-0badc0de'}))
        self.assertTrue(council.fits_schema(self.SCHEMA, {'summary': 's', 'turn': 'r1-A-0badc0de', 'note': 'n'}))

    def test_missing_required(self):
        self.assertFalse(council.fits_schema(self.SCHEMA, {'summary': 's'}))

    def test_a_previous_turn_tag(self):
        self.assertFalse(council.fits_schema(self.SCHEMA, {'summary': 's', 'turn': 'r0-A-11111111'}))

    def test_extra_property_when_closed(self):
        self.assertFalse(council.fits_schema(self.SCHEMA, {'summary': 's', 'turn': 'r1-A-0badc0de', 'extra': 1}))
        open_schema = dict(self.SCHEMA, additionalProperties=True)
        self.assertTrue(council.fits_schema(open_schema, {'summary': 's', 'turn': 'r1-A-0badc0de', 'extra': 1}))

    def test_not_an_object(self):
        for result in (None, 'text', ['a'], 3):
            self.assertFalse(council.fits_schema(self.SCHEMA, result))


class HomeBlocked(TmpDirCase):
    def test_writable(self):
        self.assertIsNone(council.home_blocked(self.tmp, 'Codex'))
        self.assertEqual(os.listdir(self.tmp), [], 'the probe file is removed')

    def test_missing_directory_is_created_on_request(self):
        home = self.path('new', 'home')
        self.assertIsNone(council.home_blocked(home, 'Codex', create=True))
        self.assertTrue(os.path.isdir(home))

    def test_missing_directory_is_an_error_otherwise(self):
        with self.assertRaisesRegex(council.CouncilError, 'does not exist'):
            council.home_blocked(self.path('absent'), 'agy')

    @unittest.skipIf(os.geteuid() == 0, 'root can write anywhere')
    def test_read_only_directory_names_the_vendor(self):
        home = self.path('ro')
        os.mkdir(home, 0o555)
        try:
            msg = council.home_blocked(home, 'agy')
        finally:
            os.chmod(home, 0o755)
        self.assertIn('cannot write to', msg)
        self.assertIn('agy needs to run outside it', msg)


class SettleExistingJob(TmpDirCase):
    def make_job(self, spec, status=None):
        jd = self.path('jobs', 'k')
        os.makedirs(jd)
        council.write_json(os.path.join(jd, 'spec.json'), spec)
        if status:
            council.write_json(os.path.join(jd, 'status.json'), status)
        return jd

    def settle(self, jd, decide):
        emitted = []
        with mock.patch.object(council, 'emit', emitted.append), \
                mock.patch.object(council, 'wait_job', lambda jd, key, max_wait: {'status': 'waited', 'job': key}):
            answered = council.settle_existing_job(jd, 'k', 5, decide)
        return answered, emitted

    def test_no_directory(self):
        self.assertEqual(self.settle(self.path('jobs', 'absent'), lambda o, s: 'wait'), (False, []))

    def test_wait(self):
        jd = self.make_job({'hash': 'h'}, {'status': 'done'})
        seen = []
        answered, emitted = self.settle(jd, lambda old, state: seen.append((old, state)) or 'wait')
        self.assertEqual((answered, emitted), (True, [{'status': 'waited', 'job': 'k'}]))
        self.assertEqual(seen, [({'hash': 'h'}, {'status': 'done'})])

    def test_emit_a_dict(self):
        jd = self.make_job({}, {'status': 'done'})
        answered, emitted = self.settle(jd, lambda old, state: dict(state, reused=True))
        self.assertEqual((answered, emitted), (True, [{'status': 'done', 'reused': True}]))

    def test_archive_when_stale(self):
        jd = self.make_job({}, {'status': 'error'})
        answered, emitted = self.settle(jd, lambda old, state: None)
        self.assertEqual((answered, emitted), (False, []))
        self.assertFalse(os.path.exists(jd))
        self.assertTrue(os.path.isdir(jd + '.old1'))

    def test_archive_numbers_do_not_collide(self):
        for _ in range(2):
            jd = self.make_job({}, {'status': 'error'})
            self.settle(jd, lambda old, state: None)
        self.assertEqual(sorted(os.listdir(self.path('jobs'))), ['k.old1', 'k.old2'])

    def test_job_without_spec_or_status(self):
        jd = self.path('jobs', 'k')
        os.makedirs(jd)
        seen = []
        self.settle(jd, lambda old, state: seen.append((old, state)))
        self.assertEqual(seen, [({}, None)])


class JobState(TmpDirCase):
    def test_states(self):
        jd = self.path('j')
        os.makedirs(jd)
        self.assertIsNone(council.job_state(jd))
        council.write_json(os.path.join(jd, 'spec.json'), {})
        self.assertEqual(council.job_state(jd)['status'], 'error')           # a spec, no runner, no result
        council.write(os.path.join(jd, 'pid'), str(os.getpid()))
        self.assertEqual(council.job_state(jd), {'status': 'running'})
        council.write_json(os.path.join(jd, 'status.json'), {'status': 'done'})
        self.assertEqual(council.job_state(jd), {'status': 'done'})


class Snapshot(TmpDirCase):
    """A seat's commits survive its snapshot, so a task that asks for commits can be checked and delivered."""
    def setUp(self):
        super().setUp()
        self.repo, run_dir = self.path('repo'), self.path('repo', '.council', 'R')
        os.makedirs(self.repo)
        self.sh(self.repo, 'init', '-q')
        self.write(self.repo, 'f', 'a\n')
        self.sh(self.repo, 'add', 'f')
        self.sh(self.repo, 'commit', '-qm', 'init')
        head = council.git('rev-parse', 'HEAD', cwd=self.repo).strip()
        self.run_ = {'runId': 'R', 'runDir': run_dir, 'head': head, 'room': os.path.join(run_dir, 'room')}
        self.wt = os.path.join(run_dir, 'wt', 'A')
        council.git('worktree', 'add', '-q', '--detach', self.wt, head, cwd=self.repo)

    def sh(self, cwd, *args):
        return council.git('-c', 'user.name=t', '-c', 'user.email=t@t', *args, cwd=cwd)

    def write(self, cwd, name, text):
        with open(os.path.join(cwd, name), 'w') as f:
            f.write(text)

    def log(self, ref):
        return council.git('log', '--format=%s', f'{self.run_["head"]}..{ref}', cwd=self.repo).split('\n')[:-1]

    def test_uncommitted_work_is_one_council_commit(self):
        self.write(self.wt, 'f', 'b\n')
        out = council.snapshot(self.run_, 'A', 'r0')
        self.assertEqual(self.log(out['ref']), ['council R A r0'])
        self.assertEqual(out['seatCommits'], 0)

    def test_seat_commits_are_kept(self):
        for msg, text in (('one', 'b\n'), ('two', 'c\n')):
            self.write(self.wt, 'f', text)
            self.sh(self.wt, 'commit', '-qam', msg)
        out = council.snapshot(self.run_, 'A', 'r0')
        self.assertEqual(out['commit'], council.git('rev-parse', 'HEAD', cwd=self.wt).strip())
        self.assertEqual(self.log(out['ref']), ['two', 'one'])
        self.assertEqual(out['seatCommits'], 2)
        self.assertEqual(out['files'], 1)

    def test_uncommitted_work_goes_on_top_of_seat_commits(self):
        self.write(self.wt, 'f', 'b\n')
        self.sh(self.wt, 'commit', '-qam', 'one')
        self.write(self.wt, 'notes.md', 'n\n')
        out = council.snapshot(self.run_, 'A', 'r0')
        self.assertEqual(self.log(out['ref']), ['council R A r0: uncommitted changes', 'one'])
        self.assertEqual(sorted(out['fileList']), ['f', 'notes.md'])

    def test_head_moved_off_the_base_is_measured_from_the_base(self):
        self.sh(self.wt, 'checkout', '-q', '--orphan', 'elsewhere')
        self.sh(self.wt, 'commit', '-qm', 'unrelated')
        out = council.snapshot(self.run_, 'A', 'r0')
        self.assertEqual(self.log(out['ref']), ['council R A r0'])
        self.assertEqual(out['seatCommits'], 0)

    def test_codex_may_write_only_its_own_worktree_git_data(self):
        spec = {'cwd': self.wt, 'runDir': self.run_['runDir']}
        common = os.path.join(os.path.realpath(self.repo), '.git')
        self.assertEqual(council.seat_git_dirs(spec), [os.path.join(common, 'worktrees', 'A'), os.path.join(common, 'objects')])
        self.assertEqual(council.seat_git_dirs(dict(spec, cwd=self.repo)), [])


class CodexCommand(TmpDirCase):
    def spec(self, **kw):
        return dict({'runDir': self.tmp, 'job': 'panel-astra-r1', 'model': 'm', 'effort': 'high', 'schema': False,
                     'sandbox': 'read-only', 'cwd': self.path('repo'), 'writable': []}, **kw)

    def test_read_only_turn_runs_from_scratch_with_temp_files(self):
        # Codex's read-only sandbox forbids even temp files (zsh heredocs, Rscript), so the turn may
        # write only to an empty scratch directory and the temp directories, never the repository.
        cmd, cwd = council.codex_command(self.path('job'), self.spec(), None)
        self.assertEqual(cwd, self.path('scratch', 'codex-panel-astra-r1'))
        self.assertTrue(os.path.isdir(cwd))
        self.assertIn('sandbox_mode="workspace-write"', cmd)
        self.assertEqual(cmd[cmd.index('-C') + 1], cwd)
        self.assertFalse(any(c.startswith('sandbox_workspace_write.writable_roots') for c in cmd))

    def test_workspace_write_turn_keeps_its_cwd_and_roots(self):
        room = self.path('room')
        cmd, cwd = council.codex_command(self.path('job'), self.spec(sandbox='workspace-write', writable=[room]), 'T')
        self.assertEqual(cwd, self.path('repo'))
        self.assertEqual(cmd[:3], ['codex', 'exec', 'resume'])
        self.assertIn('sandbox_workspace_write.writable_roots=' + json.dumps([room]), cmd)
        self.assertEqual(cmd[-2:], ['T', '-'])

    def test_output_recovery_uses_a_strict_read_only_sandbox(self):
        cmd, cwd = council.codex_command(self.path('job'), self.spec(resumeSession='T'), 'T')
        self.assertEqual(cwd, self.path('repo'))
        self.assertIn('sandbox_mode="read-only"', cmd)
        self.assertFalse(any(c.startswith('sandbox_workspace_write.writable_roots') for c in cmd))


class SmallHelpers(unittest.TestCase):
    def test_tail(self):
        self.assertEqual(council.tail('a\nb\nc\n', 2), 'b\nc')
        self.assertEqual(council.tail('only', 5), 'only')

    def test_oneline(self):
        self.assertEqual(council.oneline('a\n  b\tc'), 'a b c')
        self.assertEqual(council.oneline('x' * 400, 10), 'x' * 10 + ' […]')
        self.assertEqual(council.oneline(None), '')


if __name__ == '__main__':
    unittest.main()


class KeepAwake(TmpDirCase):
    def setUp(self):
        super().setUp()
        bin_dir = self.path('bin')
        os.makedirs(bin_dir)
        self.record = self.path('caffeinate.args')
        fake = os.path.join(bin_dir, 'caffeinate')
        council.write(fake, f'#!/bin/sh\necho "$@" > {self.record}\n')
        os.chmod(fake, 0o755)
        self.env = {'PATH': bin_dir + os.pathsep + os.environ['PATH']}

    def start(self, env):
        jd = self.path('jobs', 'job')
        with mock.patch.object(council.sys, 'platform', 'darwin'), mock.patch.dict(os.environ, env):
            council.start_job(jd, {'kind': 'noop'})
        return council.read(os.path.join(jd, 'pid')).strip()

    def test_started_job_keeps_the_mac_awake_until_it_exits(self):
        pid = self.start(self.env)
        for _ in range(200):
            if os.path.exists(self.record) and council.read(self.record).strip():
                break
            council.time.sleep(0.01)
        self.assertEqual(council.read(self.record).split(), ['-i', '-w', pid])

    def test_keep_awake_can_be_disabled(self):
        self.start(dict(self.env, DARK_FACTORY_KEEP_AWAKE='0'))
        council.time.sleep(0.2)
        self.assertFalse(os.path.exists(self.record))


class Timeline(TmpDirCase):
    def write_events(self, events):
        with open(self.path('timeline.jsonl'), 'w') as f:
            for minute, event, job in events:
                at = council.datetime.fromtimestamp(1_800_000_000 + minute * 60, council.timezone.utc)
                f.write(council.json.dumps({'at': at.isoformat(timespec='milliseconds'), 'event': event, 'job': job}) + '\n')

    def test_events_are_appended_and_a_job_records_its_start_and_end(self):
        council.timeline_event(self.tmp, 'measure', None)
        jd = self.path('jobs', 'measure-A-base')
        os.makedirs(jd)
        council.write_json(os.path.join(jd, 'spec.json'), {'kind': 'unknown-kind', 'runDir': self.tmp})
        council.cmd_job(jd)
        lines = [json.loads(l) for l in council.read(self.path('timeline.jsonl')).splitlines()]
        self.assertEqual([(l['event'], l['job']) for l in lines],
                         [('measure', None), ('job-start', 'measure-A-base'), ('job-end', 'measure-A-base')])
        self.assertTrue(all(l['at'].endswith('+00:00') for l in lines))

    def test_elapsed_caps_idle_gaps_counts_jobs_in_full_and_merges_overlaps(self):
        self.assertIsNone(council.timeline_elapsed(self.tmp))
        self.write_events([
            (0, 'init', None),
            (5, 'job-start', 'review-pair-design-1'),
            (45, 'wait', 'review-pair-design-1'),            # inside a job: counts in full
            (50, 'job-end', 'review-pair-design-1'),
            (52, 'job-start', 'measure-A-pair-code-2'),
            (55, 'job-start', 'verify-A-impl'),              # overlapping author job
            (60, 'job-end', 'measure-A-pair-code-2'),
            (62, 'job-end', 'verify-A-impl'),
            (182, 'measure', None),                           # two idle hours: count 15 minutes
        ])
        elapsed = council.timeline_elapsed(self.tmp)
        self.assertEqual(elapsed['elapsedMs'], (5 + 45 + 2 + 10 + 15) * 60_000)
        self.assertEqual(elapsed['byRole'], {'reviewer': 45 * 60_000, 'measure': 8 * 60_000, 'author': 7 * 60_000})

    def test_retro_facts_take_timeline_elapsed_only_when_none_was_recorded(self):
        self.write_events([(0, 'init', None), (10, 'retro', None)])
        run = {'runDir': self.tmp}
        facts = council.fill_metrics(run, {'metrics': {'elapsedMs': None, 'tokens': {}}})['metrics']
        self.assertEqual((facts['elapsedMs'], facts['elapsedSource']), (600_000, 'helper-timeline'))
        kept = council.fill_metrics(run, {'metrics': {'elapsedMs': 5, 'tokens': {}}})['metrics']
        self.assertEqual(kept['elapsedMs'], 5)
        self.assertNotIn('elapsedSource', kept)


class ClaudeCommand(TmpDirCase):
    def test_every_headless_claude_turn_can_read_the_run_room_and_refs_without_editing_them(self):
        jd = self.path('jobs', 'review-pair-code-3')
        os.makedirs(jd)
        for sandbox in ('read-only', 'workspace-write'):
            spec = {'runDir': self.tmp, 'job': 'review-pair-code-3', 'model': 'opus', 'effort': 'high', 'sandbox': sandbox,
                    'writable': [self.path('jobs')], 'cwd': self.path('snap'), 'schema': None, 'gitRoots': []}
            cmd, _ = council.claude_command(jd, spec, None)
            settings = json.loads(cmd[cmd.index('--settings') + 1])
            self.assertEqual(settings['permissions']['allow'], [f'Read(/{self.tmp}/refs/**)', f'Read(/{self.tmp}/room/**)'])
            self.assertNotIn(self.path('room'), cmd)
