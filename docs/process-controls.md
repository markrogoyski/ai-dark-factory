# Process controls, explanation, and resume

[Documentation index](README.md) · [Project README](../README.md)

## Explain and prepare

Use `--explain` to inspect the resolved process before implementation:

```text
$dark-factory --explain Add cancellation support
$dark-factory --workflow pair --explain Implement the retry policy
$dark-factory --strategy pair Implement the retry policy
```

Factory explanation runs its read-only intake, then returns the tier, strategy, participants,
reviewers, required CLIs, verification setting, limits, and expected deliverable. Missing plans,
split decisions, and tier disagreements still take precedence. Explanation of an explicit Pair,
Council, or Ensemble performs no model turns. It does not run setup, preflight, or verification,
and does not claim readiness. Architecture explicitly says it returns a plan without building.

`--prepare` is the offline counterpart: no model turn, no run directory, no account change.
It lists each vendor reachable from the request with the roles it could fill, checks that its
CLI answers `--version` (the same sandbox and Gemini-settings probe setup makes), and checks
that absolute `plan` documents exist. Tracked changes absent from HEAD are a warning, because
setup decides them for the run's mode. Authentication is reported as unknown. Every new single
run makes the same check first and stops with status `preflight` before intake when anything
blocks, so a missing CLI costs no intake turn. Resume and Run-plan are not prepared. The same
controls are available as object arguments in Claude Code.

## Budgets

- `maxTurns` (`--max-turns`) limits workflow model turns, including orchestration and explicit
  recovery turns. Retries inside a provider's CLI helper don't count.
- `maxRunMin` (`--max-run-min`) needs the standalone runner, which cancels active jobs at the
  deadline. Native Claude Code workflows reject it before launching work, because they have no
  replay-safe clock: use `maxTurns` there, or launch through `dark-factory-codex`. Run-plan uses
  that runner from both hosts, so its time limits always apply.
- `--timeout-min` is the per-turn deadline, and `--concurrency` bounds simultaneous turns in Codex.

These are limits, not price forecasts. Required work that runs out of budget is reported
incomplete; an optional retro that couldn't run doesn't erase a completed review. Across
resumes, Codex keeps the spent turns and active elapsed time (time between invocations is not
counted), and the saved `--concurrency` and `--timeout-min`. Passing either flag on resume
overrides its saved value for that and later resumes.

## Repairs

For Council and Factory's independent tiers, opt into repeated repairs with:

```json
{"task":"Fix the boundary case","repair":{"maxPasses":2,"minor":"block"},"maxTurns":60,"maxRunMin":45}
```

(`maxRunMin` only on the standalone runner.) Each repair is measured, then reviewed in fresh
contexts and separate checkouts. Findings keep stable IDs and evidence. The loop stops on
readiness, unchanged artifacts and verification outcomes, a missing review, or the repair limit
(1–20 passes). Reworded notes and reordered findings or criteria don't count as progress. By
default actionable minor findings must close; `minor: "report"` lists them in the report without
making them repair obligations. Preferences stay suggestions. Simple uses this loop by default,
with one repair pass, and keeps its escalation rules. Without `repair`, Council, Fix, Feature and
Architecture use their one-pass audit. Pair has its own design-and-code `maxReviews` budget and
strict finding closure instead.

## Resume

Codex saves a checkpoint when all in-flight operations at a boundary have completed successfully:

```sh
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc --args-file answers.json
```

A resume validates the engine, repository HEAD, tracked working/index changes, reference bytes,
tracked and unignored worktree files, snapshot refs, and saved evidence before reusing any operation. Completed
operations replay without model calls; new reviews remain fresh. A lock prevents two hosts
from continuing the same run. The same task and execution options must be retained. Allowed
updates are appended answers to the paused run's question IDs, `tierConfirmed`, `noSplit`,
`explain`, run-wide budgets, and explicit concurrency or per-turn timeout overrides. For a debate question the host preserves its `afterRound`. Pair author questions are free text; incorporate those answers into `context` in a new run.

Host metadata and results use atomic file replacement. Resume recovers an unterminated final
event record before appending more events, preserving all preceding records and their turn
counts. A valid final record without a newline is retained; malformed completed records still
stop resume with a diagnostic.

If an interrupted write changed a worktree, or inputs/evidence changed, resume fails with the
mismatch and leaves all files intact. Start a new run in that case; no checkpoint is silently
reset and no dependent review is reused. Ignored dependency directories and external toolchains are not frozen by the checkpoint; start a new run if those inputs change. An interruption before the first successful boundary
may have no checkpoint. A new run after a changed task should carry the full questions and
answers in `context`, rather than old question IDs. `hostRunDir`, `checkpoint`, and `hostEvents`
in the result identify the saved artifacts.

