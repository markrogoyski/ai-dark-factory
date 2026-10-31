# dark-factory

A workflow engine for Claude Code and Codex in which models solve one task independently,
debate it on an evidence ledger, and converge on one result. The Claude entry point defaults to
Claude Opus, Claude Sonnet, Codex Astra and Gemini Flash. The Codex entry point defaults to
OpenAI models and also supports explicit Claude and Gemini seats.

    /dark-factory:council Fix the cancellation in Special::confluentHypergeometric at large negative z

## Install in Claude Code

The repo is a Claude Code plugin marketplace with one plugin, `dark-factory`:

    /plugin marketplace add markrogoyski/ai-dark-factory
    /plugin install dark-factory@ai-dark-factory

That adds `/dark-factory:factory`, `/dark-factory:council` and `/dark-factory:ensemble`, and puts
the helper the agents run, `dark-factory`, on their PATH. A plugin can't grant permissions, so add
this to `~/.claude/settings.json` yourself (see the permission note under Install and test):

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

Codex and Gemini seats need the `codex` and `agy` CLIs; the requirements are listed under
Install and test.

## Install in Codex

From a checkout of this repository, install the skill in the project where you want to use it:

```sh
./install-codex.sh --repo /path/to/project
```

With no arguments, the installer uses the current Git repository. `./install-codex.sh --user`
installs in `~/.agents/skills` for use across projects. It creates a symlink to the shipped skill,
so keep this checkout in place. It does not replace an existing skill from another location or
change account settings. Codex discovers the skill automatically; start a new session if it
doesn't appear.

Then, in Codex:

```text
$dark-factory Add a debug log line with the retry count in Fetcher::retry
$dark-factory --tier fix Find why the sync drops the last page
```

The skill runs the same factory/council JavaScript through a local Node runner. Tier routing,
escalation, verification, scoring, and readiness stay in that shared engine. Model turns are
separate CLI sessions; the runner starts them directly and bounds their concurrency. It does
not need Claude relay agents. All four factory tiers and the council are available; the separate
`ensemble` workflow remains a Claude Code entry point.

You need Node, Python 3, Git, and an authenticated `codex` CLI. The default Codex profile needs
no Claude or Gemini account. Explicit mixed-vendor selections additionally need the relevant
authenticated `claude` or `agy` CLI. Each CLI keeps its normal permission controls; a required
permission that cannot be obtained headlessly is reported as a failure.

Simple uses Sol to implement and Astra to review. Fix and Feature use Astra and Sol seats;
Architecture adds Luna. Orchestration roles can be changed through `roles`, for example
`{"intake": "sol", "checker": {"model": "astra", "effort": "high"}}`.

You can also invoke the runner without installing a skill:

```sh
node plugins/dark-factory/bin/dark-factory-codex --cwd /path/to/project -- "Fix the missing final page"
node plugins/dark-factory/bin/dark-factory-codex --workflow council --seats astra,sol,opus --cwd /path/to/project -- "Investigate the intermittent timeout"
```

Use `--args-file task.json` for the full factory options, including uncommitted reference
documents and model overrides. Paths in `plan` should be absolute:

```json
{
  "task": "Implement the retry policy in the design",
  "plan": ["/path/to/project/RETRY_DESIGN.md"],
  "tier": "feature",
  "seats": ["astra", "sol"],
  "audit": {"correctness": "astra", "design": "sol", "tests": "luna"}
}
```

`--concurrency N` bounds simultaneous model turns, `--timeout-min N` sets turn deadlines,
and `--output result.json` saves an additional copy of the final JSON. Progress is written to
stderr and the final result to stdout. Every run retains its arguments, events, and result in
`hostRunDir` under the target repository's `.council/`; `runDir` identifies the factory's
worktrees and evidence. Exit 0 means a completed ready result, 2 means a decision or unresolved
readiness, and 1 means execution failure. Always inspect `final.readiness`, not just `status`.

The skill handles `needs-plan`, `needs-tier`, `needs-split`, and `needs-user` using the same
factory decisions described below. Reruns use updated arguments and start a new host run;
there is no workflow checkpoint resume. Seat sessions persist across their turns within a run.
The reviewed change stays in its worktree until delivered to the main checkout. Architecture
returns reviewed milestones and does not automatically build them.

## Factory verification and delivery

Factory setup stores the full gate in `<runDir>/verify.sh` and explicit execution overrides
in `<runDir>/verification.json`, for example:

```json
{"env": {"PHPSTAN_FLAGS": "--debug --no-progress", "PSALM_FLAGS": "--threads=1 --no-cache --no-progress"}}
```

Factory setup also captures a small base environment for tool discovery, locale, identity,
and temporary paths. Other shell-local exports do not reach verification; required project
variables must be explicit overrides. These example variables require the project's commands
to consume them. Setup must establish
a working invocation without removing required checks; there are no PHP-specific defaults in
the factory. Setup and specification amendment own the configuration. Seats and auditors use
`dark-factory verify --run-dir RUN --path CHECKOUT --label UNIQUE --max-wait 5` to run the same
gate and overrides. `--command-file FILE` runs a focused test or intended red instead. Each
job captures its command and overrides before execution and records cwd, output, exit status,
and timing. Only explicit overrides are recorded, not the caller's full environment; keep
credentials out of this configuration.

Neutral measurement includes the configuration and raw evidence in its cache identity.
Factory baseline and increment checks run in disposable snapshots; a live-worktree pass
cannot replace a failed snapshot check, and a gate that alters tracked snapshot files fails.
Codex checkers poll running shell sessions and helper jobs, while `--suite-timeout` controls
the gate deadline.

Builders place raw historical artifacts under `room/evidence/SEAT/` with an ordered
`manifest.json` array of `{ "path": "inc1/red.log", "criterion": "C5", "stage": "inc1-red" }`
entries. Required artifacts include commands, cwd, outputs, exits, test-only diffs, source
hashes, and handoff updates. Debate, votes and review conclusions stay out. Measurement
publishes a content-addressed copy under `<runDir>/evidence/`, tied to the snapshot.
`dark-factory evidence --run-dir RUN --seat A --label inc4` validates the bundle and returns
its index. The tests auditor (or correctness/review lens when there is no tests auditor)
owns historical acceptance. Missing evidence keeps readiness incomplete even with no bug
findings and a passing current suite.

A ready factory result has `delivery.status: pending`: the reviewed change is still in its
worktree. After authorized application and required local-plan updates, run:

```sh
dark-factory verify-delivery --run-dir RUN --result RESULT.json --manifest MANIFEST.json --max-wait 5
```

The manifest contains `adjustments` and `handoffs` arrays, each entry with `path`, `reason`,
and `sha256` for the exact reviewed bytes (`"absent"` for deletion). Empty arrays are valid;
omit `--manifest` if both are empty. The helper compares delivered files to the snapshot,
checks unrelated local files against setup, reruns the shared gate in the main checkout,
and writes `<runDir>/delivery.json`. It never applies changes itself. Record and review any
post-audit adjustment, including scanner exclusions for `.council`; verify that project
files remain in scope in both main and nested worktrees. Only delivery's `status: delivered`
means that this final check passed. Factory readiness remains a separate result.
When no automated gate was configured, delivery records that it was not run rather than
claiming a test pass.

## Layout

    .claude-plugin/marketplace.json   the marketplace: lists the plugins in this repo
    plugins/dark-factory/             the plugin, and the only thing that ships
      .claude-plugin/plugin.json
      workflows/                      factory.js, council.js (built from src/), ensemble.js
      bin/dark-factory                the helper CLI the agents call
      bin/dark-factory-codex          the Codex host runner
      skills/dark-factory/            the Codex skill and its relative launcher
    install-codex.sh                  link the skill into a project or user skill directory
    src/ tools/ test/                 development: sources, build, tests

A new workflow goes in `plugins/dark-factory/workflows/` and runs as `/dark-factory:<meta.name>`.

## The factory

`/dark-factory:factory` is the entry point for work that should be done end to end with independent review
when it isn't obvious how much process the work needs. It decides that first, then runs the
cheapest process that plausibly suffices, and hands the work up when the evidence says that
wasn't enough.

    /dark-factory:factory Add a debug log line with the retry count in Fetcher::retry
    /dark-factory:factory --tier fix Find why the sync drops the last page

| tier | what runs | rough cost |
|---|---|---|
| `simple` | Sonnet implements, the neutral check, Codex Astra reviews, at most one fix pass | 6–9 agent turns |
| `fix` | the council with two seats, Opus and Astra: blind attempts, debate, audit | 15–25 |
| `feature` | Opus and Astra plan it blind and debate the plans; the chosen plan's author builds it in checked increments; a three-lens audit | 25–40 |
| `architecture` | Opus, Astra and Sonnet design it blind and debate the designs; the chosen design's author writes a milestone plan; a three-lens review and one revision; nothing is built | 35–50 |

The model names below describe the Claude profile. Codex uses its own OpenAI defaults while
keeping the same stages and rules; explicit `seats`, `simple`, `panel`, `spec`, `audit`, and
`roles` options override the Codex defaults.

- **Intake.** An Opus agent reads the task, any document it names and the code, without
  running anything, and returns a tier, a mode, its reasons and the signals it went on
  (files touched, public API, across modules, test coverage, ambiguity). It picks the lowest
  tier that plausibly suffices, because a tier too low costs a few turns and a tier too high
  costs dozens. An ambiguous request is never Simple, and Simple and Feature are for changes
  only (an investigation goes to fix, a design to architecture). One connected piece of work too
  big for one feature (more than about 4 increments, or a design decision to settle before it
  can be planned) also goes to architecture; separate pieces go to `needs-split` instead. Intake
  also stops the run with `needs-plan` when the task depends on a document it can't find.
- **A task of several pieces.** When the task bundles work that stands on its own (a checklist,
  fixes with separate causes, one commit per item), intake stops the run with `needs-split`
  before anything is created and lists the pieces: each a self-contained task, an estimated
  tier, and the earlier pieces it builds on. One run would debate and review all of them
  together at the cost of the hardest. The main session asks you once: run each piece as its
  own `/dark-factory:factory` run, in order, committing each before the next (every run starts from HEAD),
  or rerun with `noSplit: true` to run the whole task as one. Each piece's run has its own
  intake, so the estimated tiers aren't pinned.
- **A pinned tier.** `tier` (or `--tier` at the start of a string task) sets the tier. Intake
  still runs, blind to the pin. When it would pick another tier, the run stops with
  `needs-tier` before anything is created, and the main session asks you once. Rerun with
  `tierConfirmed: true` to keep yours, or with intake's tier. Intake's prompt doesn't contain
  the pin, so it replays from cache either way. A kept tier is where the run starts, not a
  ceiling.
- **Escalation**, automatic, upward only, in the same run. Simple hands the work up when:

  | trigger | when | to |
  |---|---|---|
  | `too-big` | the implementer says it isn't a simple change | its tier (fix or feature) |
  | `over-budget` | the round-0 change exceeds `maxLines` (200) changed lines or `maxFiles` (8) files | feature |
  | `design-finding` | the panel upholds a blocker or major judgment finding about the approach | feature, before any fix |
  | `verify-failed`, `blocked` | after the fix pass, the verification command still fails, or the result is blocked | fix |

  Feature hands the work to architecture, before anything is built, when its chosen plan lists
  more than 4 increments (`too-many-increments`): that is work for milestones, not one build.

  A failed agent is not evidence about the task, so it never escalates. The higher tier runs
  its own setup (a fresh run directory, its own criteria, the spec review) and starts blind:
  its seats are told why the work was handed up, with the upheld findings, the failing tests
  and the failing tail, but they aren't shown the earlier change or plan. The result is the
  higher tier's, with the report opening on "Escalated from Simple" (or Feature). A run handed
  up twice, Simple to Feature to Architecture, reports both steps.
- **The Feature tier** spends its independence on the plans, where it is cheap, and builds once:
  1. **Setup and the spec review**, as in the council (two seats: Opus and Astra unless you pass
     `seats`).
  2. **Plans, blind.** Each seat writes a plan, not code: the approach and the alternatives, the
     changes file by file, how each criterion will be met and tested, the risks, and at most 4
     increments, each leaving the verification command passing. Worktrees stay untouched.
     Every claim about the existing code cites file:line, and the checkers verify those
     citations (nothing is measured yet).
  3. **The debate** on the plans, with the council's rounds, votes and scorecard. Findings are
     plan defects: a step that relies on code that isn't there, a criterion left uncovered, an
     increment that would break the suite.
  4. **The final plan.** The chosen plan's author merges in the best of the others (credited)
     and lists its increments. There is no ratification: the audit reviews the change itself.
  5. **The build.** The same author builds it in its worktree, one increment per turn, each
     followed by the neutral check (snapshot `inc<N>`, the verification command, its claims).
     A failing check, a turn that returned nothing and findings still standing go into the next
     turn's prompt. A plan listing more than 4 increments goes to the Architecture tier instead.
  6. **The audit**, through three lenses: correctness (Codex Astra), design (Claude Opus) and
     **tests** (Claude Sonnet, IDs `XT1`, `TXT1`), which mutates the change to find behaviour no
     test would catch. `audit: {tests: 'haiku'}` swaps it. Then the council's one fix pass (a
     failing verification command also earns it) and the auditors' re-review of the fix.

  The report covers the plan chosen and why, the plans, the planning debate, the build
  increment by increment, and the audit. A Simple run handed up to feature runs this flow.
- **The Architecture tier** is for a request for a design or a plan, and for one connected piece
  of work too big for one feature. It builds nothing: it hands back milestones, each ready to be
  a factory run of its own.
  1. **Setup and the spec review**, as in the council, in design mode. The criteria say what the
     design must cover and decide. Three seats, Opus, Astra and Sonnet, unless you pass `seats`:
     design is where diversity has paid off (the one design run in `retros/` produced four
     different designs, and its finalists were Sonnet's and Astra's).
  2. **Designs, blind**, each ending in milestones: each one reviewable and committable by
     itself, leaving the system working, and small enough for one feature build (at most 4
     increments). Claims about the code cite file:line, and the checkers verify them.
  3. **The debate** on the designs. Findings are design defects: code that isn't there, a
     criterion left uncovered, a milestone that would leave the system broken or needs what only
     a later one delivers.
  4. **The milestone plan.** The chosen design's author merges in the best of the others
     (credited) and lists at most 8 milestones: a title, the milestone as a self-contained task,
     draft criteria, the earlier milestones it builds on, a tier (simple or feature), and what
     works once it lands. There is no ratification: the review checks the plan.
  5. **The review**, by reviewers who never saw the debate, through three lenses: **grounding**
     (Codex Astra, IDs `XG1`: does the plan match the code as it is), **sequencing** (Claude Opus,
     `XS1`: does each milestone leave the system working, and are the order, dependencies and
     sizes sound) and **risk and alternatives** (Gemini Flash, `XK1`: what could sink it, and
     whether a design the council didn't choose is better, for the plan or one milestone; only
     this lens reads the other designs). They read the plan and the repository, write nothing,
     and say which milestone each finding is about. Gemini is the only model in the run that
     wrote no design, and a reviewer that fails costs a gap in the review, not the run;
     `audit: {risk: 'sonnet'}` swaps it (the preflight stops the run if agy can't start). Then
     the audit's triage, one revision by the author (which lists the milestones again), and the
     reviewers' re-review of the revision.
  6. **The result** lists `milestones[]`, each with the review findings still open against it and
     `args` for its own run: its task with the draft criteria and those findings, the final
     design as its `plan` document, its tier, `tierConfirmed: true` and `noSplit: true`. The
     main session shows them and offers to run them one at a time, in order, committing each
     before the next. Nothing chains automatically. Keep the run directory until the milestones
     are done (`cleanup` without `--all` keeps the room), since each milestone run reads the
     design from it.

  The report covers the design chosen and why, the designs, the debate, the milestone plan and
  the review.
- **The Simple tier** reuses the council's machinery: the setup agent (1–3 criteria, one
  worktree), the neutral checker, the audit with a single `review` lens (IDs `XR1`, `TXR1`), the
  panel for blocker and major findings, and the audit's one fix pass. A failing verification
  command also earns the fix pass. There's no re-review: the checker's run on the fixed version
  is the verification. `simple: {implementer, reviewer, maxLines, maxFiles}` changes it, and
  every `/dark-factory:council` argument passes through to the council tiers.
- **Facts on every run.** Each factory run puts a JSON facts block in its retro payload: tier,
  how it was chosen, intake's signals, the escalation (from the tier it started at, with each
  step when there were two), readiness, turns by role, review findings, the number of
  milestones for an architecture run, and hints that the tier was too high (seats that agreed
  blind, a clean audit on a small diff).
  The model retro runs only on notable runs: every council tier, an escalation, an overruled
  intake, a result that isn't ready, a fabrication or a relay failure. A clean Simple run instead
  gets a Haiku turn that saves the facts (`dark-factory retro --facts-only`).
  `dark-factory retro --summary` tallies `retros/*.facts.json` by starting tier, which is what the
  intake rubric is tuned from.

## Choosing the models

Claude, Codex and Gemini are separate accounts with separate limits. When one runs out, pick
the lineup yourself, for example with Codex Sol in place of Gemini:

    /dark-factory:council --seats opus,sonnet,astra,sol Fix the cancellation in ...

or, from a session, `Workflow({name: 'council', args: {task: '...', seats: ['opus', 'sonnet', 'astra', 'sol']}})`.
Asking in words ("run the council with Sol instead of Gemini") works too. The launching session
passes `seats`.

| seat | model | vendor |
|---|---|---|
| `opus`, `sonnet`, `fable`, `haiku` | Claude | Claude Code subagents |
| `astra`, `sol`, `luna` | gpt-6-astra, gpt-6.1-sol, gpt-6-luna | Codex CLI |
| `gemini` | Gemini 3.8 Flash | Antigravity CLI (`agy`) |
| `gemini-pro` | Gemini 3.1 Pro (low and high effort only) | Antigravity CLI |
| `codex:<slug>`, `gemini:<slug>` | any model the CLI offers (`agy models` lists Gemini's) | |

Use 2–6 seats. Consensus needs votes from at least two vendors whenever the lineup has more
than one vendor.

It is the sibling of `/dark-factory:ensemble`. Ensemble returns ranked candidates for you to pick from; the
council argues until it agrees, and falls back to an evidence scorecard when it can't.

## How a run goes

1. **Setup.** One Opus agent first runs `dark-factory preflight` for the Codex and Gemini CLIs the
   lineup and panel need, and stops the run, before anything is created, if one can't start
   from this session (with the fix, or the seat to swap). Then it creates the run directory and
   a git worktree per seat, finds the verification command, measures the baseline, and writes
   3–7 acceptance criteria *before anyone starts*, so nobody can redefine success halfway
   through. Each criterion must be checkable from inside a seat's sandbox.
2. **Spec review** (every mode; `spec: false` skips it). Every later check measures against the
   criteria, so a criterion that is wrong lets a wrong result pass all of them. Before any seat
   starts, two reviewers who see only the task, the code and the setup's criteria look for
   problems, each through one lens: **coverage** (Codex Astra: missed edge cases and error
   paths, regressions the criteria would allow, criteria wrong about the code, a verification
   command that wouldn't catch a breakage) and **intent** (Claude Opus: ambiguity,
   contradictions, scope creep or gaps against the task, uncheckable criteria). Each finding is a
   *fact* (the code, documents or task settle it) or a *decision* (only you can).
   - **The panel rules** on every finding: accept, reject, or decision. A finding is amended
     only if every adjudicator accepts it; any decision vote makes it a question; accept against
     reject is disputed and left alone. Widening the scope counts as a defect.
   - **One Opus turn amends** the criteria (and the verification command, re-measuring the
     baseline if it changes). It never rewords criteria you passed in `criteria`.
   - **Questions only you can answer** are settled autonomously on the most conservative reading
     (keeps existing behaviour, easiest to undo, closes off the fewest options). The criteria
     follow it, seats are told it, and the report opens with an "Assumptions to check" section,
     one yes-or-no line each. With `spec: 'ask'` the run instead stops with `needs-user` before
     any seat starts, and resumes from cache with your answers as `clarifications`.

   A clean review costs 3 turns (two reviewers and a relay); one with findings adds the panel
   (3 turns with its relay) and the amendment. The report gets a "Specification review" section.
3. **Solve, blind.** Each seat works alone in its own worktree and posts to the shared room.
   Seats are anonymous letters, assigned by a per-run shuffle. In implement mode, if every
   seat's checked snapshot is the same tree and the verification command passes on it, there is
   nothing to debate: the council skips to synthesis by the copy highest on the scorecard.
4. **Debate rounds** (default 2, max 3). Each seat reads the other positions and the ledger,
   then files findings, challenges claims, concedes, adopts ideas (credited), revises, and votes
   on which position should ship. From round 2 it starts from what changed since it last looked.
5. **Neutral checks after every round.** A Sonnet checker per position re-runs the
   verification command and every published test against it, in a disposable checkout of the
   snapshot it just took (never the seat's live worktree), and rules on each claim:
   VERIFIED, REFUTED, FABRICATED or UNRESOLVED. Disputed load-bearing claims go to a two-vendor
   panel (a fresh Opus and a fresh Astra by default; set `panel`). If the panel splits, the claim is UNRESOLVED.
   A checker that returns nothing gets one retry.
6. **Stop rule** (code, not a model): consensus when ⌈2N/3⌉ seats vote for the same
   non-disqualified position, with votes from at least two vendors among them. If a round changes
   nothing, or the last round ends without consensus, a scorecard picks the base.
   Otherwise the field narrows before the next round (see below). Two experiments, both off
   unless you turn them on per run, change when or how agreement counts: `ballot` and
   `approval` (see [Arguments](#arguments)).
7. **Synthesis.** The winning author folds in amendments, fixes standing findings and
   credits adopted ideas.
8. **Ratification.** The other seats endorse or object. Blocking fact objections go to the
   panel, and upheld ones get one fix pass. Judgment objections are reported as dissent.
9. **Readiness.** Separately from how it was chosen, the final version is reported as
   *ready*, *blocked* (an unmet criterion, a failing suite or published test, a fabricated
   verification, an upheld blocker or major) or *incomplete* (no check, an unrun suite, an
   unjudged criterion, an unresolved or one-adjudicator ruling, a missing review). Readiness is
   reported only; it never changes which position was chosen.
10. **Audit** (implement mode; `audit: false` skips it). Every reviewer so far took part in the
   debate, or ruled only on claims somebody made, so a problem nobody raised gets past them all,
   and agreement among seats that share a frame proves little. Two auditors who never saw the
   debate now review the final version, each through one lens: **correctness** (Codex Astra:
   edge cases, regressions, error paths, whether the tests would catch the change's loss) and
   **design** (Claude Opus: abstractions, simplicity, fit with the codebase, test level, and a
   change-tolerance probe that traces where two or three plausible next changes would land).
   Each gets the task, the criteria, the final diff and its own checkout. The room is off limits.
   A correctness finding should come with a failing test, published like a seat's.
   - **Triage** reuses the checks: a checker re-measures the final version with the auditors'
     tests and rules on minor fact findings, and the panel rules on blocker and major ones. A
     judgment finding the panel agrees on becomes a fact, upheld or refuted. A split leaves it
     a judgment call. Minor judgment findings go to the author as suggestions.
   - **One fix pass** when anything is upheld, disputed or failing. The winning author fixes
     it, or declines with evidence, and the final version is checked again.
   - **Re-review of the fix only.** The auditors read the fix's delta for defects it introduced.
     Blocker and major ones go to the panel and are reported, never fixed: the loop is capped
     at one cycle, so it ends.

   A clean audit costs 3 turns (two auditors and a relay; nothing to rule on, so no re-check);
   one with findings, about 10 more, plus their relays. Readiness then reflects the last check, and an auditor that
   returned nothing leaves it *incomplete*. The report gets an "Independent audit" section listing each finding and how it
   ended. The default panel is also Opus and Astra, but fresh ones: an adjudicator never sees
   the audit it rules on.

Escalation: the council settles judgment calls itself. It stops to ask you only when ⌈2N/3⌉
seats (3 of 4) raise or second the same question about the request itself. Questions that
don't reach that bar are reported as assumptions.

## Working from a plan

Seats work in git worktrees checked out from HEAD, so they can't see anything uncommitted: a
plan from plan mode (saved under `~/.claude/plans/`), an untracked `PLAN.md`, a bug checklist.
The council handles that in three layers:

1. **The launching session passes the plan.** The workflow's description tells the main
   session to call it with the plan's absolute path and to say in the task which part to do,
   without pasting the document:

       Workflow({name: 'council', args: {task: 'Do item 13 on the bug checklist',
                                         plan: ['/abs/path/BUG_CHECK_LIST.md']}})

2. **Setup snapshots it.** `dark-factory init --ref` copies each document into `<run>/refs/`, byte
   for byte, with no model retyping it, and records whether the worktrees have it. Setup also
   looks for documents the task names, such as "item 13 on BUG_CHECK_LIST.md", and snapshots
   those too. The acceptance criteria are written from the documents as well as the task.
   Every seat, checker, panel member and the final author is pointed at the snapshots. Seats
   are told not to copy them into the worktree, and not to cite them (file names, step or item
   numbers) in code, comments or tests.
3. **No guessing.** If the task depends on a plan the council can't find, including "the plan"
   with no file named, it stops before any seat starts. The main session is told to find the
   plan (one made in the same conversation is under `~/.claude/plans/`) and rerun with `plan`,
   or to ask you if it can't tell which plan is meant.

## Scoring

All scores are computed by the script from the checkers' and panel's rulings.

**Positions** (deciding what ships when there is no consensus) are ranked in strict order:

1. Disqualified last: the verification command fails (when it passed at baseline), or the
   round's verification claim was fabricated.
2. Fewest standing blocker findings, then fewest standing major findings.
3. Highest pass rate on valid published tests.
4. Most acceptance criteria met.
5. Fewest standing minor findings.
6. Votes from other seats.
7. Author credibility.
8. Smaller diff.

**Seats** (whom to trust) record:

- fabricated and wrong claims
- findings upheld and refuted
- challenges won and lost
- a refutation score, where upheld findings earn by severity and refuted ones cost 1.5× as much
- ideas adopted by others and ideas that made it into the final version
- tests published and valid
- capitulations (changed position with nothing verified behind it)
- ignored findings (left a verified blocker or major unaddressed)

## Keeping context focused

Reading three rival solutions every round is where context would grow, so the moderator keeps
each seat's reading to what the decision needs:

- **Pointers, not pastes.** Prompts list the paths of posts and diffs. Seats open what they
  need. The ledger digest is capped: one line per position, ledger entries cut to about 260
  characters, and at most 30 refuted and 30 other checked claims.
- **What changed, from round 2.** Each checker run snapshots the seat's tree and writes
  `rN/<seat>.delta.diff`, the change since the seat's previous round. Readers start from that
  and the post's "Changes this round" section, and open the full post or diff only when needed.
  Ratifiers also get `final/<seat>.delta.diff`, the change since the version they last reviewed.
- **The field narrows.** After a debate round without consensus, the two positions ranked
  highest on the scorecard stay in contention, as does any position another seat voted for and
  any whose author has a verified blocker or major finding against one that stays. The other
  authors become reviewers: they stop revising, and they critique, publish tests and vote for a
  contender. Reviewers' positions are no longer measured or read, and findings against them
  are no longer filed. With 2 or 3 seats this rarely triggers; turn it off with `narrow: false`.
- **Memory for Claude seats.** Claude seats are fresh agents each turn, so each one returns
  private notes of under about 400 words (key file:line references, what it verified, its read
  on each position). The notes are pasted into that seat's next prompt and nobody else sees
  them. Codex and Gemini seats keep their own thread instead.
- **Length limits.** Posts should stay under about 800 words (implement), 1,500
  (investigate) or 2,000 (design). Only the post file counts: long material the task asks for,
  such as exact edits or logs, goes in separate files in the room. Checkers count the words, and
  the digest flags a post that runs over.
- **Fewer, sharper claims.** Each turn records at most 12 claims: every verification claim, plus
  the facts that name an acceptance criterion they bear on. Checkers verify every claim, and
  incidental facts nearly always came back verified, so they stay in the post, unchecked. A diff of more than 400 changed lines is offered with its per-file summary
  (`rN/<seat>.stat`) first.
- **Narrow neutral roles.** Each checker sees only the claims about one position; each panel
  member sees only the disputed claims.

## Arguments

`/dark-factory:council <task>` passes a string. From a session, `Workflow({name: 'council', args: {...}})`
accepts:

| arg | default | |
|---|---|---|
| `task` | required | |
| `plan` | | path or list of paths: a plan or other document the work follows; snapshotted for every seat |
| `mode` | auto | `implement`, `investigate` or `design`. Unless given, setup picks it after reading the task and its documents: a bug fix or "do the next item" on a checklist is implement |
| `seats` | `['opus','sonnet','astra','gemini']` | a list or a comma-separated string; see [Choosing the models](#choosing-the-models). A string task may start with `--seats a,b,c,d` |
| `rounds` | 2 | debate rounds, 1–3 |
| `effort` | `high` | for every seat, or per seat: `{astra: 'xhigh'}`. Codex also accepts `ultra`. Gemini maps the level to the nearest one the model has (Flash: low, medium, high), since agy names it in the model slug |
| `context` | | extra context for every seat |
| `criteria` | written by setup | your own acceptance criteria, as a list of strings |
| `verify` | found by setup | the verification command |
| `repo` | session cwd | run against another repository |
| `consensusAt`, `escalateAt` | ⌈2N/3⌉ | |
| `panel` | `['opus','astra']` | adjudicators for disputed load-bearing claims |
| `checkModel` | `sonnet` | |
| `allowDirty` | false | implement mode refuses uncommitted tracked changes, since worktrees branch from HEAD |
| `narrow` | true | after a round without consensus, positions with no support leave contention and their authors review |
| `retro` | true | every agent may leave a process note, and a retro agent suggests workflow changes at the end; see [Process retro](#process-retro) |
| `timeoutMin` | 90 | deadline for a Codex or Gemini turn, in minutes: one number, or per phase `{spec, solve, debate, final, ratify, panel, ballot, audit}`. A turn that hits it is not retried |
| `spec` | `{coverage: 'astra', intent: 'opus'}` | the spec review before any seat starts (step 2). `'ask'` stops for your answer on questions only you can settle instead of assuming; an object swaps a lens's model, sets `effort`, or `ask: true`; `false` skips it |
| `audit` | `{correctness: 'astra', design: 'opus'}` | implement mode: the independent audit of the final version (step 10). Swap a lens's model, e.g. `{design: 'sonnet'}`, or set `effort` for both; `false` skips it |
| `ballot` | false | experiment: when a round ends one vote short of consensus (and another round is left), every seat votes again once that round's checks are in, instead of debating a full round more |
| `approval` | false | experiment: seats also list the other positions they could accept. With no strict consensus, a position chosen first by another seat, and chosen or accepted by ⌈2N/3⌉ seats from two vendors, with no verified blocker or major, carries the round; acceptors' amendments go to the final author |
| `clarifications` | | `[{id, answer, afterRound}]`, used when resuming after an escalation, or `[{id, answer}]` after the spec review asked |

## Pieces

- `plugins/dark-factory/bin/dark-factory-codex`: the local Codex host for the generated factory
  and council workflows. Its runtime adapter launches the helper directly, writes exact prompt
  files, validates structured results, and records progress. The skill's launcher resolves the
  runner relative to its real installed path, so prompts do not depend on an installation path.
- `plugins/dark-factory/workflows/council.js` and `factory.js`: the moderators. `factory.js` is the same
  engine with intake, the Simple tier (`src/simple.js`), the Feature tier (`src/feature.js`), the
  Architecture tier (`src/architecture.js`) and `src/main-factory.js` (routing, and `escalate()`)
  on top. They
  hold the turn order, the ledger, the stop rule, the scorecards and every prompt, and never
  judge. Both are **generated** from `src/` by `tools/build.mjs` (the workflow runtime allows no
  imports, so each has to be one file), and are
  committed so it can be diffed and run without a build. Edit `src/`, then `make build`:
  - `src/lib/*.js`: the pure half. Every function takes the state object `S` (built by
    `newState(parseConfig(args))`) as its first argument and calls nothing from the runtime:
    config and seats, the state queries, every prompt, the ingestion and rulings, consensus,
    narrowing, ranking and readiness, and the report.
  - `src/boot.js`, `schemas.js`, `turns.js`, `council.js`: the half that uses `agent()`,
    `parallel()` and `log()`: the agent turns and relays, the checks, and the round loop
    (`councilRun()` in `council.js`, which `main-council.js` calls). Its stages,
    `councilSetup()`, `debateStage()` and `synthesize()`, are what `featureRun()` and
    `architectureRun()` reuse; the Architecture tier's review is `runAudit()` with its own
    prompts and a revision that returns the milestones.
  - `src/lib/tiers.js`: the factory's pure half: tier parsing and routing, the pushback, the
    escalation triggers, brief and chain, the Feature tier's increments, report and result, the
    Architecture tier's milestones (and each one's run args), report and result, the run facts.
  - `src/00-meta.js`, `src/00-meta-factory.js`: each workflow's `meta` (it must stay a plain
    literal) and header comment.
  - `tools/sources.mjs` lists each built workflow's files in order.
- `bin/dark-factory`: deterministic plumbing, since workflow scripts have no shell. It handles
  worktrees, snapshots (`refs/council/<run>/<seat>-<round>`), suite and cross-test runs, and
  Codex turns. Seats leave their change uncommitted unless the task asks for commits; a snapshot
  keeps a seat's commits and puts anything uncommitted in one council commit on top. A Codex
  seat can commit because its worktree's git dir and the object store are writable roots of its
  sandbox; agy's sandbox can't write them, so a Gemini seat describes its commits instead. A
  Codex panel or spec reviewer must not change the repository, but Codex's read-only sandbox
  forbids even temp files (zsh heredocs, Rscript), so it runs in workspace-write from an empty
  scratch directory under the run: it reads everything and writes only there and to temp. Long work runs as detached jobs, polled with `dark-factory wait`, so it outlives the
  Bash tool's 10-minute limit.
- **Codex and Gemini seats.** Each turn goes through a Haiku relay agent, since a workflow script can't
  run commands itself. The relay runs `dark-factory seat-run`, which reads the prompt from the
  relay's own transcript (Claude Code saves every agent's prompt), checks its hash, and runs
  `codex exec` or `agy -p` (or, on later turns, resumes the seat's Codex thread or agy
  conversation). No model copies the prompt: in
  the first live run, Haiku dropped a line of a 13 KB prompt three times. Copying it by hand is
  only the fallback, hash-checked, with Sonnet as the second relay. Codex and Gemini seats keep
  their own memory across rounds, and after round 0 they get only the round-specific part of
  the prompt.
- **What the relay reports.** The relay returns the CLI's outcome as fields (`status`
  done/error/sandboxed, `error`, `errorClass`, `seconds`) and is told that any error text comes
  from the other model, not from its own Bash call. The workflow acts on those fields, never on
  the wording. (In one run a Gemini "Malformed function call" came back labelled "sandboxed",
  and Gemini was blocked for the rest of the run.) `seat-run` retries a capacity error or a
  malformed tool call by the vendor's model once inside the job, never a timeout or a used-up
  quota, and runs an identical failed turn at most twice. Each external turn's output schema
  pins a per-turn tag (`turn`, a one-value enum), so a stale answer from an earlier turn is
  rejected.
- **The run directory**, `<repo>/.council/<runId>/`, kept out of git through `.git/info/exclude`:
  - `room/` holds the transcript: `r0..r3/<seat>.md` posts, `<seat>.diff`, `<seat>.stat`,
    `<seat>.delta.diff`, `final/`, `ratify/`, the audit's `audit/<lens>.md`, `final3/` (its
    fix pass, or the Architecture tier's revision) and `reaudit/`, and `tests/<ID>/` (seats'
    tests, and auditors' as `TXC1`, `TXD1`). The Architecture tier's reviewers write no files:
    their reviews are in the result.
  - `refs/` holds the snapshots of the plan and other reference documents.
  - `wt/<seat>` and `snap/` are worktrees (`snap/audit-<lens>` is an auditor's checkout); `scratch/` holds the short-lived checkouts the
    suite and cross-tests run in.
  - `jobs/` holds Codex, Gemini and measurement jobs.
  - `usage.jsonl` records Codex and Gemini token use.
  - `retro.md` and `retro-data.md` hold the process retro and the notes it drew on.

## After a run

The main session reads the final version, spot-checks its load-bearing claims, and reports:

1. **A summary in its own words**: which model's work the council went with and why, what
   the other models proposed, and how it ended, followed by the debate topics, one line each
   saying how each was settled.
2. **The council's report** (`report.markdown`), computed by the script from the ledger, the
   votes and the rulings, with every seat named by its model:
   - **Assumptions to check**, first, when the spec review settled a question about the request
     without you: the result is built on them.
   - **Chosen, and why.** Consensus (who voted for it, with every seat's stated reason) or the
     scorecard. Also the criterion that put it above the runner-up, or, when the vote overrode a
     higher-ranked position, which one and on what. And its evidence when chosen.
   - **The positions.** Each seat's opening and closing position and its fate: chosen, its
     rank, or when it left contention.
   - **How the debate went.** Round by round: findings filed and how they were ruled,
     disputes, revisions, adopted ideas, votes, narrowing, and how it ended.
   - **The debates.** Up to 10, most severe first. Each one gives the point, who disputed it and
     why, the ruling (checker, panel, or judgment call), and the outcome (conceded, fixed, or
     still standing).
   - **How it turned out.** Readiness first, then the final version, ideas folded in from other seats, what the
     author declined and why, the neutral check, ratification and objections, and what is
     still open.
   - **Problems during the run**, such as a seat that failed, Codex or agy blocked by the sandbox,
     or a Gemini turn that agy cut short.
3. **The scorecards.**
4. **What the spot-check found.**
5. **A suggested commit message** (implement mode), written by the main session from the final
   diff in the repository's own style: concise, one imperative subject line, a body only when
   needed. It describes the change itself, with no references to plan documents, to the
   council, or to models, and no attribution lines. If the author committed (the task asked for
   commits), the main session cherry-picks those commits instead of applying the diff.
6. **The process retro** (`retro.markdown`): what the council suggests changing in this
   workflow. It's about the council workflow itself, not your project; see below.

If the council stops to ask you a question, you get the debate so far with it.

Nothing touches your tree until you approve; then the final diff is applied with `git apply`.

    dark-factory usage   --run-dir <runDir>   # tokens: Codex and Gemini per model, Claude agents per model and role
    dark-factory jobs    --run-dir <runDir>   # job status, for debugging
    dark-factory cleanup --run-dir <runDir>   # drop worktrees + refs, keep the room
    dark-factory cleanup --run-dir <runDir> --all

## Process retro

For now, while the workflow is being tuned, each run reviews its own process. Turn it off with
`retro: false`.

- **Notes during the run, not a retro at the end.** Every agent's output has a `process` field:
  at most two sentences on what in that turn's instructions, inputs or tools got in its way,
  naming the instruction or input, or `""`. That covers seats, checkers, the panel, relays,
  setup and question clustering. Notes are taken as they happen because Claude seats are fresh
  agents each turn and wouldn't remember an earlier turn at the end.
- **One retro agent** (Sonnet) gets the notes, facts the script computed, and the report. The
  facts cover turns per role, turns that returned nothing, relay attempts that failed, posts
  over the length limit, the ledger, and problems during the run. It can open the room, the
  Codex job logs and the workflow source. It weighs the notes instead of counting them,
  discounting requests for more of everything and the losing seat's complaints about scoring.
  It returns up to 3 things to keep and 3–5 concrete changes, each tied to evidence from the run.
- **Saved outside the run**, since `cleanup --all` deletes it. The agent writes
  `<run>/retro.md`, then `dark-factory retro` copies it to `retros/<runId>-<repo>.md` in this repo when the
  plugin is installed from a checkout (gitignored), otherwise under `~/.claude/dark-factory/retros/`. It attaches the exact notes and facts, read from the retro agent's saved
  transcript and hash-checked, as `seat-run` does for relays. If the sandbox blocks the write,
  the agent reruns the command outside it, which the allow rule permits.

One note is a lead and the same note across turns or runs is a pattern, so read `retros/`
across several runs before changing anything. Transcripts still explain a failure better than
any note: no seat would have diagnosed the relay indentation bug.

## Install and test

    ./install.sh                 # once: builds from src/, installs this checkout as the plugin, removes pre-plugin copies
    make build                   # after editing src/; then /reload-plugins or a new session (the plugin is read live)
    make check                   # all code, host, and installer gates; no models or installed Claude plugin required
    make installed               # separately check that the local Claude plugin is this checkout
    make hooks                   # run `make check` before every commit (there is no remote for CI)

The pieces of `make check`:

    node test/sim.mjs            # the real script against stub agents, and bin/dark-factory against a stub agy and real git; 27 scenarios
    SIM_ONLY=scenarioBallot,scenarioMeasure node test/sim.mjs   # just those
    node --test test/logic.mjs   # the decision logic called directly: consensus, tallies, narrowing, ranking, readiness, rulings, ingestion, config
    node --test test/host-logic.mjs test/codex-runner.mjs test/codex-install.mjs # Codex routing, runner, and installation with stub CLIs
    python3 -B -m unittest discover -s test -p 'test_*.py'      # bin/dark-factory's pure functions
    node test/static.mjs         # scripts parse, `meta` is a plain literal, src/lib stays pure
    node test/hash-parity.mjs    # the JS and Python prompt hashes agree
    node tools/build.mjs --check # the built workflows are what src/ builds to

**Prompt golden files.** `test/golden/<run>/<kind>.txt` holds the rendered prompt of each kind
(setup, solve, debate, checker, panel, ratify, relay and so on) for fixed scenarios, and the
sim compares against them. The prompts are the product, so a change to one shows up as a
failure naming the line. After an intended change, run `UPDATE_GOLDEN=1 node test/sim.mjs` and
read `git diff test/golden` before committing. The CLI's polling intervals can be shortened
for tests with `COUNCIL_JOB_POLL`, `COUNCIL_TRANSCRIPT_POLL` and `COUNCIL_TRANSCRIPT_WAIT`.

`plugins/dark-factory/workflows/ensemble.js` ships in the same plugin; it is hand-written.

Requirements: Claude Code with the Workflow tool, the `codex` CLI and the Antigravity CLI
(`agy`) logged in, `python3`, and `git`. Implement mode needs a repository with at least one
commit. Without one of the CLIs, pick a lineup without its seats.

**Permission (required for Codex and Gemini seats).** Neither CLI can run inside Claude Code's
Bash sandbox: each writes to its home directory (`~/.codex`, `~/.gemini`) as it starts, and
needs the network. `dark-factory seat-run` detects
this; the relay runs the command outside the sandbox from the first try. That needs an allow
rule in `~/.claude/settings.json`, which also stops the relay and checker agents prompting:

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

Per the Claude Code docs, an allow rule also approves running the commands it matches outside
the sandbox, and it applies before auto mode's classifier. Without it, setup's preflight
finds the CLI stuck in the sandbox and stops the run before any seat starts, saying how to fix
it or which seat to swap.

**agy settings (required for Gemini seats).** Headless agy can't ask for permission, so it
denies every command and file edit unless `~/.gemini/antigravity-cli/settings.json` has
`"toolPermission": "proceed-in-sandbox"`. Commands then run without prompting inside agy's
sandbox, which has no network and can only write where a grant allows. This setting is global,
so it applies to interactive agy sessions too; `seat-run` refuses to start a Gemini turn without
it. `seat-run` adds the one grant a run needs, `write_file(<repo>/.council)`, the first time a
repository has a Gemini seat.

## Gotchas

- agy reports `SUCCESS` with exit code 0 in several failures, so `bin/dark-factory` checks every
  Gemini result. It catches:
  - a command or edit it denied, which ends the turn. The runner resumes the conversation once,
    saying so; a second denial fails the turn. The usual cause is git: a worktree keeps its git
    data under the main checkout, which agy's sandbox can't read, so a seat that runs git asks
    to leave the sandbox. Gemini seats are told not to run git and never to ask;
  - an unknown conversation id, where agy quietly starts a new conversation;
  - a resumed turn answered in plain text, where agy hands back the *previous* turn's
    structured output. The runner asks once, in the same conversation, for structured output,
    and fails the turn if it still doesn't match the schema.
- agy's sandbox blocks shell writes anywhere under the directory agy starts in, and from inside
  the repository it blocks even reads under `.council/`. So a Gemini seat starts in an empty
  directory under `$TMPDIR/council-agy/`, and its prompt names the worktree by absolute path.

- A Codex or Gemini turn that fails because the model is at capacity or rate-limited is retried
  once, after 90 seconds, inside the job. A used-up quota is not retried: swap the vendor's
  seats out with `--seats`.
- Projects often gitignore their `CLAUDE.md`, so a worktree checked out from HEAD wouldn't have
  it. `dark-factory init` copies an ignored `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or `GEMINI.md`
  into each worktree, and snapshots leave them out of the diffs. Project-specific tool tips
  (memory limits, cache paths) belong there.
- Seats are told to run tests and gates themselves, with output going to a log, and that a
  CLAUDE.md rule to delegate gate runs to a subagent is meant for the main session. Seats have
  no subagents, and `claude -p` can't log in from a Codex or agy sandbox.
- In the Claude host, a question answered mid-run counts only from the round after it was
  escalated, so the resumed run replays earlier rounds from cache. The Codex host starts a new
  run: append each full question and answer to `context`, since question IDs can change.
- `codex exec` waits forever on an open stdin pipe. `bin/dark-factory` always feeds it a file.
- Ignored dependency directories (`vendor/`, `node_modules/`) are copied into each worktree
  with APFS clones (`cp -c`), not symlinked. A symlinked `vendor/` makes Composer autoload the
  *main* tree's classes.
- Cost: roughly 30–50 agent turns per run at the defaults. On the toy smoke test below, a Codex
  turn used 74–101k input tokens (65–78% cached), nearly all of it Codex's own fixed overhead:
  the whole room was about 5k tokens. That run used 22 agents, about 840k Claude subagent
  tokens, and 525k Codex input tokens (6k output) over six Codex turns, and took 4.3 minutes.
- `codex exec resume` reports usage as the thread's running total, not the turn's.
  `bin/dark-factory` subtracts the previous total, so `dark-factory usage` is per turn.

## Smoke test, 2026-10-11

On a toy `median()` bug (even-length lists wrong; the function also sorts the caller's list in
place), with all four seats at `effort: 'low'` and `rounds: 1`:

- Setup wrote five criteria before any seat started.
- All four fixes passed every published test.
- The seats split on a genuine judgment call, which they recorded as judgment, not as a defect:
  - Astra and Sol kept the in-place sort ("out of scope").
  - Opus and Sonnet sorted a copy.
- The 2–2 vote went to the scorecard, which ranked Opus's position first.
- Opus wrote the final version and adopted Astra's extra tests.
- All three others endorsed it, with their preference recorded as dissent.
