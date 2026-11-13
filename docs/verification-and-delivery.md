# Verification and delivery

[Documentation index](README.md) · [Project README](../README.md)


Factory setup stores the full gate in `<runDir>/verify.sh` and explicit execution overrides
in `<runDir>/verification.json`, for example:

```json
{"env": {"PHPSTAN_FLAGS": "--debug --no-progress", "PSALM_FLAGS": "--threads=1 --no-cache --no-progress"}}
```

Factory setup also captures a small base environment for tool discovery, locale, identity,
and temporary paths. Other shell-local exports do not reach verification; required project
variables must be explicit overrides. These example variables require the project's commands
to consume them. Setup must establish
a working invocation without removing required checks; there are no PHP-specific defaults in
the factory. Setup and specification amendment own the configuration. Seats and auditors use
`dark-factory verify --run-dir RUN --path CHECKOUT --label UNIQUE --max-wait 5` to run the same
gate and overrides. `--command-file FILE` runs a focused test or intended red instead. Each
job captures its command and overrides before execution and records cwd, output, exit status,
and timing. Only explicit overrides are recorded, not the caller's full environment; keep
credentials out of this configuration.

Neutral measurement includes the configuration and raw evidence in its cache identity.
Factory baseline and increment checks run in disposable snapshots; a live-worktree pass
cannot replace a failed snapshot check, and a gate that alters tracked snapshot files fails.
Codex checkers poll running shell sessions and helper jobs, while `--suite-timeout` controls
the gate deadline.

```text
  author's worktree --dark-factory measure--> snapshot refs/council/<run>/A-<label> + diff
                                                 |
       +-----------------------------------------+-----------------------------+
       v                                         v                             v
  base checkout + the snapshot's      snapshot checkout:             snapshot checkout:
  test files: mapped commands         mapped commands                the full gate
  (cached while inputs match)                                        (verify.sh)
       |                                         |                             |
       +-----------------------------------------+-----------------------------+
                                                 v
                    jobs/measure-A-<label>/status.json   the full record, with output tails
                                                 |
                                                 v   the summary (what --brief prints)
                    engine checks, then the author and reviewer prompts, which point
                    back to status.json for the output tails
```

A Pair measurement replays the changed test files on base and on the final snapshot. Those
executions run in parallel with each other and with the gate, each in its own disposable
checkout and private TMPDIR, and their records keep mapping order (base before final), so the
evidence doesn't depend on which one finished first. At most `concurrency` run at once:
`min(4, max(1, cpus / 2))` by default. Set it in `verification.json` beside `env`, for example
`{"env": {}, "concurrency": 1}`, for tests that share a fixed port, a database or a global
cache; `1` restores the fully serial order (replay, then gate). A base execution that ran and
finished (no launch error, no timeout) is cached in `<runDir>/cache/replay-base/`, keyed by the
base commit, the command, the overlaid file and fixture bytes, the test timeout and the
verification settings. A later round with the same key copies its log and marks the record
`reused: true` instead of running it again. The final side always runs.

The historical-evidence check is off unless a factory run passes `evidence: true`. With it on,
builders place raw historical artifacts under `room/evidence/SEAT/` with an ordered
`manifest.json` array of `{ "path": "inc1/red.log", "criterion": "C5", "stage": "inc1-red" }`
entries. Required artifacts include commands, cwd, outputs, exits, test-only diffs, source
hashes, and handoff updates. Debate, votes and review conclusions stay out. Measurement
publishes a content-addressed copy under `<runDir>/evidence/`, tied to the snapshot.
`dark-factory evidence --run-dir RUN --seat A --label inc4` validates the bundle and returns
its index. The tests auditor (or correctness/review lens when there is no tests auditor)
owns historical acceptance. Missing evidence keeps readiness incomplete even with no bug
findings and a passing current suite.

Readiness and delivery are separate steps:

```text
  ready result: final.readiness ready, delivery.status pending, change still in its worktree
     |
     |  you authorize delivery
     v
  dark-factory apply --run-dir RUN       clean base required; stages the reviewed snapshot
     |                                   and checks its tree hash; does not commit
     v
  local-plan updates and any reviewed adjustments, listed in a manifest with their hashes
     |
     v
  dark-factory verify-delivery ...       compares the delivered bytes with the snapshot,
     |                                   checks unrelated files, reruns the gate in the
     |                                   main checkout
     v
  <runDir>/delivery.json                 status delivered, or incomplete with the mismatches
```

A ready factory result has `delivery.status: pending`: the reviewed change is still in its
worktree. After authorized application and required local-plan updates, run:

```sh
dark-factory verify-delivery --run-dir RUN --result RESULT.json --manifest MANIFEST.json --max-wait 5
```

The manifest contains `adjustments` and `handoffs` arrays, each entry with `path`, `reason`,
and `sha256` for the exact reviewed bytes (`"absent"` for deletion). Empty arrays are valid;
omit `--manifest` if both are empty. The helper compares delivered files to the snapshot,
checks unrelated local files against setup, reruns the shared gate in the main checkout,
and writes `<runDir>/delivery.json`. It never applies changes itself. Record and review any
post-audit adjustment, including scanner exclusions for `.council`; verify that project
files remain in scope in both main and nested worktrees. Only delivery's `status: delivered`
means that this final check passed. Factory readiness remains a separate result.
When no automated gate was configured, delivery records that it was not run rather than
claiming a test pass.


## Results and delivery helpers

Factory and Pair results include a compact `summary` and, when saved, `summaryFile`. The
Codex runtime writes `runDir/summary.json` directly and links it in the completion event;
`runDir/result.json` and `hostRunDir/result.json` contain the full result. Native runs return the
summary inline, without an extra model turn; save their full returned result for delivery.
Full results identify themselves as `artifactType: "dark-factory-result"`, `artifactVersion: 1`;
summaries use `artifactType: "dark-factory-summary"`. Summaries expose readiness, open findings,
snapshot identity, and evidence paths without embedding the full conversation. They are
informational and cannot be supplied to delivery helpers.

For an authorized delivery of a ready snapshot, use:

```sh
dark-factory apply --run-dir <runDir>
dark-factory verify-delivery --run-dir <runDir> --result <runDir>/result.json
```

`apply` requires the original base and a clean tracked checkout/index, refuses local file
collisions, stages the snapshot, and checks its tree hash. It does not commit. Supply `--result`
when the full saved result is elsewhere, including native runs. Delivery verification still runs the project gate.

For diagnosis of an incomplete run whose snapshot has already been applied, add
`--diagnostic-reason "explanation"` to `verify-delivery`. It checks snapshot identity and delivered
bytes and runs the gate, but records `verified-diagnostic` in `delivery-diagnostic.json` rather
than marking delivery complete. Factory readiness stays unchanged. `--max-wait` controls how
long the invocation waits, not the gate deadline; omit the five-second override when a longer
foreground wait is appropriate.

Factory verification creates a private temporary directory for each gate/replay execution.
It prefers short roots, tries the configured and host temporary roots as well as `/tmp` and
`/var/tmp`, and falls back to a longer writable root when sandbox permissions require it.
It sets `TMPDIR`, `TMP`, and `TEMP` and removes only its own directory. No writable root is
reported as infrastructure failure. A recognized socket exception referencing that execution's
directory retries the full gate once within its deadline, with separate logs, provided the
tracked tree is unchanged. Other failures remain failures.

Pair preserves the original task. Setup supplies repository observations and proposed
interpretations; the author reconciles them during design, and the reviewer checks them against
the original request, reference documents, and explicit decisions. Unresolved contradictions
require user input. Explicit test-file requirements override the default preference for separate files;
reviewers still check that focused commands preserve useful baseline evidence. Contracts may
use `kind: "gate"`, `purpose: "preserved"`, the exact verification command, `file: ""`, and
`fixtures: []` for a final whole-suite obligation. Gate checks need no replay mapping and do not
replace changed-behavior baseline checks. A clean review with missing evidence returns a precise
incomplete result without another author/reviewer cycle. Unchanged unmet criteria or failed
verification can also stop a stalled run even without an open finding.

