# Ensemble: reviewed alternatives

[Documentation index](README.md) · [Project README](../README.md)

```text
/dark-factory:ensemble Compare fixes for the iterator boundary
$dark-factory --workflow ensemble --seats sol,astra Compare fixes for the iterator boundary
```

Use ensemble when you want several independent attempts at one task and will choose between
them yourself: a subtle bug, a design fork, an investigation where the obvious answer may be
wrong. Each candidate works blind under its own stance, is measured and reviewed through
several lenses, and an advisory comparison ranks them. Ensemble does not debate, repair, or pick
a winner; the [council](council.md) is the workflow that converges on one result. It shares the
council's setup (without the spec review), worktrees, neutral snapshot checks and verification
gate. Pass `mode: "implement"` or `"investigate"` when the wording is ambiguous.

```text
  setup: run dir, a worktree per candidate, criteria, gate (no spec review)
     |
     +-- candidate 1, stance minimal ----> neutral check --> lens reviews --+
     +-- candidate 2, stance root-cause -> neutral check --> lens reviews --+
     +-- candidate 3, stance edge-cases -> neutral check --> lens reviews --+
     +-- candidate 4, stance idiomatic --> neutral check --> lens reviews --+
     |   in parallel, each blind to the others                              |
     |                                                                      v
     |                                         each candidate's own readiness
     v
  compare (Opus, advisory): ranking, disagreements, a merge plan
     |
  result: status advisory, delivery pending-selection: you pick or merge
```

Implement mode's stances are minimal, root-cause, edge-cases, idiomatic, contrarian and
test-first, and its lenses correctness, verification, fit and simplicity. Investigate mode
uses trace-code, history, falsify, empirical, outside-in and analogy, reviewed for evidence,
refute and completeness. `candidates` and `reviewers` take that many from the front of each
list.

## Arguments

| arg | default | |
|---|---|---|
| `task` | required | |
| `mode` | auto | `implement` or `investigate` |
| `candidates` | 4 | 2–6 |
| `reviewers` | 2 | review lenses per candidate, 1–4, capped by the mode's lenses |
| `seats` | | candidate models, one per candidate (its length must match `candidates` when both are given); see [Choosing the models](models.md) |
| `models` | Claude Code: Sonnet solvers, Sonnet or Opus per lens, Opus compare; Codex: Astra for all three | `{solve, review, compare}` |
| `effort` | | for every solver, reviewer and the comparison |
| `plan`, `context`, `criteria`, `verify`, `repo`, `allowDirty` | | as in the [council](council.md#arguments) |
| `explain`, `maxTurns` | | see [Process controls](process-controls.md) |

## The result

Each candidate has its measured `final.snapshotRef`, `final.readiness`, review gaps, and
`delivery` status. A candidate with a missing review, a reviewed tree that is stale, a failing
gate or an unmet criterion is never ready. The overall result is always `advisory`, with delivery
`pending-selection` (Codex exit 2). An unchanged ready candidate can be delivered by saving its
candidate object as the delivery result for `verify-delivery`. A merge of candidates is a new change: it
needs its own measurement and independent review, for example a [pair](pair.md) run with the
merge plan as its task.

With four candidates and two lenses the clean path is about 18 turns: setup, four solvers, four
neutral checks, eight reviews, and the comparison, before relays and retries.
