# Verify a factory delivery

Resolve the helper as `../../bin/dark-factory` relative to this skill's directory, using
the installed skill's real path when it is a symlink. Use the actual resolved path below;
do not assume it is on the coordinator's PATH.

Read the reviewed diff and check applicability in the main checkout before applying it within
the user's existing authorization. Preserve unrelated edits and requested commit history.
Complete any original local-plan updates required by the handoff.

Save a delivery manifest with `adjustments` and `handoffs` arrays. Both can be empty. Each
entry describes a relative repository path, the reason for the change, and the SHA-256 digest
of its exact bytes after review. Use `"absent"` for a deletion. For example:

```json
{
  "adjustments": [],
  "handoffs": [
    {"path": "PLAN.md", "reason": "Advance to the next milestone", "sha256": "<actual SHA-256 digest>"}
  ]
}
```

Review adjustments made after the factory audit before listing them. A manifest records that
review; it does not perform it. If a scanner needs a scratch-directory exclusion, verify that
it still scans the project files in both the main checkout and nested worktrees. Changes to
production behavior need appropriate review as well as passing gates.

Run:

```sh
/resolved/helper verify-delivery --run-dir /actual/run --result /actual/result.json --manifest /actual/delivery-manifest.json --max-wait 5
```

Poll a running shell session first, then a returned helper job using `wait --run-dir ...
--job verify-delivery --max-wait 5`. The helper never applies a patch. It checks factory
readiness, compares files with the reviewed snapshot and setup's local-file baseline, checks
declared hashes, and runs `verify.sh` with `verification.json` overrides in the main checkout.
It checks the files again afterward and writes `<runDir>/delivery.json`.

Only `status: delivered` establishes successful delivery. For `incomplete` or an execution
error, inspect the mismatches and gate log, fix within the authorized scope, and rerun. Keep
the factory's readiness and the delivery outcome distinct in the final report. Older runs
without a delivery baseline need manual verification; do not manufacture a new baseline
after applying their changes.
