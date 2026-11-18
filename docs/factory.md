# The factory

[Documentation index](README.md) · [Project README](../README.md)

`/dark-factory:factory` is the entry point when you don't know how much process a task needs. It
runs the cheapest process that plausibly suffices and hands the work up when the evidence says
that wasn't enough.

    /dark-factory:factory Add a debug log line with the retry count in Fetcher::retry
    /dark-factory:factory --tier fix Find why the sync drops the last page

| tier | what runs | rough cost |
|---|---|---|
| `simple` | Sonnet implements, the neutral check, Codex Astra reviews, at most one fix pass | 6–9 agent turns |
| `fix` | the council with two seats, Opus and Astra: blind attempts, debate, audit | 15–25 |
| `feature` | Opus and Astra plan it blind and debate the plans; the chosen plan's author builds it in checked increments; a three-lens audit | 25–40 |
| `architecture` | Opus, Astra and Sonnet design it blind and debate the designs; the chosen design's author writes a milestone plan; a three-lens review and one revision; nothing is built | 35–50 |

Models here are the Claude Code defaults; the Codex host has its own ([Choosing the models](models.md#defaults)).

Intake can also choose [Pair](pair.md) for a scoped implementation with one clear approach.
`strategy: "independent"` keeps the tier's process; `strategy: "pair"`, with
`pair: {author, reviewer, maxReviews}`, asks for Pair. The result reports tier and strategy
separately. Passing `seats`, `simple`, `panel`, `spec`, `audit`, `roles` or `evidence` keeps
routing independent, and combining one with `strategy: "pair"` is rejected.

## Intake

A read-only Opus agent reads the task, any document it names and the code, and returns a tier,
a mode, its reasons and its signals (files touched, public API, across modules, test coverage,
ambiguity). It picks the lowest tier that plausibly suffices: too low costs a few turns, too high
dozens.

- An ambiguous request is never Simple.
- Simple and Feature are for changes only: an investigation goes to fix, a design to architecture.
- One connected piece of work too big for one feature (over about 4 increments, or a design
  decision to settle first) goes to architecture.

It can also stop the run before anything is created:

| status | when | you then |
|---|---|---|
| `needs-plan` | the task depends on a document intake can't find | supply it via `plan` |
| `needs-split` | the task bundles standalone work (a checklist, fixes with separate causes, one commit per item) | the main session asks once: run each listed piece as its own factory run, in order, committing each before the next (every run starts from HEAD), or rerun with `noSplit: true` |
| `needs-tier` | you pinned a tier (`tier`, or `--tier` at the start of a string task) and intake, which runs blind to the pin, would pick another | the main session asks once: rerun with `tierConfirmed: true` to keep yours, or with intake's tier |

`needs-split` lists each piece as a self-contained task with an estimated tier and the pieces it
builds on; each gets its own intake, so those tiers aren't pinned. A kept tier is where the run
starts, not a ceiling.

## Escalation

Automatic, upward only, in the same run. Simple hands the work up when:

| trigger | when | to |
|---|---|---|
| `too-big` | the implementer says it isn't a simple change | its tier (fix or feature) |
| `over-budget` | the round-0 change exceeds `maxLines` (200) changed lines or `maxFiles` (8) files | feature |
| `design-finding` | the panel upholds a blocker or major judgment finding about the approach | feature, before any fix |
| `verify-failed`, `blocked` | after the fix pass, the verification command still fails, or the result is blocked | fix |

Feature hands the work to architecture, before anything is built, when its chosen plan lists more
than 4 increments (`too-many-increments`).

A failed agent never escalates. The higher tier runs its own setup and starts blind: its seats
are told why (upheld findings, failing tests, failing tail) but not shown the earlier change or
plan. The result is the higher tier's; its report opens with "Escalated from Simple" (or
Feature), and a run handed up twice reports both steps.

## Simple

It reuses the council's machinery: setup (1–3 criteria, one worktree), the neutral checker, the
audit with a single `review` lens (IDs `XR1`, `TXR1`), the panel for blocker and major findings,
and one fix pass, which a failing verification command also earns. Every repair gets a fresh
independent review as well as the neutral check. `repair: {maxPasses: 2}` allows a second pass
(see [Process controls](process-controls.md#repairs)). "How the run went" lists each review item
with its ruling and each repair pass (addressed and declined).

`simple: {implementer, reviewer, maxLines, maxFiles}` changes the tier. Every
`/dark-factory:council` argument passes through to the council tiers.

## Feature

It spends its independence on the plans, where it is cheap, and builds once.

1. **Setup and spec review**, as in the council, with two seats (Opus and Astra) unless you pass
   `seats`.
2. **Plans, blind.** Each seat writes a plan, not code: approach and alternatives, changes file by
   file, how each criterion will be met and tested, risks, and at most 4 increments, each leaving
   the verification command passing. Claims about existing code cite file:line; the checkers
   verify them.
3. **Debate** with the council's rounds, votes and scorecard. Findings are plan defects: a step
   relying on code that isn't there, an uncovered criterion, an increment that would break the
   suite.
4. **Final plan.** The chosen plan's author merges in the best of the others (credited). There is
   no ratification; the audit reviews the change itself.
5. **Build.** The same author builds in its worktree, one increment per turn, each followed by the
   neutral check (snapshot `inc<N>`, the verification command, its claims). Failing checks, an
   empty turn and standing findings go into the next turn's prompt.
6. **Audit** through three lenses: correctness (Codex Astra), design (Claude Opus) and **tests**
   (Claude Sonnet, IDs `XT1`, `TXT1`), which mutates the change to find behaviour no test would
   catch; `audit: {tests: 'haiku'}` swaps it. Then the council's one fix pass (a failing
   verification command also earns it) and the auditors' re-review.

The report covers the plan chosen and why, the debate, the build by increment, and the audit. A
Simple run handed up to feature runs this flow.

## Architecture

For a request for a design or plan, and for one connected piece of work too big for one feature.
It builds nothing: it hands back milestones, each ready to be a factory run of its own.

1. **Setup and spec review**, as in the council, in design mode: the criteria say what the design
   must cover and decide. Three seats (Opus, Astra, Sonnet) unless you pass `seats`; design is
   where diversity has paid off.
2. **Designs, blind**, each ending in milestones: each reviewable and committable alone, leaving
   the system working, and small enough for one feature build (at most 4 increments). Claims about
   code cite file:line, and the checkers verify them.
3. **Debate** on the designs. Findings are design defects: code that isn't there, an uncovered
   criterion, a milestone that leaves the system broken or needs what only a later one delivers.
4. **Milestone plan.** The chosen design's author merges in the best of the others (credited) and
   lists at most 8 milestones, each with a title, a self-contained task, draft criteria, the
   earlier milestones it builds on, a tier (simple or feature), and what works once it lands.
   There is no ratification; the review checks the plan.
5. **Review** by reviewers who never saw the debate:

   | lens | model | IDs | question |
   |---|---|---|---|
   | grounding | Codex Astra | `XG1` | does the plan match the code as it is |
   | sequencing | Claude Opus | `XS1` | does each milestone leave the system working; are order, dependencies and sizes sound |
   | risk and alternatives | Gemini Hydrogen | `XK1` | what could sink it; is a design the council didn't choose better, for the plan or one milestone |

   Reviewers read the plan and the repository, write nothing, and say which milestone each
   finding concerns. Only the risk lens reads the other designs. A reviewer that fails costs a gap
   in the review, not the run. `audit: {risk: 'sonnet'}` swaps the risk lens; the preflight stops
   the run if `agy` can't start. Then the audit's triage, one revision by the author, and the
   reviewers' re-review.
6. **Result.** `milestones[]`, each with the review findings still open against it and `args` for
   its own run: its task with the draft criteria and those findings, the final design as its
   `plan` document, its tier, `tierConfirmed: true` and `noSplit: true`. The main session shows
   them and offers to run them one at a time, in order, committing each before the next; nothing
   chains automatically. Keep the run directory until the milestones are done (`cleanup` without
   `--all` keeps the room), since each milestone run reads the design from it.

## Facts on every run

Each run's retro payload carries a JSON facts block: tier and how it was chosen, intake's
signals, each escalation step, readiness, turns by role, review findings, milestone count
(architecture), and hints the tier was too high (seats that agreed blind, a clean audit on a small
diff).

The model retro runs only on notable runs: every council tier, an escalation, an overruled
intake, a result that isn't ready, a fabrication or a relay failure. A clean Simple run instead
gets a Haiku turn that saves the facts (`dark-factory retro --facts-only`).
`dark-factory retro --summary` tallies `retros/*.facts.json` by starting tier, which is what the
intake rubric is tuned from.
