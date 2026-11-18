# Verification and delivery

[Documentation index](README.md) · [Project README](../README.md)

## The verification gate

Factory setup stores the full gate in `<runDir>/verify.sh` and explicit execution overrides in
`<runDir>/verification.json`, for example:

```json
{"env": {"PHPSTAN_FLAGS": "--debug --no-progress", "PSALM_FLAGS": "--threads=1 --no-cache --no-progress"}}
```

- **Environment.** Setup captures a small base environment (tool discovery, locale, identity,
  temporary paths). Other shell exports don't reach verification, so required project variables must
  be explicit overrides, and the project's commands must consume them. Only overrides are recorded:
  keep credentials out.
- **Configuration.** Setup and specification amendment own it. Setup must find a working invocation
  without removing required checks. There are no PHP-specific defaults.
- **Running it.** Seats and auditors run the same gate and overrides with
  `dark-factory verify --run-dir RUN --path CHECKOUT --label UNIQUE --max-wait 5`.
  `--command-file FILE` runs a focused test or intended red instead. Each job records its command,
  overrides, cwd, output, exit status and timing. `--suite-timeout` sets the gate deadline.

**Baseline.** Pair's baseline is measured by setup natively in Claude Code. On the standalone
runtime (the Codex host, `runtime: "cli"`, Run-plan) the runner measures it after setup returns,
outside setup's sandbox, and setup is told not to add overrides for failures it sees only inside
that sandbox (refused socket binds, network). Pair results report the overrides the measured gate
ran with in `final.suite.overrides` (`{}` when none) and name them in `report.markdown`; they don't
affect readiness. Council and the factory tiers still measure their baseline from setup.

**Snapshots.** Factory baseline and increment checks run in disposable snapshots: a live-worktree
pass can't replace a failed snapshot check, and a gate that alters tracked snapshot files fails.

**Temporary directories.** Each gate or replay execution gets a private directory (short roots
preferred; falls back through the configured and host roots, `/tmp` and `/var/tmp`), exported as
`TMPDIR`, `TMP` and `TEMP` and removed afterward. No writable root is an infrastructure failure. A
recognized socket exception that references that directory retries the full gate once within its
deadline, with separate logs, if the tracked tree is unchanged. Other failures stay failures.

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

A Pair measurement replays the changed test files on base and on the final snapshot, besides the
full gate. Each implementation response maps approved check IDs to current files, focused commands
and fixtures.

- Each focused command must isolate one test file. Prefer separate files for new-API and
  preserved-behavior tests unless the user or plan requires otherwise. Shared files need focused
  selections and a review of base loadability.
- A whole-suite final obligation is a gate check in the contract, with no replay mapping.
- **Overlaid:** only added or modified regular test and fixture files under the reviewed test
  roots, from snapshot bytes. Unchanged files use the base copy. Production, config and dependency
  changes, unsafe paths and symlinks are excluded; renames and deletions are reported, not overlaid.
- Each execution gets a fresh checkout, a fresh dependency copy and the captured verification
  environment.
  - Base replay copies ignored dependencies from the original run repository and reports that
    author dependency changes were excluded.
  - Final replay uses the author's dependency installation, like the full gate, so a package
    addition or upgrade can pass its final focused checks.
  - Ignored dependencies have the checkpoint limits in
    [Process controls](process-controls.md#resume).
- Each command uses the helper's focused-test timeout (default 300 seconds).

**Parallelism.** Executions run in parallel with each other and the gate, each in its own checkout
and private TMPDIR; records keep mapping order (base before final). At most `concurrency` run at once, by default `min(4, max(1, cpus / 2))`. For tests
that share a fixed port, a database or a global cache, set it (integer, 1–64) in `verification.json`
beside `env`; `1` restores the fully serial order (replay, then gate):

```json
{"env": {}, "concurrency": 1}
```

**Base cache.** A base execution that finished (no launch error, no timeout) is cached in
`<runDir>/cache/replay-base/`, keyed by the base commit, command, overlaid file and fixture bytes,
test timeout and verification settings. A later round with the same key copies the log and marks
the record `reused: true`. The final side always runs.

**Evidence and judgment**

- The job's `status.json` holds the raw evidence per file and command (check IDs, identity, cwd,
  exit/signal/timeout, launch errors, logs, output tails). The summary the engine reads drops cwd,
  log digests and tails.
- A base fatal is a result even when no assertions ran. Base passes, timeouts and tool errors need
  reviewer judgment; none automatically establishes or rejects intended behavior. An excluded or
  unscheduled file has no result.
- Every changed check needs a base result and every executable check a passing final result.
  Missing evidence is incomplete; an observed final failure blocks.
- Only the reviewer closes findings, and the final review covers the whole implementation,
  including weakened or omitted agreed checks and regressions from fixes. Test order isn't
  enforced.

## Historical evidence

Off unless a factory run passes `evidence: true`. Then:

- Builders place raw historical artifacts under `room/evidence/SEAT/` with an ordered
  `manifest.json` array of entries like `{ "path": "inc1/red.log", "criterion": "C5", "stage": "inc1-red" }`.
  Required artifacts: commands, cwd, outputs, exits, test-only diffs, source hashes and handoff
  updates. Debate, votes and review conclusions stay out.
- Measurement publishes a content-addressed copy under `<runDir>/evidence/`, tied to the snapshot.
  `dark-factory evidence --run-dir RUN --seat A --label inc4` validates the bundle and returns its
  index.
- The tests auditor (or the correctness/review lens when there is none) owns historical acceptance.
  Missing evidence keeps readiness incomplete even with no bug findings and a passing suite.

## Delivery

Readiness and delivery are separate. A ready result has `delivery.status: pending`: the reviewed
change is still in its worktree.

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

Once delivery is authorized:

- **Native Claude Code run.** Pass the workflow task's output file as it stands (the helper reads
  the result inside it), or a saved copy of the returned result, as `--result`:

      dark-factory apply           --run-dir <runDir> --result <task-output-or-saved.json>
      dark-factory verify-delivery --run-dir <runDir> --result <task-output-or-saved.json>

- **Codex or the standalone runner.** `--result` defaults to `<runDir>/result.json`:

      dark-factory apply           --run-dir <runDir>
      dark-factory verify-delivery --run-dir <runDir>

`verify-delivery` takes two more options when needed:

- `--manifest MANIFEST.json` lists what you changed after `apply`, such as required local-plan
  updates: `adjustments` and `handoffs` arrays, each entry with `path`, `reason` and `sha256` for
  the exact reviewed bytes (`"absent"` for deletion). Omit it when both would be empty.
- `--max-wait N` is how long the call waits for the gate job (default 540 seconds, under the Bash
  tool's ceiling), not the gate deadline (`--suite-timeout`). If the gate is still running when the
  wait ends, the call returns `status: running` with the job to poll with `dark-factory wait`;
  rerunning the same command settles that job.

### What `apply` does

It needs the original base and an index matching HEAD, so any staged change refuses. It stages the
snapshot, checks its tree hash and does not commit.

- **May stay:** local edits recorded at setup (`deliveryBaseline` in `run.json`): untracked files
  and, for an `allowDirty` run, unstaged tracked edits. They are left in place.
- **Refuses:** a recorded edit that has since changed; any other tracked edit or new untracked file;
  a reviewed change to a recorded path (or its parent or child); local file collisions.
- Files delivered any other way, such as copied by hand, count only once `verify-delivery` reports
  `delivered`.

### What `verify-delivery` does

It compares delivered files to the snapshot, checks unrelated local files against setup, reruns the
shared gate in the main checkout and writes `<runDir>/delivery.json`. It never applies changes.

- Only `status: delivered` means this final check passed; readiness is separate. With no automated
  gate configured, delivery records that it was not run, not a test pass.
- Record and review any post-audit adjustment, including scanner exclusions for `.council`, and
  check that project files stay in scope in main and nested worktrees.
- **Diagnosis.** For an incomplete run whose snapshot is already applied, add
  `--diagnostic-reason "explanation"`. It checks snapshot identity and delivered bytes and runs the
  gate, but records `verified-diagnostic` in `delivery-diagnostic.json` instead of marking delivery
  complete. Readiness is unchanged.

### Cleanup

After a verified delivery, `dark-factory cleanup --run-dir <runDir>` removes the run's worktrees and
its `refs/council/<runId>/` refs and keeps the room. `--all` also removes the run directory.

## Results and summaries

Factory and Pair results include a compact `summary` and, when saved, `summaryFile`.

- Codex writes `runDir/summary.json` and links it in the completion event; `runDir/result.json` and
  `hostRunDir/result.json` hold the full result. Native runs return the summary inline, with no
  extra model turn.
- Full results have `artifactType: "dark-factory-result"` and `artifactVersion: 1`; summaries have
  `artifactType: "dark-factory-summary"`.
- Summaries show readiness, open findings, snapshot identity and evidence paths, not the
  conversation. They are informational and can't be passed to delivery helpers.
