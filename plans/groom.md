# Groom: get a ticket ready before the factory works on it

Prepared 2026-11-23, revised the same day after a Codex review. Milestones 1-5 built 2026-11-25 (sim and stub tests only; no live run yet); the bench (milestone 6) has not run. A standalone Pair or council given `brief: <path>` always re-checks it (1 turn): unlike Factory, it has no intake turn to load the file in.

## Problem

A ticket, plan item or bug report that allows two outcomes its owner would judge differently
pushes that decision onto the agents. They guess, review rounds go to the guess, and the result
can pass every check while still being the wrong thing. Today only Factory checks the goal
(`src/brief.js`: a shaper, then a fresh challenger, then `needs-user` before intake). Pair,
council, ensemble and run-plan start from the task as written. No tool helps the ticket's
writer get the ticket right before handing it off.

## Stories

1. **Writer.** As someone writing a Jira story, I groom it with dark-factory in an
   interactive session: it challenges the wording against the repository, I answer or edit,
   and I end with a ticket I can paste into Jira and hand to a pair or council run.
2. **Runner.** As the person who starts `/pair`, `/council` or `/factory`, a groomed ticket
   gets a cheap re-check rather than full shaping. An ungroomed ticket gets the full
   shape-and-challenge, and I answer any questions myself: the runner is presumed able to
   settle them.

## Decisions

### Groom is a skill that calls a small workflow

- **The interactive loop is a skill, `dark-factory:groom`.** Grooming is a conversation:
  rewording, rethinking scope, answering some questions and deferring others. A workflow is
  batch (run, `needs-user`, resume) and would make every round trip a resumed run. The skill
  runs in the writer's own Claude Code or Codex session, in a checkout of the repository.
- **The challenge is not done in the skill's chat.** The session talking with the writer is
  anchored on that conversation, and an independent challenge is the whole point. Each pass
  runs a new generated workflow, `dark-factory:brief`: the existing shaper and challenger from
  `src/brief.js`, in fresh contexts that see the ticket text and the repository, not the
  conversation. In Claude Code the skill calls it with the Workflow tool; in Codex it calls
  `scripts/run.mjs --workflow brief`.
- **One copy of the prompts.** The challenger prompt stays in `src/`, under the golden
  tests. The skill describes the loop and the ticket format and never restates the challenge.
  The same challenger is the re-check an implementation run does, so the writer and the
  runner get the same judgment.
- **The skill and the workflow have different names** (`groom` and `brief`) so the two slash
  commands don't collide.

### No fingerprint, and no zero-turn path for a ticket

The first draft let a stamped, unchanged ticket skip every goal turn by matching a hash of the
text. The review showed three ways that skip goes wrong: a normalization loose enough to
survive Jira's markup conversion also erases changes in meaning (`x < 10` and `x <= 10`); a
mismatch can't tell the challenger what changed; and a valid stamp says nothing about the
criteria, context, documents or mode the runner adds, which the shaper reads and setup uses
verbatim. Fixing each one costs more machinery (canonical section hashing, an embedded copy
of the old brief, input-interaction rules) to save one turn on runs of 10 to 40.

So a groomed ticket always gets one challenger turn at run time, and the challenger sees
everything (the ticket, every explicit input, the repository at the run's revision, and the
ticket's recorded decisions). That single rule covers all three cases, and there is no hash
to keep in parity.

### The rewritten ticket carries everything

The writer's `.council/` directory is not on the runner's machine, so the ticket text itself
carries the brief. The skill writes `TICKET.md` in a fixed layout that survives being pasted
into Jira, with one section per v1 brief field, so it round-trips:

```
<title>

Outcome — what the user will see, receive or be able to do
Why — the purpose
Scope
Out of scope
Acceptance examples — concrete cases, one per line
How we'll know it's done — the observable evidence
Left to the implementers — testing, implementation, internal design, plus any specific
  guidance ("testing: write the regression first")
Decisions — G3: <question> → <answer>, one per line

Groomed by dark-factory
```

- **Left to the implementers** carries `delegated` in full. The parser does not fill in the
  default categories when the section is missing: a ticket without it fails the parse and
  takes the two-turn path, so specific guidance is never silently dropped.
- **Decision IDs are stable across passes.** A new question gets the next unused ID after
  every ID already in the ticket's decisions (`G1`, `G2`, … for groomed decisions, kept apart
  from a run's own `B` IDs), never one renumbered from the pass. On every re-check the
  challenger returns a status for each carried decision: `holds`, `superseded` (with the new
  question that replaces it) or `obsolete` (the edit removed what it was about). Only
  decisions that hold bind the brief, and the report lists the others.
- The footer is a plain marker. It tells the parser to try; it vouches for nothing.
- `BRIEF.json` (v1, unchanged) is still written beside the ticket for same-machine handoff
  through `brief: <path>`.

### What an implementation run does with the task

Factory, pair and council (and run-plan, through them) settle the goal before setup:

| Task | What runs | Goal turns |
| --- | --- | --- |
| `brief: <path>` to a settled `BRIEF.json`, no other explicit goal inputs | load it (today's Factory reuse) | 0 |
| `brief: <path>` with criteria, context, documents or a mode | load it, then challenger on the brief plus those inputs | 1 |
| Groomed ticket that parses | parse it into the brief (no shaper), then challenger with decisions revalidated | 1 |
| Ungroomed, or the sections don't parse | today's shaper + challenger | 2 |
| `brief: false` | nothing (today's `--no-brief`) | 0 |

- The parser is deterministic JS in `src/lib/` (headings matched loosely: `#`, `h2.`, bold,
  trailing colon; values kept verbatim apart from list markers). A parse that fails
  `validBriefContent` takes the two-turn path.
- The second row changes Factory's existing reuse: today a supplied brief skips both turns
  even when the runner adds criteria that contradict it.
- **The runner answers.** Questions return `needs-user` to the runner exactly as Factory's do
  today (both outcomes, a recommendation, what the answer changes, `resumeSteps`). The answers
  become decisions in the brief.
- **The run hands back an updated ticket.** Whenever a run settles a decision or a carried
  decision stops holding, the result includes a revised `TICKET.md`, so the runner can update
  Jira and the ticket stays the record of what was built.
- The brief moves from `S.factory.brief` to a shared `S.brief`. Pair's and council's prompts
  already render `goalBriefBlock(S)`; today it is empty outside Factory.

### Loading a brief outside Factory

Native Factory loads a supplied `BRIEF.json` inside its intake turn (`dark-factory brief
--reuse`). Standalone pair and council have no intake turn: the load goes into their setup
turn, which already runs the helper's `init`, so it costs no turn. A groomed ticket needs no
load at all, because the parse is pure JS on the task text. On the Codex host, the runner
accepts `--workflow brief` and stops rejecting `brief:` outside Factory. Both entry points get
stub-based tests (native setup prompt, and the Codex CLI's argument validation and host brief
save).

### Council and pair change by default

An ungroomed task to standalone `/pair` or `/council` now costs two extra turns, and a groomed
one costs one. A question can stop the run before any seat starts. That is a deliberate
`/council` change, not Factory behaviour leaking into it: update the council goldens on
purpose and say so in the commit. `brief: false` restores today's behaviour.

## Split and not-actionable

The `brief` workflow also returns intake's `needs-split` judgment (a ticket bundling standalone
work) without picking a tier, which needs a code-level read and belongs at run time. Verdicts:
`ready`, `needs-answers`, `needs-split`, `not-actionable` (no outcome can be found).

## Milestones

1. **Shared goal stage.** Move the brief from `S.factory` to `S`. Add the ticket parser,
   stable decision IDs and decision revalidation (`holds` / `superseded` / `obsolete`) to the
   challenger. `test/lib.mjs` cases include Jira-markup round trips and a ticket without the
   implementers section. Factory gains the groomed-ticket row and the reuse-plus-inputs row;
   its goldens change only on those paths.
2. **`dark-factory:brief` workflow.** A sixth generated workflow (`src/00-meta-brief.js`,
   `src/main-brief.js`, an entry in `tools/sources.mjs`): shaper, challenger, split check,
   verdict, `TICKET.md` and `BRIEF.json`. Resume with `clarifications`. Codex host: accept
   `--workflow brief`, with stub tests. It is small, so the 512 KiB budget is not a concern.
   Update the "all five workflows" line in `CLAUDE.md`.
3. **`dark-factory:groom` skill.** `plugins/dark-factory/skills/groom/SKILL.md`: the loop
   (run `brief`, show the verdict and questions, take answers or edits, rerun with the
   ticket's decisions carried, stop at `ready`), the `TICKET.md` layout, and an optional
   starting text from a file. Codex: `agents/openai.yaml` and `install-codex.sh`.
4. **Pair and council consume it.** The table above, the `brief:` argument loaded in setup,
   `brief: false`, the revised ticket in the result, Codex host validation, stub tests, and
   docs (`docs/pair.md`, `docs/council.md`). Council goldens updated on purpose.
5. **Run-plan pre-pass.** Before the first task, run the challenger on every task at the
   plan's starting revision to **surface** questions early and ask them in one batch. Answers
   are stored in the run state keyed by task and decision ID
   (`answers: {task: {decisions: {G1: "…"}}}`, alongside today's string or
   `{answer, tier?, noSplit?}` form). The pre-pass decides nothing from the repository: a
   task's own run re-checks at its execution revision, after its dependencies have landed,
   with the pre-pass answers as carried decisions. So a conclusion drawn from code that a
   dependency later changes is checked again, and a decision that no longer holds comes back
   as a question.
6. **Bench.** Take past retro tasks, write down each one's intended outcome, then make vaguer
   copies of their tickets. Run with and without grooming. The primary measure is whether the
   delivered behaviour matches the recorded intent, checked against concrete cases from it.
   Review rounds, escalations and readiness are secondary: they can all improve while the
   wrong thing ships. Intent match decides whether pair and council keep the default from
   milestone 4.

## Open questions

- **Overlap with spec review.** Council's intent lens and Pair's spec reviewer already ask
  whether the criteria capture what the user meant. Once a settled brief exists, they could
  check criteria against the brief rather than re-deriving intent. Measure before cutting
  them.
- **Jira API.** v1 takes pasted text or a file. Reading a ticket by key, or writing the
  groomed ticket back, is outward-facing and needs credentials; leave it until the format
  has settled.
- **Writer without a checkout.** The challenger settles most questions from the code. Run
  without the repository, it asks more questions, and the skill should say so. Whether to
  support that mode at all is open.
