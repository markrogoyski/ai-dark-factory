# Reading a result

[Documentation index](README.md) · [Project README](../README.md)

Every run ends with a result object. Native Claude Code runs return it to the launching session;
the Codex host also saves it as `<hostRunDir>/result.json` and `<runDir>/result.json`, with a
compact `summary.json` beside it. Read three fields, in this order:

1. `status`: how the run ended.
2. `final.readiness`: whether the result can be trusted. A `done` status alone says nothing about
   it.
3. `delivery`: whether it has reached your checkout.

## Following a run as it goes

Each workflow logs its milestones while it runs. In Claude Code they appear in the workflow's
live view (`/workflows`); on the Codex host they are `log` events on the runner's stderr and in
`<hostRunDir>/events.jsonl`. Pair, the Simple tier and ensemble log the same lines their report
later lists under "How the run went". The council's tiers log each spec ruling, round, vote,
audit ruling and fix pass. In Claude Code the launching session hears from the run only when it
ends; the Codex skill polls the runner and can relay progress as it goes.

Outside the council, each milestone line also ends with the run's token use so far, for example
`pair: Code review 2/8 by Claude Opus: approved. Criteria all met. · tokens so far: 1.2M in (1.1M cached) / 31k out`.
On the Codex host it counts every turn the helper has recorded (each milestone reads only what
`usage.jsonl` gained since the last one), and adds `; 1 turn not counted yet` when a turn's CLI
reported no usage. In Claude Code the workflow can read no files, so the line shows only Claude
Code's budget meter, the output tokens spent since the workflow started (`Claude output so far ≈
42k (budget meter)`): it includes anything else the session spent meanwhile, and none of the
input, Codex or Gemini tokens. The story the report and the retro prompt quote keeps the line
without it.

To follow a Claude Code run from a terminal, run `dark-factory watch` in the directory the
workflow was started from. The helper is on the agents' PATH, not your shell's, so give its path:

    ~/.claude/plugins/cache/ai-dark-factory/dark-factory/*/bin/dark-factory watch   # marketplace install
    plugins/dark-factory/bin/dark-factory watch                                    # in a clone, after ./install.sh

It follows the newest running workflow, or waits for one to start. It prints a line on stderr as each agent starts and ends,
with a short summary of the result: a relay's findings and criteria, a vote, the gate, the first
sentence of a summary. When the run ends, it prints the run's log lines. Those lines aren't
available sooner: Claude Code saves them only at the end. `--run wf_<id>` replays or follows one
run, and `--once` prints what has happened so far and exits. It reads Claude Code's own run files
(`~/.claude/projects/<project>/<session>/subagents/workflows/wf_<id>/`), which aren't
documented, so a Claude Code release can change them; watch then says what it couldn't read.

## `status`: how the run ended

| status | meaning | what to do |
|---|---|---|
| `done` | the process ran to its end | read `final.readiness` |
| `advisory` | ensemble: ranked candidates, no winner chosen | pick or merge a candidate; see [Ensemble](ensemble.md) |
| `needs-plan` | the task depends on a document the run couldn't find | rerun with the document's absolute path in `plan` |
| `needs-split` | the task is several independent pieces | run each listed piece on its own, or rerun with `noSplit: true` |
| `needs-tier` | intake would pick a tier other than the one you pinned | rerun with `tierConfirmed: true`, or with intake's tier |
| `needs-user` | a question only you can settle (spec review with `spec: 'ask'`, a question most seats raised, a criterion nothing in the run can verify, a conflict a pair's spec review found in the criteria, or a question from a pair author or reviewer) | answer it: `clarifications` for the council; for a pair (or factory pair) result with `resumable: true`, `clarifications` keyed by its question IDs to continue the run, as its `resumeSteps` say ([Pair](pair.md#answering-a-stop)), otherwise `context` for a new pair run; `answers` for run-plan |
| `blocked` | the run stopped without a usable result, for example a pair whose review budget ran out or that stalled, or a plan with parked tasks | read the open findings and `stopReason` |
| `preflight` | a CLI the lineup needs can't run from this session, or (in Claude Code) its settings don't allow `Bash(dark-factory:*)`; nothing was created. In Claude Code, setup's preflight reports this as `blocked`, with the CLI or the permission in `reason` | install or authorize the CLI, or swap its seats ([Choosing the models](models.md)); add the permission ([Installing](install.md#permission-required)) |
| `explained`, `prepared` | `--explain` or `--prepare`: nothing was implemented | read the plan it reports |
| `failed`, `error` | the run itself failed (an agent or transport error) | see [Gotchas and troubleshooting](gotchas.md) |

The Codex runner's exit code follows the same split: 0 for a ready result (or `explained` and
`prepared`), 2 for a decision to make or a result that isn't ready, 1 for a failure, including
`preflight`.

## `final.readiness`: can it be trusted

Code, not a model, sets readiness from the checks, and it never changes which result was chosen.

| state | meaning |
|---|---|
| `ready` | every criterion met, the verification gate and published tests pass on the exact reviewed snapshot, no upheld blocker or major finding |
| `blocked` | something is wrong: an unmet criterion, a failing gate or test, a fabricated verification, an upheld blocker or major finding |
| `incomplete` | something wasn't checked: no measurement, an unrun suite, an unjudged criterion, a missing review, an unresolved ruling |
| `unverified` | pair: no open blocker or major findings, but the measurement itself failed for environmental reasons; the cause is in `final.readiness.infrastructure` |
| `not-assessed` | an explanation run: nothing was reviewed |

`final.readiness.blocked` and `final.readiness.incomplete` list the reasons. Ensemble reports a
readiness for each candidate instead.

A Pair run, or a Run-plan that committed Pair tasks, can be `ready` with live checks pending.
`final.readiness.liveChecks` lists the criteria the run could check only against a stand-in for
something outside it, such as a network service or credentials, each with the command or action
that checks it against the real thing. Run them before delivery; the run isn't done until they
pass ([Pair](pair.md#live-checks)).

## `delivery`: has it reached your checkout

| `delivery.status` | meaning |
|---|---|
| `pending` | ready, still in its worktree: apply it when you're ready |
| `not-ready` | readiness isn't `ready`, so there is nothing to deliver |
| `pending-selection` | ensemble: choose a candidate first |

Delivery is a separate step: `dark-factory apply`, then `dark-factory verify-delivery`. It writes
`<runDir>/delivery.json` with `status: delivered` only when the delivered bytes match the
reviewed snapshot and the gate passes in your checkout. See
[Verification and delivery](verification-and-delivery.md).

## Other fields worth reading

- `report.markdown`: the run's own account, computed from the ledger and rulings, not written by
  a model. Pair, the Simple tier, ensemble and run-plan reports open with "How the run went"
  ("How the plan went" for run-plan): one numbered line per milestone, such as a review with its
  findings and rulings, the author's reply to each finding, a repair pass, or a stop. Pair adds
  "Points of interest": the author's disputes and how they ended, findings that took more than
  one revision, blockers, and readings the reviewer ruled on. The council's tiers use "How the
  debate went", "The debates" and the audit sections.
- `final.suite` (Pair): the gate's result on the reviewed snapshot. `final.suite.overrides` is
  the explicit `env` object from `verification.json` the gate ran with, `{}` when there are none;
  when non-empty, `report.markdown` names each overridden variable. Overrides are reported, not
  judged: they don't change `final.readiness`.
- `forTheOrchestrator`: instructions for the launching session, such as what to show you first.
- `questions`, `decisions`, `unusedAnswers`, `resumable`, `resumeSteps` (Pair):
  - `questions`: the current stop's questions as `{id, about, kind, question}`, with IDs Q1, Q2,
    … unique across the run.
  - `decisions`: the answers the run took, each with the question, the answer and the turn that
    asked it. `unusedAnswers`: answers no stop took.
  - `resumable: true` with `resumeSteps`: only on a needs-user stop that can continue (setup's
    conflict or unverifiable criterion, a spec review conflict, an author's or a reviewer's
    questions, or a design that used its review allowance). Other results, budget stops included,
    carry neither.

  See [Pair](pair.md#answering-a-stop).
- `retro`: suggested changes to the workflow itself ([Process retro](process-retro.md)).
- `metrics`: turns, findings and tokens ([Evaluating process value](evaluation.md)); see
  [Token use](#token-use).
- `runDir` and `hostRunDir`: where the evidence is. Keep them until the work is delivered, and
  for a resume.

## Token use

Outside the council, `report.markdown` ends with a "Token use" table: per model, the turns, input,
cached input, cache writes, output and the turns' summed wall time, as counted when the run ended.
On the Codex host `metrics.tokens` then has the complete count, written by the runner after the
workflow returns, with each turn's line in `<hostRunDir>/tokens.json` (`metrics.tokens.turnsFile`).
For a native Claude Code run, `dark-factory usage --run-dir RUN` prints the same report, and the
evaluator fills `metrics.tokens` the same way.

`metrics.tokens` (version 2) has:

- `total`, `byModel`, `byRole` (setup, author, reviewer, seat, checker, relay, intake, …) and
  `byVendor`, each `{turns, input, cachedInput, cacheCreation, output, seconds}`. `input` is
  every prompt token the model read: uncached input, cache reads (`cachedInput`) and cache writes
  (`cacheCreation`) together. Codex reports cached tokens inside its input and Claude and agy
  beside it; the accountant adds them up the same way for each. `output` includes reasoning.
  `seconds` is wall time per turn, summed; turns run in parallel, so it can exceed the run's
  active time (`metrics.elapsedMs`).
- `sources`: how many turns came from each source:
  - `helper-usage`: the helper's `usage.jsonl` record of a vendor CLI turn (Codex
    `turn.completed`, the claude CLI's result envelope, OpenRouter seats, agy's answer).
  - `codex-rollout`, `claude-transcript`: a turn whose CLI reported no usage (a timeout, a lost
    envelope), read back from the vendor's own log for the turn's time window. Codex rollouts are
    under `$CODEX_HOME/sessions` by thread, Claude transcripts under
    `$CLAUDE_CONFIG_DIR/projects` by session (an OpenRouter seat's own configuration directory).
  - `native-transcript`: a native workflow's own agents, from Claude Code's transcript
    directory for the workflow (`projects/<project>/<session>/subagents/workflows/wf_<id>/`),
    found by an agent that names one of the run's directories. Every agent of that workflow
    counts, including intake, which runs before the run directory exists, and the relays.
- `complete` and `missing`: a turn no source covers is listed in `missing` with its job, role,
  vendor, model and the reason, and `complete` is false. A missing turn is never counted as
  zero, so a partial total is a lower bound. What stays partial: an agy turn that returned no
  answer (agy keeps its conversations in binary SQLite records the accountant does not parse), a
  turn recorded before the helper noted thread and time window, and a native run whose Claude
  Code transcripts are gone (Claude Code deletes old ones) or were never found.

`dark-factory usage` runs `lib/usage.mjs`, so it needs node; without it, the helper prints its
older reading (the helper's records and Claude agents found by the run directory), marked
`complete: false`. No dollar figure is computed anywhere: prices change and are not recorded.
