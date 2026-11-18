# Ensemble: reviewed alternatives

[Documentation index](README.md) · [Project README](../README.md)

```text
/dark-factory:ensemble Compare fixes for the iterator boundary
$dark-factory --workflow ensemble --seats sol,astra Compare fixes for the iterator boundary
```

Use ensemble when you want several independent attempts at one task and will choose between them
yourself: a subtle bug, a design fork, an investigation where the obvious answer may be wrong.
Each candidate works blind under its own stance, is measured and reviewed through several lenses,
and an advisory comparison ranks them. Ensemble does not debate, repair or pick a winner; the
[council](council.md) converges on one result. It shares the council's setup (without the spec
review), worktrees, neutral snapshot checks and verification gate. Pass `mode: "implement"` or
`"investigate"` when the wording is ambiguous.

```text
  setup: run dir, a worktree per candidate, criteria, gate (no spec review)
     |
  N candidates in parallel, each blind to the others:
     stance -> solve -> neutral check -> lens reviews -> its own readiness
     |
  compare (Opus, advisory): ranking, disagreements, a merge plan
     |
  result: status advisory, delivery pending-selection: you pick or merge
```

| mode | stances | review lenses |
|---|---|---|
| implement | minimal, root-cause, edge-cases, idiomatic, contrarian, test-first | correctness, verification, fit, simplicity |
| investigate | trace-code, history, falsify, empirical, outside-in, analogy | evidence, refute, completeness |

`candidates` and `reviewers` take that many from the front of each list.

## Arguments

| arg | default | |
|---|---|---|
| `task` | required | |
| `mode` | auto | `implement` or `investigate` |
| `candidates` | 4 | 2–6 |
| `reviewers` | 2 | review lenses per candidate, 1–4, capped by the mode's lenses |
| `seats` | | candidate models, one per candidate (length must match `candidates` when both are given); see [Choosing the models](models.md) |
| `models` | Claude Code: Sonnet solvers, Sonnet or Opus per lens, Opus compare; Codex: Astra for all | `{solve, review, compare}` |
| `effort` | `high` | every solver, reviewer and the comparison; see [Effort](models.md#effort) |
| `plan`, `context`, `criteria`, `verify`, `repo`, `allowDirty` | | as in the [council](council.md#arguments) |
| `explain`, `maxTurns` | | see [Process controls](process-controls.md) |

## The result

`report.markdown` lists the run under "How the run went": each candidate's solution and gate
result, its reviews (verdict, score and defects per lens) with its readiness, and the advisory
comparison. Candidates run in parallel, so their lines interleave as they finish; the run logs
each line as it happens.

Each candidate has its measured `final.snapshotRef`, `final.readiness`, review gaps and
`delivery` status. A candidate with a missing review, a stale reviewed tree, a failing gate or an
unmet criterion is never ready. The overall result is always `advisory`, with delivery
`pending-selection` (Codex exit 2).

- **Deliver one candidate:** if it is ready and unchanged, save its candidate object as the
  delivery result for `verify-delivery`.
- **Merge candidates:** a merge is a new change and needs its own measurement and independent
  review, for example a [pair](pair.md) run with the merge plan as its task.

The clean path with four candidates and two lenses is about 18 turns: setup, four solvers, four
neutral checks, eight reviews and the comparison, before relays and retries.
