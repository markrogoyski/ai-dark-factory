---
name: dark-factory
description: "Run dark-factory for implementation, investigation, or design with independent attempts, verification, and review. Use when the user asks for the factory or council process."
---

# Dark Factory

Run the shared factory engine through [scripts/run.mjs](scripts/run.mjs). It owns routing,
agent turns, checks, escalation, voting, and readiness. Do not reproduce those decisions in
chat or launch additional seats outside the runner.

## Launch

Resolve `scripts/run.mjs` relative to this skill's installed location. Run it with Node from
the target repository, or pass `--cwd` explicitly:

```sh
node /resolved/skill/scripts/run.mjs --cwd /path/to/repo -- "Fix the missing final page"
```

The paths above are placeholders. Use the actual skill and repository paths, quoted as shell
arguments. The launcher finds the shipped runner and helper itself; neither needs to be on PATH.
Node, Python 3, and an authenticated Codex CLI must be available. Mixed-vendor runs additionally
need their selected CLIs and authentication.

Use `--workflow council` for a requested council run; factory is the default. Preserve requested
`--tier` and `--seats`. Use `--args-file` with a JSON object for other factory options: `task`,
`context`, `plan`, `simple`, `roles`, `panel`, `spec`, `audit`, or `clarifications`. Write the
object as a file rather than interpolating it into a shell command. Pass absolute paths for
documents in `plan`, including uncommitted plans; seats start from HEAD and cannot otherwise
see those files. Never silently enable `allowDirty` or commit/stash the user's changes to get
past a dirty-tree result.

The Codex profile uses OpenAI models by default. Explicit Claude or Gemini seats retain their
vendors. Use `--concurrency` to bound simultaneous model turns and `--timeout-min` for turn
deadlines. The engine supplies each seat's task and evidence; do not add the coordinator's
conversation history to blind attempts or fresh reviews.

## Monitor and handle results

Keep the runner's process/session alive and poll it while reporting meaningful progress.
Progress goes to stderr; the final stdout is JSON. The result includes `hostRunDir` and
`hostEvents`; the host directory retains the arguments, events, and `result.json`. `--output`
also saves the result at a chosen path. A run's worktrees and evidence are under `runDir`.
Keep these artifacts for inspection, especially when a milestone will refer to its design.

Exit 0 means a completed result whose readiness passed; exit 2 means a decision or unresolved
readiness; exit 1 means an execution failure. Read the JSON in all cases. `status: done` alone
does not mean a change is ready: inspect `final.readiness`, checks, findings, and review gaps.

Handle paused results using their actual fields and the user's existing instructions:

- `needs-plan`: locate the named document and rerun with its absolute path in `plan`. Ask only
  if the intended document cannot be determined.
- `needs-tier`: show the requested and recommended tiers with intake's reason. If the user
  already confirmed the choice, carry it forward; otherwise obtain that choice. Rerun with
  `tierConfirmed: true` to retain the pin, or change `tier` to the accepted recommendation.
- `needs-split`: show the independent pieces and dependencies. Follow an already stated
  preference, or obtain the user's choice. `noSplit: true` retains one run; separate runs
  need each earlier result delivered and committed before dependent work starts from HEAD.
- `needs-user`: present the unresolved questions. Append each full question and its answer
  to `context`, preserving any original context, and rerun with the original arguments.
  A new run may assign different question IDs; do not reuse old IDs as `clarifications`.
- `blocked`, `failed`, or incomplete readiness: report the concrete failing check, missing
  review, or CLI problem. Do not relabel it as success, change vendors without authority,
  or retry the same failing launch indefinitely.

Reruns use this launcher and an updated args file. There is no workflow checkpoint/resume
command: a rerun starts a new host run. Seat sessions continue only across turns within a run.

## Present and deliver

Read the final post and diff/design yourself; spot-check the claims that determine readiness.
Lead with any blocked or incomplete outcome and assumptions requiring the user's attention.
Explain the chosen result, verification evidence, independent review, remaining findings, and
artifact paths. Preserve the report's facts and scorecards; do not recompute the winner.

The runner leaves implementation changes in `final.worktree` and supplies the diff and
`final.snapshotRef`; it does not apply them to the main checkout. Deliver the reviewed change
within the user's existing authorization, checking the main tree and patch applicability first.
Preserve unrelated edits and rerun project checks after application. Creating a factory result
does not itself authorize publishing or deploying it.

Factory results report delivery as pending. After application and required local-plan updates,
use the shipped helper's `verify-delivery` command as described in
[references/delivery.md](references/delivery.md). It compares the delivered bytes, records any
reviewed adjustments and handoffs, and runs the shared gate in the main checkout. Report its
`delivery.json` separately from factory readiness; a ready snapshot can still fail delivery.

Architecture returns a reviewed design and `milestones[]`, with arguments for later factory
runs. Present those milestones and retain the design artifacts. Do not automatically launch
them; execute only the milestones the user requests.
