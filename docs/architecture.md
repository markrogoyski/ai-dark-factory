# Architecture

[Documentation index](README.md) · [Project README](../README.md)

## How the workflows fit together

```text
  run-plan    a plan of many tasks, worked one at a time
     |
     +-- each task, in dependency order, goes through factory or pair:
     |       reviewed and verified --> committed
     |       not ready -------------> parked; tasks that depend on it wait
     |
     '-- when every task is done, a council checks the whole plan was implemented

  factory     chooses how much process a task needs
     |
  shape the goal and challenge unresolved outcomes
     |
  intake reads the brief, task and code, then picks:
     |
     +-- a small, clear change ----> Simple        one implementer, one reviewer
     |                                              (moves up to Fix or Feature if it struggles)
     +-- a subtle bug -------------> Fix           a council
     +-- a new feature ------------> Feature       two plans debated, then built in checked steps
     |                                              (moves up to Architecture if it is too big)
     +-- a design or a plan -------> Architecture  designs only, returns milestones to build
     '-- a scoped change, one owner -> Pair          one author, one reviewer

  council and ensemble are used on their own.
```

## Shared guarantees

Every workflow runs seats in their own git worktrees from HEAD, starts reviewers in fresh
contexts, and lets code, not a model, decide readiness. Neutral checks run the verification gate
on a snapshot, never on a live worktree (seats may run it in their own worktrees, and
`verify-delivery` reruns it in your checkout). Nothing reaches your checkout until it is delivered, by you or by a plan run
you authorized to commit. Model names in the diagrams are the Claude Code defaults; the Codex
profile substitutes OpenAI models for most roles ([both hosts' defaults](models.md#defaults)).

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
     +-- Codex, Gemini, OpenRouter turns: a relay    |   (codex exec, claude -p, agy)
     |   agent runs `dark-factory seat-run`          +-- helper calls: run directly
     +-- other helper calls: an agent runs them      |
     |   (setup's init, checks, measurements)        |
     v                                               v
  +-------------------------------------------------------------------------------+
  | bin/dark-factory, the Python helper: worktrees, snapshots, gate and replay    |
  | jobs, Codex, Gemini, OpenRouter turns, apply, verify-delivery, usage, retro   |
  +-------------------------------------------------------------------------------+
     |
     v
  <repo>/.council/<runId>/    room/  refs/  wt/  snap/  jobs/  scratch/  usage.jsonl

  Pair with runtime: "cli", and every run-plan: in Claude Code, one Sonnet transport
  agent launches dark-factory-codex, so the right-hand column runs the whole workflow.
```

### The Codex host

`plugins/dark-factory/bin/dark-factory-codex` is the local Codex host for all five workflows. Its
adapter, `lib/codex-runner.mjs`, launches the helper directly, writes exact prompt files,
validates structured results and records progress. The skill's launcher resolves the runner
relative to its real installed path, so prompts never depend on an install path. Beside it in
`lib/`:

| file | role |
|---|---|
| `run-plan-runner.mjs` | run-plan's process, filesystem and Git adapter: delivery, commits, the journal |
| `checkpoint.mjs` | resume |
| `evaluate.mjs` | behind `bin/dark-factory-evaluate` |
| `usage.mjs` | the token accountant: every turn's tokens by role and model, read back from the vendors' logs when a CLI reported none; behind `dark-factory usage` ([Token use](results.md#token-use)) |
| `sessions.mjs` | where each CLI keeps its session logs (Codex rollouts, Claude transcripts, workflow transcript directories), shared with the benchmark's contamination scan |
| `history.mjs` | past runs for `--explain`'s estimate ([Process controls](process-controls.md#explain-and-prepare)) |
| `engine.mjs`, `engine-observations.mjs` | engine pinning and provider observations |
| `policy.mjs` | generated from `src/lib/` by `make build` |

### The workflow files

`workflows/*.js` hold the turn order, the ledger, the stop rule, the scorecards and every prompt,
and never judge. `factory.js` is the council's engine plus goal shaping, intake, the three tiers, Pair for its
pair strategy, and `src/main-factory.js` (routing and `escalate()`).

All five are **generated** from `src/` by `tools/build.mjs` (the workflow runtime allows no
imports, so each must be one file) and committed, so they can be run without a build.
Edit `src/`, then `make build`. `tools/sources.mjs` lists each built workflow's files in order.
The build drops the top-level declarations a workflow never reaches (`tools/prune.mjs`), then
minifies everything after its `meta` with esbuild, a development dependency (`npm ci`); strings and
prompts are kept as written. Claude Code skips a plugin workflow over 512 KiB, so `make check`
fails a workflow over 480,000 bytes, and `make installed` asks a headless Claude Code session which
workflows it loaded. Read and diff `src/`, not the built files.

- `src/lib/*.js` is the pure half. Every function takes the state object `S` (from
  `newState(parseConfig(args))`) first and calls nothing from the runtime: config and seats,
  state queries, every prompt, ingestion and rulings, consensus, narrowing, ranking, readiness
  and the report. Per-tier rules are in `tiers.js` (shared: routing, pushback, escalation, run
  facts), `tier-simple.js`, `tier-feature.js` and `tier-architecture.js`.
- `src/boot.js`, `schemas.js`, `turns.js` and `council.js` are the half that uses `agent()`,
  `parallel()` and `log()`: agent turns and relays, checks, and the round loop (`councilRun()`).
  Its stages `councilSetup()`, `debateStage()` and `synthesize()` are reused by `featureRun()`
  and `architectureRun()`. The Architecture tier's review is `runAudit()`, with its own prompts
  and a revision that returns the milestones.
- Tier flows: `src/simple.js`, `feature.js`, `architecture.js`.
- Pair (also Factory's pair strategy): `src/pair.js` (the design and code loop and the
  `runtime: "cli"` transport), `lib/pair.js`, `lib/pair-prompts.js`, `pair-schemas.js`,
  `boot-pair.js`, `main-pair.js`.
- Ensemble: `src/lib/ensemble.js` (stances, lenses, prompts), `ensemble-schemas.js`,
  `boot-ensemble.js`, `main-ensemble.js`, on the council's setup and checks.
- Run-plan: `src/lib/run-plan.js` (validation, scheduling, outcomes, answers, limits, report) and
  `main-run-plan.js`; process work is in `lib/run-plan-runner.mjs`.
- `src/lib/controls.js` (strategy, budgets, explanation, repair policy) and `src/repair.js`
  (bounded repairs with fresh reviews).
- `src/00-meta*.js`: each workflow's `meta` (a plain literal) and header comment.

### The helper

`bin/dark-factory` is the deterministic plumbing, since workflow scripts have no shell: a thin
entry point for the `lib/dark_factory_cli/` package (one module per concern: jobs, providers,
verification, measure, delivery, retro, and so on). It handles worktrees, snapshots
(`refs/council/<run>/<seat>-<round>`), suite and cross-test runs, and Codex turns.

- Seats leave their change uncommitted unless the task asks for commits. A snapshot keeps a
  seat's commits and puts anything uncommitted in one council commit on top.
- A Codex seat can commit, because its worktree's git dir and the object store are writable
  roots of its sandbox. agy's sandbox can't write them, so a Gemini seat describes its commits.
- A Codex panel or spec reviewer must not change the repository, but Codex's read-only sandbox
  forbids even temp files (zsh heredocs, Rscript). It runs in workspace-write from an empty
  scratch directory under the run: it reads everything and writes only there and to temp.
- Long work runs as detached jobs, polled with `dark-factory wait`, so it outlives the Bash
  tool's 10-minute limit.

### Codex, Gemini and OpenRouter seats

A workflow script can't run commands, so each turn goes through a Haiku relay agent. The relay
runs `dark-factory seat-run`, which reads the prompt from the relay's own transcript (Claude Code
saves every agent's prompt), checks its hash, and runs `codex exec` or `agy -p`; later turns
resume the seat's Codex thread or agy conversation. No model copies the prompt: in the first live
run, Haiku dropped a line of a 13 KB prompt three times. Copying by hand is only the fallback,
hash-checked, with Sonnet as the second relay.

An OpenRouter seat (`openrouter:<model-id>`) runs `claude -p` with the endpoint, its key and a
run-owned `CLAUDE_CONFIG_DIR` in that process's environment only. It counts toward the votes
needed but never as a vendor of its own ([OpenRouter seats](models.md#openrouter-seats)).

These seats keep their own memory across rounds, and after round 0 get only the round-specific
part of the prompt.

The relay returns the CLI's outcome as fields (`status` done/error/sandboxed, `error`,
`errorClass`, `seconds`) and is told that error text comes from the other model, not its own Bash
call. The workflow acts on the fields, never the wording. (In one run a Gemini "Malformed
function call" came back labelled "sandboxed", and Gemini was blocked for the rest of the run.)

- `seat-run` retries a capacity error or a malformed tool call by the vendor's model once inside
  the job, never a timeout or a used-up quota, and runs an identical failed turn at most twice.
- Each external turn's output schema pins a per-turn tag (`turn`, a one-value enum), so a stale
  answer from an earlier turn is rejected.

### The run directory

`<repo>/.council/<runId>/` is kept out of git through `.git/info/exclude`.

| path | holds |
|---|---|
| `room/` | the transcript: `r0..r3/<seat>.md` posts, `<seat>.diff`, `.stat`, `.delta.diff`, `final/`, `ratify/`, `audit/<lens>.md`, `final3/` (the audit's fix pass, or the Architecture tier's revision), `reaudit/`, `tests/<ID>/` (seats' tests; auditors' as `TXC1`, `TXD1`) |
| `room/pair-<stage>-<n>/`, `room/review-pair-<stage>-<n>/probes/` | Pair: the author's `A.md` and `probes/` (scripts its claims cite); the reviewer's probes |
| `refs/` | snapshots of the plan and other reference documents |
| `wt/<seat>`, `snap/` | worktrees (`snap/audit-<lens>` is an auditor's checkout) |
| `scratch/` | short-lived checkouts for suite and cross-tests |
| `jobs/` | Codex, Gemini, OpenRouter and measurement jobs |
| `usage.jsonl` | Codex, Gemini and OpenRouter token use (tokens only) |
| `openrouter/<seat>/` | an OpenRouter seat's Claude configuration and transcripts; `cleanup` deletes it, with or without `--all` |
| `retro.md`, `retro-data.md` | the process retro and the notes it drew on |

- The Architecture tier's reviewers write no files; their reviews are in the result. `seat-run`
  creates a missing writable root inside the run before a turn.
- Where a sandbox refuses to write `.git/worktrees`, a `snap/` or `scratch/` checkout is instead
  a standalone repository with its git dir beside it (`<name>.gitdir`), borrowing the main
  repository's objects. Seat worktrees have no such fallback, since seats commit in them: setup
  runs `init` outside the Bash sandbox.
