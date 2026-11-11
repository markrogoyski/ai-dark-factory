---
name: dark-factory
description: "Run dark-factory for implementation, investigation, or design with independent verification and review. Use when the user asks for the pair, factory, council, or ensemble process. Pair uses one author and one reviewer through design, implementation, and repeated fixes."
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

Use `--explain` to resolve a process without starting implementation (Factory performs intake only). Use `--prepare` to check offline, with no model turn and no run directory, that each reachable vendor's CLI answers and every absolute `plan` document exists; it reports roles per vendor, warns about tracked changes absent from HEAD, and leaves authentication unknown. Every new single run makes this check first and returns status `preflight` before intake when something is missing. It does not cover `--resume` or Run-plan. Preserve requested `--strategy`, `--max-turns`, `--max-run-min`, and `--repair-passes`; full repair and evaluation options can be passed through `--args-file`.

Use `--workflow ensemble` for independently reviewed alternatives. Its overall result remains advisory; inspect each candidate's readiness and missing reviews before selecting one. A merge requires fresh verification and review. An unchanged ready candidate can be saved as the result for delivery verification.

Use `--workflow pair` for one author with one reviewer and `--workflow council` for a requested
council run; factory is the default. Pair owns design review, implementation, repeated fixes,
and readiness. Its defaults are Codex Sol author and Claude Opus reviewer; preserve requested
`--author`, `--reviewer`, and `--max-reviews`. The review budget defaults to 8 across design and
code. A stalled or exhausted run remains unresolved; do not start a council automatically.
For Pair, use `--args-file` for `task`, `author`, `reviewer`, `maxReviews`, `effort`, `context`,
`plan`, `criteria`, `verify`, `repo`, `allowDirty`, and `timeoutMin`. Tier, seats, panel, roles,
spec, audit, and historical-evidence options belong to other workflows.

Use `--workflow run-plan --plan-file /absolute/path/plan.json` when the user requests
implementation of an entire plan with local commits. Run-plan owns task scheduling,
delivery, commits, budgets, and final acceptance; do not reproduce that loop in chat. The
versioned JSON plan may be untracked on the intended branch. Tracked code must be clean; local plans, named references, and root agent instruction files are frozen by hash and preserved.
See the repository README's Run-plan section for its schema. Plan creation and committing it
are within an authorized run-plan setup; preserve unrelated work. Model choices belong in
the plan's defaults/task args. Both hosts use the standalone runtime's Codex profile for plan runs.
Repeat the same command to resume, without `--resume`. For parked tasks, pass an args file with
`planFile` and `answers: {taskId: "the user's answer"}`; structured answers can also select
`tier` or `noSplit`. Existing authorization governs routine choices; scope changes and conflicting
requirements remain parked. Answers do not reset attempts or budgets. To increase limits on resume, keep the plan unchanged and pass `extendLimits: {reason: "recorded explanation", limits: {maxRunMin: 240, taskMaxRunMin: 90}}`. Limits may only increase and prior usage stays charged. Preserve `.council/run-plan-ID`
and child runs. Never reset a dirty checkout or remove a journal to force resume. Run-plan output
lists completed and parked tasks and remaining budgets. Required parked tasks or failed final
acceptance mean incomplete work. Run-plan commits locally; publishing/deploying remains separate.

For factory and council, preserve requested
`--tier` and `--seats`. Use `--args-file` with a JSON object for other factory options: `task`,
`context`, `plan`, `simple`, `roles`, `panel`, `spec`, `audit`, or `clarifications`. Write the
object as a file rather than interpolating it into a shell command. Pass absolute paths for
documents in `plan`, including uncommitted plans; seats start from HEAD and cannot otherwise
see those files. Never silently enable `allowDirty` or commit/stash the user's changes to get
past a dirty-tree result.

The factory/council Codex profile's default seats are Claude Opus, Codex Astra and Codex Sol, so it needs an
authenticated `claude` CLI; reviewers and roles default to OpenAI models. Explicit Claude or
Gemini seats retain their vendors. Use `--concurrency` to bound simultaneous model turns and `--timeout-min` for turn
deadlines. The engine supplies each seat's task and evidence; do not add the coordinator's
conversation history to blind attempts or fresh reviews.

## Monitor and handle results

For a requested pinned single run, pass `--pin-engine DIRECTORY` through the installed-relative
launcher. New exports require committed clean shipped inputs. Existing exports retain their
original executor; never replace them with the candidate or install/promote the candidate.
Choose a directory outside the candidate and all effective seat write grants, including temp
defaults and merged user/project/managed settings. Unknown bounds or unavailable mandatory
Claude hooks refuse; do not change account settings to get past that refusal. Resume validates
the saved executor/evidence and retains usage. A relocated export must have the same identity.
Pinning does not support Run-plan or launch preparation. Keep old artifacts when drift refuses.

Keep the runner's process/session alive and poll it while reporting meaningful progress.
Progress goes to stderr; the final stdout is JSON. The result includes `hostRunDir` and
`hostEvents`; the host directory retains the arguments, events, and `result.json`. `--output`
also saves the result at a chosen path. A run's worktrees and evidence are under `runDir`.
Read `summaryFile` when available for compact readiness, snapshot identity, findings, and evidence paths. Keep these artifacts for inspection, especially when a milestone will refer to its design.

Exit 0 means a completed result whose readiness passed; exit 2 means a decision or unresolved
readiness; exit 1 means an execution failure. Read the JSON in all cases. `status: done` alone
does not mean a change is ready: inspect `final.readiness`, checks, findings, and review gaps.

Handle paused results using their actual fields and the user's existing instructions:

- `needs-plan`: locate the named document and rerun with its absolute path in `plan`. Ask only
  if the intended document cannot be determined.
- `needs-tier`: show the requested and recommended tiers with intake's reason. If the user
  already confirmed the choice, carry it forward; otherwise obtain that choice. Resume the validated checkpoint with
  `tierConfirmed: true` to retain the pin. Accepting a different `tier` changes execution arguments and requires a new run.
- `needs-split`: show the independent pieces and dependencies. Follow an already stated
  preference, or obtain the user's choice. `noSplit: true` retains one run and can be supplied on resume; separate runs
  need each earlier result delivered and committed before dependent work starts from HEAD.
- `needs-user`: present the unresolved questions. For questions with IDs and a validated resume, append `{id, answer}` to `clarifications` and use `--resume` with the saved hostRunDir. The host preserves the debate round. For Pair free-text questions, failed validation, or changed tasks, start a new run with each full question and answer appended to `context`; do not reuse old IDs in a new run.
- `blocked`, `failed`, or incomplete readiness: report the concrete failing check, missing
  review, or CLI problem. Do not relabel it as success, change vendors without authority,
  or retry the same failing launch indefinitely.

Reruns normally start a new run. Use `--resume HOST_RUN_DIR` to reuse a validated checkpoint. The runner checks engine, repository, reference inputs, snapshots, worktrees and evidence before replaying completed operations. Changed task/configuration or evidence requires a new run; never reset files to force checkpoint validation. Saved worktrees and evidence remain intact. Run budgets retain spent work across resumes.

## Present and deliver

Read the final post and diff/design yourself; spot-check the claims that determine readiness.
Lead with any blocked or incomplete outcome and assumptions requiring the user's attention.
Explain the chosen result, verification evidence, independent review, remaining findings, and
artifact paths. Preserve the report's facts and scorecards; do not recompute the winner.

The runner leaves implementation changes in `final.worktree` and supplies the diff and
`final.snapshotRef`; it does not apply them to the main checkout. Deliver the reviewed change
within the user's existing authorization, checking the main tree and patch applicability first.
Use `dark-factory apply --run-dir RUN` when the original base and tracked checkout are clean; it stages the reviewed snapshot and verifies its tree hash without committing. Supply `--result FILE` if needed. Preserve unrelated edits and rerun project checks after application. Creating a factory result
does not itself authorize publishing or deploying it.

Ready Factory and Pair results report delivery as pending. After application and required local-plan updates,
use the shipped helper's `verify-delivery` command as described in
[references/delivery.md](references/delivery.md). It compares the delivered bytes, records any
reviewed adjustments and handoffs, and runs the shared gate in the main checkout. Report its
`delivery.json` separately from factory readiness; a ready snapshot can still fail delivery. For an incomplete run, `verify-delivery --diagnostic-reason "explanation"` can record gate results in `delivery-diagnostic.json`; it does not grant readiness or authorize delivery.

Architecture returns a reviewed design and `milestones[]`, with arguments for later factory
runs. Present those milestones and retain the design artifacts. Do not automatically launch
them; execute only the milestones the user requests.
