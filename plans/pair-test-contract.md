# Pair test-contract and baseline-replay experiment

Prepared 2026-11-08. This is an execution plan, not an implementation or a trial report.
No trial tasks have been frozen and no control runs have been started by this planning session.

Execution completed 2026-11-08. See the [trial report](pair-test-contract-trial/report.md) for
implementation verification, frozen inputs, all run outcomes, and comparability limitations.

## Objective

Reduce late requirement and edge-case findings by reviewing concrete test expectations during
Pair's existing design review. During each implementation measurement, replay the current
tests against the original base revision and the implementation snapshot. Preserve a broad,
independent final code review and the existing readiness requirements.

The hypothesis is that this reduces total cost per ready result without weaker defect
detection. Fewer implementation-review rounds alone do not establish success.

## Read first and preserve

- Read [AGENTS.md](../AGENTS.md), [CLAUDE.md](../CLAUDE.md), and the Pair, verification,
  evaluation, and checkpoint sections of [README.md](../README.md).
- Read several retros, particularly `retros/20261020-214328-math-php.md`,
  `retros/20261013-194116-workflow.md`, and `retros/20261013-230439-council-smoke.md`.
  The MathPHP run caught specification gaps early but still introduced defects during an
  audit fix: the negative-sign branch and INF-versus-NaN behavior. This motivates both
  concrete boundaries upfront and independent review after fixes. It is not a Pair baseline.
- Keep decisions in the shared `src/` engine; process, filesystem, and Git work belong in
  the shipped helper/runtime. Both Claude and Codex must receive the same policy and evidence.
- Retain separate author/reviewer worktrees, fresh review contexts, exact-snapshot review,
  reviewer-only finding closure, existing review budgets, and incomplete/blocked outcomes.
- Scope the change to Pair, including Factory when it selects Pair. Preserve Council,
  independent Factory strategies, and Ensemble behavior. Council goldens stay byte-identical.
- Edit `src/`, then regenerate with `make build`. Only `plugins/dark-factory/` ships.
  The real helper is `plugins/dark-factory/bin/dark-factory`; some older instructions refer
  to a root `bin/dark-factory` that is absent in this checkout. Prompts use the bare helper
  name. Installed launchers continue resolving paths relative to the plugin.

## Settled scope

Build the concrete contract, structured reviewer challenges, isolated baseline replay at
normal implementation measurement, raw evidence transport, and objective readiness checks.
Do not add a mandatory review round or a separate test-writing phase.

Do not build mid-implementation capture, chronological TDD enforcement, separate contract
versions, a new test-hash registry, semantic classification of red failures, or a dedicated
contract-amendment workflow. Keep ordinary snapshot/cache/checkpoint integrity. A later trial
finding that authors quietly weaken agreed tests may justify additional contract binding.

## 0. Freeze the trial and start control runs before implementation

The control engine is the unmodified repository at:

```text
e915be937ff53b9c7eca54257258a9a9a1583372
```

First create an isolated checkout/clone of that revision. Invoke its own shipped runner and
helper so a live installation pointing at the development checkout cannot change the control
arm while implementation proceeds. Do not change account settings or reinstall plugins.

Before editing implementation code, choose three real, scoped tasks, with an optional fourth
chosen at the same time:

| Required task | Selection requirement |
| --- | --- |
| Bug fix | An observable defect with a reproducible starting state; the iterator over-read history is a possible source. |
| Small feature | A narrow public API addition, exercising the missing-API baseline case. |
| Numeric boundaries | One bounded numeric defect with sign, limit, overflow, or NaN cases; a single MathPHP root cause is preferable to the old multi-defect campaign. |

Inspect the available target repositories and history to select actual tasks and exact commits.
Historical references above are leads, not already selected tasks or verified starting revisions.
Do not fabricate revisions or choose a task already fixed at its starting commit. If a target
cannot run in the available environment, record that before outcomes and choose a replacement
before freezing the sample. A genuinely unavailable task repository is a trial prerequisite;
report it while continuing independent repository work.

Save a trial manifest under `plans/pair-test-contract-trial/manifest.json` with:

- Stable task ID, category, repository identity, full starting commit, exact task text,
  reference documents, verification command, and environment/dependency setup.
- Control engine revision, host, author/reviewer models and effort, review/turn/time limits,
  concurrency, repetition count, and planned execution order. Use identical settings per pair.
- Variant names `pair-control` and `pair-contract-replay`; begin with one repetition per task
  and variant. Decide any extra repetitions before looking at outcomes.
- Fixed acceptance expectations and any independent outcome probes used to compare both arms.
  Give both arms identical task/reference inputs; do not supply only the treatment with an
  extra task-level test contract.

Launch the control runs after the manifest is complete and before implementation begins.
They can run while the new version is built. Use isolated target clones at each frozen commit;
never reset the user's working repositories or deliver benchmark changes into them. Preserve
all results, including blocked runs and execution failures. Do not replace difficult tasks
after seeing results. Do not expose control solutions or review transcripts to treatment agents.

Use the existing runner and evaluation metadata; a per-run arguments file includes the frozen
task/settings plus `evaluation: {taskId, variant, repetition}`. Invocation shape:

```sh
node "$control_checkout/plugins/dark-factory/bin/dark-factory-codex" \
  --workflow pair --cwd "$trial_target" --args-file "$trial_args" --output "$trial_result"
```

Resolve these variables to the frozen manifest's paths. The experimental arm later uses the
built candidate checkout's runner with the corresponding variant. This trial intentionally
consumes model calls; ordinary regression tests below must use only stubs and temporary repos.

## 1. Contract and design-review output

Extend Pair's author output/state with a small structured test contract alongside the existing
design text. Retain the approved contract for the final reviewer and include it in the existing
design artifact/review identity; do not create a separate contract-version system. Required
information:

| Item | Contents |
| --- | --- |
| Test roots | Repository-relative test directories, grounded in the base project's configuration or established layout, with evidence the design reviewer checks. |
| Test/check identity | Stable local ID and the acceptance criterion IDs it covers. |
| Scenario | Concrete inputs/setup, expected observable outcome, and relevant boundaries. |
| Purpose | `changed` or `preserved` behavior for executable tests. |
| Execution | Planned test file, focused command from repository root, and required test fixtures. |
| Alternative check | For criteria unsuitable for automated tests, a concrete inspection/check and reason; do not force meaningless tests. |

Require tests that depend on new APIs to live in their own files, separate from
preserved-behavior tests. Explain that a fatal during loading must not erase the preserved
behavior signal. A reviewer finding handles a violation; do not add a language-specific
dependency analyzer.

The design reviewer returns a structured challenge for every acceptance criterion:
`criterion`, `wrongImplementation`, and `rejectingCheckIds`. For a non-code criterion,
describe a plausible incorrect result and the alternative check that rejects it. Check IDs
must resolve to the contract and cover that criterion. The engine validates completeness,
nonempty descriptions, valid references, and unique criterion coverage before accepting the
design. The reviewer judges whether the challenge and expected outcomes are substantive.

The author supplies the current replay file/command mapping with each implementation response.
It references the approved contract's check IDs; omissions remain visible rather than removing
obligations. Keep the mapping compact and avoid a second lifecycle/version system. Ordinary
code review handles changed paths, assertions, and justified differences from the design.
Only a materially different approach uses the existing return-to-design mechanism.

## 2. Baseline replay during implementation measurement

Extend the existing measurement request/result rather than creating an additional model turn
or author checkpoint. Every implementation or repair measurement performs these operations:

1. Snapshot the implementation through the existing helper. Read test bytes from that snapshot,
   never the mutable live worktree. The base is the run's original `run.head`, not a later
   author commit or the previous repair snapshot.
2. Obtain the actual base-to-snapshot Git diff and independently validate overlay candidates
   against the accepted project test roots. The author's declared list is only a request.
3. Overlay only added or modified regular files from the snapshot that lie under those roots.
   Apply the same restriction to fixtures. Unchanged dependencies already in base need no
   overlay. Reject absolute/traversing paths and symlink escapes, and do not permit `.` as a
   test root. Verify roots against the existing repository layout/configuration during design
   review; do not infer that any directory becomes a test root because the author names it.
4. Exclude production files and files outside accepted test roots, including root-level config,
   autoload changes, or dependencies. Report every excluded path and reason for the reviewer.
   Do not silently expand roots or copy production changes to make replay work. Represent
   renames/deletions explicitly; do not accidentally run the old file as the new test. Keep
   any unsupported replay dependency visible as a limitation for review.
5. Execute focused checks on base with the overlay and on the exact implementation snapshot.
   Use the same captured verification environment and established timeout/process handling.
   Isolate commands at least by test file. A fatal or timeout in one file must not stop other
   files. Reset disposable checkouts between executions so test mutations cannot contaminate
   later evidence. Preserve the existing tracked-file mutation checks on final verification.
6. Run the existing full verification gate as usual. Focused results supplement that gate.
   Preserve separate raw logs and return compact summaries plus log paths to the reviewer.

Keep result granularity honest. Report file/command-level execution records containing the
associated check IDs, base/snapshot identity, cwd, command, exit/signal, timeout information,
output/log path, and launch errors when applicable. Use individual-test outcomes only when
the runner actually supplies them. A file-level record can cover several checks, but must not
invent individual pass/fail results when the file aborted.

Reuse existing measurement input identity and checkpoint handling. Include replay commands,
mapping, and accepted test roots in the existing request/cache inputs; snapshot identity
already covers test bytes. A change to any input must prevent reuse of incompatible results.
This is normal measurement correctness, not the deferred contract-version/hash infrastructure.

## 3. Objective readiness and reviewer judgment

For every changed-behavior check, require a corresponding base execution-result record.
For every required executable check, require a passing final execution result, in addition to
the existing full-gate requirement. Missing final execution evidence is incomplete; an observed
final failure is blocked. Keep all existing readiness conditions and finding closure rules.

**A fatal at file level on base is a base result.** For example, a test file referencing a new
PHP class can terminate before PHPUnit emits individual case results. Preserve its output and
associate the file result with its requested checks. Its existence satisfies the objective
base-result requirement. The reviewer decides whether it demonstrates the intended missing API.

Likewise, a baseline pass, timeout, or tool error is raw evidence for interpretation, not an
automatic semantic red/green ruling. Missing scheduling/results or a path exclusion without
execution does not become a base execution result merely because a diagnostic was recorded.
Do not label unexecuted individual cases as failed or claim their assertions ran.

The final reviewer must:

- Interpret each check's evidence. A preserved-behavior test passing on base is expected.
  A changed-behavior test passing on base needs investigation, not automatic rejection.
- Distinguish intended missing behavior from infrastructure failure using actual output.
  If evidence is inconclusive, reflect that in criterion assessments/findings rather than
  approving solely because the engine has a record.
- Inspect excluded overlay paths and missing preserved-behavior signals.
- Compare actual test assertions and coverage with the approved contract; report omissions or
  weakening through the existing findings mechanism.
- Attack the whole implementation for uncovered requirements, regressions, races, numeric
  mistakes, and defects introduced by fixes. The contract is a floor, not the review checklist.

Do not add automatic semantic parsing of failure messages, mandatory baseline nonzero exits,
or automatic findings closure based on tests. Passing all agreed tests never replaces the
independent review of the final measured snapshot.

## 4. Code locations and implementation order

| Location | Work |
| --- | --- |
| `src/lib/pair-prompts.js` | Concrete contract, isolated new-API tests, reviewer challenges, current replay mapping, broad final-review wording, and native measurement transport prompt. |
| `src/pair-schemas.js` | Author contract/mapping, reviewer challenge output, and raw replay measurement results. |
| `src/lib/pair.js` | Pure contract/challenge validation, approved contract state, objective readiness, relevant stalled-state inputs, and result/report evidence. |
| `src/pair.js` | Carry contract/mapping through existing stages and measurement; preserve review/version semantics and worktree isolation. |
| `plugins/dark-factory/bin/dark-factory` | Extend measurement arguments/job spec, safe overlay, isolated base/final execution, raw results, and cache inputs. Start at `cmd_measure`, `input_digest`, `run_measure_job`, and disposable checkout utilities. |
| `plugins/dark-factory/lib/codex-runner.mjs` | Pass replay requests through `measure` and return helper evidence without interpretation. |
| `plugins/dark-factory/lib/checkpoint.mjs` | Confirm existing journaling captures the extended request/results and logs; change only if necessary. |
| `src/lib/evaluation.js` and existing results | Reuse metrics/reviews/findings for the trial. Prefer offline extraction over new runtime telemetry. |
| `README.md`, optionally `src/00-meta-pair.js` | Describe contract/replay behavior, fatal interpretation, exclusions, and limitations. |

The current `crosstest` helper is a useful reference but refuses to overwrite a file with
different content. Baseline replay must handle modified existing test files inside disposable
checkouts; do not weaken shared cross-test behavior to obtain that capability.

Implement the schema/prompt/state slice, then helper replay and transport, then readiness/report
integration. Exercise both native Claude measurement transport and the Codex adapter. Do not
introduce a new public workflow or a broad replay framework. A control checkout and candidate
checkout are sufficient to compare variants; an extra public experiment toggle is unnecessary.

## 5. Regression verification without models

Use `test/pair.mjs` for shared policy and both host paths, `test/test_verification.py` for helper
processes in temporary repositories, and relevant runner/checkpoint tests for transport/cache
behavior. Add focused cases proving:

1. Missing, duplicate, empty, or invalid reviewer challenges cannot approve a design; valid
   challenges cover every criterion, including justified non-test criteria.
2. A changed-behavior test fails on base and passes on final; a preserved-behavior test passes
   on both. Base pass alone does not automatically block a changed-behavior test.
3. A new-API file fatals on base, its file-level result is retained, and a separate preserved
   file still runs. The complete record can reach ready only with the normal reviewer approval.
4. Missing base results prevent readiness; baseline timeout/tool errors remain visible for
   reviewer judgment; missing or failing final checks cannot yield ready.
5. Modified existing tests and new test fixtures replay correctly, and current snapshot bytes
   are used even if live-worktree files differ.
6. Production/config files, unchanged overlay requests, path traversal, and symlink escapes are
   handled according to the overlay rules; rejected files are reported and never copied.
7. One fatal/timeout does not suppress later file results. Base replay cannot mutate the author
   tree, and mutations do not leak between executions or into final evidence.
8. Changed tests, commands, mapping, roots, or verification settings cannot reuse stale results.
   Compatible resume retains evidence; incompatible resume follows existing refusal behavior.
9. Both hosts carry the same raw evidence and enforce the same readiness rules; no new review
   stage appears. Factory Pair receives the change while other strategies remain unchanged.

Simulate a fatal process using a small local script; do not add PHP or a new test framework as
a regression dependency merely to model PHPUnit behavior. Inspect actual PHP behavior in the
real trial when applicable. Use stub CLIs for every ordinary process/installation test.

After focused checks, run:

```sh
make build
UPDATE_GOLDEN=1 node test/sim.mjs
git diff -- test/golden
make check
```

Inspect intended prompt changes and ensure unrelated/Council goldens remain unchanged. Do not
claim effectiveness from passing sims: they prove enforcement and transport only.

## 6. Treatment runs and evaluation

After checks pass, pin the candidate revision and run the treatment arm on fresh clones of the
same frozen task revisions. Preserve the control's task prompts, references, models, host,
budgets, verification settings, and dependencies; the workflow prompts change as specified
above. Never reuse an author/reviewer session across arms.
Record any unavoidable model/environment drift and its effect on comparability.

Use `plugins/dark-factory/bin/dark-factory-evaluate` on result JSON files for existing metrics.
Extract additional trial fields from `reviews`, `findings`, raw logs, and host events into a
small comparison artifact; a new benchmark service is out of scope. Record:

- Design reviews and code reviews separately; total model turns and failed turns.
- Available tokens, cost, elapsed time, readiness, and unresolved outcomes. Unknown cost remains
  unknown; do not invent dollar estimates or discard failed runs from cost per ready result.
- Final-review finding severity and origin: requirement/edge-case omission, implementation
  defect, fix-induced regression, or weakened/omitted agreed test. Annotate from evidence;
  ambiguous origins stay ambiguous.
- Baseline replay overhead, unusable evidence, overlay exclusions, and interrupted files.
- Independent outcome-check results for both arms and any defects missed by their final reviews.

Review actual defects, not just counts. Fewer reported findings could mean better work or
weaker detection. Keep final-review standards equally broad in both arms and use the frozen
outcome checks to help distinguish those possibilities.

Write a trial report alongside the manifest with run/result locations, per-task comparisons,
failures, and a recommendation to retain, revise, or abandon the experiment. A small sample
supports a directional conclusion only; measuring the combined change does not isolate each
component's causal contribution. Extra contract binding/amendment machinery requires observed
weakening that this version's ordinary review did not adequately catch.

## Completion checklist

- [x] Trial tasks/revisions/settings frozen before implementation; pinned control runs launched.
- [x] Concrete contract and complete structured challenges enforced in existing design review.
- [x] Current tests replayed at implementation measurement with independent path checks.
- [x] Fatal base-file results accepted as records; new-API and preserved tests isolated.
- [x] Raw evidence reaches both hosts; objective checks and broad final review determine readiness.
- [x] No extra review stage, chronological capture, or contract-version/amendment subsystem.
- [x] Focused regressions and `make check` pass; generated outputs and goldens inspected.
- [x] Matched-task treatment runs complete; setup environment drift explicitly reported.
- [x] Trial report distinguishes implementation correctness from evidence of process value.
