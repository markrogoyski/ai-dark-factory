"""dark-factory watch against a fake Claude Code projects directory; no models.

The files are shaped like the ones Claude Code writes for a workflow run: agent-<id>.meta.json as
each agent starts, journal.jsonl with started/result lines, and <session>/workflows/wf_<id>.json
once the run has finished.
"""

import io
import json
import os
import re
import subprocess
import unittest

from test_council import CLI, TmpDirCase
from dark_factory_cli import watch


class Summaries(unittest.TestCase):
    def test_table(self):
        for result, want in [
            (None, 'no result'),
            ('OK1', 'OK1'),
            ('First sentence. Second one.', 'First sentence.'),
            ({'status': 'done'}, 'done'),
            ({'status': 'error', 'error': 'codex exited 1'}, 'error; error: codex exited 1'),
            ({'status': 'done', 'seconds': '12', 'result': {'summary': 'Changes are required. More.',
                                                            'findings': [{'id': 'P1'}, {'id': 'P2'}],
                                                            'criteria': [{'status': 'met'}, {'status': 'partial'}, {'status': 'met'}]}},
             '2 findings; criteria: 2 met, 1 partial; Changes are required.'),
            ({'status': 'sandboxed', 'error': 'denied', 'result': {}}, 'sandboxed; error: denied'),
            ({'vote': {'ship': 'B', 'amendments': []}}, 'votes B'),
            ({'rulings': [{'verdict': 'verified'}, {'verdict': 'refuted'}, {'verdict': 'verified'}]},
             'rulings: 2 verified, 1 refuted'),
            ({'status': 'done', 'suite': {'ran': True, 'passed': False}}, 'gate failed'),
            ({'status': 'done', 'suite': {'ran': True, 'passed': True}, 'readings': [1]}, 'gate passed'),
            ({'tier': 'simple', 'reasons': 'small'}, 'tier simple'),
        ]:
            with self.subTest(result=result):
                self.assertEqual(watch.summarize(result), want)

    def test_durations(self):
        self.assertEqual([watch.duration(s) for s in (4, 65, 3600 + 120)], ['4s', '1m05s', '1h02m'])

    def test_project_slug(self):
        self.assertEqual(watch.project_slug('/Users/me/Develop/ai/ai-dark-factory'), '-Users-me-Develop-ai-ai-dark-factory')


class Run(TmpDirCase):
    SLUG = '-repo'

    def setUp(self):
        super().setUp()
        self.root = self.path('config', 'projects')

    def run_dir(self, wf='wf_abc', session='s1', slug=SLUG):
        d = os.path.join(self.root, slug, session, 'subagents', 'workflows', wf)
        os.makedirs(d, exist_ok=True)
        return d

    def agent(self, d, agent_id, label, phase, model='haiku', at=1000.0, done_at=None):
        meta = os.path.join(d, f'agent-{agent_id}.meta.json')
        with open(meta, 'w') as f:
            json.dump({'description': label, 'workflowPhase': phase, 'model': model}, f)
        os.utime(meta, (at, at))
        transcript = os.path.join(d, f'agent-{agent_id}.jsonl')
        with open(transcript, 'w') as f:
            f.write('{}\n')
        os.utime(transcript, (done_at or at, done_at or at))

    def journal(self, d, *entries, partial=''):
        with open(os.path.join(d, 'journal.jsonl'), 'a') as f:
            for e in entries:
                f.write(json.dumps(e) + '\n')
            f.write(partial)

    def finish(self, d, **final):
        path = watch.final_file(d)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump(final, f)

    def follow(self, d, once=True):
        out = io.StringIO()
        result = watch.follow(d, out, interval=0, once=once)
        return result, [re.sub(r'^\d\d:\d\d:\d\d  ', '', line) for line in out.getvalue().splitlines()]

    def test_a_finished_run_is_replayed_with_restarts_and_its_log_lines(self):
        d = self.run_dir()
        self.agent(d, 'a1', 'setup', 'Setup', 'opus', at=1000, done_at=1065)
        self.agent(d, 'a2', 'design-1', 'Design', 'opus', at=1065)
        self.agent(d, 'a3', 'design-1', 'Design', 'opus', at=1200, done_at=1260)
        self.agent(d, 'a4', 'review (relay)', 'Review', at=1260)
        self.journal(d, {'type': 'launched'},
                     {'type': 'started', 'key': 'k1', 'agentId': 'a1', 'label': 'setup', 'phase': 'Setup'},
                     {'type': 'result', 'key': 'k1', 'agentId': 'a1', 'result': {'status': 'ok', 'mode': 'implement'}},
                     {'type': 'started', 'key': 'k2', 'agentId': 'a2', 'label': 'design-1', 'phase': 'Design'},
                     {'type': 'started', 'key': 'k2', 'agentId': 'a3', 'label': 'design-1', 'phase': 'Design'},
                     {'type': 'result', 'key': 'k2', 'agentId': 'a3', 'result': {'status': 'done', 'summary': 'Drafted.'}},
                     {'type': 'started', 'key': 'k3', 'agentId': 'a4', 'label': 'review (relay)', 'phase': 'Review'})
        self.finish(d, status='failed', durationMs=300000, logs=['pair: one', 'pair: two'])
        result, lines = self.follow(d)
        self.assertEqual(result, {'status': 'ok', 'run': 'wf_abc', 'workflowStatus': 'failed'})
        self.assertEqual(lines[1:], [
            'Setup · setup started (opus)',
            'Setup · setup done in 1m05s: mode implement',
            'Design · design-1 started (opus)',
            'Design · design-1 restarted (attempt 2)',
            'Design · design-1 done in 1m00s: Drafted.',
            'Review · review (relay) started (haiku)',
            'Review · review (relay) ended without a result',
            'run failed in 5m00s',
            '',
            'How the run went (its log lines):',
            '  pair: one',
            '  pair: two',
        ])

    def test_a_running_run_shows_each_step_once_as_it_appears(self):
        d = self.run_dir()
        f = watch.Follower(d, io.StringIO())
        self.agent(d, 'a1', 'step-1', 'Probe', at=1000, done_at=1003)
        f.poll()                                           # the meta file comes before the journal line
        self.journal(d, {'type': 'started', 'key': 'k1', 'agentId': 'a1', 'label': 'step-1', 'phase': 'Probe'},
                     partial='{"type": "result", "key": "k1", "agentId": "a1", "res')
        f.poll()                                           # a half-written line waits for the rest
        self.journal(d, partial='ult": "OK1"}\n')
        f.poll()
        f.poll()
        lines = [line.split('  ', 1)[1] for line in f.out.getvalue().splitlines()]
        self.assertEqual(lines, ['Probe · step-1 started (haiku)', 'Probe · step-1 done in 3s: OK1'])

    def test_an_unknown_journal_entry_is_reported_once(self):
        d = self.run_dir()
        self.journal(d, {'type': 'mystery'}, {'type': 'mystery'})
        _, lines = self.follow(d)
        self.assertEqual(sum('unknown journal entry' in line for line in lines), 1)

    def test_the_newest_unfinished_run_of_the_project_is_followed(self):
        old, new, done, other = (self.run_dir('wf_old'), self.run_dir('wf_new', 's2'),
                                 self.run_dir('wf_done', 's3'), self.run_dir('wf_other', slug='-elsewhere'))
        for d, t in ((old, 2000), (new, 3000), (done, 4000), (other, 5000)):
            os.utime(d, (t, t))
        self.finish(done)
        os.utime(watch.final_file(done), (1, 1))
        self.assertEqual(watch.find_run(self.root, None, self.SLUG, now=3500), new)
        self.assertIsNone(watch.find_run(self.root, None, self.SLUG, now=3000 + watch.RUNNING_MAX_AGE + 1))
        self.assertEqual(watch.find_run(self.root, 'done', self.SLUG), done)
        self.assertEqual(watch.find_run(self.root, 'wf_other', self.SLUG), other)
        with self.assertRaisesRegex(Exception, 'no workflow run wf_none'):
            watch.find_run(self.root, 'none', self.SLUG)

    def test_the_command_prints_progress_on_stderr_and_one_json_object_on_stdout(self):
        d = self.run_dir()
        self.agent(d, 'a1', 'step-1', 'Probe')
        self.journal(d, {'type': 'started', 'key': 'k1', 'agentId': 'a1', 'label': 'step-1', 'phase': 'Probe'},
                     {'type': 'result', 'key': 'k1', 'agentId': 'a1', 'result': 'OK1'})
        self.finish(d, status='completed', durationMs=1000, logs=['probe: done'])
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.path('config'))
        r = subprocess.run([CLI, 'watch', '--run', 'abc', '--once'], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {'status': 'ok', 'run': 'wf_abc', 'workflowStatus': 'completed'})
        self.assertIn('Probe · step-1 done in 0s: OK1', r.stderr)
        self.assertIn('  probe: done', r.stderr)

    def test_once_with_nothing_running_fails_with_the_project(self):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.path('config'))
        r = subprocess.run([CLI, 'watch', '--once', '--project', self.path('repo')], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertIn('no workflow is running', json.loads(r.stdout.splitlines()[-1])['error'])


if __name__ == '__main__':
    unittest.main()
