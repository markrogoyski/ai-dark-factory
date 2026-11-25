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
  goal brief (Opus)   shape the outcome and challenge it, or re-check a groomed ticket or a
     |                supplied brief; a question only you can settle stops the run (needs-user)
     |
  setup (Opus)        criteria, reference snapshots, the gate and its baseline; stops first
     |                on needs-plan, a dirty tree, a task built on uncommitted changes,
     |                conflicting requirements, or a criterion nothing in the run can
     |                verify (needs-user)
     |
  baseline            natively, setup measured it; on the standalone runtime the runner
     |                measures the base itself (helper), outside setup's sandbox
     |
  spec review         one fresh reviewer reads the criteria against the task, its documents,
     |                the run's rules and the code; a conflict only you can settle stops the
     |                run (needs-user), and your answer runs setup again; anything a reading
     |                settles goes to the author's readings ledger
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
  |      +-- ready, no minor findings open --> done, delivery pending
  |      +-- ready, minor findings open --> polish pass: the author fixes or declines
  |      |      them, the helper measures, a short check confirms; done either way,
  |      |      with the polish set aside if it broke anything
  +------+-- blocker or major findings, or failed checks
         '-- the approach must change --> back to the design stage
  Ready means every criterion met, required checks passing and no blocker or major finding
  open. Every review counts against maxReviews (default 8, both stages together); the polish
  check does not.
```

## Goal brief

Before setup, a standalone Pair settles its goal as [Factory does](factory.md#goal-brief): a
shaper writes the outcome, purpose, scope and acceptance examples, and a fresh challenger looks
for two outcomes your wording permits that you would judge differently, settling what it can from
the repository. Setup, the author and the reviewer read the brief when the criteria leave a
judgment call open.

- **Cost.** 2 Opus turns on an ungroomed task. A [groomed ticket](groom.md) as the task, or an
  absolute path to a settled `BRIEF.json` in `brief`, gets one re-check turn instead. Answering a
  question costs one more. [Groom](groom.md#what-a-run-does-with-the-task) has the full table.
- **Questions** stop the run with `needs-user` before setup, with IDs `B1`, `B2`, … (kind
  `brief`). Resume as for any [stop](#answering-a-stop).
- **Skip it** with `brief: false` (`--no-brief`), as before this stage existed. `--explain` doesn't
  run it, and Factory's pair strategy carries Factory's brief instead.
- A run whose task was a groomed ticket returns `ticket`, the ticket as the run settled it.

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
- **Work not in HEAD.** When the task, context or a reference document tells the author to apply
  a patch, diff, stash or saved snapshot first, or says the work to fix is uncommitted, setup
  stops before creating the run (setup status `needs-commit`; the run ends `blocked`). The
  baseline would be measured on HEAD without those changes, the reviewers' checkouts would lack
  them, and applying them in the worktree fails in the sandbox. Commit them first (a WIP commit on
  your branch is fine; squash it after delivery) and rerun; don't stash them and hand the run a
  patch. Earlier commits, branches, and reference documents passed in `plan` are fine.
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

## Spec review

Setup writes the criteria, so it is not an independent check of them. In the retros, a
conflict between two criteria, or between a criterion and the rules Pair imposes, was found only
by a design review, one to three reviews in, and then stopped the run for the user anyway: a test
file a criterion fixed that the isolation rule ruled out, a named mechanism against a stated
complexity limit, two criteria no input could meet together. So after setup (and on the
standalone runtime after the runner's baseline), one fresh reviewer reads the criteria before the
first author turn, with or without a design stage.

- **Who.** The pair's reviewer model (Codex Astra by default in Claude Code, Claude Opus in
  Codex) at `medium` effort, in a fresh read-only context in the repository. `spec: false` skips
  it; `spec: {model: 'sonnet', effort: 'low'}` swaps either. Factory's pair strategy takes it as
  `pair: {spec: …}`.
- **What it looks for.** Contradictions between criteria, or between a criterion and the task, a
  reference document, an explicit user decision or the rules the run holds the work to (its own
  worktree, test roots, separate files for tests of new code, the base replay, the gate). Criteria
  that are wrong about how the code works. Requirements the task or a document states that no
  criterion carries. It doesn't ask for more criteria than the task calls for, report preferences,
  or recheck whether a criterion can be verified (setup did that).
- **A finding a reading settles** (an ambiguity with a conservative reading, a criterion that
  misdescribes the code but has an obvious correct reading) goes to the author as S1, S2, … with
  the reading the reviewer proposes. Both participants see them under "Spec review findings". The
  author answers each in its `readings`, citing the ID, and the next review rules on that reading
  like any other. That ruling settles the spec finding; a review resolution naming an S ID is
  ignored (and noted), since resolutions close only the review's own findings. Before the first
  review, an author turn whose readings leave one unanswered gets the turn's one correction; after
  it, the reviewer files an unanswered one as a finding.
- **A conflict no reading settles** stops the run with `needs-user` before any author turn, with
  one question of kind `spec` per conflict, quoting each requirement involved. Answered, setup
  runs again (`setup-answered`, in a new run directory, with its baseline) with the decisions, so
  the role that owns the criteria rewrites them, and the spec review reads the new criteria
  (`spec-2`). The decisions are in its prompt, and it asks only about a conflict they leave open:
  a question that returns to an answered one names that decision in `revisits` and says in
  `leftOpen` what its answer leaves open, and the user sees both. The engine sends a repeat to the
  author instead, marked with the decision it repeats, which the author reads it by: a revisit
  with nothing in `leftOpen`, and any question clearly the same as an answered one (other than
  the decision a stated revisit names). Clearly the same means it names the same things (files,
  paths by their last part, identifiers, versions, options) and shares at least 60% of the
  shorter question's content words, with a Dice coefficient of at least 0.4; criterion IDs are
  ignored, since setup renumbers them. A question about another file, or one that shares the
  subject but asks something else, still reaches the user. After two spec stops every later
  conflict goes to the author too, whose own `needs-user` still covers it. A resumed run rebuilds
  the answered questions from the replayed passes and the decisions. The stopped run's directory
  stays; the notes name the `dark-factory cleanup` command for it.
- **A failed turn** changes nothing: the run goes on with setup's criteria, and the notes, the
  story and the report say the spec review returned nothing. It never blocks readiness.

The log and "How the run went" get a line per pass ("Spec review by Codex Astra: no problems in
the criteria."), and `report.markdown` has a "Specification review" section with each pass's
verdict and what became of each finding. `spec` in the result holds the passes and findings.

## Design stage

The author drafts a design and a test contract (criterion IDs, inputs, expected outcomes,
boundaries, changed/preserved purpose, test files, commands, fixtures) and reconciles setup's
interpretations with the request.

Neither participant runs the full verification command in design: setup, or the runner, already
measured it on base. Focused checks are allowed for evidence: one test file or filter, one
analyser on the files in question, probes, and (for the author) prototype code run against the
existing tests from a scratch copy in the turn's probes directory, for example to show that a
planned test fails on base or that a filter selects the intended tests. The author changes no
tracked file in its worktree until implementation.

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

**Severity.** Every review prompt defines it by what goes wrong if the finding stays: a
**blocker** does the wrong thing on the main path, breaks what worked, loses data or opens a
security hole (for a document or plan, states something false that work built from it would rely
on); a **major** does the same on a plausible case, misses a requirement or criterion, or changes
behaviour no check would catch; a **minor** is anything else worth the author's time (wording,
naming, style, a rare case, a tighter check). A blocker or major finding must give its `failure`,
the concrete input or situation and what goes wrong in it; the engine files one without a failure
as minor and notes it. A criterion assessed partial or unmet needs something that fails it: an
open or new blocker or major finding, a failing or missing required check, a challenge with no
rejecting check, a design revision request, a rejected reading or a question to the user. A review
holding one short without any of those gets the review's one correction. Two document runs
(Jira ticket rewrites, 2026-11-23) spent all 8 reviews on wording filed as major and criteria held
partial over it; these rules are the response.

**Minor findings never hold the work.** Open blocker and major design findings block design
approval; open minor ones don't. They stay open into the code stage, and the code-stage author and
reviewer prompts name them as carried items to fix and check against the implementation. At the
code stage they don't block readiness either: they go to the polish pass ([below](#the-polish-pass)). The design reviewer is told to raise new findings for
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

Blocker and major findings, including those carried from the design stage, must close; minor
ones go to the polish pass, and optional preferences are reported separately. When a defect
appears in several places (a claim restated, a pattern repeated), the reviewer files it once and
lists every place, and the author searches the whole deliverable for every place before answering:
in the document runs, a claim fixed in one place and restated in another kept findings open for up
to six revisions. The author's handoff, notes and probes are evidence, not the deliverable: a flaw
in them is a finding only when it hides a defect in the deliverable or weakens a contract check.
For a document deliverable, the author keeps that evidence out of the document unless the task
asks for it there, and setup writes a hard size or format limit the deliverable must meet (a Jira
field's 32,767 characters) as a criterion, so it is met from the first draft. The author's `addressed` entry for each
finding says whether it `changed` the work or `disputed` the finding.

### The polish pass

When a code review leaves only minor findings open, with every criterion met and verification
passing, the author gets one polish turn (label `pair-polish`): it fixes the minor findings it
agrees with and declines the rest with a reason, changing nothing else (the contract and replay
mapping stay as reviewed). The helper measures the result, and a short check reviews only the
polish: it resolves each minor finding, files a new finding only for a blocker or major defect
the polish introduced, and assesses every criterion. If the polished snapshot is ready, it is the
result. If the polish broke anything, or the author, the measurement or the check didn't finish,
the polish is set aside and the result is the snapshot reviewed before it, which was ready:
`final.snapshotRef` names it, and `final.worktree` still holds the polish, so deliver with
`dark-factory apply`. The polish check spends none of `maxReviews`, runs at most once, and is
recorded in `polish`, not `reviews`. The report's "Minor findings" list gives each minor finding
the run ends with and what became of it: fixed in the polish pass, declined with the author's
reason, or left open.

### Readings

Every author turn lists in `readings` each place it reads a requirement, criterion or approved
contract check other than literally (an exact list read as a minimum, an open threshold it
settled, two requirements it reconciled). A reading left only in a handoff or note is not
reviewed. The engine numbers them R1, R2, … in a ledger both participants see, and the next review
rules on each, accepted or rejected with evidence (a missing, repeated or unknown ruling gets the
review's one correction, as does a resolution of a finding that doesn't exist). An accepted reading is settled for the run; a rejected one becomes an
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

Seven stops ask you questions and can continue once you answer: a [goal brief](#goal-brief)
question, setup's conflicting requirements,
setup's criterion nothing in the run can verify, a [spec review](#spec-review) conflict, an
author's `needs-user`, a reviewer's questions, and a design that used its
[review allowance](#design-stage) without approval. Every
other stop is final and carries no `resumable` flag or resume guidance: blocked, stalled, budget
exhausted (`maxReviews`, `maxTurns` or `maxRunMin`; including a stop that asked questions but ran
out of budget), failed, verification infrastructure failure, a dirty tree, and a task built on
uncommitted changes.

Question IDs Q1, Q2, … are unique across the run; a second stop continues the numbering. Goal
brief questions have their own IDs (`B1`, …) and are answered under them.
`questions` lists the current stop's as `{id, about, kind, question}`, and `report.markdown` lists
them under "Questions for the user (answer each under its ID)". `kind` is `setup`, `criterion`,
`spec`, `author`, `reviewer` or `design`. `about` is the criterion of a criterion question, the
first criterion a spec question involves, the first finding, criterion or reading ID (P3, C2, R1)
another question names, or `none`. A goal brief question has kind `brief` and carries the
quoted wording, both outcomes, the evidence, a recommendation and what the answer changes.

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
| Goal brief | One turn revises the brief with your answers, then setup runs. |
| Setup conflict | Setup runs again (`setup-answered`) with the decisions, in a new run directory, and pays the baseline again. |
| Unverifiable criterion | The criterion is rewritten or dropped; the run goes on to the spec review (with `spec: false`, to its first author turn). |
| Spec review conflict | Setup runs again (`setup-answered`) with the decisions, in a new run directory, and pays the baseline again; then the spec review reads its criteria (`spec-2`). |
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
checkpoint validation refuses the same changes. A setup conflict has no run yet, so no record; a
spec review conflict is recorded at `base`.

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
setup has none. Setup, the spec reviewer, the author, the reviewer and the relays can each leave
a process note (the measurement transport leaves none), and one agent turns them with the run facts and report into
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
| `spec` | the reviewer's model, `medium` | `false` skips the [spec review](#spec-review); `{model, effort}` swaps either |
| `brief` | shaped | `false` (`--no-brief`) skips the [goal brief](#goal-brief); an absolute path to a settled `BRIEF.json` re-checks it in one turn |
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
`audit`, `roles`, `evidence`) are refused.

## Results

Results open with `summary` (status, readiness, open findings, snapshot, gate result, and the
cleanup command for after delivery), followed by `design`, `testContract`, `replayMapping`,
`reviews`, `findings`, `stopReason`, and:

- `readings`, each with its ruling (also in `report.markdown`).
- `spec`: the [spec review](#spec-review)'s passes and its findings S1, S2, …, each with whom it
  went to (the author or the user), for a question its ID, and for a repeat the decision it
  `repeats`.
- `questions`, `decisions`, `unusedAnswers`, `resumable`, `resumeSteps`: see
  [Answering a stop](#answering-a-stop).
- `brief`, `briefFile` and, for a groomed ticket, `ticket`: see [Goal brief](#goal-brief).
- `liveChecks`: the [live checks](#live-checks) still to run (also in `final.readiness.liveChecks`).
- `final.replay`, `final.suite` and `final.readiness`. The first two are the measurement summary;
  the job's `status.json` keeps the output tails.

`report.markdown` tells the run in "How the run went" (setup, the spec review, each author pass,
each review, each question and answer, and how the run ended), logging each line as it happens. "Points of interest"
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
