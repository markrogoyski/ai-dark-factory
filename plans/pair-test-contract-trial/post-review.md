# Pair contract/replay review follow-up — 2026-11-08

The experiment was initially held uncommitted after review. The user subsequently requested
committing the revised implementation, without a public toggle. The original sample had no
late findings to eliminate and showed substantial overhead; the commit decision does not
establish an efficiency benefit. A future effectiveness trial needs separately frozen tasks
known to produce late findings and identical setup environment settings.

The six-run results, manifest, and candidate revision
`28f359b15106f707b1863227401559ce34c3976d` are unchanged. The fixes below are newer changes;
the original comparison is not evidence about their effectiveness. Verification metadata records
the working tree before the subsequent commit request.

## Code findings addressed

1. **Malformed contracts and challenges get one correction attempt.** The engine sends the
   semantic validation error and prior artifact back before stopping. Reviewer correction uses
   a fresh context and checkout, retains the original review in its prompt, and cannot mutate
   the finding ledger until validation succeeds. Correction turns respect the run's turn
   budget and do not consume a completed review or approve a design. A second invalid response
   still stops safely; the retry cannot loop indefinitely.
2. **A reviewer can report that no check rejects a wrong implementation.** Empty rejecting IDs
   are accepted with a substantive finding, an evidenced partial/unmet assessment of that
   criterion, or an explicit design revision request. These all prevent approval and return the
   design to its author. A clean approval with empty IDs remains invalid.
3. **The native Claude relay was exercised live.** The workflow runtime exposes no direct file
   reading primitive, so the existing transport was tested rather than introducing a job-key
   response that the workflow could not resolve. The returned object exactly matched the helper
   result. Details and scope are below.
4. **Final replay uses the author's dependencies.** Base execution still receives independent
   copies of the original repository's dependencies. Final execution copies the author's
   dependencies, matching the full gate. The regression fixture requires an author-only
   dependency update in both the gate and final replay, proves the base fails with its original
   dependency, and verifies that test mutations do not leak into either source copy.
5. **Replay base identity is checked against the original run head.** Pair setup retains the
   helper's full base commit. The Codex adapter also compares the setup response with `run.json`.
   A well-formed but different base hash cannot satisfy readiness, even if every returned base
   record repeats it.

## Live native transport check

This was a targeted transport check, not another effectiveness trial or a complete native
author/reviewer Pair run. A session-only temporary plugin invoked the real `ask`/`agent` path
with `pairMeasurePrompt` and `PAIR_MEASURE_SCHEMA`, using native Claude Opus at low effort.
No standalone Codex runtime adapter was supplied. Claude Code was 2.1.319; the recorded model
was `claude-opus-5-5`.

A fresh temporary repository reproduced the numeric task's original base and reviewed final
diff. Its existing 13 mappings produced 26 independently executed base/final records. The
helper's full Vector gate passed (721 tests, 1,263 assertions), and every final replay passed.
The native workflow completed one measurement agent without an agent error.

The result saved by the native workflow journal was compared structurally against the helper's
actual saved JSON, including every replay field, mapping, identity, exclusion, record, tail,
log path, hash, and timing. **There were zero differences.** All 26 archived raw log hashes
also match. [Comparison](native-transport-review/comparison.json),
[helper result](native-transport-review/helper-result.json),
[native returned result](native-transport-review/returned.json), and
[native journal](native-transport-review/native-journal.jsonl) retain that evidence.

The helper took 49.0 seconds, including 47.0 seconds of replay. The native workflow took about
234.9 seconds in total. This confirms that the relay can carry this substantial result, not
that it is cheap or guaranteed reliable for every size/model. One optional combined shell
polling loop was denied by Claude's permission parser; ordinary individual wait calls continued
successfully. No account settings were changed, plugin installed, or benchmark code delivered.

[Metadata](native-transport-review/metadata.json), the exact
[measurement prompt](native-transport-review/native-prompt.txt),
[entrypoint](native-transport-review/smoke-main.js), and
[tool calls](native-transport-review/native-tool-calls.json) record the execution. Full original
transcripts and the generated temporary plugin remain at the paths named in the metadata.
Recheck the archived evidence without model calls:

```sh
python3 plans/pair-test-contract-trial/native-transport-review/verify.py
```

## Regression verification

`make build`, golden regeneration/review, and `make check` pass: 102 Python tests, 229 shared
policy Node tests, 108 host/integration Node tests, and 42 simulation scenarios. These checks
use temporary repositories and stub CLIs, with no model calls. Only Pair prompt goldens changed;
Council and Ensemble generated workflows remain byte-identical. See
[verification metadata](post-review-verification.json) and [full output](post-review-make-check.log).

The tests cover successful correction, repeated invalid output, exhausted turn budgets, honest
missing-check rejection through each supported route, finding closure, dependency isolation,
and a wrong base commit through both host policies. No review stage or public option was added.
