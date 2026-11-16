# Pair: one author, one reviewer

[Documentation index](README.md) · [Project README](../README.md)

Use Pair for a scoped change you want one agent to own through completion, with independent
feedback before implementation and after every revision:

```text
/dark-factory:pair Implement the retry policy
/dark-factory:pair --author astra --reviewer opus Add cancellation support
/dark-factory:pair --no-design Write the utility refactoring plan in UTIL_REFACTOR_PLAN.md
```

In Codex:

```text
$dark-factory --workflow pair Implement the retry policy
$dark-factory --workflow pair --author opus --reviewer astra Add cancellation support
$dark-factory --workflow pair --no-design Write the utility refactoring plan in UTIL_REFACTOR_PLAN.md
```

Pair defaults to a Claude Opus author and a Codex Astra reviewer in Claude Code, and a Codex
Astra author and a Claude Opus reviewer in Codex. `author` and `reviewer` take any seat name from
[Choosing the models](models.md), independently. An unspecified reviewer defaults to the other
vendor, so the default pair needs both authenticated CLIs. `--author sol --reviewer astra` uses
only Codex models.

```text
  setup (Opus)        criteria, reference snapshots, the gate and its baseline; stops first
     |                on needs-plan, a dirty tree, conflicting requirements, or a criterion
     |                nothing in the run can verify (needs-user)
     |
  baseline            natively, setup measured it; on the standalone runtime the runner
     |                measures the base itself (helper), outside setup's sandbox
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
   repository notes instead. The task itself is passed on unchanged: setup adds repository
   observations and proposed interpretations beside it, never in place of it.

   Setup writes the gate to `verify.sh` and its explicit overrides to `verification.json`. Who
   measures the baseline depends on the runtime. Natively in Claude Code, setup runs
   `dark-factory measure --label base` itself and reports `baselinePasses` and `baselineNote`.
   On the standalone runtime (the Codex host, `runtime: "cli"`, and Run-plan) setup is a
   sandboxed model turn, where a refused socket bind or a blocked network call can fail a gate
   that passes outside it. There setup is told not to measure, and not to add overrides, PATH
   wrappers or debug flags for failures it sees only inside its own sandbox. After setup returns,
   the engine asks the runner to measure the base revision (job `measure-A-base`, no model turn),
   and that measurement replaces setup's `baselinePasses` and `baselineNote`. A failing baseline
   is reported to the author and reviewer as the reason and the end of the failing output, on
   one line of at most 300 characters, and the run continues as it does for any failing
   baseline. Factory's pair strategy works the same way.
2. The author drafts a design and concrete test contract: criterion IDs, inputs, expected
   outcomes, boundaries, changed/preserved purpose, test files, commands, and fixtures, and
   reconciles setup's interpretations with the request. Criteria unsuitable for tests name an
   inspection and reason. A final whole-suite obligation is a gate check: `kind: "gate"`,
   `purpose: "preserved"`, the exact verification command, `file: ""` and `fixtures: []`. It
   needs no replay mapping and doesn't replace the baseline checks for changed behaviour. An
   exception or error message that the task, a plan or a criterion specifies is asserted
   exactly, never by substring or a pattern anchored only at its end. The reviewer checks the
   interpretations against the original request, the reference documents and explicit
   decisions; a contradiction neither can resolve needs your input. It verifies test roots
   against the base configuration/layout and supplies a plausible wrong implementation plus
   rejecting check IDs for every criterion. The engine requires complete, valid challenges
   before approval. A reviewer who finds no rejecting check can return empty IDs with an
   evidenced finding, a partial/unmet assessment, or a design revision request; this returns
   the design to its author. A malformed contract or challenge gets one correction attempt
   before stopping. Correction turns count toward the run's turn budget and never count as
   design approval.
3. The author implements the reviewed design in its own worktree. The helper snapshots the
   change, replays the current mapped tests on the original base and final snapshot in disposable
   checkouts, and runs the full verification gate.
4. A fresh reviewer context inspects that snapshot, the tests, and every criterion. Findings
   receive stable IDs. Only the reviewer can mark them fixed or refuted, with evidence.
5. The author fixes findings and failed checks, then verification and review repeat. A material
   approach problem can send the task back through design review before implementation continues.

Every author turn, in either stage and with or without a design stage, lists in `readings` each
place its work reads a requirement, criterion or approved contract check other than literally:
an exact list read as a minimum, an open threshold it settled, two requirements it reconciled, a
contract setup it checks another way. A reading left only in a handoff or a note is not reviewed.
The engine numbers readings R1, R2, … in a ledger both participants see, and the next review
rules on each proposed one, accepted or rejected with evidence; a missing, repeated or unknown
ruling gets the review's one correction. An accepted reading is settled for the rest of the run.
A rejected one becomes an open major finding, which only the reviewer can close.

The reviewer, in design or code review, can stop the run for you. When a finding or a reading
can be settled only by the user (two requirements that can't both hold as written, or one that
the reviewer's evidence shows is impossible as written, with no reading inside the task's words
that settles it), it returns a question quoting each requirement involved, and can rule that
reading `needs-user`. The run then stops with `needs-user` after that review, as it does when the
author asks: the review counts, its findings and rulings are recorded, and `questions` holds each
question with the requirements it quotes. A question without a quoted requirement, or a
`needs-user` ruling no question cites, gets the review's one correction.

### Live checks

Some criteria the run can check only against a stand-in for something outside it, where the real
thing can behave differently: a network service, credentials, the machine's certificate store or
another platform-specific resource, an external CLI's login. In one run an HTTP preflight passed
review and the gate with its call stubbed, and failed on its first live call because python.org's
Python has an empty CA store. Setup lists such criteria in `liveChecks`, each with the command or
action that checks it against the real thing and why the stand-in can't show it, and an author
turn adds any its design or implementation introduces; repeated entries are dropped. They are not
unverifiable: the run still checks them with the stand-in. The reviewer sees the list and assesses
those criteria on the evidence inside the run, without running the live checks. Readiness keeps
its state, so a run can be `ready` with live checks pending: `final.readiness.liveChecks` lists
them, the report's readiness line reads "Readiness: ready; live checks pending: C3, C5." followed
by each check, and `forTheOrchestrator` says to run each one against the real thing before
delivery. Such a run isn't done until they pass.

### Without a design stage

`design: false` (`--no-design` at the start of a string task, or on the Codex runner's command
line) skips step 2, the design and its review. Use it when the deliverable is itself a document or a
plan: there the approved design is the deliverable, and a run that designs first writes and
reviews the same text twice. In one such run the approved design was 19.4K characters and the
delivered plan 18.8K; the implementation turn re-read the code only to transcribe the design,
and about 5.5 of 23.6 minutes went to doing it twice.

The first author turn writes the deliverable and its test contract together, under the same
contract rules (a document's criteria are usually inspection checks, with `testRoots` empty when
no check is a test), plus the replay mapping. A malformed contract or mapping gets the same single
correction attempt. The run then loops through the code stage only: measure, code review, fix.
Because no design review approved the contract, the code reviewer reviews it as part of the
artifact: its test roots against the base layout, its coverage of the request and every
criterion, and whether its checks would reject a plausible wrong implementation. The first code
review, and any review after the contract changed since a review last passed this check, returns
the same structured challenge a design review does (one plausible wrong implementation per
criterion, with the contract checks that reject it), under the same validation and single
correction. The author keeps the contract current in every turn (an empty one keeps the
contract in force), so a contract change counts as a new version, and stall detection sees it as
progress. A reviewer who finds the approach itself must change files a finding and the author
reworks it in the next turn; there is no design stage to return to, and a
`requiresDesignRevision` flag only blocks readiness until a later review clears it. The review
budget, stall detection, and readiness are otherwise unchanged. Factory's pair strategy always
designs first.

### Sessions, measurement and review

All actionable findings, including minor ones, must close. Optional preferences are reported
separately. The author keeps its CLI session across design and implementation; native Claude
workflow turns carry an explicit handoff and private notes. Review contexts and checkouts are
fresh each time. Codex's runner executes measurements directly; Claude's workflow uses a
transport turn, on the Claude participant's model, to run the same helper with `--brief`. That
prints everything the engine checks, leaving out what each execution printed, its checkout path
and its log digest, so the transport retypes about a third of the record (8k characters instead of
22k on average). Both hosts hand the engine and the prompts that same summary. The author and
reviewer read the output tails in the job's full record, `<runDir>/jobs/measure-A-<label>/status.json`,
which their prompts name, or in the logs it lists. External participants' turns go through the
CLI relay. There is no council, panel, voting, or automatic escalation.

How the mapped tests are replayed on base and snapshot, and what evidence each replay records,
is in [Pair replay](verification-and-delivery.md#pair-replay).

In Claude Code, `runtime: "cli"` (or `--runtime cli` at the start of a string task) runs the
whole Pair on the standalone runner instead: one Sonnet transport agent writes the arguments to
a file, runs `dark-factory-codex --workflow pair --brief --args-file FILE [--cwd REPO]` in the
background outside the Bash sandbox (the runner starts the Claude and Codex CLIs), waits for its
exit-code file, and returns the compact result `--brief` prints: status, stage, readiness,
findings, notes, metrics, `forTheOrchestrator` (the guidance the orchestrating session acts on,
including showing the retro) and `hostRunDir`, with `resultFile` naming the full `result.json`, which
is too large for an agent to relay. There are no per-turn relays or measurement
transports; the Claude author resumes its CLI session between turns, and the result records
exact `elapsedMs` and a checkpoint. The transport names the participants explicitly (Opus author
and Astra reviewer unless you choose others), so the runner's Codex defaults don't apply. To
resume an interrupted run, repeat the same arguments and add `resume` with the earlier result's
`hostRunDir`: `{"task": "…", "runtime": "cli", "resume": "/repo/.council/host-abc123"}`. Changed
arguments are refused on resume. The native path is the default. The option is refused in the
Codex host, which always runs this runtime. Factory doesn't support it: its runner path
applies Codex role defaults to intake and the tiers.

### When the run stops

`maxReviews` (CLI: `--max-reviews`) limits total reviews across both stages, default **8**.
An unchanged artifact with the same open findings and verification results on consecutive
attempts stops as stalled, as do unchanged unmet criteria or failed verification even with no
open finding; a criterion the reviewer moves between partial and met on the same bytes does not
count as progress. A clean review that still lacks evidence returns a precise incomplete result
without another author/reviewer cycle. When the measurement itself fails for environmental
reasons (its disposable checkout can't be made, or the gate's environment fails after bounded
recovery), the run stops after that code review: readiness is `unverified` when no finding is
open, with the cause in `final.readiness.infrastructure`, and the reviewer is told not to file
the missing evidence as a finding. Budget exhaustion, incomplete reviews, failed required checks,
or unresolved findings never report readiness. A ready result requires review of the exact
measured final snapshot, all criteria met, and all required checks passing. When no automated
gate exists, the result records that it was not run. Pair delivers changes (code, or a document
with `design: false`); use council or factory for investigation and architecture work.

Like the other workflows, Pair ends with a [process retro](process-retro.md) once setup has
made a run. Setup, the author, the reviewer and the relays can each leave a process note (the
measurement transport, which must return the helper's result exactly, leaves none), and one
agent turns the notes, the run facts and the report into suggested changes to the workflow,
returned as `retro` and saved outside the run. It runs on Sonnet in Claude Code. In the
standalone runtime it runs on the Codex host's retro role (Astra) when the pair already uses
Codex, otherwise on Sonnet, or on the author's model when no participant is Claude, so it never
needs a CLI the pair doesn't. It counts toward `maxTurns`. A run that stops in setup has no retro.
Factory's pair strategy keeps the factory's rule instead: it always records the run facts and
runs the model retro only on a notable run.

## Arguments

Object arguments, or the Codex runner's `--args-file`:

| arg | default | |
|---|---|---|
| `task` | required | |
| `author` | `opus` in Claude Code, `astra` in Codex | any seat name; `--author` at the start of a string task |
| `reviewer` | the other vendor: `astra` for a Claude author, else `opus` | `--reviewer` |
| `maxReviews` | 8 | total reviews across design and code, 2–100; `--max-reviews` |
| `design` | true | `false` (`--no-design`) skips the design stage; see [above](#without-a-design-stage) |
| `effort` | `high` | for both participants, or per seat: `{astra: 'xhigh'}` |
| `context` | | extra context for every turn |
| `plan` | | absolute path or list of paths: reference documents, including uncommitted ones |
| `criteria` | written by setup | your own acceptance criteria, as a list of strings |
| `verify` | found by setup | the verification command |
| `repo` | session cwd | run against another repository |
| `allowDirty` | false | worktrees start at HEAD, so tracked local edits are refused unless set |
| `timeoutMin` | 90 | deadline for a Codex, Gemini or OpenRouter turn, in minutes |
| `retro` | true | `false` (`--no-retro`) turns off the [process retro](process-retro.md) |
| `runtime` | native | `"cli"` (`--runtime cli`) runs on the standalone runner; Claude Code only |

Factory tier, panel, audit, and historical-evidence options (`tier`, `seats`, `simple`, `panel`,
`spec`, `audit`, `roles`, `evidence`) are refused.

## Results

Results open with `summary` (status, readiness, open findings, snapshot, gate result, and the
cleanup command for after delivery), followed by `design`, `testContract`, `replayMapping`,
`reviews`, `findings`, `readings` (each with its ruling, also listed in `report.markdown`),
`stopReason`, `questions` (when setup, the author or the reviewer stops the run for you, also
listed in `report.markdown` under "Questions for the user"), `liveChecks` (the
[live checks](#live-checks) still to run, also in `final.readiness.liveChecks`), `final.replay`,
and `final.readiness`. `final.suite` and `final.replay` are the measurement summary; the job's
`status.json` keeps the output tails.
`final.suite.overrides` (also in `summary.final.suite`) is the explicit `env` object from the
run's `verification.json` that the measured gate ran with, as the measurement read it, and `{}`
when there are none; the base environment is never included. When it is non-empty,
`report.markdown` says so in a "Verification overrides" line naming each variable, so an
override setup added (a `PATH` wrapper, a debug flag) is visible. Overrides never change
`final.readiness`.
Replay requests and logs are part of the cache and checkpoint integrity checks. Ignored
dependency directories and external toolchains have the checkpoint limitations in
[Process controls](process-controls.md#resume). Changes stay in `final.worktree`; a ready
snapshot has `delivery.status: pending`. Apply it within the user's authorization, then follow
[delivery](verification-and-delivery.md#delivery). Pair never launches a council when it stops.
The Codex host supports validated checkpoint resume; changed task inputs or evidence require a
new run.
