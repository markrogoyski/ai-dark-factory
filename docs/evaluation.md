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
- An Ensemble run's grade carries `ensemble: {pick, recommendation, candidates}` (see
  [grade](#commands)). Its 2×2 entry is the pick against the pick's own readiness, since the
  run's readiness is always `incomplete`. Groups with such runs also get
  `hiddenTests.candidates`: `runs`, every candidate's own 2×2 (`readyPassed`, `readyFailed`,
  `notReadyPassed`, `notReadyFailed`) with `graded` and `ungraded`,
  `runsWithPassingCandidate` (did any candidate pass), `pickPassed` (did the advisor pick one
  that passed) and `pickMissedPassing` (a candidate passed, the pick did not). Contaminated runs
  are left out of these too. Other workflows' groups have no `candidates`.

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

`smoke` is for proving the harness, not for measuring: Pair with a Codex Luna author and a Claude
Haiku reviewer, so both CLI paths run, at `medium` effort, the spec review on Haiku at `low`,
`maxReviews: 2`, `maxDesignReviews: 1`, `maxTurns: 10` and no retro. Pair refuses `roles`, and
needs none: on the standalone runner its only orchestration roles are setup, which runs on a Codex
author's own model (Luna), the spec review (`spec`), and the retro (off). Measurement is the
helper's, with no model. `test/bench.mjs` checks offline, through `--prepare` and a stub run, that
the variant reaches Luna and Haiku and nothing else. Its results are not comparable with any
other variant's.

`ensemble` runs Ensemble in implement mode with its defaults; on the standalone runner every
turn is Codex Astra: setup, four solvers and their checkers, two review lenses per candidate and
the comparison, 18 turns. `test/bench.mjs` runs it through the stub CLIs and grades it.

### Commands

Clones and records go under `~/.cache/dark-factory-bench` (`--root` or
`DARK_FACTORY_BENCH_ROOT` to change it; never inside this checkout):

    node tools/bench.mjs list                                   # tasks and whether each validated
    node tools/bench.mjs prepare math-gcd-int-min               # leak-proof clone at base, with dependencies
    node tools/bench.mjs validate math-gcd-int-min              # hidden tests fail at base, pass at the fix
    node tools/bench.mjs run math-gcd-int-min --variant default --rep 1          # prints the plan only
    node tools/bench.mjs run math-gcd-int-min --variant default --rep 1 --yes    # LIVE MODELS
    node tools/bench.mjs grade $(node tools/bench.mjs results)  # every recorded run; or name result or record files
    node tools/bench.mjs scan $(node tools/bench.mjs results)   # the contamination scan alone; writes nothing
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
  observation. Each graded run is also scanned for [contamination](#contamination-check).
- **grade an Ensemble run**: the result has no `final.snapshotRef`, but each of its
  `candidates` has one (`refs/council/<run>/<seat>-r0`, kept until `dark-factory cleanup`) and
  its tree. Every candidate with a snapshot is graded, ready or not, into
  `ensemble.candidates: [{candidate, stance, readiness, status, evidence, ...}]`. The outcome's
  own `status`, `readiness`, `evidence` and commit are those of `ensemble.pick`, the advisory
  comparison's top-ranked candidate (lowest `rank`; the first listed on a tie), the one the
  ensemble recommends; `ensemble.recommendation` (`adopt-one`, `merge`, `none-adequate`) is
  recorded beside it but doesn't change the pick. With no comparison, or a ranking that names
  no candidate the result has, `pick` is null and the outcome is `ungraded`, with the
  candidates still graded.
- **grade's exit code** is for a script grading a batch: `0` when every run was graded, its
  scan wasn't contaminated, and it passed; `1` when every run counts and at least one failed;
  `3` when any run is missing from the 2×2 (ungraded, skipped because its record names no
  result, or contaminated), whatever else happened. In a baseline, failures are the data, so a
  script carries on after `1`; `3` means the batch's numbers are incomplete and a run needs
  rerunning or a look first, so it takes precedence over `1`, which would otherwise hide it in
  any batch with a failure. A partial scan doesn't change the code. An error also exits `1`,
  with a `bench:` line on stderr and nothing on stdout; otherwise stderr ends with a one-line
  count (`bench: graded 10 run(s): 7 passed, 2 failed, 1 ungraded; 0 contaminated; exit 3`).
- **scan** runs the contamination scan alone and prints each run's report; it exits 0 when
  every run is clean and 2 otherwise.

Grading every snapshot is what makes the 2×2 useful: an escaped defect is a ready result that
fails the hidden tests, a false block a result the process held back that passes them.

The first run of a new setup, or after a change to the harness, should be the smoke variant on
the smallest task:

    node tools/bench.mjs validate math-gcd-int-min                               # no models
    node tools/bench.mjs run math-gcd-int-min --variant smoke --rep 1            # prints the plan only
    node tools/bench.mjs run math-gcd-int-min --variant smoke --rep 1 --yes      # LIVE MODELS: Luna and Haiku
    node tools/bench.mjs grade ~/.cache/dark-factory-bench/records/runs/math-gcd-int-min/smoke/rep-1.json
    node plugins/dark-factory/bin/dark-factory-evaluate \
      --outcomes ~/.cache/dark-factory-bench/records/outcomes.json $(node tools/bench.mjs results math-gcd-int-min)

`grade` prints the hidden-test status and the scan's status (`clean`, `partial` or
`contaminated`); `scan` with the same record file shows what a partial scan missed.

### Contamination check

The clone holds no trace of the fix, but the agents can read the whole disk, and two places on it
hold the answer: the task's source repository, which has the fix, and the bench records, whose
validate and grade logs name the hidden tests and show their output. The harness doesn't stop an
agent from going there; the scan detects it afterwards.

It reads what records the run's agents' tool calls and outputs on the standalone runner, found
from the run itself:

| record | where | attributed by |
|---|---|---|
| host run | `hostRunDir`: `events.jsonl`, `result.json`, `checkpoint.json`'s entries | the result |
| each model turn | `<runDir>/jobs/<key>/`: `out.json`, `status.json`, `stderr.txt`, and for Codex `events.jsonl` (`codex exec --json`: every command, its output and each file change) | every run directory the host's events name, and the result's `runDir`; `spec.json` gives the vendor |
| Codex session | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl` (or `archived_sessions/`) | the thread ID in the job's `thread.started` event, `status.json` or `seats/<seat>/thread`; only the date directories the run spans are listed |
| Claude session (`claude -p`) | `$CLAUDE_CONFIG_DIR/projects/<escaped cwd>/<session>.jsonl` (default `~/.claude`), and any files under `<session>/` beside it | the session ID in `status.json`, `out.json` or `seats/<seat>/claude-session`; an OpenRouter seat's under its own `claudeConfigDir` |
| agy conversation | `~/.gemini/antigravity-cli/conversations/<conversation>.db` (SQLite) | the conversation ID in `out.json` or `seats/<seat>/conversation` |

`run` records the `CODEX_HOME` and `CLAUDE_CONFIG_DIR` the runner had (`homes` in the run
record); without a record the scan uses the current environment's. Nothing else under
`~/.codex`, `~/.claude` or `~/.gemini` is read. Worktrees, snapshots and room posts aren't read
either: what an agent wrote there went through a tool call that is.

A hit is any of these in a tool call, a tool output or an agent's own output:

- the source repository's path, as the manifest gives it, with `~`, or resolved through links;
- the bench root's `records/` path, in the same spellings;
- the fix commit's hash, in full or as a prefix of 7 or more characters, as a whole word.

A path must end where a name ends (`math-php-old` is not `math-php`), and paths inside the run's
own clone (with its worktrees) or the pristine clone under `tasks/<id>/repo` never count, since
neither holds the fix. What the harness wrote is skipped: the job's `prompt.md`, `schema.json`
and `spec.json`, `<key>.host.prompt.md`, the result's `task` and `provenance`, a rollout's session
header, turn context and user or developer messages, and a transcript's prompt, queued prompts,
request copies, hook attachments and system records. So a task that names a path doesn't make its
run contaminated.

A run with a hit gets `contaminated: true` and `contamination: [{file, at, match, excerpt}]`
(the first 20 hits; `at` is a line number with a JSON pointer, or a JSON pointer) in its outcome,
beside `scan: {status, hits, files, missing, sources}`; it is still graded. A record the scan
should read but can't find (a rollout or transcript that isn't there, a job with no thread ID,
missing host events) makes the scan `partial`, with each gap listed in `missing`, so `clean` is
never claimed on incomplete evidence. An agy conversation always leaves the scan partial: its
steps are binary records, and only their readable text is searched.

The evaluator validates these fields, counts contaminated runs under `hiddenTests.contaminated`
(and `hiddenContaminated` per matched task), and leaves them out of the 2×2 and its rates.
`hiddenTests.scanPartial` counts graded runs whose scan was partial, `unscanned` those graded
before the scan existed; both stay in the 2×2.

### Limits

The clone can't reach the fix, but the machine can: the source repositories, other clones and
the grade logs are readable by an agent that goes looking outside its checkout. The
[contamination check](#contamination-check) detects the source repository, the records and the
fix commit, but not every route to the answer: another task's clone or work directory of the
same repository at a later base, this checkout's `bench/` (its manifests name the fix commit, so
reading one is caught, but listing it is not), a copy of the fix elsewhere on disk, or the web. A
command whose output the CLI didn't record in full is searched only as far as it was recorded. A
hidden test
checks one fix's reading of the task, so a failure is a lead to read, not a verdict. The tests
in `test/bench.mjs` run the whole loop against stub CLIs and throwaway repositories, with no
PHP, network or models.

## Interpreting results

Use several representative tasks and repetitions per variant (small changes, ambiguous bugs,
scoped features, architecture work), compare like-for-like inputs, and inspect the actual defects
found before tuning defaults. Readiness is process evidence, not proof of correctness, and
duplicate findings aren't independent discoveries; the [benchmark](#benchmark)'s hidden tests are
the check that doesn't come from the process.
