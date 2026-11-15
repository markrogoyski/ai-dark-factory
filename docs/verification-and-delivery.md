# Verification and delivery

[Documentation index](README.md) · [Project README](../README.md)

## The verification gate

Factory setup stores the full gate in `<runDir>/verify.sh` and explicit execution overrides
in `<runDir>/verification.json`, for example:

```json
{"env": {"PHPSTAN_FLAGS": "--debug --no-progress", "PSALM_FLAGS": "--threads=1 --no-cache --no-progress"}}
```

Factory setup also captures a small base environment for tool discovery, locale, identity,
and temporary paths. Other shell-local exports do not reach verification; required project
variables must be explicit overrides. These example variables require the project's commands
to consume them. Setup must establish a working invocation without removing required checks;
there are no PHP-specific defaults in the factory. Setup and specification amendment own the
configuration. Seats and auditors use
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

Factory verification creates a private temporary directory for each gate/replay execution.
It prefers short roots, tries the configured and host temporary roots as well as `/tmp` and
`/var/tmp`, and falls back to a longer writable root when sandbox permissions require it.
It sets `TMPDIR`, `TMP`, and `TEMP` and removes only its own directory. No writable root is
reported as infrastructure failure. A recognized socket exception referencing that execution's
directory retries the full gate once within its deadline, with separate logs, provided the
tracked tree is unchanged. Other failures remain failures.

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

## Pair replay

A Pair measurement replays the changed test files on base and on the final snapshot, besides
running the full gate. Each implementation response maps approved check IDs to current files,
focused commands, and fixtures. Each focused command must isolate one test file. Separate files
are preferred for new-API and preserved-behavior tests; explicit user or plan file requirements
take precedence, and reviewers still check that focused commands preserve useful baseline
evidence. Shared files need focused selections and a review of base loadability. A whole-suite
final obligation is a gate check in the contract, with no replay mapping.

Only added/modified regular test and fixture files under the reviewed test roots are overlaid,
using snapshot bytes. Unchanged files use the base copy. Production/config/dependency changes,
unsafe paths and symlinks are excluded; renames/deletions are reported explicitly and are not
overlaid. Dependencies needed for replay must be visible to the reviewer, rather than silently
copied. Each execution gets a fresh checkout and the captured verification environment. Replay
supplements the full gate and uses the helper's focused-test timeout (default 300 seconds per
command). Base replay copies ignored dependencies from the original run repository and reports
that author dependency changes were excluded. Final replay uses the author's dependency
installation, like the full gate, so a package addition or upgrade can pass its final focused
checks. Each command gets a fresh dependency copy. Ignored dependencies still have the
checkpoint limitations in [Process controls](process-controls.md#resume).

The executions run in parallel with each other and with the gate, each in its own disposable
checkout and private TMPDIR, and their records keep mapping order (base before final), so the
evidence doesn't depend on which one finished first. At most `concurrency` run at once:
`min(4, max(1, cpus / 2))` by default. Set it in `verification.json` beside `env`, for example
`{"env": {}, "concurrency": 1}`, for tests that share a fixed port, a database or a global
cache; `1` restores the fully serial order (replay, then gate). A base execution that ran and
finished (no launch error, no timeout) is cached in `<runDir>/cache/replay-base/`, keyed by the
base commit, the command, the overlaid file and fixture bytes, the test timeout and the
verification settings. A later round with the same key copies its log and marks the record
`reused: true` instead of running it again. The final side always runs.

The helper's raw replay evidence, in the job's `status.json`, is at file/command granularity,
with check IDs, base/snapshot identity, cwd, exit/signal/timeout, launch errors, logs and output
tails. The measurement summary the engine reads drops the cwd, log digests and tails. A base
fatal is a result even when no individual assertions ran. Base passes, timeouts and tool errors
also require reviewer judgment; none automatically establishes or rejects intended changed
behavior. An excluded or unscheduled file has no execution result. Every changed check needs a
base result; every executable check needs a passing final result. Missing evidence is
incomplete, and observed final failures block. Only the reviewer can close findings, and the
final review examines the whole implementation, including omissions or weakening of the agreed
checks and regressions introduced by fixes. Test order is not enforced: the evidence is the
base and final replay, not a record of when tests were written.

## Historical evidence

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

## Delivery

Readiness and delivery are separate steps:

```text
  ready result: final.readiness ready, delivery.status pending, change still in its worktree
     |
     |  you authorize delivery
     v
  dark-factory apply --run-dir RUN       original base, nothing staged, only the local edits recorded
     |                                   at setup; stages the reviewed snapshot and checks its tree
     |                                   hash; does not commit
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

A ready result has `delivery.status: pending`: the reviewed change is still in its worktree.
Once delivery is authorized:

- **Native Claude Code run.** Pass the workflow task's output file as it stands (the helper
  reads the result inside it), or a saved copy of the returned result, as `--result`:

      dark-factory apply           --run-dir <runDir> --result <task-output-or-saved.json>
      dark-factory verify-delivery --run-dir <runDir> --result <task-output-or-saved.json>

- **Codex or the standalone runner.** Both commands default `--result` to
  `<runDir>/result.json`, so:

      dark-factory apply           --run-dir <runDir>
      dark-factory verify-delivery --run-dir <runDir>

Two options go on `verify-delivery` when needed:

- `--manifest MANIFEST.json` lists what you changed after `apply`: `adjustments` and `handoffs`
  arrays, each entry with `path`, `reason`, and `sha256` for the exact reviewed bytes (`"absent"`
  for deletion), such as required local-plan updates. Omit it when both would be empty.
- `--max-wait N` is how long the call waits for the gate job before returning (default 540
  seconds, under the Bash tool's ceiling); it is not the gate deadline, which `--suite-timeout`
  sets. If the gate is still running when the wait ends, the call returns `status: running` with the
  job to poll with `dark-factory wait`; rerunning the same command settles that job.

`apply` requires the original base and an index matching HEAD, so it refuses any staged change.
Local edits recorded at setup (`deliveryBaseline` in `run.json`), which are untracked files and,
for an `allowDirty` run, unstaged tracked edits, may stay and are left in place. It refuses a
recorded edit that has changed since, any other tracked edit or new untracked file, a reviewed
change to a recorded path (or to a parent or child of one), and local file collisions. It stages
the snapshot and checks its tree hash. It does not commit. Files delivered any other way, such
as copied by hand, count as delivered only once `verify-delivery` reports `delivered`.

`verify-delivery` compares delivered files to the snapshot, checks unrelated local files against
setup, reruns the shared gate in the main checkout, and writes `<runDir>/delivery.json`. It never
applies changes itself. Record and review any post-audit adjustment, including scanner
exclusions for `.council`; verify that project files remain in scope in both main and nested
worktrees. Only delivery's `status: delivered` means that this final check passed; readiness
remains a separate result. When no automated gate was configured, delivery records that it was
not run rather than claiming a test pass.

For diagnosis of an incomplete run whose snapshot has already been applied, add
`--diagnostic-reason "explanation"` to `verify-delivery`. It checks snapshot identity and
delivered bytes and runs the gate, but records `verified-diagnostic` in
`delivery-diagnostic.json` rather than marking delivery complete. Readiness stays unchanged.

After a verified delivery, `dark-factory cleanup --run-dir <runDir>` removes the run's
worktrees and its `refs/council/<runId>/` refs and keeps the room; `--all` also removes the run
directory.

## Results and summaries

Factory and Pair results include a compact `summary` and, when saved, `summaryFile`. The
Codex runtime writes `runDir/summary.json` directly and links it in the completion event;
`runDir/result.json` and `hostRunDir/result.json` contain the full result. Native runs return the
summary inline, without an extra model turn. Full results identify themselves as
`artifactType: "dark-factory-result"`, `artifactVersion: 1`; summaries use
`artifactType: "dark-factory-summary"`. Summaries expose readiness, open findings, snapshot
identity, and evidence paths without embedding the full conversation. They are informational
and cannot be supplied to delivery helpers.
