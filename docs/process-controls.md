# Process controls, explanation, and resume

[Documentation index](README.md) · [Project README](../README.md)

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
blocks, so a missing CLI no longer costs an intake turn. Resume and Run-plan are not prepared.
The same controls are available as object arguments in Claude Code.

`maxTurns` (`--max-turns`) limits workflow model turns, including orchestration and explicit
recovery turns. Provider transport retries within a turn remain governed by that CLI helper.
`maxRunMin` (`--max-run-min`) requires the standalone runner, which cancels active jobs at the deadline.
Native Claude workflows reject this option before launching work because they have no replay-safe
clock; use `maxTurns` there, or launch through `dark-factory-codex` for a time limit. Run-plan uses
that runner from both hosts and retains its time limits. `--timeout-min` remains the
per-turn deadline, and `--concurrency` bounds simultaneous turns in Codex. These are limits,
not price forecasts. Exhausted required work remains incomplete. An optional retrospective
that could not run does not erase a completed review. Codex retains spent turns and active
elapsed time across resumes; time spent waiting between invocations is excluded.
Codex also retains `--concurrency` and `--timeout-min` across resumes. Supply either flag on
resume to override its saved value; that override becomes the default for subsequent resumes.

For Council and Factory's independent tiers, opt into repeated repairs with:

```json
{"task":"Fix the boundary case","repair":{"maxPasses":2,"minor":"block"},"maxTurns":60,"maxRunMin":45}
```

Each repair is measured, then reviewed in fresh contexts and separate checkouts. Existing
findings retain stable IDs and evidence. The loop stops on readiness, unchanged artifacts and
verification outcomes, missing review, or the repair limit (1–20 passes). Reworded notes and
reordered findings or criteria do not count as repair progress. The default minor policy
requires actionable minor findings to close; `minor: "report"` retains them in the report without
making them repair obligations. Preferences remain suggestions. Simple uses this fresh-review
loop by default with one repair pass and retains its escalation rules. Council, Fix, Feature,
and Architecture retain their original audit path unless `repair` is supplied. Pair continues
to use its separate design-and-code `maxReviews` budget and strict finding closure.

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

