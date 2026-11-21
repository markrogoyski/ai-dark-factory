"""Follow a Claude Code workflow run as it goes (watch).

A workflow's log() lines reach Claude Code's own view (/workflows) and are saved only when the run
ends, in <session>/workflows/wf_<id>.json. What Claude Code writes while the run goes is the
run's transcript directory, <session>/subagents/workflows/wf_<id>/: an agent-<id>.meta.json as
each agent starts (its label, phase and model), the agent's transcript as it works, and
journal.jsonl, which records each agent's start and result. watch reads those and prints a line
as each step starts and ends, then the run's milestones once it has finished.

None of these files is documented by Claude Code; when their shape changes, watch says what it
could not read rather than going quiet.
"""

import glob
import json
import os
import re
import sys
import time

from . import common
from .common import CouncilError, oneline

RUNNING_MAX_AGE = 2 * 3600       # a run with no write for this long is not picked as the running one
OK_STATUSES = ('done', 'ok')


def projects_root():
    return os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'projects')


def project_slug(path):
    """The directory name Claude Code gives a project: its path with every other character a dash."""
    return re.sub(r'[^A-Za-z0-9]', '-', os.path.abspath(path))


def final_file(run_dir):
    """<session>/workflows/wf_<id>.json for <session>/subagents/workflows/wf_<id>: written at the end."""
    session = os.path.dirname(os.path.dirname(os.path.dirname(run_dir)))
    return os.path.join(session, 'workflows', os.path.basename(run_dir) + '.json')


def last_write(run_dir):
    times = [os.path.getmtime(run_dir)]
    for path in glob.glob(os.path.join(run_dir, '*')):
        try:
            times.append(os.path.getmtime(path))
        except OSError:
            pass
    return max(times)


def run_dirs(root, slug=None):
    pattern = os.path.join(root, glob.escape(slug) if slug else '*', '*', 'subagents', 'workflows', 'wf_*')
    return [d for d in glob.glob(pattern) if os.path.isdir(d)]


def find_run(root, run, slug, now=None):
    """The run to follow: --run (an ID or a directory), else the project's newest unfinished run
    with a recent write; None when nothing is running yet."""
    if run:
        if os.path.isdir(run):
            return os.path.abspath(run)
        name = run if run.startswith('wf_') else 'wf_' + run
        found = [d for d in run_dirs(root) if os.path.basename(d) == name]
        if not found:
            raise CouncilError(f'no workflow run {name} under {root}')
        return found[0]
    now = time.time() if now is None else now
    live = [(last_write(d), d) for d in run_dirs(root, slug) if not os.path.exists(final_file(d))]
    live = [(t, d) for t, d in live if now - t < RUNNING_MAX_AGE]
    return max(live)[1] if live else None


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def clock(t):
    return time.strftime('%H:%M:%S', time.localtime(t if t is not None else time.time()))


def duration(seconds):
    seconds = int(round(seconds))
    if seconds < 60:
        return f'{seconds}s'
    if seconds < 3600:
        return f'{seconds // 60}m{seconds % 60:02d}s'
    return f'{seconds // 3600}h{seconds // 60 % 60:02d}m'


def first_sentence(text, n=140):
    text = ' '.join(str(text or '').split())
    m = re.match(r'(.+?[.!?])(\s|$)', text)
    return oneline(m.group(1) if m else text, n)


def tally(items):
    """'3 verified, 1 refuted' for a list of objects that each carry a status or verdict."""
    for key in ('verdict', 'status'):
        values = [i.get(key) for i in items if isinstance(i, dict) and isinstance(i.get(key), str) and i.get(key)]
        if values and len(values) == len(items):
            counts = {}
            for v in values:
                counts[v] = counts.get(v, 0) + 1
            return ', '.join(f'{n} {v}' for v, n in counts.items())
    return None


def summarize(result):
    """A short line from an agent's result: its status when not done, an error, a vote, a gate
    result, a tally of each list it returned, and the first sentence of its summary. A relay's
    result is read through to the other model's answer it carries."""
    if result is None:
        return 'no result'
    if isinstance(result, str):
        return first_sentence(result) or 'empty answer'
    if not isinstance(result, dict):
        return oneline(json.dumps(result, ensure_ascii=False), 140)
    parts = []
    status = result.get('status')
    if isinstance(status, str) and status and status not in OK_STATUSES:
        parts.append(status)
    if result.get('error'):
        parts.append(f"error: {oneline(result['error'], 120)}")
    body = result['result'] if isinstance(result.get('result'), dict) else result
    if body is not result and isinstance(body.get('status'), str) and body['status'] not in OK_STATUSES + ('',):
        parts.append(body['status'])
    vote = body.get('vote')
    if isinstance(vote, dict) and vote.get('ship'):
        parts.append(f"votes {vote['ship']}")
    for key in ('verdict', 'tier', 'mode'):
        if isinstance(body.get(key), str) and body[key]:
            parts.append(f'{key} {body[key]}')
    suite = body.get('suite')
    if isinstance(suite, dict) and 'passed' in suite:
        parts.append('gate ' + ('passed' if suite['passed'] else 'not run' if suite.get('ran') is False else 'failed'))
    for key, value in body.items():
        if isinstance(value, list) and value and key not in ('readings', 'replayMapping', 'addressed'):
            counted = tally(value)
            parts.append(f'{key}: {counted}' if counted else f'{len(value)} {key}')
    if body.get('summary'):
        parts.append(first_sentence(body['summary']))
    return oneline('; '.join(parts), 300) if parts else 'done'


class Follower:
    """Reads one run's directory, printing each start, restart and result once, in journal order."""

    def __init__(self, run_dir, out):
        self.dir, self.out = run_dir, out
        self.offset, self.pending = 0, b''
        self.agents = {}          # agentId -> {label, phase, model, started}
        self.keys = {}            # journal key -> agentIds started under it
        self.shown_meta = set()
        self.warned = set()

    def say(self, t, text):
        self.out.write(f'{clock(t)}  {text}\n')
        self.out.flush()

    def warn(self, what):
        if what not in self.warned:
            self.warned.add(what)
            self.say(None, f'(watch: {what}; Claude Code may have changed its run files)')

    def meta(self, agent_id):
        path = os.path.join(self.dir, f'agent-{agent_id}.meta.json')
        data = read_json(path) or {}
        return data, mtime(path)

    def name(self, a):
        return f"{a['phase']} · {a['label']}" if a.get('phase') else a['label']

    def started(self, agent_id, label=None, phase=None):
        if agent_id in self.agents:
            return
        data, t = self.meta(agent_id)
        a = {'label': label or data.get('description') or agent_id, 'phase': phase or data.get('workflowPhase') or '',
             'model': data.get('model') or '', 'started': t}
        self.agents[agent_id] = a
        self.shown_meta.add(agent_id)
        model = f" ({a['model']})" if a['model'] else ''
        self.say(t, f'{self.name(a)} started{model}')

    def line(self, raw):
        try:
            entry = json.loads(raw)
        except ValueError:
            self.warn('a journal line is not JSON')
            return
        kind, agent_id = entry.get('type'), entry.get('agentId')
        if kind == 'started' and agent_id:
            earlier = self.keys.setdefault(entry.get('key'), [])
            if earlier and agent_id not in earlier:
                prev = self.agents.get(earlier[-1], {})
                prev['done'] = True             # superseded: its retry reports for it
                a = self.agents.setdefault(agent_id, {k: v for k, v in prev.items() if k != 'done'})
                a['started'] = self.meta(agent_id)[1]
                t = a['started']
                self.shown_meta.add(agent_id)
                self.say(t, f"{self.name(self.agents[agent_id])} restarted (attempt {len(earlier) + 1})")
            else:
                self.started(agent_id, entry.get('label'), entry.get('phase'))
            earlier.append(agent_id)
        elif kind == 'result' and agent_id:
            self.started(agent_id)
            a = self.agents[agent_id]
            t = mtime(os.path.join(self.dir, f'agent-{agent_id}.jsonl')) or time.time()
            took = f" in {duration(t - a['started'])}" if a.get('started') else ''
            a['done'] = True
            self.say(t, f"{self.name(a)} done{took}: {summarize(entry.get('result'))}")
        elif kind not in ('launched', 'started', 'result'):
            self.warn(f'unknown journal entry {kind!r}')

    def poll(self):
        """Read what is new: agents whose meta file appeared, then new journal lines."""
        journal = os.path.join(self.dir, 'journal.jsonl')
        try:
            with open(journal, 'rb') as f:
                f.seek(self.offset)
                data = f.read()
        except OSError:
            data = b''
        self.offset += len(data)
        lines = (self.pending + data).split(b'\n')
        self.pending = lines.pop()             # a line still being written
        for raw in lines:
            if raw.strip():
                self.line(raw)
        metas = []
        for path in glob.glob(os.path.join(self.dir, 'agent-*.meta.json')):
            agent_id = os.path.basename(path)[len('agent-'):-len('.meta.json')]
            if agent_id not in self.shown_meta:
                metas.append((mtime(path) or 0, agent_id))
        for _, agent_id in sorted(metas):
            self.started(agent_id)

    def finish(self, final):
        """The run's end: agents that never returned, how it ended, and its milestone lines."""
        t = mtime(final_file(self.dir))
        for a in self.agents.values():
            if not a.get('done') and a.get('started') is not None:
                a['done'] = True
                self.say(t, f'{self.name(a)} ended without a result')
        status = final.get('status') or 'finished'
        took = f" in {duration(final['durationMs'] / 1000)}" if isinstance(final.get('durationMs'), (int, float)) else ''
        self.say(t, f'run {status}{took}')
        logs = final.get('logs')
        if isinstance(logs, list) and logs:
            self.out.write('\nHow the run went (its log lines):\n')
            for entry in logs:
                text = entry if isinstance(entry, str) else (entry.get('message') if isinstance(entry, dict) else None)
                self.out.write(f'  {oneline(text if text is not None else json.dumps(entry), 2000)}\n')
            self.out.flush()
        return status


def follow(run_dir, out, interval=1.0, once=False):
    f = Follower(run_dir, out)
    name = os.path.basename(run_dir)
    out.write(f'watching {name}: {run_dir}\n')
    out.flush()
    while True:
        done = os.path.exists(final_file(run_dir))     # checked first, so the last poll reads everything
        f.poll()
        if done:
            final = read_json(final_file(run_dir))
            if final is None:
                f.warn(f'could not read {final_file(run_dir)}')
                return {'status': 'ok', 'run': name, 'workflowStatus': 'unknown'}
            return {'status': 'ok', 'run': name, 'workflowStatus': f.finish(final)}
        if once:
            return {'status': 'ok', 'run': name, 'workflowStatus': 'running'}
        time.sleep(interval)


def cmd_watch(a):
    root = projects_root()
    slug = project_slug(a.project or os.getcwd())
    out, run_dir = sys.stderr, None
    try:
        run_dir = find_run(root, a.run, slug)
        if run_dir is None:
            if a.once:
                raise CouncilError(f'no workflow is running for {a.project or os.getcwd()} (Claude Code project {slug}); pass --run ID')
            out.write(f'waiting for a workflow to start in {a.project or os.getcwd()}…\n')
            out.flush()
            while run_dir is None:
                time.sleep(a.interval)
                run_dir = find_run(root, None, slug)
        common.emit(follow(run_dir, out, a.interval, a.once))
    except KeyboardInterrupt:
        out.write('\n')
        common.emit({'status': 'ok', 'run': os.path.basename(run_dir) if run_dir else None, 'workflowStatus': 'not followed to the end'})
