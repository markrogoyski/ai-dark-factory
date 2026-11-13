# Run-plan: execute a plan across runs

[Documentation index](README.md) · [Project README](../README.md)

The `run-plan` workflow executes a suite of features or defects sequentially through Factory or Pair. Each task
has fresh agent sessions, separate worktrees, and the existing independent review and readiness
gates. A successful task is applied, checked with `verify-delivery`, and committed together with
its progress record. Requesting a plan run authorizes those local commits. Use a checkout with clean tracked files
on the intended feature branch; the plan run does not publish, deploy, or switch branches.

```text
  plan.json (bytes frozen)                  .council/run-plan-<id>/state.json: attempts,
     |                                      budgets, answers, questions, decisions
     v
  +-> next eligible task: dependencies done, attempts and budget left
  |      |
  |   reserve its turns and time
  |      |
  |   a Factory or Pair run: fresh sessions, its own worktrees, review and readiness
  |      |
  |      +-- ready ----------> apply --> verify-delivery --> commit code + progress
  |      |                     (a failed check or commit hook rolls back and parks)
  |      +-- failed run, attempts left --> tried again
  |      '-- needs-user / needs-tier / needs-split / not ready --> parked; dependents wait
  +------'
     |
  no eligible task left
     +-- every task done --> acceptance: run acceptance.verify, then a fresh council
     |                       investigation on the integrated revision; both must pass
     '-- otherwise --------> incomplete: answer the parked tasks, rerun the same command
```

Create a plan such as `plan.json`. It may remain untracked; its bytes are frozen for the run. A tracked plan retains the existing behavior of committing progress with each task:

```json
{
  "version": 1,
  "id": "retry-policy",
  "decisions": ["Preserve the existing public API."],
  "limits": {
    "maxTurns": 200,
    "maxRunMin": 120,
    "maxAttempts": 2,
    "taskMaxTurns": 50,
    "taskMaxRunMin": 30
  },
  "defaults": {"verify": "make check", "retro": false},
  "tasks": [
    {
      "id": "policy",
      "task": "Implement the retry policy with bounded exponential backoff.",
      "criteria": ["Retries stop at the configured limit.", "Backoff is bounded."],
      "workflow": "pair",
      "args": {"author": "sol", "reviewer": "astra"}
    },
    {
      "id": "integration",
      "task": "Use the retry policy in the fetcher.",
      "after": ["policy"],
      "criteria": ["Transient fetch failures retry using the configured policy."]
    }
  ],
  "acceptance": {
    "verify": "make check",
    "criteria": ["The fetcher and retry policy work together without API regressions."]
  }
}
```

`workflow` defaults to `factory`. Task IDs are stable; dependencies can appear in any order,
but missing IDs and cycles are rejected. Each task and final acceptance need explicit criteria.
The limits above are also the defaults. Turn limits count workflow model turns, including failed
turns and explicit recovery turns; provider transport retries remain governed by the existing CLI
helper. These are execution limits, not dollar forecasts. Final acceptance uses a fresh Council
investigation after independently running `acceptance.verify`; both must pass on the integrated
revision. Its model options go in `acceptance.args`.

```text
$dark-factory --workflow run-plan --plan-file /absolute/path/plan.json
```

Or run the shipped CLI directly:

```sh
node plugins/dark-factory/bin/dark-factory-codex --workflow run-plan --cwd /path/to/project --plan-file /path/to/project/plan.json
```

In Claude Code, invoke `/dark-factory:run-plan` with object arguments
`{planFile: "/absolute/path/plan.json", repo: "/path/to/project"}`. A transport turn
launches the same standalone controller. Plan runs use its Codex model profile on both hosts;
explicit participants in task/default args override that profile. Existing native workflows
retain their original behavior. Node, Python, Git, and the selected authenticated CLIs are required.

Reference documents named in task/default `plan` options are frozen by hash for the plan run;
changes invalidate resume. Keep the plan run's own changing JSON file out of those references.
To use an Architecture result, map its milestones to task IDs and `after` dependencies, retain
their criteria, and pass the reviewed design as a reference. Final acceptance covers the original
requirements across all milestones.

Each task gets a snapshot of settled decisions, answers, and pointers to accepted designs and
final posts. It reads the relevant evidence instead of inheriting prior agent conversations.
Routine implementation choices stay with the task agents; scope changes and conflicting
requirements must become questions. Factory specification review uses `ask`. `needs-tier`,
`needs-split`, `needs-user`, unresolved readiness, and exhausted attempts park the task with
its result. Its dependents wait while independent tasks continue. Transport failures retry only
within the attempt and run-plan limits. If no task is eligible, the result remains incomplete.

Repeat the same invocation to resume; run-plan resume does not use `--resume`. To answer parked
tasks, use `--args-file` with:

```json
{
  "planFile": "/absolute/path/plan.json",
  "answers": {
    "integration": {"answer": "Keep the existing retry API and use the feature tier.", "tier": "feature"}
  }
}
```

Answers may be strings or `{answer, tier?, noSplit?}`. A split proposal can be kept as one task
with explicit `noSplit: true`; creating a different decomposition or changing requirements needs
a revised plan with a new ID. Answers never reset attempts or budgets; new answers are rejected
when the task has exhausted its attempts. The default two attempts allow one answered retry.
The plan definition remains immutable once started; budget exhaustion is reported,
not silently extended.

For tracked plans, completed code and the controller-owned `progress` field share a commit, with
`Factory-Plan` and `Factory-Task` trailers. `.council/run-plan-ID/state.json` also retains
unsuccessful attempts, questions, decisions, and budget accounting. Keep it and child-run evidence.
It records the engine's package digest and each task's base commit. Resuming after a plugin
update is refused: finish the plan with the plugin that started it, or start a new plan. Older
journals without the digest resume with a warning. When the engine lives inside the target
repository, its digest follows the plan's own commits, so a change only warns; use a frozen export.
Before launching, the controller reserves an attempt's allowed turns and time. A completed
attempt settles to measured usage; an interrupted attempt conservatively retains its full
reservation, so restarting cannot replenish its budget. Interrupted delivery reserves additional
verification time before retrying; if none remains, the task is rolled back and parked.
Time between completed invocations is not charged.

Recovery recognizes an exact prepared delivery or its completed commit. A failed delivery check
or rejected commit hook restores the recorded base and parks the task, charging that attempt once.
Reinvoking leaves a parked task idle until an answer requests a retry within its remaining limits.
Rollback only removes the recorded delivery bytes; unexpected edits are preserved.
Unexpected edits, changed HEAD/branch/requirements, or a still-running child stop recovery with
a diagnostic. Ordinary interrupted tasks are parked with their artifacts retained; an answer
can retry them if attempts remain. Child checkpoints retain their existing strict validation.
There is no background supervisor: an interrupted plan run is resumable, not guaranteed to keep
running after its host closes. Final acceptance checks the settled criteria without a new specification
review; its Council must return ready with every criterion met on the integrated repository.
Final acceptance failures are parked for inspection; v1 does not
invent repair scope or weaken acceptance criteria.

Untracked execution plans, named reference documents, and root-level local agent instruction files
(`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) are allowed without committing or excluding
them. Their bytes are frozen and checked on resume; tracked edits and unrelated untracked files
still stop the run. Untracked plans are never staged or rewritten: progress lives in the run's
`state.json`. A task cannot overwrite these control files.

To raise execution limits on resume, keep the plan unchanged and pass an args file:

```json
{
  "planFile": "/absolute/path/plan.json",
  "extendLimits": {
    "reason": "Allow the reviewed implementation to finish verification.",
    "limits": {"maxRunMin": 240, "taskMaxRunMin": 90, "maxAttempts": 3}
  },
  "answers": {"policy": "Retry with the increased allowance."}
}
```

Limits may only increase. The journal records the reason, old and new limits, and prior usage;
spent time, turns, and attempts remain charged. The new limits apply to subsequent attempts,
not to an already running child process. The deadline remains a hard cap, including audits.
Intake sees that cap and can warn when the selected process is unlikely to fit. Run-plan's
request to ask about unresolved requirements does not force a council when intake selects Pair.

