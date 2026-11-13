# Pair: one author, one reviewer

[Documentation index](README.md) · [Project README](../README.md)

Use Pair for a scoped change you want one agent to own through completion, with independent
feedback before implementation and after every revision:

```text
/dark-factory:pair Implement the retry policy
/dark-factory:pair --author astra --reviewer opus Add cancellation support
```

In Codex:

```text
$dark-factory --workflow pair Implement the retry policy
$dark-factory --workflow pair --author opus --reviewer astra Add cancellation support
```

Pair defaults to Claude Opus author and Codex Astra reviewer in Claude Code, and Codex Astra
author and Claude Opus reviewer in Codex. `author` and `reviewer` select the roles independently
using the existing model names. An unspecified reviewer defaults to the other vendor. The
default pair needs both authenticated CLIs. Explicit `--author sol --reviewer astra` uses only
Codex models in the Codex host.

```text
  setup (Opus)        criteria, reference snapshots, the gate and its baseline; stops first
     |                on needs-plan, a dirty tree, conflicting requirements, or a criterion
     |                nothing in the run can verify (needs-user)
     v
  DESIGN STAGE
  author: design + test contract  ----------->  reviewer: design review, with a plausible
     ^    (one correction if malformed)         wrong implementation and the checks that
     |                                          reject it, for every criterion
     |                                                |
     +--------------- not approved: open findings ----+
                                                      | approved
                                                      v
  CODE STAGE
  +-> author: implement, or fix findings and failed checks; map checks to test files
  |      |
  |   measure (helper)   snapshot; replay the mapped tests on base and on the snapshot;
  |      |               run the full gate
  |      v
  |   reviewer: a fresh context and its own checkout of the measured snapshot
  |      |
  |      +-- ready: every criterion met, required checks pass --> done, delivery pending
  +------+-- findings or failed checks
         '-- the approach must change --> back to the design stage

  Every review counts against maxReviews (default 8, both stages together). The run stops
  unresolved when the budget is spent, when it stalls (same artifact, same open findings),
  when a clean review still lacks evidence, or when verification infrastructure fails.
```

1. A setup turn establishes acceptance criteria, reference documents, and the verification gate.
   The run inherits their quality, so setup runs on Claude Opus at `medium` effort whatever the
   participants are: Sonnet setup dropped stated criteria and stopped on guesses where Opus setup
   didn't. The one exception is a Codex author in the Codex host or the standalone runtime, whose
   setup runs on the author's own model at `medium`. On those runtimes an explicit `effort` applies
   instead of `medium`; natively in Claude Code setup always runs at `medium`. Factory's pair
   strategy follows the same rule. Every requirement the task or its documents state that the
   gate can't check, such as "run coverage and inspect the report", becomes its own criterion,
   citing document and line. A criterion that no evidence inside the run can meet (it needs
   post-delivery, production or live-service evidence) stops the run with `needs-user` before
   any author turn, with one question per criterion: rewrite it so the run can check it, or drop
   it. Setup lists only what it has established: a tool that might be missing is checked with one
   command first, and doubt, or a check refused only in setup's own sandbox, goes into the
   repository notes instead.
2. The author drafts a design and concrete test contract: criterion IDs, inputs, expected
   outcomes, boundaries, changed/preserved purpose, test files, commands, and fixtures. Criteria
   unsuitable for tests name an inspection and reason. An exception or error message that the
   task, a plan or a criterion specifies is asserted exactly, never by substring or a pattern
   anchored only at its end. The reviewer verifies test roots against
   the base configuration/layout and supplies a plausible wrong implementation plus rejecting
   check IDs for every criterion. The engine requires complete, valid challenges before approval.
   A reviewer who finds no rejecting check can return empty IDs with an evidenced finding,
   a partial/unmet assessment, or a design revision request; this returns the design to its author.
   A malformed contract or challenge gets one correction attempt before stopping. Correction turns count toward the
   run's turn budget and never count as design approval.
3. The author implements the reviewed design in its own worktree. The helper snapshots the
   change, replays the current mapped tests on the original base and final snapshot in disposable
   checkouts, and runs the existing full verification gate.
4. A fresh reviewer context inspects that snapshot, the tests, and every criterion. Findings
   receive stable IDs. Only the reviewer can mark them fixed or refuted, with evidence.
5. The author fixes findings and failed checks, then verification and review repeat. A material
   approach problem can send the task back through design review before implementation continues.

All actionable findings, including minor ones, must close. Optional preferences are reported
separately. The author retains its CLI session across design and implementation; native Claude
workflow turns carry an explicit handoff and private notes. Review contexts and checkouts are
fresh each time. Codex's runner executes measurements directly; Claude's workflow uses a
transport turn, on the Claude participant's model, to run the same helper with `--brief`. That
prints everything the engine checks, leaving out what each execution printed, its checkout path
and its log digest, so the transport retypes about a third of the record (8k characters instead of
22k on average). Both hosts hand the engine and the prompts that same summary. The author and
reviewer read the output tails in the job's full record, `<runDir>/jobs/measure-A-<label>/status.json`,
which their prompts name, or in the logs it lists. Its existing CLI relay handles external participants.
There is no council, panel, voting, or automatic escalation.

In Claude Code, `runtime: "cli"` (or `--runtime cli` at the start of a string task) runs the
whole Pair on the standalone runner instead: one Sonnet transport agent writes the arguments to
a file, runs `dark-factory-codex --workflow pair --brief --args-file FILE [--cwd REPO]` in the
background outside the Bash sandbox (the runner starts the Claude and Codex CLIs), waits for its
exit-code file, and returns the compact result `--brief` prints: status, stage, readiness,
findings, notes, metrics and `hostRunDir`, with `resultFile` naming the full `result.json`, which
is too large for an agent to relay. The runner's Claude setup turn runs `dark-factory init` inside
Claude's own sandbox, which refuses to write files such as `.gitmodules` anywhere; when copying an
ignored dependency directory hits one, init leaves those files out and names each on stderr. There are no per-turn relays or measurement
transports; the Claude author resumes its CLI session between turns, and the result records
exact `elapsedMs` and a checkpoint. The transport names the participants explicitly (Opus author
and Astra reviewer unless you choose others), so the runner's Codex defaults don't apply. To
resume an interrupted run, repeat the same arguments and add `resume` with the earlier result's
`hostRunDir`: `{"task": "…", "runtime": "cli", "resume": "/repo/.council/host-abc123"}`. Changed
arguments are refused on resume. The native path stays the default. The option is refused in the
Codex host, which always runs this runtime. Factory doesn't support it yet: its runner path
applies Codex role defaults to intake and the tiers.

Each implementation response maps approved check IDs to current files, focused commands, and
fixtures. Each focused command must isolate one test file. Separate files are preferred for
new-API and preserved-behavior tests; explicit user or plan file requirements take precedence.
Shared files need focused selections and a review of base loadability. A whole-suite final
obligation uses a designated-gate contract check without a replay mapping. Only
added/modified regular test and fixture files under the reviewed test roots are overlaid, using
snapshot bytes. Unchanged files use the base copy. Production/config/dependency changes, unsafe
paths and symlinks are excluded; renames/deletions are reported explicitly and are not overlaid.
Dependencies needed for replay must be visible to the reviewer, rather than silently copied.
Each execution gets a fresh checkout and the captured verification environment. Replay supplements
the full gate and uses the helper's focused-test timeout (default 300 seconds per command).
Base replay copies ignored dependencies from the original run repository and reports that author
dependency changes were excluded. Final replay uses the author's dependency installation, like
the full gate, so a package addition or upgrade can pass its final focused checks. Each command
gets a fresh dependency copy. Ignored dependencies still have the checkpoint limitations in [Process controls](process-controls.md#resume).

The helper's raw replay evidence, in the job's `status.json`, is at file/command granularity,
with check IDs, base/snapshot identity, cwd, exit/signal/timeout, launch errors, logs and output
tails. The measurement summary the engine reads drops the cwd, log digests and tails. A base fatal is a result even when no
individual assertions ran. Base passes, timeouts and tool errors also require reviewer judgment;
none automatically establishes or rejects intended changed behavior. An excluded or unscheduled
file has no execution result. Every changed check needs a base result; every executable check
needs a passing final result. Missing evidence is incomplete, and observed final failures block.
Only the reviewer can close findings, and the final review examines the whole implementation,
including omissions or weakening of the agreed checks and regressions introduced by fixes.
There is no extra review stage, chronological TDD enforcement, or separate contract-version system.

`maxReviews` (CLI: `--max-reviews`) limits total reviews across both stages, default **8**.
An unchanged artifact with the same open findings and verification results on consecutive
attempts stops as stalled; a criterion the reviewer moves between partial and met on the same
bytes does not count as progress. When the measurement itself fails for environmental reasons
(its disposable checkout can't be made, or the gate's environment fails after bounded recovery),
the run stops after that code review: readiness is `unverified` when no finding is open, with
the cause in `final.readiness.infrastructure`, and the reviewer is told not to file the missing
evidence as a finding. Budget exhaustion, incomplete reviews, failed required checks, or unresolved findings
never report readiness. A ready result requires review of the exact measured final snapshot,
all criteria met, and all required checks passing. When no automated gate exists, the result
records that it was not run. Pair currently delivers implementations; use council or factory
for standalone investigation and architecture work.

Object arguments, or the Codex runner's `--args-file`, accept `task`, `author`, `reviewer`,
`maxReviews`, `effort`, `context`, `plan`, `criteria`, `verify`, `repo`, `allowDirty`, and
`timeoutMin`. The existing model catalog and effort mapping apply. Pass absolute reference
paths in `plan`, including uncommitted documents. Worktrees start at HEAD; tracked local edits
require explicit `allowDirty` or an already clean checkout. Factory tier, panel, audit, and
historical-evidence options do not apply to Pair.

Results open with `summary` (status, readiness, open findings, snapshot, gate result, and the
cleanup command for after delivery), followed by `design`, `testContract`, `replayMapping`, `reviews`, `findings`, `stopReason`,
`final.replay`, and `final.readiness`. `final.suite` and `final.replay` are the measurement summary;
the job's `status.json` keeps the output tails. Replay requests and logs participate in existing cache and
checkpoint integrity. Ignored dependency directories and external toolchains retain the checkpoint
limitations in [Process controls](process-controls.md#resume). Changes stay
in `final.worktree`; a ready snapshot has `delivery.status: pending`. Apply it within the user's
authorization, then use the [delivery verification](verification-and-delivery.md). Pair does not automatically launch a council when it stops. The Codex host supports validated checkpoint resume; changed task inputs or evidence require a new run.

