# Process controls, explanation, and resume

[Documentation index](README.md) · [Project README](../README.md)

## Explain and prepare

`--explain` shows the resolved process before implementation:

```text
$dark-factory --explain Add cancellation support
$dark-factory --workflow pair --explain Implement the retry policy
$dark-factory --strategy pair Implement the retry policy
```

- **Factory** runs its read-only intake, then returns the tier, strategy, participants, reviewers,
  required CLIs, verification setting, limits and expected deliverable. Missing plans, split
  decisions and tier disagreements still take precedence. Architecture says it returns a plan
  without building.
- **Explicit Pair, Council or Ensemble** runs no model turns, setup, preflight or verification, and
  claims no readiness.

`--prepare` is the checking counterpart: no model turn, no run directory, no account change. It:

- lists each vendor reachable from the request with the roles it could fill (an OpenRouter seat
  as `openrouter:<model-id>`);
- checks that each CLI answers `--version` (the same sandbox and Gemini-settings probe setup
  makes);
- checks that absolute `plan` documents exist;
- warns about tracked changes absent from HEAD, because setup decides them for the run's mode;
- reports authentication as unknown, except OpenRouter's answer to the key check.

It is offline unless the request names an OpenRouter seat; then it sends two authenticated GET
requests (`/v1/key` and `/v1/models`) to check the key and model ID.

Every new single run makes the same check first and stops with status `preflight` before intake
when anything blocks, so a missing CLI costs no intake turn. Resume and Run-plan are not prepared.
In Claude Code the same controls are object arguments.

## Budgets

| Option | Limits |
|---|---|
| `maxTurns` (`--max-turns`) | Workflow model turns, including orchestration and explicit recovery turns. Retries inside a provider's CLI helper don't count. |
| `maxRunMin` (`--max-run-min`) | Run time. Needs the standalone runner, which cancels active jobs at the deadline. Native Claude Code workflows reject it before launching work (no replay-safe clock): use `maxTurns`, or launch through `dark-factory-codex`. Run-plan always uses that runner, so its time limits always apply. |
| `--timeout-min` | Per-turn deadline. |
| `--concurrency` | Simultaneous turns in Codex. |

These are limits, not price forecasts. Required work that runs out of budget is reported
incomplete; an optional retro that couldn't run doesn't erase a completed review.

Across resumes, Codex keeps spent turns, active elapsed time (time between invocations doesn't
count) and the saved `--concurrency` and `--timeout-min`. Passing either flag on resume overrides
the saved value from then on.

## Repairs

For Council and Factory's independent tiers, opt into repeated repairs:

```json
{"task":"Fix the boundary case","repair":{"maxPasses":2,"minor":"block"},"maxTurns":60,"maxRunMin":45}
```

(`maxRunMin` only on the standalone runner.) Each repair is measured, then reviewed in fresh
contexts and separate checkouts. Findings keep stable IDs and evidence.

- **Stops** on readiness, unchanged artifacts and verification outcomes, a missing review, or the
  repair limit (`maxPasses`, 1–20, default 2). Reworded notes and reordered findings or criteria don't count
  as progress.
- **`minor`** defaults to `"block"`: actionable minor findings must close. `"report"` lists them
  in the report without making them repair obligations. Preferences stay suggestions.
- **Defaults.** Simple uses this loop with one repair pass and keeps its escalation rules. Without
  `repair`, Council, Fix, Feature and Architecture use their one-pass audit. Pair has its own
  design-and-code `maxReviews` budget and strict finding closure instead.

## Resume

Codex saves a checkpoint when all in-flight operations at a boundary have completed successfully:

```sh
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc --args-file answers.json
```

Before reusing any operation, resume validates the engine, repository HEAD, tracked working and
index changes, reference bytes, tracked and unignored worktree files, snapshot refs and saved
evidence. Completed operations replay without model calls; new reviews stay fresh. A lock stops two
hosts continuing the same run.

**What you may change.** Keep the same task and execution options. Allowed updates are:

- appended answers to the paused run's question IDs (a debate question keeps its `afterRound`);
- `tierConfirmed`, `noSplit`, `explain`;
- run-wide budgets;
- explicit `--concurrency` or `--timeout-min` overrides.

Pair author questions are free text: put those answers in `context` of a new run.

**When resume fails.** If an interrupted write changed a worktree, or inputs or evidence changed,
resume fails with the mismatch and leaves all files intact; nothing is silently reset and no
dependent review is reused. Start a new run. Do the same if ignored dependency directories or
external toolchains change, because the checkpoint doesn't freeze them. After a changed task, carry
the full questions and answers in `context`, not old question IDs. An interruption before the first
successful boundary may leave no checkpoint.

**Recovery.** Host metadata and results use atomic file replacement. Resume recovers an
unterminated final event record before appending, keeping all preceding records and their turn
counts. A valid final record without a newline is kept; malformed completed records stop resume
with a diagnostic.

`hostRunDir`, `checkpoint` and `hostEvents` in the result identify the saved artifacts.
