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

Pair defaults to a Claude Opus author and a Codex Astra reviewer in Claude Code, and the reverse
in Codex. `author` and `reviewer` take any seat name from [Choosing the models](models.md),
independently. An unspecified reviewer is the other vendor, so the default pair needs both
authenticated CLIs. `--author sol --reviewer astra` uses only Codex models.

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
     +--- not approved: open blocker/major findings --+
                                                      | approved (minor findings
                                                      | carry into code review)
                                                      v
  (a design not approved after maxDesignReviews reviews stops and asks the user)
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
  Every review counts against maxReviews (default 8, both stages together).
```

## Setup

Setup establishes the acceptance criteria, reference documents and verification gate. It runs on
Claude Opus at `medium` effort whatever the participants are (Sonnet setup dropped stated criteria
and stopped on guesses). The exception is a non-Claude author (Codex, Gemini or OpenRouter) on the
Codex host or standalone runtime: setup runs on the author's model. Setup effort is `medium`, except on the Codex host and the
standalone runtime, where an explicit `effort` applies whatever the author (a Sonnet author with
`effort: xhigh` gets Opus setup at `xhigh`). Natively in Claude Code it is always `medium`.
Factory's pair strategy follows the same rule.

- **Criteria.** Every requirement the task or its documents state that the gate can't check, such
  as "run coverage and inspect the report", becomes its own criterion, citing document and line.
  The task itself is passed on unchanged; setup adds observations and interpretations beside it,
  and lists only what it has established (a doubt, or a check refused only in setup's sandbox, goes
  into the repository notes).
- **Unverifiable criteria.** A criterion no evidence inside the run can meet (it needs
  post-delivery, production or live-service evidence) stops the run with `needs-user` before any
  author turn, with one question per criterion: rewrite it so the run can check it, or drop it.
- **Gate and baseline.** Setup writes the gate to `verify.sh` and explicit overrides to
  `verification.json`.
  - Natively in Claude Code, setup runs `dark-factory measure --label base` and reports
    `baselinePasses` and `baselineNote`.
  - On the standalone runtime (the Codex host, `runtime: "cli"`, Run-plan), setup is a sandboxed
    model turn where a refused socket bind or blocked network call can fail a gate that passes
    outside it. It is told not to measure, and not to add overrides, PATH wrappers or debug flags
    for failures it sees only in its sandbox. The runner measures the base instead (job
    `measure-A-base`, no model turn), replacing setup's `baselinePasses` and `baselineNote`.

  A failing baseline is reported to the author and reviewer as the reason plus the end of the
  failing output, on one line of at most 300 characters; the run continues. Factory's pair
  strategy works the same way.

## Design stage

The author drafts a design and a test contract (criterion IDs, inputs, expected outcomes,
boundaries, changed/preserved purpose, test files, commands, fixtures) and reconciles setup's
interpretations with the request.

- A criterion unsuitable for tests names an inspection and a reason.
- A final whole-suite obligation is a gate check: `kind: "gate"`, `purpose: "preserved"`, the exact
  verification command, `file: ""`, `fixtures: []`. It needs no replay mapping and doesn't replace
  the baseline checks for changed behaviour.
- An exception or error message that the task, a plan or a criterion specifies is asserted
  exactly, never by substring or a pattern anchored only at its end.

The reviewer checks the interpretations against the request, reference documents and explicit
decisions, and the test roots against the base layout. For every criterion it supplies a plausible
wrong implementation and the check IDs that reject it; the engine requires complete, valid
challenges before approval. A reviewer who finds no rejecting check returns empty IDs with an
evidenced finding, a partial/unmet assessment, or a design revision request, which sends the design
back to the author. A malformed contract or challenge gets one correction attempt before the run
stops; corrections count toward the turn budget and never count as approval.

**Minor findings don't hold the design.** Open blocker and major design findings block design
approval; open minor ones don't. They stay open into the code stage, where every open finding
blocks readiness, and the code-stage author and reviewer prompts name them as carried items to fix
and check against the implementation. The design reviewer is told to raise new findings for
defects that affect an acceptance criterion, correctness or scope, and to leave benchmark,
documentation and wording detail to code review unless a criterion depends on it; a criterion can
be assessed met when the design satisfies it apart from minor findings. A challenge with no
rejecting check needs a blocker or major finding (or a partial/unmet assessment, or a design
revision request): a minor one can't stand in for it.

**The design's review allowance.** In the retros no run that ended ready used more than two
design reviews, while the runs that spent most of the budget on design ended with little or no
code reviewed. So a design still not approved after `maxDesignReviews` design reviews (default 3)
stops the run with `needs-user` instead of reviewing it again. The stop has one question, of kind
`design`, that gives how each design round went (new findings, the blocker, major and minor
findings left open, the design's size in words), the open design findings, the reviews left, and
the choices:

- **Continue the design**: answer with a scope decision the author and reviewer then follow, for
  example narrowing the scope or accepting named findings as documented residuals (the reviewer
  resolves them under their IDs). The design gets `maxDesignReviews` more reviews.
- **Start the implementation**: answer with `implement: true`. The current design and contract
  become the approved ones, and the open design findings, major ones included, carry into code
  review as open items that block readiness until the reviewer closes them.
- **Stop**: don't continue the run.

The allowance counts every design review in the run, a return from the code stage included. A
design never moves on past an open blocker or major finding without your answer. The stop comes
only while reviews remain: an allowance that would outrun `maxReviews` ends the run on the budget
instead.

## Code stage

1. The author implements the reviewed design in its own worktree. The helper snapshots the change,
   replays the mapped tests on base and snapshot in disposable checkouts, and runs the full gate
   ([Pair replay](verification-and-delivery.md#pair-replay)).
2. A fresh reviewer inspects the snapshot, tests and every criterion. Findings get stable IDs; only
   the reviewer can mark them fixed or refuted, with evidence.
3. The author fixes findings and failed checks, then measurement and review repeat. A material
   approach problem can send the task back through design review.

All actionable findings, including minor ones and those carried from the design stage, must
close; optional preferences are reported separately. The author's `addressed` entry for each
finding says whether it `changed` the work or `disputed` the finding.

### Readings

Every author turn lists in `readings` each place it reads a requirement, criterion or approved
contract check other than literally (an exact list read as a minimum, an open threshold it
settled, two requirements it reconciled). A reading left only in a handoff or note is not
reviewed. The engine numbers them R1, R2, … in a ledger both participants see, and the next review
rules on each, accepted or rejected with evidence (a missing, repeated or unknown ruling gets the
review's one correction). An accepted reading is settled for the run; a rejected one becomes an
open major finding, which only the reviewer can close.

### Questions from the reviewer

In either review, the reviewer can stop the run when a finding or reading can be settled only by
you: two requirements that can't both hold as written, or one its evidence shows is impossible,
with no reading inside the task's words that settles it. It returns a question quoting each
requirement involved and can rule that reading `needs-user`. The run stops with `needs-user` after
that review, as it does when the author asks; the review counts. A question without a quoted
requirement, or a `needs-user` ruling no question cites, gets the review's one correction. See
[Answering a stop](#answering-a-stop).

### Live checks

Some criteria the run can check only against a stand-in for something outside it (a network
service, credentials, the machine's certificate store or another platform-specific resource, an
external CLI's login), where the real thing can behave differently. In one run an HTTP preflight
passed review and the gate with its call stubbed, then failed on its first live call because
python.org's Python has an empty CA store.

Setup lists such criteria in `liveChecks`, each with the command or action that checks it against
the real thing and why the stand-in can't show it; an author turn adds any its work introduces.
They are not unverifiable: the run still checks them with the stand-in, and the reviewer assesses
them on the evidence inside the run without running the live checks.

A run can be `ready` with live checks pending. `final.readiness.liveChecks` lists them, the
report's readiness line reads "Readiness: ready; live checks pending: C3, C5." followed by each
check, and `forTheOrchestrator` says to run each against the real thing before delivery. The run
isn't done until they pass.

### Without a design stage

`design: false` (`--no-design` at the start of a string task, or on the Codex runner's command
line) skips the design stage. Use it when the deliverable is itself a document or plan: the
approved design would be the deliverable, and designing first writes and reviews the same text
twice.

- The first author turn writes the deliverable and its test contract together, under the same
  contract rules (a document's criteria are usually inspection checks, with `testRoots` empty when
  no check is a test), plus the replay mapping; a malformed one gets the same single correction.
  The run then loops through the code stage only.
- No design review approved the contract, so the code reviewer reviews it with the artifact (test
  roots, coverage, whether its checks would reject a plausible wrong implementation). The first
  code review, and any review after the contract changed since one last passed this check, returns
  the same structured challenge as a design review, under the same validation and correction.
- The author keeps the contract current every turn (an empty one keeps it in force). A change
  counts as a new version, so stall detection sees it as progress.
- A reviewer who finds the approach itself must change files a finding, and the author reworks it
  next turn. A `requiresDesignRevision` flag only blocks readiness until a later review clears it.
- Review budget, stall detection and readiness are unchanged. Factory's pair strategy always
  designs first.

## Sessions, measurement and review

The author keeps its CLI session across design and implementation; native Claude workflow turns
carry an explicit handoff and private notes. Review contexts and checkouts are fresh each time.
External participants' turns go through the CLI relay. There is no council, panel, voting or
automatic escalation.

Codex's runner executes measurements directly; Claude's workflow uses a transport turn, on the
Claude participant's model, to run the helper with `--brief`, which omits each execution's output,
checkout path and log digest. Both hosts give the engine and prompts the same summary. The author
and reviewer read output tails in the job's full record,
`<runDir>/jobs/measure-A-<label>/status.json`, or in the logs it lists.

### The standalone runner in Claude Code

`runtime: "cli"` (or `--runtime cli` at the start of a string task) runs the whole Pair on the
standalone runner instead of the native path, which is the default. One Sonnet transport agent
writes the arguments to a file, runs `dark-factory-codex --workflow pair --brief --args-file FILE
[--cwd REPO]` in the background outside the Bash sandbox, waits for its exit-code file, and returns
the compact `--brief` result: status, stage, readiness, findings, notes, metrics,
`forTheOrchestrator` (including showing the retro) and `hostRunDir`. `resultFile` names the full
`result.json`, too large for an agent to relay.

- No per-turn relays or measurement transports. The Claude author resumes its CLI session between
  turns, and the result records exact `elapsedMs` and a checkpoint.
- The transport names the participants (Opus author, Astra reviewer unless you choose others), so
  the runner's Codex defaults don't apply.
- To resume an interrupted run, repeat the same arguments and add `resume` with the earlier
  result's `hostRunDir`: `{"task": "…", "runtime": "cli", "resume": "/repo/.council/host-abc123"}`.
  Changed arguments are refused.
- The option is refused in the Codex host, which always runs this runtime. Factory doesn't support
  it: its runner path applies Codex role defaults to intake and the tiers.

## Answering a stop

Five stops ask you questions and can continue once you answer: setup's conflicting requirements,
setup's criterion nothing in the run can verify, an author's `needs-user`, a reviewer's
questions, and a design that used its [review allowance](#design-stage) without approval. Every
other stop is final and carries no `resumable` flag or resume guidance: blocked, stalled, budget
exhausted (`maxReviews`, `maxTurns` or `maxRunMin`; including a stop that asked questions but ran
out of budget), failed, verification infrastructure failure, and a dirty tree.

Question IDs Q1, Q2, … are unique across the run; a second stop continues the numbering.
`questions` lists the current stop's as `{id, about, kind, question}`, and `report.markdown` lists
them under "Questions for the user (answer each under its ID)". `kind` is `setup`, `criterion`,
`author`, `reviewer` or `design`. `about` is the criterion of a criterion question, the first
finding, criterion or reading ID (P3, C2, R1) a question names, or `none`.

A resumable result has `resumable: true` and `resumeSteps` (also in `forTheOrchestrator`) saying
how to continue on its host:

- Claude Code (`/pair` or `/factory`): in the **same session only**, call the Workflow tool with
  `resumeFromRunId` of the stopped run and the same args plus `clarifications`. Earlier turns
  replay from the session's cache. A new session has no cache; start a new run instead.
- The Codex host: write a JSON file holding `{"clarifications": […]}` and run
  `dark-factory-codex --resume <hostRunDir> --args-file <file>`; the other arguments stay those of
  the stopped run.
- `runtime: "cli"` in Claude Code: the same args plus `runtime: "cli"`, `resume: "<hostRunDir>"`
  and `clarifications`, from any session.

An answer is `{id, answer}` under the question's ID; earlier entries stay unchanged and in order.
An answer to a `criterion` question may also give `criterion` (the new text) or `drop: true`. IDs
are never renumbered, and dropping every criterion stops the run as blocked. An answer with neither
keeps the criterion and is recorded as a decision. An answer to a `design` question continues the
design with the answer as a scope decision, or, with `implement: true`, starts the implementation
with the open design findings carried into code review.

| Stop | On resume |
|---|---|
| Setup conflict | Setup runs again (`setup-answered`) with the decisions, in a new run directory, and pays the baseline again. |
| Unverifiable criterion | The criterion is rewritten or dropped; the run goes on to its first author turn. |
| Author | A fresh author turn (`pair-design-1-answered`, for example), then a review of what it writes. |
| Reviewer | The rest of that review's pass runs (readiness, stall and design-revision handling), then the next author turn. |
| Design allowance | A fresh design author turn with the decision and another `maxDesignReviews` reviews; with `implement: true`, the first implementation turn (`pair-code-4`, for example). |

A resume reuses the run directory, worktree, criteria, baseline, findings, readings and reviews
already spent. The review budget never resets: a stop in the review that spent the last of it ends,
once answered, as budget exhausted. Every resumed design or code gets a fresh review.

**Decisions.** Every later setup, author and review prompt carries the answers in an "Explicit user
decisions" block, which overrides setup observations and readings for the rest of the run; the
reviewer resolves a finding a decision settles under its existing ID. The review `Version` gains a
`:u<hash>` suffix, so no review from before an answer counts for the version after it. A reading
ruled `needs-user` goes back to proposed when an answered question cites it. `decisions` lists
`{id, about, kind, question, answer, label}` (`label` is the turn that asked, plus `criterion`,
`drop` or `implement` when given); `report.markdown` lists them under "User decisions".

**Answers that don't settle the stop** stop the run again at once with `needs-user`, no further
turn and no retro. These are a missing, empty or repeated answer, a malformed ID or one the run
never asked, `criterion` or `drop` where they don't apply or both together, a non-text `criterion`,
a `drop` that is not true or false (`null` included), and an `implement` on a question that is not
of kind `design`, or that is not true or false. `stopReason` names them, for example "The
answers do not settle this stop (Q1, Q2). Missing: Q2. Unknown: Q9. Answer every question at this
stop under its ID, and only questions this run asked."

- In Claude Code the run can't tell a replayed stop from a live one, so an ID numbered above every
  question asked so far is held for a later stop; if the run never asks it, `unusedAnswers` and
  `report.markdown` ("Unused answers") list it.
- The runner checks every answer, saved and new, against the run's own questions on every resume
  before any turn, and returns `needs-user` with `answerIssues` (missing, unknown and invalid IDs),
  writing nothing. An answer saved with the first arguments that no stop took is unknown there;
  remove it and resume again.
- Once the answers settle the stop, they cannot change: a changed one fails with "Existing
  clarification answers cannot change on resume."

**Keep the state intact.** Don't run `dark-factory cleanup` on a stopped run you mean to continue,
and leave its worktree and your checkout as they are. In Claude Code, each resumable stop records
the author's worktree (HEAD and every file) and the last snapshot ref in
`<runDir>/stops/<Qn>.json` (`dark-factory resume-check --record`, which keeps an earlier record).
Just before the run continues, `dark-factory resume-check` refuses, changing nothing, when:

- HEAD has moved from setup's base;
- the checkout or its index differs from setup's as `apply` judges it;
- the worktree differs from the record;
- the snapshot ref is missing or points at another commit (even with the same tree);
- the stop was already continued with other answers.

A refusal stops the run as blocked, and a stop that couldn't be recorded cannot continue; both say
to start a new run with the answers in `context` and the last handoff in `plan`. The runner's
checkpoint validation refuses the same changes. A setup conflict has no run yet, so no record.

## When the run stops

`maxReviews` (CLI: `--max-reviews`) limits total reviews across both stages, default **8**.
`maxDesignReviews` (`--max-design-reviews`) is how many design reviews may pass without approval
before the run stops for you ([above](#design-stage)), default **3**.

- **Stalled.** An unchanged artifact with the same open findings and verification results on
  consecutive attempts, or unchanged unmet criteria or failed verification with no open finding. A
  criterion moving between partial and met on the same bytes is not progress.
- **Clean but unproven.** A clean review that still lacks evidence returns an incomplete result
  without another cycle.
- **Infrastructure failure.** When measurement fails for environmental reasons (its disposable
  checkout can't be made, or the gate's environment fails after bounded recovery), the run stops
  after that code review. Readiness is `unverified` when no finding is open, with the cause in
  `final.readiness.infrastructure`; the reviewer is told not to file the missing evidence as a
  finding.
- **Never ready.** Budget exhaustion, incomplete reviews, failed required checks or unresolved
  findings never report readiness. Ready requires review of the exact measured final snapshot, all
  criteria met and all required checks passing. When no automated gate exists, the result records
  that it was not run.

Pair delivers changes (code, or a document with `design: false`); use council or factory for
investigation and architecture work.

### Retro

Pair ends with a [process retro](process-retro.md) once setup has made a run; a run that stops in
setup has none. Setup, the author, the reviewer and the relays can each leave a process note (the
measurement transport leaves none), and one agent turns them with the run facts and report into
suggested workflow changes, returned as `retro` and saved outside the run. It counts toward
`maxTurns`. It runs on Sonnet in Claude Code. On the standalone runtime it runs on the Codex host's
retro role (Astra) when the pair already uses Codex, otherwise on Sonnet, or on the author's model
when no participant is Claude, so it never needs a CLI the pair doesn't. Factory's pair strategy
always records the run facts and runs the model retro only on a notable run.

## Arguments

Object arguments, or the Codex runner's `--args-file`:

| arg | default | |
|---|---|---|
| `task` | required | |
| `author` | `opus` in Claude Code, `astra` in Codex | any seat name; `--author` at the start of a string task |
| `reviewer` | the other vendor: `astra` for a Claude author, else `opus` | `--reviewer` |
| `maxReviews` | 8 | total reviews across design and code, 2–100; `--max-reviews` |
| `maxDesignReviews` | 3 (`maxReviews` − 2 when that is smaller, at least 1) | design reviews without approval before the run asks you how to go on, 1 to `maxReviews` − 1; `--max-design-reviews`; ignored with `design: false` |
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

Factory tier, panel, audit and historical-evidence options (`tier`, `seats`, `simple`, `panel`,
`spec`, `audit`, `roles`, `evidence`) are refused.

## Results

Results open with `summary` (status, readiness, open findings, snapshot, gate result, and the
cleanup command for after delivery), followed by `design`, `testContract`, `replayMapping`,
`reviews`, `findings`, `stopReason`, and:

- `readings`, each with its ruling (also in `report.markdown`).
- `questions`, `decisions`, `unusedAnswers`, `resumable`, `resumeSteps`: see
  [Answering a stop](#answering-a-stop).
- `liveChecks`: the [live checks](#live-checks) still to run (also in `final.readiness.liveChecks`).
- `final.replay`, `final.suite` and `final.readiness`. The first two are the measurement summary;
  the job's `status.json` keeps the output tails.

`report.markdown` tells the run in "How the run went" (setup, each author pass, each review, each
question and answer, and how the run ended), logging each line as it happens. "Points of interest"
follows: author disputes and how each ended, findings that took more than one revision, blockers,
readings accepted or rejected, and code reviews that sent the work back to design.

`final.suite.overrides` (also in `summary.final.suite`) is the explicit `env` object from the run's
`verification.json` that the measured gate ran with, `{}` when there are none; the base environment
is never included. When non-empty, `report.markdown` shows a "Verification overrides" line naming
each variable, so an override setup added (a `PATH` wrapper, a debug flag) is visible. Overrides
never change `final.readiness`.

Changes stay in `final.worktree`; a ready snapshot has `delivery.status: pending`. Apply it within
your authorization, then follow [delivery](verification-and-delivery.md#delivery). Pair never
launches a council when it stops.

Replay requests and logs are part of the cache and checkpoint integrity checks. Ignored dependency
directories and external toolchains have the checkpoint limitations in
[Process controls](process-controls.md#resume). The Codex host supports validated checkpoint
resume; changed task inputs or evidence require a new run. A result says how to resume only when it
is a stop you can answer.
