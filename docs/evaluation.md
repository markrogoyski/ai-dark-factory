# Evaluate process value without model calls

[Documentation index](README.md) · [Project README](../README.md)

Each Factory, Pair, Council, and Ensemble result includes versioned `metrics`; Codex also saves `metrics.json` in `hostRunDir`.
It records workflow, tier, strategy, turns by role, failed turns, elapsed time when available,
findings by stage, readiness, escalation, and recorded token usage. The runner also records
repository HEAD. Factory retrospective facts include a metrics snapshot before the retrospective itself; the evaluator keeps that scope separate from completed-run metrics. Unknown measurements and dollar costs stay unknown. Native workflow results
can be saved as JSON and passed to the same evaluator. Native workflows have no exact clock, so
the helper appends `{at, event, job}` lines to `<runDir>/timeline.jsonl`: one per `init`,
`measure`, `seat-run`, `wait`, `materialize`, `verify-delivery` and `retro` call, and one at each
job's start and end. Active time counts every job in full and any other gap between events up
to 15 minutes; a longer gap counts as paused (a resume, or nobody at the keyboard). `dark-factory
retro` writes it into the facts as `elapsedMs` with `elapsedSource: "helper-timeline"` and an
`elapsedByRole` breakdown (`author`, `reviewer`, `measure`, from job labels; a native author's
own turn is not a job, so it shows only in the total). The evaluator uses the timeline when a
native result has no `elapsedMs`, counts each group's `elapsedSources`, and always prefers the
Codex host's exact `elapsedMs`, which covers the whole run. A native timeline starts at `init`,
except in Pair (and Factory's pair strategy): its setup agent runs `date -u` before anything
else and passes the time to `init --started-at`, which records a `setup-start` event first (an
ISO time with an offset from the last hour; anything else is ignored). In eight runtime `"cli"`
Pair runs, 19-140 seconds of setup (30% of it) came before `init`. So native Pair time covers
setup from its start and the rest of the run. Factory intake, and setup before `init` in the
other native workflows, aren't counted. The evaluator still excludes older estimates derived
from `run.json` modification time.

Token facts use the same `records`/`byModel` format in both hosts; older native facts are also
accepted. A Codex-host result, including runtime `"cli"`, records every turn, the Claude CLI
turns among them. A native result records `tokens: null`, since the workflow can't read files; the
evaluator then reads `<runDir>/usage.jsonl`, which the helper writes only for external CLI turns
(Codex, Gemini), and labels the metrics `tokenSource: "helper-usage"` and
`nativeClaudeTurnsIncluded: false`. Each group counts its `tokenSources`; a `helper-usage` total
leaves out every native Claude turn (author, setup, relays, measurement transports), so it is not
comparable with a recorded one. `dark-factory retro` adds those turns to Factory facts from Claude
Code's saved transcripts, and the evaluator keeps facts that already carry tokens as recorded.

Run-plan reports aggregate budget accounting separately. Its child results retain these metrics
and can be passed to the evaluator individually; interrupted reservations are conservative limits,
not measured token usage or monetary spend.

Give repeated evaluations stable identities in the workflow arguments:

```json
{"task":"Fix the iterator boundary","evaluation":{"taskId":"iterator-boundary","variant":"repair-2","repetition":1},"repair":{"maxPasses":2}}
```

```sh
node plugins/dark-factory/bin/dark-factory-evaluate --output comparison.json run-1/result.json run-2/result.json
```

The offline evaluator deduplicates runs, groups by host/workflow/tier/strategy/variant, and
reports turns per ready result, readiness and escalation rates, findings by stage, available
token totals, and delivery failures. Ensemble's ready candidates and review findings are counted
separately from overall run readiness. Matched task comparisons include the repository revision;
unknown revisions are labeled. Use several representative tasks and repetitions per variant:
small changes, ambiguous bugs, scoped features, and architecture work. Compare like-for-like
inputs and inspect the actual defects found before tuning defaults. Readiness is process
evidence, not proof of correctness, and duplicate findings are not independent discoveries.

`--collect REPO` adds every `host-*` run under `REPO/.council` instead of a hand-picked list,
so failed and interrupted runs are counted beside the successful ones. Runs with no result, an
unreadable one, or no supported metrics are listed under `collected[].incomplete` with the
reason rather than silently dropped. It can be combined with explicit result files.

For failures discovered after delivery, pass `--outcomes outcomes.json`. This is an explicit
observation map keyed by `hostRunDir` (or `runDir` for native runs), with values such as
`{"status":"regression","evidence":"integration-log.txt:42"}` or `{"status":"passed","evidence":"acceptance-log.txt"}`.
The evaluator reports observed regressions separately from delivery-check failures and unknown
outcomes. It never runs tasks, changes defaults, contacts providers, or invents current prices.

