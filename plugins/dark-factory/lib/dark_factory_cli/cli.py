"""dark-factory — deterministic plumbing for the factory workflows.

The workflow script can only spawn Claude agents; it has no shell. Everything that has to be
deterministic — worktrees, snapshots, test runs, and driving the Codex and Gemini (agy) CLIs — lives here, and the
workflow's agents call it. Every subcommand prints one JSON object on its last line.

    dark-factory init        --repo DIR --seats A,B,C,D [--run-id ID] [--ref FILE]...
    dark-factory seat-run    --run-dir D [--vendor codex|gemini|claude] --seat KEY --job KEY --model M --effort E --cwd DIR
                        --prompt-file F --expect HASH [--sandbox MODE] [--writable DIR]... [--fresh]
                        [--checkout L-LABEL]   (first creates --cwd as a checkout of that snapshot)
                        (reads the payload from the relay's saved transcript when F is missing)
    dark-factory measure     --run-dir D --seat L --label rN [--since rM] [--tests T0A1,T1B2] [--no-snapshot]
                        [--replay-json JSON] [--brief]   (--brief: the result as Pair reads it, without
                        output tails; the job's status.json keeps the full record)
    dark-factory wait        --run-dir D --job KEY [--brief]
    dark-factory materialize --run-dir D --seat L --label rN [--name DIR]
    dark-factory usage       --run-dir D [--no-claude]
    dark-factory preflight   --vendors codex,gemini,claude
    dark-factory jobs        --run-dir D
    dark-factory cleanup     --run-dir D [--all]
    dark-factory retro       --run-dir D [--expect HASH] [--payload-file FILE] [--out-dir DIR]
                        (saves <run>/retro.md, plus the run's process notes read from the retro
                        agent's saved transcript, where they outlive the run)
    dark-factory hash        --file F

Long-running work (Codex and Gemini turns, test runs) executes as a detached job so it survives the 10-minute
Bash tool timeout: the command waits up to --max-wait seconds, then returns {"status": "running"}
and the caller polls with `dark-factory wait`.
"""

import argparse
import os
import sys

from .common import CouncilError, DEFAULT_MAX_WAIT, TRANSCRIPT_WAIT_SEC, emit, fail, prompt_hash, read
from .delivery import cmd_apply, cmd_verify_delivery
from .jobs import cmd_job, cmd_jobs, cmd_wait
from .measure import cmd_measure
from .pinning import pin_guard
from .providers import cmd_seat_run
from .retro import RETRO_DIR, TIMELINE_COMMANDS, cmd_retro, timeline_event
from .sandbox import cmd_preflight
from .setup import cmd_cleanup, cmd_init
from .snapshots import cmd_materialize
from .usage import cmd_usage
from .verification import cmd_evidence, cmd_verify


def cmd_hash(a):
    emit({'status': 'ok', 'hash': prompt_hash(read(a.file))})


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '_job':
        cmd_job(sys.argv[2])
        return

    ap = argparse.ArgumentParser(prog='dark-factory', description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('init')
    p.add_argument('--repo')
    p.add_argument('--seats', required=True)
    p.add_argument('--run-id')
    p.add_argument('--factory', action='store_true', help='capture delivery baseline and publish verification evidence')
    p.add_argument('--ref', action='append', help='a plan or other document the work follows; copied into <run>/refs/')
    p.add_argument('--started-at', help="the setup agent's own start time (ISO, from `date -u`); recorded as the timeline's setup-start")

    p = sub.add_parser('seat-run')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--vendor', default='codex', choices=['codex', 'gemini', 'claude'])
    p.add_argument('--seat', required=True, help='thread key; the vendor session is resumed per key')
    p.add_argument('--job', required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--effort', default='high')
    p.add_argument('--sandbox', default='workspace-write', choices=['read-only', 'workspace-write'])
    p.add_argument('--cwd', required=True)
    p.add_argument('--writable', action='append')
    p.add_argument('--prompt-file', required=True)
    p.add_argument('--expect')
    p.add_argument('--no-transcript', action='store_true', help='read only --prompt-file; never recover a payload from Claude transcripts')
    p.add_argument('--transcript-wait', type=float, default=TRANSCRIPT_WAIT_SEC,
                   help='seconds to wait for the relay transcript to appear')
    p.add_argument('--fresh', action='store_true')
    p.add_argument('--resume-session', help='require this exact saved session; fail rather than start fresh (no transient retry)')
    p.add_argument('--timeout-min', type=int, default=90)
    p.add_argument('--max-wait', type=int, default=DEFAULT_MAX_WAIT)
    p.add_argument('--checkout', help='SEAT-LABEL: create --cwd as a checkout of that snapshot first, if it does not exist')

    p = sub.add_parser('wait')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--job', required=True)
    p.add_argument('--max-wait', type=int, default=DEFAULT_MAX_WAIT)
    p.add_argument('--brief', action='store_true', help='print a finished measurement as Pair reads it, without output tails')

    p = sub.add_parser('measure')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--seat', required=True)
    p.add_argument('--label', required=True)
    p.add_argument('--since', help='label of the previous snapshot; also writes <seat>.delta.diff')
    p.add_argument('--tests')
    p.add_argument('--replay-json', help='Pair accepted testRoots and current file/command mapping as JSON')
    p.add_argument('--path')
    p.add_argument('--no-snapshot', action='store_true')
    p.add_argument('--suite-timeout', type=int, default=1200)
    p.add_argument('--test-timeout', type=int, default=300)
    p.add_argument('--max-wait', type=int, default=DEFAULT_MAX_WAIT)
    p.add_argument('--brief', action='store_true', help='print the finished result as Pair reads it, without output tails')

    p = sub.add_parser('materialize')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--seat', required=True)
    p.add_argument('--label', required=True)
    p.add_argument('--name', help='directory name under snap/ (default SEAT-LABEL)')

    p = sub.add_parser('verify', help='run a gate in the named checkout using the shared verification settings')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--path', required=True)
    p.add_argument('--label', required=True, help='unique label for this gate run')
    p.add_argument('--command-file', help='focused or red-test command; defaults to the full verify.sh gate')
    p.add_argument('--suite-timeout', type=int, default=1200)
    p.add_argument('--max-wait', type=int, default=DEFAULT_MAX_WAIT)

    p = sub.add_parser('evidence', help='validate the published historical-evidence bundle for a snapshot')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--seat', required=True)
    p.add_argument('--label', required=True)

    p = sub.add_parser('verify-delivery', help='compare delivered bytes and rerun the gate in the main checkout')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--result', help='saved result JSON or native workflow task output; defaults to RUN/result.json')
    p.add_argument('--manifest', help='JSON with adjustments and handoffs, each with path/reason/sha256')
    p.add_argument('--suite-timeout', type=int, default=1200)
    p.add_argument('--max-wait', type=int, default=DEFAULT_MAX_WAIT)
    p.add_argument('--diagnostic-reason', help='verify an incomplete run for diagnosis; records the reason without granting delivery readiness')

    p = sub.add_parser('apply', help='apply a ready reviewed snapshot to its base and verify the index tree hash')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--result', help='saved result JSON or native workflow task output; defaults to RUN/result.json')

    p = sub.add_parser('usage')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--no-claude', action='store_true', help='skip the Claude agents\' token use (read from transcripts)')

    p = sub.add_parser('jobs')
    p.add_argument('--run-dir', required=True)

    p = sub.add_parser('preflight')
    p.add_argument('--vendors', required=True, help='comma-separated: codex, gemini, claude')

    p = sub.add_parser('cleanup')
    p.add_argument('--run-dir', required=True)
    p.add_argument('--all', action='store_true', help='also delete the room transcript')

    p = sub.add_parser('retro')
    p.add_argument('--run-dir')
    p.add_argument('--facts-only', action='store_true', help='save only the factory run facts from the payload (no retro.md)')
    p.add_argument('--summary', action='store_true', help='tally the saved factory facts by tier')
    p.add_argument('--expect', help='hash of the process notes and run facts in the retro agent\'s prompt')
    p.add_argument('--payload-file', help='read the process notes and facts from this file instead of Claude transcripts')
    p.add_argument('--out-dir', help=f'where retros are kept (default $COUNCIL_RETRO_DIR or {RETRO_DIR})')
    p.add_argument('--transcript-wait', type=float, default=TRANSCRIPT_WAIT_SEC,
                   help='seconds to wait for the retro agent\'s transcript to appear')

    p = sub.add_parser('hash')
    p.add_argument('--file', required=True)

    a = ap.parse_args()
    if getattr(a, 'run_dir', None):
        a.run_dir = os.path.abspath(os.path.expanduser(a.run_dir))
    handlers = {'init': cmd_init, 'seat-run': cmd_seat_run, 'wait': cmd_wait, 'measure': cmd_measure,
                'verify': cmd_verify, 'verify-delivery': cmd_verify_delivery, 'evidence': cmd_evidence,
                'apply': cmd_apply,
                'materialize': cmd_materialize, 'usage': cmd_usage, 'jobs': cmd_jobs,
                'cleanup': cmd_cleanup, 'retro': cmd_retro, 'hash': cmd_hash, 'preflight': cmd_preflight}
    try:
        pin_guard(getattr(a, 'run_dir', None), repo=getattr(a, 'repo', None))
        if a.cmd in TIMELINE_COMMANDS and a.cmd != 'init' and getattr(a, 'run_dir', None) and os.path.isdir(a.run_dir):
            timeline_event(a.run_dir, a.cmd, getattr(a, 'job', None))
        handlers[a.cmd](a)
    except (CouncilError, OSError, ValueError) as e:
        fail(str(e))
