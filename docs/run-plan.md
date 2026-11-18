# Run-plan: execute a plan across runs

[Documentation index](README.md) · [Project README](../README.md)

`run-plan` executes a suite of features or defects sequentially through Factory or Pair. Each task
gets fresh sessions, its own worktrees and the usual review and readiness gates. A successful task
is applied, checked with `verify-delivery`, and committed with its progress record; requesting a
plan run authorizes those local commits. Use a checkout with clean tracked files on the intended
feature branch. The run never publishes, deploys or switches branches.

```text
  plan.json (bytes frozen)         state: .council/run-plan-<id>/state.json
     |
  +-> next eligible task (dependencies done, attempts and budget left); reserve its turns and time
  |      |
  |   a Factory or Pair run: fresh sessions, its own worktrees, review and readiness
  |      |-- ready ---> apply -> verify-delivery -> commit code + progress
  |      |              (a failed check or commit hook rolls back and parks)
  |      |-- failed run, attempts left --> tried again
  |      '-- needs-user / needs-tier / needs-split / not ready --> parked; dependents wait
  +------'
  no eligible task left:
     every task done --> acceptance: acceptance.verify, then a fresh council investigation
                         on the integrated revision; both must pass
     otherwise -------> incomplete: answer the parked tasks, rerun the same command
```

## The plan file

It may stay untracked: its bytes are frozen for the run and progress is kept in `state.json`. A
tracked plan also has its `progress` field committed with each task.

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

- `workflow` defaults to `factory`.
- Task IDs are stable. `after` dependencies can appear in any order; missing IDs and cycles are
  rejected.
- Each task and the final acceptance need explicit criteria.
- The `limits` shown are the defaults. They count workflow model turns (including failed and
  explicit recovery turns, not retries inside a provider's CLI helper) and minutes. They are
  execution limits, not dollar forecasts.
- Final acceptance runs `acceptance.verify`, then a fresh Council investigation; both must pass on
  the integrated revision. Its model options go in `acceptance.args`.
- Reference documents named in task or default `plan` options are frozen by hash; changes
  invalidate resume. Don't reference the plan file itself.
- To use an Architecture result, map its milestones to task IDs and `after` dependencies, keep
  their criteria, and pass the reviewed design as a reference. Final acceptance covers the
  original requirements across all milestones.

## Running it

```text
$dark-factory --workflow run-plan --plan-file /absolute/path/plan.json
```

Or run the shipped CLI directly:

```sh
node plugins/dark-factory/bin/dark-factory-codex --workflow run-plan --cwd /path/to/project --plan-file /path/to/project/plan.json
```

In Claude Code, invoke `/dark-factory:run-plan` with
`{planFile: "/absolute/path/plan.json", repo: "/path/to/project"}`; a transport turn launches the
same standalone controller. Plan runs use its Codex model profile on both hosts; explicit
participants in task or default args override it. Node, Python, Git and the selected
authenticated CLIs are required.

Each task gets a snapshot of settled decisions, answers, and pointers to accepted designs and
final posts, not earlier conversations. Routine implementation choices stay with the task agents;
scope changes and conflicting requirements must become questions. Factory's specification review
uses `ask`; when intake selects Pair, that doesn't force a council.

## Parked tasks, answers and resume

`needs-tier`, `needs-split`, `needs-user`, unresolved readiness and exhausted attempts park the
task with its result; dependents wait while independent tasks continue. Transport failures retry
only within the attempt and run-plan limits. With no eligible task left, the result is incomplete.

Repeat the same invocation to resume (run-plan doesn't use `--resume`). Answer parked tasks with
`--args-file`:

```json
{
  "planFile": "/absolute/path/plan.json",
  "answers": {
    "integration": {"answer": "Keep the existing retry API and use the feature tier.", "tier": "feature"}
  }
}
```

- An answer is a string or `{answer, tier?, noSplit?}`.
- A split proposal can be kept as one task with `noSplit: true`. A different decomposition or
  changed requirements need a revised plan with a new ID; the plan is immutable once started.
- A parked task stays idle until an answer requests a retry within its remaining limits. Answers
  never reset attempts or budgets, and are rejected once attempts are exhausted. The default two
  attempts allow one answered retry.

To raise limits on resume, keep the plan unchanged and add `extendLimits`:

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

Limits may only increase. The journal records the reason, old and new limits and prior usage;
spent time, turns and attempts stay charged. New limits apply to later attempts, not a running
child. The deadline stays a hard cap, including audits; intake sees it and can warn when the
process is unlikely to fit.

## The result

`report.markdown` ("How the plan went") lists every task (done with attempts and commit, parked
with its question, waiting on a dependency, or not started), then final acceptance, the budget
used, and the path to each task's own result. The runner logs each task as it finishes and passes
on each child run's progress lines.

A committed Pair task can leave [live checks](pair.md#live-checks) pending: criteria its run
checked only against a stand-in. They appear with their task IDs in `liveChecks` and
`final.readiness.liveChecks`, and change no commit, park or readiness state; run them before
relying on the plan.

Final acceptance checks the settled criteria without a new specification review; its Council must
return ready with every criterion met on the integrated repository. A failure is parked for
inspection; the run never invents repair scope or weakens criteria.

## Commits, state and budgets

- **Commits.** For tracked plans, completed code and the controller-owned `progress` field share
  a commit with `Factory-Plan` and `Factory-Task` trailers.
- **State.** `.council/run-plan-ID/state.json` retains unsuccessful attempts, questions, decisions
  and budget accounting, plus the engine's package digest and each task's base commit. Keep it
  and the child-run evidence.
- **Plugin updates.** Resuming after one is refused: finish the plan with the plugin that started
  it, or start a new plan. Older journals without the digest resume with a warning. When the
  engine lives inside the target repository, its digest follows the plan's own commits, so a
  change only warns; use a frozen export.
- **Budgets.** Before launching, the controller reserves an attempt's allowed turns and time. A
  completed attempt settles to measured usage; an interrupted one keeps its full reservation, so
  restarting can't replenish the budget. Interrupted delivery reserves extra verification time
  before retrying; if none remains, the task is rolled back and parked. Time between completed
  invocations isn't charged.

## Interruption and recovery

There is no background supervisor: an interrupted run is resumable, but stops when its host closes.

- Recovery recognizes an exact prepared delivery or its completed commit.
- A failed delivery check or rejected commit hook restores the recorded base and parks the task,
  charging that attempt once. Rollback removes only the recorded delivery bytes; unexpected edits
  are preserved.
- Unexpected edits, a changed HEAD, branch or requirements, or a still-running child stop recovery
  with a diagnostic.
- Other interrupted tasks are parked with artifacts retained; an answer can retry them if attempts
  remain. Child checkpoints are validated as strictly as any other resume.

## Untracked control files

Untracked plans, named reference documents and root-level agent instruction files (`CLAUDE.md`,
`CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) are allowed without committing or excluding them.
Their bytes are frozen and checked on resume, they are never staged or rewritten, and a task
can't overwrite them. Tracked edits and unrelated untracked files still stop the run.
