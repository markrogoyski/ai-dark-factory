# Pair contract/replay trial — 2026-11-08

**Post-review status:** the user subsequently requested committing the revised implementation. The
[review follow-up](post-review.md) records correctness fixes and a successful live native Claude
transport check. The six-run comparison below still describes the original pinned candidate;
it does not measure the revised implementation or justify making this Pair's default.

The implementation passes its regression gates, and all six model runs reached ready. All 38
frozen outcome probes passed in each arm. This sample did **not** demonstrate an efficiency gain:
both arms used five model turns per ready result, while treatment elapsed time and recorded
tokens increased. No review findings occurred in either arm.

**Recommendation: revise the experiment before treating this as a cost optimization.** The
candidate supplies useful, inspectable replay evidence, but this sample had no late-review
findings to reduce. A future, separately frozen sample should include tasks with known late
findings, fix the setup environment explicitly, and examine redundant focused/gate mappings.
No evidence here justifies the deferred contract-binding or amendment machinery. The implemented
candidate remains in the working checkout; this report does not silently retune or revert it.

## Protocol and retained artifacts

Tasks, exact starting revisions, task text, acceptance expectations, commands, dependencies,
models, limits, and execution order were frozen before implementation in
[manifest-frozen.json](manifest-frozen.json). The current [manifest](manifest.json) adds only
candidate checkout/revision information. There were three tasks, no optional fourth, and one
model repetition per task/variant. No tasks were replaced and no extra model repetitions were
added after outcomes.

- Control engine: `e915be937ff53b9c7eca54257258a9a9a1583372`.
- Candidate engine: `28f359b15106f707b1863227401559ce34c3976d`, committed only in its isolated
  clone. [Candidate identity](candidate.json) records the source patch and fixture hashes.
- Host: Codex; author `gpt-6.1-sol`, reviewer `gpt-6-astra`, both high effort. Eight reviews,
  24 model turns, 60 minutes per run, 15 minutes per turn, concurrency one within each run.
  Three runs could proceed concurrently. Controls were launched before implementation;
  treatments were launched after `make check` passed.
- PHP 8.5.3, Node 26.0.0, Codex CLI 0.167.0. Dependencies were real APFS copies of the local
  vendor directories. All frozen scoped gates passed, while frozen probes reproduced both
  defects and the absent API. See [preflight](preflight.json) and baseline logs alongside it.

Full run directories and pinned engine clones remain under
`/private/tmp/pair-test-contract-trial-20261108/`; the manifest names every target, arguments file,
runner result, and progress log. Compact result copies, host events, final diffs, independent
probe outputs, measurement results, and all 50 raw replay logs are retained under [results](results/).
All archived replay log hashes were verified. User working repositories were neither reset nor
given benchmark changes. Plugins and account settings were not changed.

[compare.py](compare.py) uses the frozen [PHP probes](outcome-probe.php), materializes exact final
snapshots, extracts [comparison.json](comparison.json), and invokes the existing evaluator to
produce [evaluation.json](evaluation.json). [Annotations](annotations.json) record evidence
interpretation and limitations. The evaluator's `postDeliveryObserved` fields refer here to
independent snapshot probes; none of these benchmark changes was delivered.

## Per-task results

Every row below has one design review, one code review, five model turns, zero failed model
turns, zero findings, and readiness `ready` in **both** arms. Time is recorded elapsed time per
run, including setup, model work, and verification; these are not summed wall-clock durations
of the concurrent trial.

| Frozen task | Control time | Treatment time | Replay time | Independent probes, each arm |
| --- | ---: | ---: | ---: | ---: |
| Iterator bounded lookahead | 486.3 s | 799.5 s | 16.8 s | 8/8 passed |
| Coprimality API | 370.9 s | 635.2 s | 25.2 s | 14/14 passed |
| Vector norm numeric boundaries | 427.4 s | 731.4 s | 42.7 s | 16/16 passed |

The probes examined bounded first-output reads, padding, lazy validation and Stream behavior;
coprimality signs, zeros, units and native integer limits; and norm scale, sign, zero, mixed
magnitudes, infinity and NaN behavior. No missed defect was detected by these probes. This is
narrow outcome evidence, not proof that the implementations contain no other defects.

| Recorded total across completed model runs | Control | Treatment |
| --- | ---: | ---: |
| Ready results | 3 | 3 |
| Design reviews / code reviews | 3 / 3 | 3 / 3 |
| Model turns / failed turns | 15 / 0 | 15 / 0 |
| Elapsed time | 1,284.476 s | 2,166.097 s |
| Elapsed time per ready result | 428.159 s | 722.032 s |
| Input tokens, including cached input | 3,771,868 | 6,343,464 |
| Cached input tokens | 3,144,448 | 5,550,976 |
| Uncached input tokens | 627,420 | 792,488 |
| Output tokens | 52,366 | 87,616 |
| Dollar cost / cost per ready result | Unknown | Unknown |

Treatment recorded 68.6% more elapsed time, 26.3% more uncached input, and 67.3% more output
tokens. Replay itself consumed 84.7 seconds across the three runs. The remaining difference
includes longer design, implementation, and review turns; [phase-times.json](phase-times.json)
contains the host-event breakdown. These measurements do not establish lower monetary cost.

Three initial control launches stopped at sandbox preflight because Codex could not write its
normal home directory. They consumed zero model turns. Their results and logs are retained;
the subsequent launches used approved execution access and unchanged frozen inputs. The
inclusive evaluator therefore reports control ready `3/6` versus treatment `3/3`, and control
elapsed time per ready result of 428.444 seconds. This is an infrastructure-launch difference,
not a treatment improvement. Failed launches were not discarded from the inclusive aggregates.

## Replay evidence and review interpretation

The treatment produced 25 base and 25 final file/command records. Nine base commands returned
nonzero; all 25 final commands and all three full gates passed. There were no replay timeouts,
launch errors, or interrupted file executions in the live sample.

- **Iterator:** two streaming files failed on base through guards detecting over-consumption.
  Three preserved commands passed on both revisions. Final review checked suspension through
  buffered outputs and subsequent tail outputs, rather than inferring individual assertions
  from the command exit alone.
- **New API:** four new-API commands returned PHPUnit errors for the absent method, with zero
  assertions in those checks. Three separate preserved files still ran and passed. PHPUnit
  completed its error reporting: this was not a fatal during file loading. The regression suite
  separately proves fatal-before-discovery handling using a small local script.
- **Numeric boundaries:** base output showed overflow/underflow failures for extreme and mixed
  cases. The reviewer explicitly interpreted base passes at `p=1` as expected. Separate zero
  and nonfinite filters retained preserved behavior. The aggregate gate-file command also
  included changed tests and failed on base; the helper did not invent individual outcomes.

All 25 exclusion notices were explainable: eight production/documentation paths, fourteen
unchanged tests/fixtures requiring no overlay, and three author dependency installations.
No unsafe path or unsupported dependency prevented execution in this sample. Original dependency
copies were used on both replay sides; author dependency changes were not copied onto base.
Final reviewers inspected exclusions and the agreed assertions. There were no findings to
classify by severity or origin, no observed fix-induced regressions, and no reported weakening
or omission of agreed checks. A sample without findings cannot establish equal defect detection.

## Comparability and implementation verification

Task arguments differ only by evaluation variant. Target HEADs and installed dependency
manifests match the frozen identities. Configured model names, efforts, toolchain versions,
budgets and verification commands match. Backend model revision is not exposed.

**Protocol limitation:** setup independently chose different `TMPDIR` paths and inconsistent
`XDG_CACHE_HOME` overrides. [Verification environments](verification-environments.json) preserve
the exact settings, and [comparability.json](comparability.json) flags the mismatch. Isolated
temporary paths are expected, but the cache-override difference was not fixed by the manifest.
Its timing effect is unknown. Controls also preceded treatments, so cache/provider load can
differ. The observed slowdown is not a clean causal estimate of the prompt change. No
post-outcome reruns were used to conceal or repair this limitation.

The implementation passed `make build`, golden regeneration/review, and `make check`: 102 Python
tests, 226 shared-policy Node tests, 107 host/integration Node tests, and 42 simulation scenarios.
See [verification.json](verification.json) and [make-check.log](make-check.log). Only Pair prompt
goldens changed; Council and Ensemble generated workflows remained byte-identical. Both native
Claude transport and the Codex adapter carry the same raw replay evidence; Factory's Pair
strategy uses the same policy. Regression tests used temporary repositories and stub CLIs,
with no model calls.

The tests establish enforcement, isolation, transport, cache/checkpoint compatibility, and
preservation of existing readiness rules. They do not establish process value. The small live
sample supports a directional negative efficiency result, with the stated comparability limits;
it does not separate the effects of contracts from those of baseline replay.
