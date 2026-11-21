# Evaluate process value without model calls

[Documentation index](README.md) · [Project README](../README.md)

## What a result records

Each Factory, Pair, Council and Ensemble result includes versioned `metrics` (Codex also saves
`metrics.json` in `hostRunDir`): workflow, tier, strategy, turns by role, failed turns, findings
by stage, readiness, escalation, elapsed time when available, recorded token usage, and the
repository HEAD (recorded by the runner). Pair and Factory's pair strategy also record
`userDecisions`: `asked` (questions its stops asked), `answered` (answers it took and continued
with) and `unused` (answers no stop took).

Unknown measurements and dollar costs stay unknown. Factory retrospective facts include a
metrics snapshot from before the retrospective; the evaluator keeps that scope separate from
completed-run metrics. Native workflow results can be saved as JSON and passed to the same
evaluator.

## Elapsed time

The Codex host records an exact `elapsedMs` for the whole run, and the evaluator always prefers
it. Native workflows have no exact clock, so the helper appends `{at, event, job}` lines to
`<runDir>/timeline.jsonl`: one per `init`, `measure`, `seat-run`, `wait`, `materialize`,
`verify-delivery` and `retro` call, and one at each job's start and end.

- Active time counts every job in full plus any other gap up to 15 minutes; a longer gap counts
  as paused (a resume, or nobody at the keyboard).
- `dark-factory retro` writes it into the facts as `elapsedMs` with
  `elapsedSource: "helper-timeline"`, and an `elapsedByRole` breakdown (`author`, `reviewer`,
  `measure`, from job labels). A native author's own turn isn't a job, so it shows only in the
  total.
- The evaluator falls back to the timeline when a native result has no `elapsedMs`, and counts
  each group's `elapsedSources`. It ignores older estimates derived from `run.json`
  modification time.
- A native timeline starts at `init`. In Pair (and Factory's pair strategy) the setup agent runs
  `date -u` first and passes it to `init --started-at`, which records a `setup-start` event
  before anything else (an ISO time with an offset from the last hour; anything else is
  ignored). In eight runtime `"cli"` Pair runs, setup spent 19-140 seconds before `init` (30% of
  setup time). So native Pair time includes setup; Factory intake, and setup before `init` in
  other native workflows, aren't counted.

## Tokens

Both hosts use the same `records`/`byModel` format; older native facts are also accepted.

- **Codex host** (including runtime `"cli"`): records every turn, Claude CLI turns included.
- **Native**: the result records `tokens: null`, since the workflow can't read files. The
  evaluator reads `<runDir>/usage.jsonl`, which the helper writes only for external CLI turns
  (Codex, Gemini, OpenRouter), and labels the metrics `tokenSource: "helper-usage"` and
  `nativeClaudeTurnsIncluded: false`. That total omits every native Claude turn (author, setup,
  relays, measurement transports), so it isn't comparable with a recorded one.
  `dark-factory retro` adds those turns to Factory facts from Claude Code's saved transcripts;
  facts that already carry tokens are kept as recorded.

Each group counts its `tokenSources`. Run-plan reports aggregate budget accounting separately;
its child results keep these metrics and can be evaluated individually. Interrupted reservations
are conservative limits, not measured usage or spend.

## Running the evaluator

Give repeated evaluations stable identities in the workflow arguments:

```json
{"task":"Fix the iterator boundary","evaluation":{"taskId":"iterator-boundary","variant":"repair-2","repetition":1},"repair":{"maxPasses":2}}
```

```sh
node plugins/dark-factory/bin/dark-factory-evaluate --output comparison.json run-1/result.json run-2/result.json
```

The evaluator deduplicates runs, groups by host/workflow/tier/strategy/variant, and reports
turns per ready result, readiness and escalation rates, findings by stage, available token
totals, and delivery failures. Ensemble's ready candidates and review findings are counted
separately from run readiness. Matched task comparisons include the repository revision;
unknown revisions are labeled.

- `--collect REPO` adds every `host-*` run under `REPO/.council`, so failed and interrupted runs
  count beside successful ones. Runs with no result, an unreadable one, or no supported metrics
  are listed under `collected[].incomplete` with the reason. Combine it with explicit result
  files if you like.
- `--outcomes outcomes.json` records what was found after the run: a map keyed by `hostRunDir`
  (or `runDir` for native runs). A post-delivery observation looks like
  `{"status":"regression","evidence":"integration-log.txt:42"}` or
  `{"status":"passed","evidence":"acceptance-log.txt"}`; observed regressions are reported
  separately from delivery-check failures and unknown outcomes. A hidden-test grade from the
  [benchmark](#benchmark) looks like `{"kind":"hidden-tests","status":"failed","evidence":"grade.log"}`
  (`passed`, `failed`, or `ungraded` when there was no snapshot to grade) and covers runs that
  were never delivered. A key can hold one of each, as an array.
- Each group's `hiddenTests` sets readiness against the hidden tests: `readyPassed`,
  `readyFailed` (`escapedDefects`: ready but wrong), `notReadyPassed` (`falseBlocks`: held back
  but right) and `notReadyFailed`, with `ungraded`, `unknown` (no grade) and three rates
  (`passRate`, `escapedDefectRate` among ready runs, `falseBlockRate` among the rest).
  `matchedTasks` cells count `hiddenGraded` and `hiddenPassed`.

The evaluator never runs tasks, changes defaults, contacts providers, or invents prices.

## Benchmark

Readiness is the process grading itself. The benchmark checks the delivered result against
ground truth: each task reverts a real fix, and the fix's own tests, which the run never sees,
grade the run's reviewed snapshot. It is development tooling (`tools/bench.mjs`, tasks under
`bench/`) and doesn't ship with the plugin.

### Tasks

`bench/tasks/<id>.json`:

| field | meaning |
|---|---|
| `id` | the file name, lowercase with dashes; the run's `evaluation.taskId` |
| `repo` | the local source repository, read-only (`~` is expanded) |
| `fixCommit` | the full hash of the commit that fixed it |
| `base` | where the run starts; defaults to `fixCommit^` |
| `task` | the request as a user would make it: the symptom or the wanted behaviour, never the fix, the commit or the hidden test files |
| `hiddenTests` | test files from `fixCommit`, each added or modified by it; their fixed bytes replace the run's copies when grading |
| `grade` | the command that runs only those tests (a test file or `--filter`, not the full gate), from the repository root |
| `gradeTimeoutSec` | optional, default 600 |
| `dependencies` | optional `{install, paths}`: `paths` are the ignored dependency directories (`vendor`); `install` runs at base, and if it fails or is absent the directories are copied from the source checkout (`cp -c`), whose versions follow that checkout rather than base's lock file (the prepare record says which) |
| `args` | the workflow arguments: `workflow`, and `tier` or models when they matter; the harness sets `task` and `evaluation` |
| `tags` | `kind` (bug, feature) and `size` (small, medium, large) |

Good tasks are fixes whose tests exercise existing public API, or a feature whose names the task
spells out, so a hidden test never depends on names the solver had to invent. A test that
reaches into private methods grades the design rather than the behaviour.

`bench/variants.json` names the variants a run can use: each is `{description, args}`, merged
over the task's `args` (a variant can change the workflow), with optional `runnerFlags` for the
runner's command line, such as `["--concurrency", "2"]`.

### Commands

Clones and records go under `~/.cache/dark-factory-bench` (`--root` or
`DARK_FACTORY_BENCH_ROOT` to change it; never inside this checkout):

    node tools/bench.mjs list                                   # tasks and whether each validated
    node tools/bench.mjs prepare math-gcd-int-min               # leak-proof clone at base, with dependencies
    node tools/bench.mjs validate math-gcd-int-min              # hidden tests fail at base, pass at the fix
    node tools/bench.mjs run math-gcd-int-min --variant default --rep 1          # prints the plan only
    node tools/bench.mjs run math-gcd-int-min --variant default --rep 1 --yes    # LIVE MODELS
    node tools/bench.mjs grade $(node tools/bench.mjs results)  # every recorded run; or name result or record files
    node plugins/dark-factory/bin/dark-factory-evaluate \
      --outcomes ~/.cache/dark-factory-bench/records/outcomes.json $(node tools/bench.mjs results)

- **prepare** makes `tasks/<id>/repo`: a fresh repository with only `base` fetched into it, no
  remote, tags or `FETCH_HEAD`, then checks that the fix commit, the hidden tests' fixed bytes and
  every source commit outside base's history are missing from it (agents can run
  `git log --all` and `git cat-file`). The dependency directories must be ignored at base.
- **validate** runs no models: base with the hidden tests overlaid must fail and the fix commit
  must pass. The record goes to `bench/validations/<id>.json` with the output tails; only a task
  whose record is valid and matches its manifest (`manifestDigest`) can be run. Rewording `task`
  needs no new validation.
- **run** costs money: it launches the standalone runner, so every model turn is billed to the
  accounts its CLIs are signed in to (see [Choosing the models](models.md)). Without `--yes` it
  prints the command and arguments and exits 2. Each repetition gets its own leak-proof clone
  under `work/<id>/<variant>/rep-<n>/`, so no run can read another's snapshot refs, and its
  arguments carry `evaluation: {taskId, variant, repetition}`. The record
  (`records/runs/<id>/<variant>/rep-<n>.json`) names `hostRunDir` and `resultFile`; the
  runner's progress is in the `.runner.log` beside it. `--replace` discards an earlier clone of
  the same repetition.
- **grade** takes result files or run records (`results [ID...]` lists every recorded run's
  result file). For every result with a snapshot, ready or not,
  it writes `final.snapshotRef`'s tree (checked against `final.snapshotTree`) into a scratch
  directory, overwrites the hidden tests with the fix's bytes, copies the dependencies, runs
  `grade` and deletes the directory. The outcome, with its log as evidence, goes to
  `records/outcomes.json` (or `--outcomes FILE`), keyed by `hostRunDir`; a result without a
  snapshot is `ungraded`. Regrading replaces a run's earlier grade and keeps its post-delivery
  observation.

Grading every snapshot is what makes the 2×2 useful: an escaped defect is a ready result that
fails the hidden tests, a false block a result the process held back that passes them.

### Limits

The clone can't reach the fix, but the machine can: the source repositories, other clones and
the grade logs are readable by an agent that goes looking outside its checkout. A hidden test
checks one fix's reading of the task, so a failure is a lead to read, not a verdict. The tests
in `test/bench.mjs` run the whole loop against stub CLIs and throwaway repositories, with no
PHP, network or models.

## Interpreting results

Use several representative tasks and repetitions per variant (small changes, ambiguous bugs,
scoped features, architecture work), compare like-for-like inputs, and inspect the actual defects
found before tuning defaults. Readiness is process evidence, not proof of correctness, and
duplicate findings aren't independent discoveries; the [benchmark](#benchmark)'s hidden tests are
the check that doesn't come from the process.
