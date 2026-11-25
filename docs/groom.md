# Groom: a ticket ready before the run

[Documentation index](README.md) · [Project README](../README.md)

A ticket, plan item or bug report that allows two outcomes its owner would judge differently
pushes that decision onto the agents. They guess, review rounds go to the guess, and the result
can pass every check while still being the wrong thing. Grooming settles the goal before the
work starts.

## Two stories

- **The writer grooms.** While writing a Jira story, the writer runs the `groom` skill in a
  checkout of the repository. A fresh challenger tests the wording against the code, the writer
  answers or edits, and the writer ends with a ticket to paste into Jira.
- **The runner hands off.** The person who starts `/pair`, `/council` or `/factory` passes the
  groomed ticket as the task. It gets one re-check turn instead of full shaping. An ungroomed
  task gets the full shape and challenge. Either way, the runner answers any questions: the
  runner is presumed able to settle them.

## Grooming a ticket

In Claude Code, the skill is `/dark-factory:groom`; in Codex, `$groom` (installed beside
`$dark-factory` by `install-codex.sh`). Paste the ticket, or give the path to a file:

    /dark-factory:groom Groom the story in ~/notes/retry-log.md

Each pass runs the [`brief` workflow](#the-brief-workflow) on the ticket. The skill shows the
verdict, the ticket and each question with both outcomes, the recommendation and what the answer
changes. You answer (the same run resumes with your answers) or edit the ticket (a new pass on
the edited text, which carries its decisions). It repeats until the verdict is `ready`, then
saves `TICKET.md` where you say.

- **The challenge is never done in the chat.** The session you talk to is anchored on the
  conversation. The workflow's shaper and challenger start in fresh contexts that see only the
  ticket and the repository, and the skill relays their questions unchanged.
- **No questions about testing, implementation or internal design.** Those are left to the
  implementers. Guidance you want to give anyway goes in "Left to the implementers".
- **Run it in a checkout of the repository the ticket is about.** The challenger settles most
  differences from the code. Elsewhere it settles less and asks more, and the skill says so.
  The workflow needs a Git checkout to run at all: it saves the brief under `.council/`.
- **Nothing is sent anywhere.** The skill gives you the text; pasting it into Jira is yours.

## The ticket

```text
# Retry count in the fetch log

## Outcome

Each retry in Fetcher::retry logs one debug line with the retry count.

## Why

On-call can't tell a slow fetch from one that retried.

## Scope

The debug log of Fetcher::retry.

## Out of scope

Changing the retry policy.

## Acceptance examples

- A fetch that succeeds on the third attempt logs "retry 1" and "retry 2".
- A fetch that succeeds first time logs no retry line.

## How we'll know it's done

The debug log of a forced retry shows the count.

## Left to the implementers

- testing: write the regression first
- implementation
- internal design

## Decisions

- G1: Should the count include the first attempt? → No: retries only.

---

Groomed by dark-factory
```

- The headings survive Jira's markup: `## Scope`, `h2. Scope`, `**Scope**` and `Scope:` all
  parse, and list items may start with `-`, `*` or `#`. Text is kept as written.
- **Left to the implementers** is required. A ticket without it doesn't parse, so specific
  guidance is never silently dropped. Testing, implementation and internal design are added if
  missing.
- **Decisions** are `<ID>: question → answer`, or `None.` IDs are `G1`, `G2`, … from grooming
  and `B1`, `B2`, … from a run that asked its runner. A new question gets the next unused number,
  so an answer never binds to a different question on a later pass.
- The footer marks the text as groomed and vouches for nothing: every run re-checks the ticket.
- A ticket that doesn't parse (a missing or repeated section, a decision line in another shape)
  is treated as ungroomed and shaped from scratch, and its decisions are lost. When you edit,
  keep the headings, the decision lines and the footer.

## What a run does with the task

Factory, and standalone Pair and council runs, settle the goal before intake or setup:

| Task | What runs | Goal turns |
|---|---|---|
| `brief: false` / `--no-brief` | nothing | 0 |
| Factory with `brief: <path>` and no `context`, `plan` documents, `criteria` or explicit `mode` | load the brief | 0 |
| `brief: <path>` otherwise (Factory with those inputs; any standalone Pair or council run) | load it, then one re-check against the task and every input | 1 |
| a groomed ticket (ends with the line "Groomed by dark-factory" and parses) | parse it, then one re-check that also rules on every earlier decision | 1 |
| anything else | a shaper, then a fresh challenger | 2 |

- The re-check rules on each carried decision: `holds` (it still applies), `superseded` (one of
  its new questions replaces it) or `obsolete` (the task no longer contains what it was about).
  Only decisions that hold bind the brief. **How the run went** lists the others.
- Questions stop the run with `needs-user` before intake or setup. Each has an ID, the quoted
  wording, both outcomes, the evidence, a recommendation and what the answer changes. Resume
  with `clarifications: [{id, answer}]` as the result's `resumeSteps` say. Answering costs one
  more turn, which revises the brief.
- The result has `brief` and `briefFile` (a `BRIEF.json` under `.council/`), and **How the run
  went** includes the brief. A run whose task was a groomed ticket also returns `ticket`: the
  ticket as the run settled it, in the same layout, so you can update Jira.
- Grooming numbers its questions `G1`, `G2`, …; a factory, pair or council run numbers its own
  `B1`, `B2`, …. Each continues after the IDs with its letter the brief already carries.
- This is a deliberate change to standalone `/pair` and `/council`: an ungroomed task now pays two
  goal turns, a groomed one one. `brief: false` restores the old behaviour.
- A plan run grooms every task before the first one runs, asks all their questions in one batch,
  and hands each ready task its ticket as the task ([Run-plan](run-plan.md#grooming-before-the-first-task)).

## The brief workflow

`/dark-factory:brief` runs one grooming pass. The `groom` skill calls it, and you can run it
yourself to check a ticket before handing it off. It reads the repository and changes nothing
in it; it picks no tier.

| arg | |
|---|---|
| `task` | required: the ticket text |
| `repo` | the checkout to read; default the session's |
| `clarifications` | `[{id, answer}]`, on resume |

`brief` is refused: pass the ticket as `task`.

| verdict | when |
|---|---|
| `ready` | no question is open |
| `needs-answers` | questions only the writer can settle |
| `needs-split` | the ticket bundles work that should be separate tickets |
| `not-actionable` | the text names no outcome anyone could deliver |

The result has `verdict`, `ticket` (Markdown; none with `not-actionable`), `brief` and
`briefFile`, `questions` (with `needs-answers`: `id`, `question`, `wording`, `outcomeA`,
`outcomeB`, `evidence`, `recommendation`, `changes`), `split` (with `needs-split`: each piece's
`title` and `task`, complete for someone who hasn't seen the ticket), `droppedDecisions`
(`id`, `status`, `reason`) and `reason` (with `not-actionable`). A split is reported before any
question about the bundle.

**Answers** resume the same run:

- Claude Code: the Workflow tool with `resumeFromRunId` of the stopped run, the original args
  and `clarifications`, in the same session.
- Codex: a JSON file holding `{"clarifications": […]}`, then
  `run.mjs --resume <hostRunDir> --args-file <file>`.

Keep earlier answers unchanged. A question left unanswered stays open, and the run stops again.
**An edited ticket** is a fresh run with the edited text as `task`.

In Codex, through the dark-factory skill's launcher:

```sh
node /path/to/skills/dark-factory/scripts/run.mjs --workflow brief --cwd /path/to/repo --args-file args.json
```

## Cost

The goal turns run on Opus at `medium` effort in Claude Code. On the Codex host they run on the
intake role (Astra), or Pair's setup role ([Choosing the models](models.md#defaults)).

| pass | turns |
|---|---|
| ungroomed text | 2 |
| groomed ticket | 1 |
| answers applied | +1 |

A groomed ticket still costs one re-check turn in each run it is handed to.
