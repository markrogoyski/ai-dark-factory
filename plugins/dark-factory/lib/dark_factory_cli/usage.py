"""Token-usage accounting (usage). The accountant is lib/usage.mjs, which also reads the vendors'
own session logs for turns their CLI reported no usage for, and a native workflow's own agents;
this module runs it, and keeps the older reading for a machine without node (marked partial)."""

import json
import os
import re
import shutil
import subprocess

from . import common
from .common import SELF, load_run, read

ACCOUNTANT = os.path.join(os.path.dirname(SELF), '..', 'lib', 'usage.mjs')


def node_usage(run_dirs, native=True, turns=False):
    """lib/usage.mjs's report for these run directories, or None when node can't run it."""
    node = shutil.which('node')
    if not node or not os.path.isfile(ACCOUNTANT):
        return None
    argv = [node, ACCOUNTANT] + [x for d in run_dirs for x in ('--run-dir', d)] + (['--native'] if native else []) + ([] if turns else ['--no-turns'])
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=300, close_fds=True)
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    return out if isinstance(out, dict) and out.get('version') == 2 else None


def cmd_usage(a):
    report = node_usage([a.run_dir], native=not a.no_claude, turns=True)
    if report is not None:
        common.emit({'status': 'ok', **report})
        return
    path = os.path.join(a.run_dir, 'usage.jsonl')
    by_model = {}
    if os.path.exists(path):
        for line in read(path).split('\n'):
            if not line.strip():
                continue
            rec = json.loads(line)
            m = by_model.setdefault(rec['model'], {'turns': 0, 'seconds': 0})
            m['turns'] += 1
            m['seconds'] = round(m['seconds'] + rec.get('seconds', 0), 1)
            for k, v in rec.get('usage', {}).items():
                m[k] = m.get(k, 0) + v
    # Without node: the helper's records as they are, and Claude agents found by the run directory
    # in their transcripts. Turns whose CLI reported no usage are not read back, so it is partial.
    out = {'status': 'ok', 'complete': False, 'missing': [{'reason': 'node is not available to run lib/usage.mjs; turns without recorded usage are not read back from their session logs'}],
           'byModel': by_model}
    if not a.no_claude:
        out['claude'] = claude_usage(load_run(a.run_dir))
    common.emit(out)


USAGE_KEYS = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')


def agent_role(label):
    """The council role behind a workflow agent's label (see the labels council.js gives agents)."""
    for role, pat in (('relay', r'\(relay'), ('setup', r'^setup$'), ('retro', r'^retro$'), ('intake', r'^intake$'),
                      ('record', r'^record$'), ('checker', r'^check '),
                      ('panel', r'^panel '), ('questions', r'^questions '), ('ballot', r'^b\d+:'),
                      ('auditor', r'^(re)?audit '), ('spec', r'^spec '), ('seat', r'^(r\d+|final\d?|ratify|inc\d+):')):
        if re.search(pat, label or ''):
            return role
    return 'other'


def claude_usage(run):
    """Token use of this run's Claude agents (seats, checkers, panel, relays, setup, retro), read from
    their saved transcripts: Claude Code keeps one per agent, and every council prompt names the run
    directory. Each API message is counted once, though a transcript may log it more than once."""
    base = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    created = os.path.getmtime(os.path.join(run['runDir'], 'run.json'))
    needle = run['runDir'].encode()
    by_model, by_role, agents = {}, {}, 0
    for dirpath, _, names in os.walk(os.path.join(base, 'projects')):
        for name in names:
            if not (name.startswith('agent-') and name.endswith('.jsonl')):
                continue
            path = os.path.join(dirpath, name)
            try:
                if os.path.getmtime(path) < created:
                    continue
                with open(path, 'rb') as f:
                    data = f.read()
            except OSError:
                continue
            if needle not in data:
                continue
            meta_path = path[:-len('.jsonl')] + '.meta.json'
            try:
                meta = json.loads(read(meta_path)) if os.path.exists(meta_path) else {}
            except ValueError:
                meta = {}
            messages = {}
            for raw in data.split(b'\n'):
                try:
                    msg = json.loads(raw).get('message') or {}
                except (ValueError, AttributeError):
                    continue
                if isinstance(msg, dict) and msg.get('role') == 'assistant' and isinstance(msg.get('usage'), dict):
                    messages[msg.get('id') or len(messages)] = msg           # the last record of a message wins
            if not messages:
                continue
            agents += 1
            role = agent_role(meta.get('description', ''))
            for msg in messages.values():
                for bucket in (by_model.setdefault(msg.get('model') or meta.get('model') or '?', {'messages': 0}),
                               by_role.setdefault(role, {'messages': 0})):
                    bucket['messages'] += 1
                    for k in USAGE_KEYS:
                        v = msg['usage'].get(k)
                        if isinstance(v, (int, float)):
                            bucket[k] = bucket.get(k, 0) + v
    return {'agents': agents, 'byModel': by_model, 'byRole': by_role}
