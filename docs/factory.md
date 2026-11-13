# The factory

[Documentation index](README.md) · [Project README](../README.md)

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

The table describes the independent strategy. Factory can also select Pair for scoped implementations with one clear approach. Use `strategy: "independent"` to retain the tier's competing-attempt process, or `strategy: "pair"` with `pair: {author, reviewer, maxReviews}` to request Pair. Task tier and collaboration strategy are reported separately. Explicit independent-process options (`seats`, `simple`, `panel`, `spec`, `audit`, `roles`, or `evidence`) keep automatic routing on the independent strategy; combining them with an explicit Pair strategy is rejected rather than silently discarding them.

```text
  task
   |
  intake (Opus, read-only: the task, its documents and the code)
   |-- a document the task needs is missing ----------> needs-plan
   |-- separate pieces of work ------------------------> needs-split  (or rerun with noSplit)
   |-- your pinned tier differs from intake's ---------> needs-tier   (or tierConfirmed)
   |
   +-- strategy pair (implement, below architecture) --> Pair
   |
   +-- simple:  setup -> implement (Sonnet) -> neutral check -> review (Astra) -> panel
   |              -> at most one fix pass -> fresh review and check -> readiness
   |
   +-- fix:     the council flow with two seats, Opus and Astra
   |
   +-- feature: setup + spec review -> plans, blind -> debate -> final plan
   |              -> build, one checked increment a turn (at most 4)
   |              -> audit: correctness, design, tests -> one fix pass -> re-review
   |
   '-- architecture: setup + spec review -> designs, blind (3 seats) -> debate
                  -> milestone plan -> review: grounding, sequencing, risk
                  -> one revision -> milestones[], each a factory run of its own

  escalation, upward only, in the same run (details in the table below):
    Simple  --too-big-----------------------> Fix or Feature, as the implementer judged
    Simple  --over-budget, design-finding---> Feature
    Simple  --verify-failed, blocked--------> Fix
    Feature --more than 4 increments--------> Architecture, before anything is built
```

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
  command also earns the fix pass. Every repair receives a fresh independent code review as well as neutral verification. The default repair budget is one pass; `repair: {maxPasses: 2}` allows a bounded additional pass. `simple: {implementer, reviewer, maxLines, maxFiles}` changes it, and
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

