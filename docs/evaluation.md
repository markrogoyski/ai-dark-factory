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
- `--outcomes outcomes.json` records failures found after delivery: a map keyed by `hostRunDir`
  (or `runDir` for native runs), with values like
  `{"status":"regression","evidence":"integration-log.txt:42"}` or
  `{"status":"passed","evidence":"acceptance-log.txt"}`. Observed regressions are reported
  separately from delivery-check failures and unknown outcomes.

The evaluator never runs tasks, changes defaults, contacts providers, or invents prices.

## Interpreting results

Use several representative tasks and repetitions per variant (small changes, ambiguous bugs,
scoped features, architecture work), compare like-for-like inputs, and inspect the actual defects
found before tuning defaults. Readiness is process evidence, not proof of correctness, and
duplicate findings aren't independent discoveries.
