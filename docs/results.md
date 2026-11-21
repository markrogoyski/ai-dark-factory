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
| `needs-user` | a question only you can settle (spec review with `spec: 'ask'`, a question most seats raised, a criterion nothing in the run can verify, or a question from a pair author or reviewer) | answer it: `clarifications` for the council; for a pair (or factory pair) result with `resumable: true`, `clarifications` keyed by its question IDs to continue the run, as its `resumeSteps` say ([Pair](pair.md#answering-a-stop)), otherwise `context` for a new pair run; `answers` for run-plan |
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
| `unverified` | pair: no open findings, but the measurement itself failed for environmental reasons; the cause is in `final.readiness.infrastructure` |
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
    conflict or unverifiable criterion, an author's or a reviewer's questions). Other results,
    budget stops included, carry neither.

  See [Pair](pair.md#answering-a-stop).
- `retro`: suggested changes to the workflow itself ([Process retro](process-retro.md)).
- `metrics`: turns, findings and tokens ([Evaluating process value](evaluation.md)).
- `runDir` and `hostRunDir`: where the evidence is. Keep them until the work is delivered, and
  for a resume.
