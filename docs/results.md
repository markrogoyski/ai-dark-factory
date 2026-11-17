# Reading a result

[Documentation index](README.md) · [Project README](../README.md)

Every run ends with a result object. Native Claude Code runs return it to the launching
session; the Codex host also saves it as `<hostRunDir>/result.json` and `<runDir>/result.json`,
with a compact `summary.json` beside it. Read three fields, in this order: `status` (how the run
ended), `final.readiness` (whether the result can be trusted), and `delivery` (whether it has
reached your checkout). A `done` status alone says nothing about readiness.

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
| `preflight` | a CLI the lineup needs can't run from this session; nothing was created. In Claude Code, setup's preflight reports this as `blocked`, with the CLI in `reason` | install or authorize it, or swap its seats ([Choosing the models](models.md)) |
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

A Pair run, and a Run-plan that committed Pair tasks, can be `ready` with live checks pending:
`final.readiness.liveChecks` lists the criteria the run could check only against a stand-in for
something outside it, such as a network service or credentials, each with the command or action
that checks it against the real thing. Run them before delivery; the run isn't done until they
pass. See [Pair](pair.md#live-checks).

## `delivery`: has it reached your checkout

| `delivery.status` | meaning |
|---|---|
| `pending` | ready, still in its worktree: apply it when you're ready |
| `not-ready` | readiness isn't `ready`, so there is nothing to deliver |
| `pending-selection` | ensemble: choose a candidate first |

Delivery is a separate step: `dark-factory apply`, then `dark-factory verify-delivery`, which
writes `<runDir>/delivery.json` with `status: delivered` only when the delivered bytes match the
reviewed snapshot and the gate passes in your checkout. See
[Verification and delivery](verification-and-delivery.md).

## Other fields worth reading

- `report.markdown`: the run's own account (the council's report, the tier's report, the pair's
  reviews), computed from the ledger and rulings, not written by a model.
- `final.suite` (Pair): the gate's result on the reviewed snapshot. `final.suite.overrides` is the
  explicit `env` object from `verification.json` the gate ran with, `{}` when there are none;
  when it is non-empty, `report.markdown` names each overridden variable. Overrides are
  reported, not judged: they don't change `final.readiness`.
- `forTheOrchestrator`: instructions for the launching session, such as what to show you first.
- `questions`, `decisions`, `unusedAnswers`, `resumable`, `resumeSteps` (Pair): the current stop's
  questions as `{id, about, kind, question}`, IDs Q1, Q2, … unique across the run; the answers the
  run took, each with the question, the answer and the turn that asked it; answers no stop took;
  and, only on a needs-user stop that can continue (setup's conflict or unverifiable criterion,
  an author's or a reviewer's questions), `resumable: true` with the host's steps to continue it.
  Other results, budget stops included, carry neither. See [Pair](pair.md#answering-a-stop).
- `retro`: suggested changes to the workflow itself; see [Process retro](process-retro.md).
- `metrics`: turns, findings and tokens; see [Evaluating process value](evaluation.md).
- `runDir` and `hostRunDir`: where the evidence is. Keep them until the work is delivered, and
  for a resume.
