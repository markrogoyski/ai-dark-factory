# Ensemble: reviewed alternatives

[Documentation index](README.md) · [Project README](../README.md)

```text
/dark-factory:ensemble Compare fixes for the iterator boundary
$dark-factory --workflow ensemble --seats sol,astra Compare fixes for the iterator boundary
```

Ensemble uses the shared setup, separate worktrees, neutral snapshot checks, verification gate,
and host adapters. It retains its distinct stances and review lenses, followed by an advisory
comparison. It does not debate, repair, or select a winner. Specify `mode: "implement"` or
`"investigate"` when the wording is ambiguous.

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

Object arguments support `candidates` (2–6, default 4), `reviewers` (1–4, default 2; capped by
available lenses), and `models: {solve, review, compare}`. Claude defaults remain Sonnet solvers,
per-lens Sonnet/Opus reviewers, and an Opus comparison. Codex defaults use Astra solvers,
Astra reviewers, and an Astra comparison. Explicit `seats` chooses candidate models, using
the shared model catalog. If `candidates` is also supplied, its count must match `seats`.
References, criteria, verification, dirty-tree policy, explanation and run budgets are shared.

Each candidate includes its measured `final.snapshotRef`, `final.readiness`, review gaps, and
`delivery` status. Missing reviewers, stale reviewed trees, failed gates, or failed criteria
cannot become a ready candidate. The overall result remains `advisory` with delivery
`pending-selection` (Codex exit 2). Selecting an unchanged ready implementation allows its
candidate object to be saved as the delivery result for `verify-delivery`. A merged change
needs fresh measurement and independent review. With four candidates and two lenses the clean
path is now about 18 turns: setup, four solvers, four neutral checks, eight reviews, and comparison,
before external relay overhead or retries.

