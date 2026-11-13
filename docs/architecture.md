# Architecture

[Documentation index](README.md) · [Project README](../README.md)

## Layout

    .claude-plugin/marketplace.json   the marketplace: lists the plugins in this repo
    plugins/dark-factory/             the plugin, and the only thing that ships
      .claude-plugin/plugin.json
      workflows/                      pair.js, factory.js, council.js, ensemble.js, run-plan.js
                                      (built from src/)
      bin/dark-factory                the helper CLI the agents call
      bin/dark-factory-codex          the Codex host and standalone runner
      bin/dark-factory-evaluate       the offline evaluator
      lib/                            the runners' adapters, checkpoints, engine pinning, and
                                      policy.mjs (built from src/lib/)
      schemas/                        the provenance schema
      skills/dark-factory/            the Codex skill and its relative launcher
    install-codex.sh                  link the skill into a project or user skill directory
    src/ tools/ test/                 development: sources, build, tests

A new workflow goes in `plugins/dark-factory/workflows/` and runs as `/dark-factory:<meta.name>`.

## Pieces

The same generated workflow file runs on both hosts; only the runtime around it changes.

```text
  Claude Code (native)                            Codex, or the standalone runner
  /dark-factory:<workflow>                        $dark-factory ..., dark-factory-codex
     |                                               |
  Claude Code's workflow runtime runs             lib/codex-runner.mjs runs the same
  workflows/<workflow>.js                         workflows/<workflow>.js
     |                                               |
     +-- Claude turns: subagents                     +-- every model turn: a CLI session
     +-- Codex and Gemini turns: a Haiku relay       |   (codex exec, claude -p, agy)
     |   agent runs `dark-factory seat-run`          +-- helper calls: run directly
     +-- other helper calls: an agent runs them      |
     |   (setup's init, checks, measurements)        |
     v                                               v
  +-------------------------------------------------------------------------------+
  | bin/dark-factory, the Python helper: worktrees, snapshots, gate and replay    |
  | jobs, Codex and Gemini turns, apply, verify-delivery, usage, retro            |
  +-------------------------------------------------------------------------------+
     |
     v
  <repo>/.council/<runId>/    room/  refs/  wt/  snap/  jobs/  scratch/  usage.jsonl

  Pair with runtime: "cli", and every run-plan: in Claude Code, one Sonnet transport
  agent launches dark-factory-codex, so the right-hand column runs the whole workflow.
```

- `plugins/dark-factory/bin/dark-factory-codex`: the local Codex host for all five generated
  workflows. Its runtime adapter (`lib/codex-runner.mjs`) launches the helper directly, writes
  exact prompt files, validates structured results, and records progress. The skill's launcher
  resolves the runner relative to its real installed path, so prompts do not depend on an
  installation path. Beside it in `lib/`: `run-plan-runner.mjs` (run-plan's process, filesystem
  and Git adapter: delivery, commits, the journal), `checkpoint.mjs` (resume), `evaluate.mjs`
  (behind `bin/dark-factory-evaluate`), `engine.mjs` and `engine-observations.mjs` (engine
  pinning and provider observations), and `policy.mjs`, which `make build` generates from
  `src/lib/`.
- `plugins/dark-factory/workflows/council.js` and `factory.js`: the moderators. `factory.js` is the same
  engine with intake, the Simple tier (`src/simple.js`), the Feature tier (`src/feature.js`), the
  Architecture tier (`src/architecture.js`), Pair for its pair strategy, and `src/main-factory.js`
  (routing, and `escalate()`) on top. They
  hold the turn order, the ledger, the stop rule, the scorecards and every prompt, and never
  judge. All five workflows are **generated** from `src/` by `tools/build.mjs` (the workflow
  runtime allows no imports, so each has to be one file), and are
  committed so they can be diffed and run without a build. Edit `src/`, then `make build`:
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
  - `src/pair.js` (the design and code loop, and the `runtime: "cli"` transport), with
    `src/lib/pair.js` (contract and mapping checks, review ingestion, readiness, stall
    detection, the measurement summary, the result), `src/lib/pair-prompts.js`,
    `src/pair-schemas.js`, `src/boot-pair.js` and `src/main-pair.js`: `pair.js`, and Factory's
    pair strategy.
  - `src/lib/ensemble.js` (stances, lenses, prompts), `src/ensemble-schemas.js`,
    `src/boot-ensemble.js` and `src/main-ensemble.js`: `ensemble.js`, on the council's setup and
    checks.
  - `src/lib/run-plan.js` (plan validation, scheduling, outcomes, answers, limits, the report)
    and `src/main-run-plan.js`: `run-plan.js`. Its process work is in `lib/run-plan-runner.mjs`.
  - `src/lib/controls.js` (strategy, budgets, explanation, repair policy) and `src/repair.js`
    (bounded repairs with fresh reviews).
  - `src/00-meta*.js`: each workflow's `meta` (it must stay a plain literal) and header comment.
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
    suite and cross-tests run in. Where a sandbox refuses to write `.git/worktrees`, a `snap/` or `scratch/` checkout is
    instead a standalone repository with its git dir beside it (`<name>.gitdir`), borrowing the main repository's objects.
    Seat worktrees have no such fallback, since seats commit in them: setup runs `init` outside the Bash sandbox.
  - `jobs/` holds Codex, Gemini and measurement jobs.
  - `usage.jsonl` records Codex and Gemini token use.
  - `retro.md` and `retro-data.md` hold the process retro and the notes it drew on.

