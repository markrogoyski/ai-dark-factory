"""Retro, run facts, metrics and the command timeline (retro)."""

from datetime import datetime, timezone
import json
import os
import re

from .common import CouncilError, SELF, emit, load_run, prompt_hash, read, write, write_json
from .transcripts import payload_from_transcripts
from .usage import claude_usage


# A development checkout (plugins/dark-factory/bin/ under the repo) keeps retros in the repo, next
# to the code they tune. An installed plugin's directory is replaced on every update, so elsewhere
# they go under ~/.claude.
_CHECKOUT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(SELF))))
RETRO_DIR = (os.path.join(_CHECKOUT, 'retros')
             if os.path.isfile(os.path.join(_CHECKOUT, '.claude-plugin', 'marketplace.json'))
             and os.path.isdir(os.path.join(_CHECKOUT, '.git'))
             else os.path.expanduser('~/.claude/dark-factory/retros'))


FACTS_RE = re.compile(r'^## Run facts \(data\)\n\n```json\n(.*?)\n```', re.S | re.M)


def facts_of(payload):
    """The JSON facts a factory run puts in its retro payload, or None."""
    m = FACTS_RE.search(payload or '')
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


# Native workflows have no replay-safe clock, so the helper records when it was called and when
# each job ran. Gaps between events longer than this count as paused (a resume, the user away).
TIMELINE_GAP_SEC = 15 * 60
TIMELINE_COMMANDS = ('init', 'measure', 'seat-run', 'wait', 'materialize', 'verify-delivery', 'retro')


def timeline_event(run_dir, event, job=None, at=None):
    """Append one line to <run>/timeline.jsonl. Best effort: a clock must never fail a command."""
    line = json.dumps({'at': (at or datetime.now(timezone.utc)).isoformat(timespec='milliseconds'), 'event': event, 'job': job})
    try:
        fd = os.open(os.path.join(run_dir, 'timeline.jsonl'), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, (line + '\n').encode())
        finally:
            os.close(fd)
    except OSError:
        pass


def setup_started(value):
    """The time a native setup agent started, which it read with `date -u` before anything else and
    passed to init as --started-at: the native workflow has no replay-safe clock of its own. An ISO
    time with an offset, from the last hour and not in the future; anything else is ignored, since
    a clock must never fail a command."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        at = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    if at.tzinfo is None:
        return None
    age = (datetime.now(timezone.utc) - at).total_seconds()
    return at.astimezone(timezone.utc) if -5 <= age <= 3600 else None


def timeline_role(job):
    if job.startswith('measure-'):
        return 'measure'
    if re.match(r'(review|audit|check|spec)-', job):
        return 'reviewer'
    return 'author'


def timeline_elapsed(run_dir):
    """Active time from <run>/timeline.jsonl: a job counts in full from start to end, and any other
    gap between consecutive events counts up to TIMELINE_GAP_SEC. A native Pair setup passes its
    start to init (a setup-start event), so its time before init counts; otherwise, and for intake,
    the time before init is not counted. None without a timeline."""
    path = os.path.join(run_dir, 'timeline.jsonl')
    if not os.path.isfile(path):
        return None
    events = []
    for line in read(path).split('\n'):
        try:
            e = json.loads(line) if line.strip() else None
            events.append((datetime.fromisoformat(e['at']).timestamp(), e.get('event'), e.get('job')))
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
    if not events:
        return None
    events.sort(key=lambda e: e[0])
    open_jobs, spans = {}, []
    for at, event, job in events:
        if event == 'job-start' and job:
            open_jobs[job] = at
        elif event == 'job-end' and job in open_jobs:
            spans.append((open_jobs.pop(job), at, job))
    points = sorted({at for at, _, _ in events})
    total = 0.0
    for a, b in zip(points, points[1:]):
        covered = any(start <= a and b <= end for start, end, _ in spans)
        total += (b - a) if covered else min(b - a, TIMELINE_GAP_SEC)
    by_role = {'author': 0.0, 'reviewer': 0.0, 'measure': 0.0}
    for role in by_role:
        merged = []
        for start, end, _ in sorted(s for s in spans if timeline_role(s[2]) == role):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        by_role[role] = sum(end - start for start, end in merged)
    return {'elapsedMs': round(total * 1000), 'byRole': {k: round(v * 1000) for k, v in by_role.items()}}


def fill_metrics(run, facts):
    """Fill token evidence from vendor logs and native transcripts, and native active elapsed time
    from the helper's timeline (never run.json mtime, which includes idle time between resumes)."""
    m = facts.get('metrics') if isinstance(facts, dict) else None
    if not isinstance(m, dict):
        return facts
    if m.get('elapsedMs') is None:
        elapsed = timeline_elapsed(run['runDir'])
        if elapsed:
            m.update(elapsedMs=elapsed['elapsedMs'], elapsedSource='helper-timeline', elapsedByRole=elapsed['byRole'])
    if m.get('tokens') is None:
        by_model, records = {}, 0
        path = os.path.join(run['runDir'], 'usage.jsonl')
        if os.path.exists(path):
            for line in read(path).split('\n'):
                try:
                    rec = json.loads(line) if line.strip() else None
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                bucket = by_model.setdefault(rec.get('model') or '?', {})
                records += 1
                for k, v in (rec.get('usage') or {}).items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                        bucket[k] = bucket.get(k, 0) + v
        try:
            claude = claude_usage(run)['byModel']
        except OSError:
            claude = {}
        for model, usage in claude.items():
            records += usage.get('messages', 0)
            bucket = by_model.setdefault(model, {})
            for key, value in usage.items():
                if key != 'messages' and isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                    bucket[key] = bucket.get(key, 0) + value
        m['tokens'] = {'records': records, 'byModel': by_model} if records else None
    return facts


def retro_dir(a):
    return os.path.abspath(os.path.expanduser(a.out_dir or os.environ.get('COUNCIL_RETRO_DIR') or RETRO_DIR))


def cmd_retro(a):
    """Keep a run's retro where it outlives the run (`cleanup --all` deletes the run directory),
    next to the workflow it is about. The retro agent writes <run>/retro.md; the process notes
    and run facts it was given are read from its own saved prompt, hash-checked, as seat-run
    reads a relay's payload, so no model copies them. A factory run's facts are also kept as
    <run>-<repo>.facts.json, for `retro --summary`; --facts-only keeps just those."""
    if a.summary:
        print(retro_summary(retro_dir(a)))
        return
    if not a.run_dir:
        raise CouncilError('retro needs --run-dir (or --summary)')
    run = load_run(a.run_dir)
    path = os.path.join(run['runDir'], 'retro.md')
    if not a.facts_only and not os.path.isfile(path):
        raise CouncilError(f'write the retro to {path} first')
    payload_file = getattr(a, 'payload_file', None)
    if payload_file:
        data = read(payload_file)
        if a.expect and prompt_hash(data) != a.expect:
            raise CouncilError('retro payload file does not match --expect')
    else:
        data = payload_from_transcripts(a.expect, a.transcript_wait) if a.expect else None
    if data is not None:
        write(os.path.join(run['runDir'], 'retro-data.md'), data + '\n')
    facts = facts_of(data)
    if a.facts_only and facts is None:
        raise CouncilError('no run facts found in the payload (is the record agent\'s transcript saved?)')
    out_dir = retro_dir(a)
    repo = re.sub(r'[^A-Za-z0-9._-]', '-', os.path.basename(run['repoRoot'])) or 'repo'
    base = os.path.join(out_dir, f"{run['runId']}-{repo}")
    try:
        if not a.facts_only:
            write(base + '.md', read(path).rstrip('\n') + ('\n\n' + data if data is not None else '') + '\n')
        if facts is not None:
            write_json(base + '.facts.json', fill_metrics(run, facts))
    except PermissionError as e:
        emit({'status': 'sandboxed', 'error': f'cannot write to {out_dir} ({e.strerror}). This command is running '
              'inside a sandbox that only allows writes to the project.'})
        return
    emit({'status': 'ok', 'path': base + ('.facts.json' if a.facts_only else '.md'), 'notes': data is not None, 'facts': facts is not None})


def retro_summary(out_dir):
    """How the factory's router has done, from every saved *.facts.json: per tier, the runs, how
    the tier was chosen, the escalations by trigger, the hints that a tier was too high, readiness
    and the median Claude turns. Plain text, for reading before tuning the intake rubric."""
    rows = []
    for name in sorted(os.listdir(out_dir)) if os.path.isdir(out_dir) else []:
        if name.endswith('.facts.json'):
            try:
                rows.append(json.loads(read(os.path.join(out_dir, name))))
            except (OSError, ValueError):
                continue
    if not rows:
        return f'No factory facts under {out_dir} yet.'

    def started(r):
        e = r.get('escalation')
        return e['from'] if e else r.get('tier') or '?'

    def tally(xs):
        out = {}
        for x in xs:
            out[x] = out.get(x, 0) + 1
        return ', '.join(f'{k} {v}' for k, v in sorted(out.items(), key=lambda kv: (-kv[1], str(kv[0])))) or 'none'

    lines = [f'{len(rows)} factory run(s) in {out_dir}', '']
    for tier in ['simple', 'fix', 'feature', 'architecture', '?']:
        rs = [r for r in rows if started(r) == tier]
        if not rs:
            continue
        esc = [r['escalation'] for r in rs if r.get('escalation')]
        turns = sorted((r.get('turns') or {}).get('claude', 0) for r in rs)
        over = [h for r in rs for h in (r.get('overTierHints') or [])]
        overruled = [r for r in rs if r.get('chosenBy') == 'overruled']
        lines.append(f'{tier}: {len(rs)} run(s), chosen by {tally(r.get("chosenBy") or "?" for r in rs)}')
        lines.append(f'  escalated: {len(esc)}' + (f' ({tally(e["trigger"] + " -> " + e["to"] for e in esc)})' if esc else ''))
        if overruled:
            lines.append(f'  overruled intake: {len(overruled)} (intake said {tally(r.get("recommended") or "?" for r in overruled)}; '
                         f'{sum(1 for r in overruled if r.get("escalation"))} of them escalated)')
        lines.append(f'  readiness: {tally(r.get("readiness") or "?" for r in rs)}')
        lines.append(f'  median Claude turns: {turns[len(turns) // 2]}')
        if over:
            lines.append(f'  hints the tier was too high: {tally(over)}')
    return '\n'.join(lines)
