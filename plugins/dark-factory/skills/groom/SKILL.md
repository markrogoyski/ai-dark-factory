---
name: groom
description: "Groom a Jira story, plan item or bug report into a ticket ready for a factory, pair or council run. Use when the user is writing or developing a ticket and wants it challenged against the repository: each pass runs the dark-factory:brief workflow, whose fresh challenger finds wording that allows outcomes the writer would judge differently. The writer answers or edits until the verdict is ready, then gets TICKET.md to paste into Jira."
---

# Groom a ticket

Help the writer turn a ticket into one a factory, pair or council run can work from without
guessing. Every pass runs the `dark-factory:brief` workflow. You run the loop; the workflow
does the challenge.

## Rules

- **Never challenge the ticket yourself.** This session is anchored on the conversation; the
  workflow's shaper and challenger start in fresh contexts that see only the ticket and the
  repository. That independence is the point. Never restate, soften, reorder or replace their
  questions, recommendations or verdict, and never add questions of your own.
- Don't ask the writer about testing, implementation or internal design. Those are left to the
  implementers. Guidance the writer wants to give anyway ("testing: write the regression first")
  goes into the ticket's "Left to the implementers" list as an edit.
- Never paste to Jira or any other external system. Give the writer the text and the file.
- Edit the ticket only as the writer asks, and run a pass on every edit.

## Before the first pass

1. Take the starting text: pasted, or read from the file path the writer gives.
2. Run `git rev-parse --show-toplevel`. The workflow needs a Git checkout (it saves the brief
   under `.council/`); if this fails, say so and ask for one. The challenger settles most
   differences from the code, so if the checkout is not the repository the ticket is about,
   say so plainly: the challenger will settle less from code and ask more. Pass `repo` (an
   absolute path) when the writer names the right checkout.

## A pass

Claude Code: call the Workflow tool with name `dark-factory:brief` and args
`{task: "<ticket text>"}` (plus `repo` if needed).

Codex: write the args to a JSON file and run the dark-factory skill's launcher, resolved
relative to this skill's directory (`../dark-factory/scripts/run.mjs`):

```sh
node /resolved/skills/dark-factory/scripts/run.mjs --workflow brief --cwd /path/to/repo --args-file /path/to/args.json
```

A pass costs 2 Opus turns on an ungroomed text, 1 on a groomed ticket (one that ends with
"Groomed by dark-factory"), and 1 more when it applies answers.

## Show the result

Show the `verdict`, then the `ticket` exactly as returned (a `not-actionable` result has
none). Then, by verdict:

- `needs-answers`: every question in `questions`, under its ID (G1, G2, ...): the question, the
  quoted wording, both outcomes, the recommendation and what the answer changes. Ask them all
  together.
- `needs-split`: each piece in `split` with its title. Offer to groom each piece as its own
  ticket, starting from its `task`. Don't hand the bundled ticket to a run.
- `not-actionable`: the reason. Ask the writer what the ticket should achieve, and start again
  from their text.
- `ready`: offer to save it.
- `failed` or any other status: report the error as given.

If `droppedDecisions` is not empty, list each: its ID, its status (superseded or obsolete) and
the reason.

## Answers and edits

- **Answers** resume the same run. Claude Code: the Workflow tool with `resumeFromRunId` of the
  stopped run, the original args, and `clarifications: [{id, answer}, ...]`, in the same
  session. Codex: an args file holding `{"clarifications": [...]}` and
  `run.mjs --resume <hostRunDir> --args-file <file>`. Keep earlier answers unchanged. A
  question the writer leaves unanswered stays open and the run stops again.
- **Edits** start a new pass on the edited ticket text. The ticket carries its decisions, and the
  re-check rules on each one. Keep the headings, the decision lines and the footer: a text that
  no longer parses as a groomed ticket is shaped from scratch, and its decisions are lost. If the
  writer has answers and edits, resume with the answers first, then edit the ticket that comes
  back.

Repeat until the verdict is `ready`, or the writer stops. If they stop with questions open, say
plainly that the ticket is not ready: a run will put its open questions to the runner instead.

## Save

Write the final `ticket` text, unchanged, to `TICKET.md` or the path the writer names. Tell
them it is ready to paste into Jira and to pass as the task of a factory, pair or council run,
which re-checks it in one turn.
