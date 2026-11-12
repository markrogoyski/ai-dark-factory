# dark-factory

A workflow engine for Claude Code and Codex. Pair one author with one independent reviewer,
or have a council solve one task independently, debate it on an evidence ledger, and converge
on one result. The Claude council entry point defaults to
Claude Opus, Claude Sonnet, Codex Astra and Gemini Flash. The Codex entry point defaults to
Claude Opus, Codex Astra and Codex Sol seats with OpenAI reviewers, and also supports explicit
Gemini seats.

    /dark-factory:council Fix the cancellation in Special::confluentHypergeometric at large negative z

## Install in Claude Code

The repo is a Claude Code plugin marketplace with one plugin, `dark-factory`:

    /plugin marketplace add markrogoyski/ai-dark-factory
    /plugin install dark-factory@ai-dark-factory

That adds `/dark-factory:pair`, `/dark-factory:factory`, `/dark-factory:council`, `/dark-factory:ensemble`, and `/dark-factory:run-plan`, and puts
the helper the agents run, `dark-factory`, on their PATH. A plugin can't grant permissions, so add
this to `~/.claude/settings.json` yourself (see the permission note under Install and test):

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

Codex and Gemini seats need the `codex` and `agy` CLIs; the requirements are listed under
Install and test.

## Install in Codex

From a checkout of this repository, install the skill in the project where you want to use it:

```sh
./install-codex.sh --repo /path/to/project
```

With no arguments, the installer uses the current Git repository. `./install-codex.sh --user`
installs in `~/.agents/skills` for use across projects. It creates a symlink to the shipped skill,
so keep this checkout in place. It does not replace an existing skill from another location or
change account settings. Codex discovers the skill automatically; start a new session if it
doesn't appear.

Then, in Codex:

```text
$dark-factory Add a debug log line with the retry count in Fetcher::retry
$dark-factory --tier fix Find why the sync drops the last page
$dark-factory --workflow pair Implement the retry policy
```

The skill runs the same factory/council JavaScript through a local Node runner. Tier routing,
escalation, verification, scoring, and readiness stay in that shared engine. Model turns are
separate CLI sessions; the runner starts them directly and bounds their concurrency. It does
not need Claude relay agents. All four factory tiers, Pair, Council, and Ensemble are available through the same shared engine.

You need Node, Python 3, Git, and authenticated `codex` and `claude` CLIs: the default Codex
profile has a Claude Opus seat. Pass `--seats astra,sol` for an OpenAI-only run. Gemini seats
additionally need the authenticated `agy` CLI. Each CLI keeps its normal permission controls.
A completed Claude turn with valid output can proceed after a denied tool call; the report and host
events retain the denial and link to its raw details in the job's `out.json`. Denied checks do not
count as passing evidence: required verification and independent review still determine readiness.
If a solve or debate turn fails after writing its own post, the runner can resume its saved
session once to return the missing structured output. This read-only follow-up has low effort
and a three-minute deadline (or the original deadline, if shorter); failed recovery still fails
the turn. Headless seats cannot grant new permissions. Their instructions require Edit/Write
for file changes, foreground commands, and no sleep polling.

Headless Claude processes run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, including resumed
turns and fresh reviewers. Claude's [auto memory is shared across worktrees](https://code.claude.com/docs/en/memory#storage-location),
so disabling it keeps project notes out of these independent sessions without changing account settings.

Simple uses Sol to implement and Astra to review. Fix, Feature and Architecture use Opus,
Astra and Sol seats. Orchestration roles can be changed through `roles`, for example
`{"intake": "sol", "checker": {"model": "astra", "effort": "high"}}`.

You can also invoke the runner without installing a skill:

```sh
node plugins/dark-factory/bin/dark-factory-codex --cwd /path/to/project -- "Fix the missing final page"
node plugins/dark-factory/bin/dark-factory-codex --workflow council --seats astra,sol,opus --cwd /path/to/project -- "Investigate the intermittent timeout"
```

Use `--args-file task.json` for the full factory options, including uncommitted reference
documents and model overrides. Paths in `plan` should be absolute:

```json
{
  "task": "Implement the retry policy in the design",
  "plan": ["/path/to/project/RETRY_DESIGN.md"],
  "tier": "feature",
  "seats": ["astra", "sol"],
  "audit": {"correctness": "astra", "design": "sol", "tests": "luna"}
}
```

`--concurrency N` bounds simultaneous model turns, `--timeout-min N` sets turn deadlines,
and `--output result.json` saves an additional copy of the final JSON. Progress is written to
stderr and the final result to stdout. Every run retains its arguments, events, and result in
`hostRunDir` under the target repository's `.council/`; `runDir` identifies the factory's
worktrees and evidence. Exit 0 means a completed ready result, 2 means a decision or unresolved
readiness, and 1 means execution failure. Always inspect `final.readiness`, not just `status`.

The skill handles `needs-plan`, `needs-tier`, `needs-split`, and `needs-user` using the same
factory decisions described below. Reruns normally start a new host run. Use `--resume HOST_RUN_DIR` to replay validated completed operations and continue a saved checkpoint; see Process controls below. Seat sessions persist across turns within a run.
The reviewed change stays in its worktree until delivered to the main checkout. Architecture
returns reviewed milestones and does not automatically build them.

## Run-plan: execute a plan across runs

The `run-plan` workflow executes a suite of features or defects sequentially through Factory or Pair. Each task
has fresh agent sessions, separate worktrees, and the existing independent review and readiness
gates. A successful task is applied, checked with `verify-delivery`, and committed together with
its progress record. Requesting a plan run authorizes those local commits. Use a checkout with clean tracked files
on the intended feature branch; the plan run does not publish, deploy, or switch branches.

Create a plan such as `plan.json`. It may remain untracked; its bytes are frozen for the run. A tracked plan retains the existing behavior of committing progress with each task:

```json
{
  "version": 1,
  "id": "retry-policy",
  "decisions": ["Preserve the existing public API."],
  "limits": {
    "maxTurns": 200,
    "maxRunMin": 120,
    "maxAttempts": 2,
    "taskMaxTurns": 50,
    "taskMaxRunMin": 30
  },
  "defaults": {"verify": "make check", "retro": false},
  "tasks": [
    {
      "id": "policy",
      "task": "Implement the retry policy with bounded exponential backoff.",
      "criteria": ["Retries stop at the configured limit.", "Backoff is bounded."],
      "workflow": "pair",
      "args": {"author": "sol", "reviewer": "astra"}
    },
    {
      "id": "integration",
      "task": "Use the retry policy in the fetcher.",
      "after": ["policy"],
      "criteria": ["Transient fetch failures retry using the configured policy."]
    }
  ],
  "acceptance": {
    "verify": "make check",
    "criteria": ["The fetcher and retry policy work together without API regressions."]
  }
}
```

`workflow` defaults to `factory`. Task IDs are stable; dependencies can appear in any order,
but missing IDs and cycles are rejected. Each task and final acceptance need explicit criteria.
The limits above are also the defaults. Turn limits count workflow model turns, including failed
turns and explicit recovery turns; provider transport retries remain governed by the existing CLI
helper. These are execution limits, not dollar forecasts. Final acceptance uses a fresh Council
investigation after independently running `acceptance.verify`; both must pass on the integrated
revision. Its model options go in `acceptance.args`.

```text
$dark-factory --workflow run-plan --plan-file /absolute/path/plan.json
```

Or run the shipped CLI directly:

```sh
node plugins/dark-factory/bin/dark-factory-codex --workflow run-plan --cwd /path/to/project --plan-file /path/to/project/plan.json
```

In Claude Code, invoke `/dark-factory:run-plan` with object arguments
`{planFile: "/absolute/path/plan.json", repo: "/path/to/project"}`. A transport turn
launches the same standalone controller. Plan runs use its Codex model profile on both hosts;
explicit participants in task/default args override that profile. Existing native workflows
retain their original behavior. Node, Python, Git, and the selected authenticated CLIs are required.

Reference documents named in task/default `plan` options are frozen by hash for the plan run;
changes invalidate resume. Keep the plan run's own changing JSON file out of those references.
To use an Architecture result, map its milestones to task IDs and `after` dependencies, retain
their criteria, and pass the reviewed design as a reference. Final acceptance covers the original
requirements across all milestones.

Each task gets a snapshot of settled decisions, answers, and pointers to accepted designs and
final posts. It reads the relevant evidence instead of inheriting prior agent conversations.
Routine implementation choices stay with the task agents; scope changes and conflicting
requirements must become questions. Factory specification review uses `ask`. `needs-tier`,
`needs-split`, `needs-user`, unresolved readiness, and exhausted attempts park the task with
its result. Its dependents wait while independent tasks continue. Transport failures retry only
within the attempt and run-plan limits. If no task is eligible, the result remains incomplete.

Repeat the same invocation to resume; run-plan resume does not use `--resume`. To answer parked
tasks, use `--args-file` with:

```json
{
  "planFile": "/absolute/path/plan.json",
  "answers": {
    "integration": {"answer": "Keep the existing retry API and use the feature tier.", "tier": "feature"}
  }
}
```

Answers may be strings or `{answer, tier?, noSplit?}`. A split proposal can be kept as one task
with explicit `noSplit: true`; creating a different decomposition or changing requirements needs
a revised plan with a new ID. Answers never reset attempts or budgets; new answers are rejected
when the task has exhausted its attempts. The default two attempts allow one answered retry.
The plan definition remains immutable once started; budget exhaustion is reported,
not silently extended.

For tracked plans, completed code and the controller-owned `progress` field share a commit, with
`Factory-Plan` and `Factory-Task` trailers. `.council/run-plan-ID/state.json` also retains
unsuccessful attempts, questions, decisions, and budget accounting. Keep it and child-run evidence.
It records the engine's package digest and each task's base commit. Resuming after a plugin
update is refused: finish the plan with the plugin that started it, or start a new plan. Older
journals without the digest resume with a warning. When the engine lives inside the target
repository, its digest follows the plan's own commits, so a change only warns; use a frozen export.
Before launching, the controller reserves an attempt's allowed turns and time. A completed
attempt settles to measured usage; an interrupted attempt conservatively retains its full
reservation, so restarting cannot replenish its budget. Interrupted delivery reserves additional
verification time before retrying; if none remains, the task is rolled back and parked.
Time between completed invocations is not charged.

Recovery recognizes an exact prepared delivery or its completed commit. A failed delivery check
or rejected commit hook restores the recorded base and parks the task, charging that attempt once.
Reinvoking leaves a parked task idle until an answer requests a retry within its remaining limits.
Rollback only removes the recorded delivery bytes; unexpected edits are preserved.
Unexpected edits, changed HEAD/branch/requirements, or a still-running child stop recovery with
a diagnostic. Ordinary interrupted tasks are parked with their artifacts retained; an answer
can retry them if attempts remain. Child checkpoints retain their existing strict validation.
There is no background supervisor: an interrupted plan run is resumable, not guaranteed to keep
running after its host closes. Final acceptance checks the settled criteria without a new specification
review; its Council must return ready with every criterion met on the integrated repository.
Final acceptance failures are parked for inspection; v1 does not
invent repair scope or weaken acceptance criteria.

Untracked execution plans, named reference documents, and root-level local agent instruction files
(`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) are allowed without committing or excluding
them. Their bytes are frozen and checked on resume; tracked edits and unrelated untracked files
still stop the run. Untracked plans are never staged or rewritten: progress lives in the run's
`state.json`. A task cannot overwrite these control files.

To raise execution limits on resume, keep the plan unchanged and pass an args file:

```json
{
  "planFile": "/absolute/path/plan.json",
  "extendLimits": {
    "reason": "Allow the reviewed implementation to finish verification.",
    "limits": {"maxRunMin": 240, "taskMaxRunMin": 90, "maxAttempts": 3}
  },
  "answers": {"policy": "Retry with the increased allowance."}
}
```

Limits may only increase. The journal records the reason, old and new limits, and prior usage;
spent time, turns, and attempts remain charged. The new limits apply to subsequent attempts,
not to an already running child process. The deadline remains a hard cap, including audits.
Intake sees that cap and can warn when the selected process is unlikely to fit. Run-plan's
request to ask about unresolved requirements does not force a council when intake selects Pair.

## Pair: one author, one reviewer

Use Pair for a scoped change you want one agent to own through completion, with independent
feedback before implementation and after every revision:

```text
/dark-factory:pair Implement the retry policy
/dark-factory:pair --author astra --reviewer opus Add cancellation support
```

In Codex:

```text
$dark-factory --workflow pair Implement the retry policy
$dark-factory --workflow pair --author opus --reviewer astra Add cancellation support
```

Pair defaults to Claude Opus author and Codex Astra reviewer in Claude Code, and Codex Sol
author and Claude Opus reviewer in Codex. `author` and `reviewer` select the roles independently
using the existing model names. An unspecified reviewer defaults to the other vendor. The
default pair needs both authenticated CLIs. Explicit `--author sol --reviewer astra` uses only
Codex models in the Codex host.

1. A setup turn establishes acceptance criteria, reference documents, and the verification gate.
   The run inherits their quality, so setup runs on Claude Opus at `medium` effort whatever the
   participants are: Sonnet setup dropped stated criteria and stopped on guesses where Opus setup
   didn't. The one exception is a Codex author in the Codex host or the standalone runtime, whose
   setup runs on the author's own model at `medium`. On those runtimes an explicit `effort` applies
   instead of `medium`; natively in Claude Code setup always runs at `medium`. Factory's pair
   strategy follows the same rule. Every requirement the task or its documents state that the
   gate can't check, such as "run coverage and inspect the report", becomes its own criterion,
   citing document and line. A criterion that no evidence inside the run can meet (it needs
   post-delivery, production or live-service evidence) stops the run with `needs-user` before
   any author turn, with one question per criterion: rewrite it so the run can check it, or drop
   it.
2. The author drafts a design and concrete test contract: criterion IDs, inputs, expected
   outcomes, boundaries, changed/preserved purpose, test files, commands, and fixtures. Criteria
   unsuitable for tests name an inspection and reason. The reviewer verifies test roots against
   the base configuration/layout and supplies a plausible wrong implementation plus rejecting
   check IDs for every criterion. The engine requires complete, valid challenges before approval.
   A reviewer who finds no rejecting check can return empty IDs with an evidenced finding,
   a partial/unmet assessment, or a design revision request; this returns the design to its author.
   A malformed contract or challenge gets one correction attempt before stopping. Correction turns count toward the
   run's turn budget and never count as design approval.
3. The author implements the reviewed design in its own worktree. The helper snapshots the
   change, replays the current mapped tests on the original base and final snapshot in disposable
   checkouts, and runs the existing full verification gate.
4. A fresh reviewer context inspects that snapshot, the tests, and every criterion. Findings
   receive stable IDs. Only the reviewer can mark them fixed or refuted, with evidence.
5. The author fixes findings and failed checks, then verification and review repeat. A material
   approach problem can send the task back through design review before implementation continues.

All actionable findings, including minor ones, must close. Optional preferences are reported
separately. The author retains its CLI session across design and implementation; native Claude
workflow turns carry an explicit handoff and private notes. Review contexts and checkouts are
fresh each time. Codex's runner executes measurements directly; Claude's workflow uses a
transport turn to run the same helper. Its existing CLI relay handles external participants.
There is no council, panel, voting, or automatic escalation.

In Claude Code, `runtime: "cli"` (or `--runtime cli` at the start of a string task) runs the
whole Pair on the standalone runner instead: one Sonnet transport agent writes the arguments to
a file, runs `dark-factory-codex --workflow pair --brief --args-file FILE [--cwd REPO]` in the
background outside the Bash sandbox (the runner starts the Claude and Codex CLIs), waits for its
exit-code file, and returns the compact result `--brief` prints: status, stage, readiness,
findings, notes, metrics and `hostRunDir`, with `resultFile` naming the full `result.json`, which
is too large for an agent to relay. The runner's Claude setup turn runs `dark-factory init` inside
Claude's own sandbox, which refuses to write files such as `.gitmodules` anywhere; when copying an
ignored dependency directory hits one, init leaves those files out and names each on stderr. There are no per-turn relays or measurement
transports; the Claude author resumes its CLI session between turns, and the result records
exact `elapsedMs` and a checkpoint. The transport names the participants explicitly (Opus author
and Astra reviewer unless you choose others), so the runner's Codex defaults don't apply. To
resume an interrupted run, repeat the same arguments and add `resume` with the earlier result's
`hostRunDir`: `{"task": "…", "runtime": "cli", "resume": "/repo/.council/host-abc123"}`. Changed
arguments are refused on resume. The native path stays the default. The option is refused in the
Codex host, which always runs this runtime. Factory doesn't support it yet: its runner path
applies Codex role defaults to intake and the tiers.

Each implementation response maps approved check IDs to current files, focused commands, and
fixtures. Each focused command must isolate one test file. Separate files are preferred for
new-API and preserved-behavior tests; explicit user or plan file requirements take precedence.
Shared files need focused selections and a review of base loadability. A whole-suite final
obligation uses a designated-gate contract check without a replay mapping. Only
added/modified regular test and fixture files under the reviewed test roots are overlaid, using
snapshot bytes. Unchanged files use the base copy. Production/config/dependency changes, unsafe
paths and symlinks are excluded; renames/deletions are reported explicitly and are not overlaid.
Dependencies needed for replay must be visible to the reviewer, rather than silently copied.
Each execution gets a fresh checkout and the captured verification environment. Replay supplements
the full gate and uses the helper's focused-test timeout (default 300 seconds per command).
Base replay copies ignored dependencies from the original run repository and reports that author
dependency changes were excluded. Final replay uses the author's dependency installation, like
the full gate, so a package addition or upgrade can pass its final focused checks. Each command
gets a fresh dependency copy. Ignored dependencies still have the checkpoint limitations below.

Raw replay evidence is at file/command granularity, with check IDs, base/snapshot identity, cwd,
exit/signal/timeout, launch errors, logs and output tails. A base fatal is a result even when no
individual assertions ran. Base passes, timeouts and tool errors also require reviewer judgment;
none automatically establishes or rejects intended changed behavior. An excluded or unscheduled
file has no execution result. Every changed check needs a base result; every executable check
needs a passing final result. Missing evidence is incomplete, and observed final failures block.
Only the reviewer can close findings, and the final review examines the whole implementation,
including omissions or weakening of the agreed checks and regressions introduced by fixes.
There is no extra review stage, chronological TDD enforcement, or separate contract-version system.

`maxReviews` (CLI: `--max-reviews`) limits total reviews across both stages, default **8**.
An unchanged artifact with the same unresolved review state on consecutive attempts stops as
stalled. Budget exhaustion, incomplete reviews, failed required checks, or unresolved findings
never report readiness. A ready result requires review of the exact measured final snapshot,
all criteria met, and all required checks passing. When no automated gate exists, the result
records that it was not run. Pair currently delivers implementations; use council or factory
for standalone investigation and architecture work.

Object arguments, or the Codex runner's `--args-file`, accept `task`, `author`, `reviewer`,
`maxReviews`, `effort`, `context`, `plan`, `criteria`, `verify`, `repo`, `allowDirty`, and
`timeoutMin`. The existing model catalog and effort mapping apply. Pass absolute reference
paths in `plan`, including uncommitted documents. Worktrees start at HEAD; tracked local edits
require explicit `allowDirty` or an already clean checkout. Factory tier, panel, audit, and
historical-evidence options do not apply to Pair.

Results include `design`, `testContract`, `replayMapping`, `reviews`, `findings`, `stopReason`,
`final.replay`, and `final.readiness`. Replay requests and logs participate in existing cache and
checkpoint integrity. Ignored dependency directories and external toolchains retain the checkpoint
limitations below. Changes stay
in `final.worktree`; a ready snapshot has `delivery.status: pending`. Apply it within the user's
authorization, then use the delivery verification below. Pair does not automatically launch a council when it stops. The Codex host supports validated checkpoint resume; changed task inputs or evidence require a new run.

## Process controls, explanation, and resume

For a self-update, the standalone runner can execute a committed plugin exported outside the
source, candidate repository and every seat write grant. Choose a named directory whose parents
are not writable by seats (including their implicit `/tmp` and `$TMPDIR` grants):

```sh
node plugins/dark-factory/bin/dark-factory-codex --pin-engine /path/to/frozen-engine --cwd /path/to/candidate --workflow pair "Implement the change"
```

A new export reads Git blobs and modes from the source checkout's HEAD. Commit generated plugin
files first; dirty, untracked or ignored shipped inputs refuse. The export contains `plugin/` and
an external `manifest.json`. Its versioned SHA-256 digest covers raw relative paths, content and
Git modes, including symlink targets. Escaping or unresolved links refuse. No installation is
performed. Reusing an existing directory validates and retains that executor, even when the
invoking checkout has advanced; it never promotes the candidate. Keep the export and manifest.

Publication builds and validates a private sibling staging directory, then performs a native
exclusive rename. The public destination is absent or complete; existing files, directories and
symlinks are never replaced. Unsupported exclusive-rename platforms/filesystems refuse. A crash
may leave private staging for inspection; retries do not sweep staging owned by other invocations.
This guarantees atomic visibility, not power-loss durability.

The same package guards helper calls, detached jobs, checkpoints, delivery and authoritative
evaluation. Complete exports can be relocated; explicitly select the relocated directory with
the resume command. Package/runtime/evidence drift refuses and preserves previous artifacts and
spent usage. Legacy results remain readable; an active unpinned run cannot migrate into pinning.

Pinned admission requires only configuration-reachable providers. Pair checks its author and
reviewer; Ensemble also checks comparison/review models. Factory includes intake, permitted
strategies, tiers, escalation and conditional control roles. Task prose never selects a provider.
Concrete seats are checked again at execution, retry, tool and resume boundaries. This narrowing
applies only to pinned adapter admission/preflight; native prompts and ordinary preflight retain
their existing behavior.

Provider settings are interpreted by shared typed policy, with read-only adapter observations:

| Provider | Supported ordinary inputs | Conservative limits |
| --- | --- | --- |
| Codex | Model/reasoning/personality/TUI presentation; project trust; selected inline user profiles; sandbox root lists; approval routing | Invocation pins escalation to `never`. Only trusted project layers apply. Unknown executable features, hooks, MCP and custom providers refuse. Mandatory requirements must allow the invocation. Nonempty default rules/plugin activation sources and hook files currently refuse until their executable policy is supported. Separate named-profile files also refuse until their precedence is supported. |
| Claude | Model/effort/theme presentation; permission rules, bounded file patterns and additional directories; inspected enabled plugins | Explicit tool list, mandatory Bash sandbox, slash-command disabling and strict empty MCP configuration apply per invocation. Unknown startup capabilities refuse. |
| agy | Conservative directory/write-rule interpretation for observations | Production pinning remains unsupported; no account grants are created. |

Known temporary-root overlap refuses before provider probes, settings reads or export writes.
Relative grants conservatively include their config-directory, working-directory and repository
bases; project Codex paths use the documented `.codex/` base. Default/Git/temp grants remain in
the possible write-root union; deny rules do not subtract them.
User/project MCP files and legacy project MCP grants are observed in addition to plugin manifests.
Managed Claude drop-in directories remain unsupported, including empty directories. Unreadable
sources and unknown versions report redacted provider/source categories that prevented admission. Mutable
mandatory executable policy cannot be made safe by a blocking ConfigChange hook and refuses.
Opaque or unavailable enforcement facts also refuse. The local version probe cannot establish
absence of server/MDM policy delivery: production Claude pinning currently refuses that unknown
fact. The offline bounded observations establish policy/adapter behavior, not account enforcement.
ConfigChange requires the documented 2.1.49+ hook family. No managed controls are overridden.

An enabled dark-factory-shaped Claude plugin can contain `bin/`, `lib/`, `schemas/`, native
workflows, skills, commands, agents and output styles. Passive executables can run only through
bounded Bash. Native workflow tools/delegation are absent, and slash commands/skills are disabled
for that pinned invocation. Pure style instructions are presentation. Active arbitrary command
hooks, MCP/LSP processes, startup agents, credential helpers and unresolved components refuse;
inspection never executes plugin scripts. Pinned status-line commands are replaced by a no-op.
The adapter's own N/job-bound PreToolUse and ConfigChange guards are required engine code; source
settings cannot claim their origin or gain an exemption by copying their command text.

Codex project profile definitions cannot narrow user grants. Every profile definition in an
applicable trusted project layer contributes its write roots to a conservative union and is
checked for unsupported executable/security keys, even when the project selects another profile
or no user profile is selected. This does not attest Codex's profile merge semantics. Untrusted
project layers remain inapplicable; inactive user profiles remain outside the selected profile.

Settings identity uses a versioned canonical effective security projection. Raw source hashes
remain provenance. Formatting, key order and unrelated presentation edits preserve compatibility;
write bounds, permission capabilities, trust/source applicability, executable plugin bytes/modes,
activation and guard enforcement changes invalidate the admission. Every boundary rereads sources.
Persistent approvals can edit watched security settings and invalidate a running job; a one-time
approval that changes no watched input does not inherently invalidate it. Invalidation preserves
the prior evidence and usage and requires a compatible executor/input or a new run, never a reset.

Pin admission emits redacted watched-source, role and capability diagnostics to stderr before
provider probes, followed by admission/refusal before work starts. Source scopes and ordinal labels
identify watched inputs without printing paths, setting values, commands, headers or credentials.
Unknown capabilities are refusals. Persistent approvals that change watched security capabilities
invalidate the run; one-time approvals writing no watched setting do not inherently invalidate it.

Typed observation support includes Codex notice acknowledgements and migration maps, plugin
activation maps and marketplace source descriptors, plus Claude's renderer, auto-mode rule object
and marketplace source variants. Notice/renderer changes are presentation. Auto-mode rules are
inactive only under the invocation's fixed plan/acceptEdits permission mode; unknown transitions
refuse. Activation, catalog sources and executable components remain security-relevant. A typed
catalog is not proof that refresh is bounded: unavailable refresh/activation observations, active
unresolved Codex plugins, MCP overrides and command/header helpers refuse specifically. Inspection
never fetches or executes a catalog. Bounded offline component fixtures do not establish production
plugin support. Project Codex settings cannot select or redefine user profiles to hide write grants.
Ensemble reviewers are included in admission in both implement and investigate modes.

Every regular pinned export file and its external manifest must be owned by the effective user
and have exactly one hardlink. Exports create independent files from committed blobs. Publication,
reuse and guarded validation read through checked no-follow descriptors and refuse added links
without deleting an existing export or its evidence. Legitimate internal symlinks remain supported.
Subprocesses explicitly close extra inherited descriptors or pass only required stdin/stdout/stderr;
workspace and linked-worktree Git access remain available. These covered checks do not establish an
atomic filesystem/policy boundary or protect against every alias race, IPC channel or account owner.

Import validation distinguishes ESM file URLs from literal CJS paths. It checks actual decoded
in-package ESM targets and explicit CJS files, preserving literal percent-directory names. Query,
fragment, computed, attribute/loader and unsupported external dependency forms refuse. The package
has no package.json; adding an ancestor module-type override is outside this supported layout.

Offline validation adds overhead. Earlier matched stub samples measured guard medians of
166.46→405.5 ms and charged pause/resume medians of 8400.44→18665.69 ms. These are historical
validation costs, not live benefit. The offline probe records base/retained/final samples and tails,
Node read/hash/probe counts and explicit unknowns; counters omit Python/native I/O and timing
excludes count instrumentation. Failed samples, sleep overlap and charged pauses remain evidence.
There is no cross-process cache or live speed/efficacy claim.

Pinned headless Claude blocks failed validation with exit 2 and prefixes the frozen helper's bin
in the actual Bash input, including after provider-side PATH replacement. A synchronous
ConfigChange guard also checks substantive non-managed reloads. Claude's shell sandbox does not
contain arbitrary hooks/helper processes; the refusals above remain necessary. Neither hashes
nor these controls defend against a malicious account/interpreter owner. Configuration support
is limited and does not establish authentication, host approval or live enforcement. Offline
regressions use temporary repositories, stub CLIs and explicitly catalogued raw observations;
there is no production test profile. No account settings are changed. Pinning does not prepare
a launch, install/promote the candidate, or support Run-plan. Ordinary unpinned execution retains
its existing behavior. TOML parsing needs Python 3.11+.

The package fingerprint covers the **whole shipped plugin**, including workflow/helper/runner,
parser, publication adapter and schema bytes, raw relative paths and Git modes. Import closure
is parsed as JavaScript. Supported forms are static imports/re-exports, literal dynamic imports,
direct CJS literal `require` and canonical ESM `import {createRequire} from 'node:module'` with
`const require = createRequire(import.meta.url)`. Local targets must be explicit inventoried files;
ESM resolves URL escapes while CJS percent paths remain literal. Computed/external targets and
unsupported grammar refuse within these covered forms. Inert prompt/comment/template text
contributes no dependencies; executable template expressions are checked.

Only the exact builtins `child_process`, `crypto`, `fs`, `module`, `os`, `path` and `url` are
admitted, with optional `node:` prefix and no subpath wildcard. The module builtin only permits
side-effect imports or static named `createRequire`/`isBuiltin` imports. Module-object acquisition,
renamed factories, loader aliases/exports/rebinding and unsupported indirect calls refuse.
CJS wrapper `require` only permits direct literal calls; wrapper `module` only permits
`module.exports` and `typeof module`; wrapper-resolving `arguments` refuses, including through
arrows. Wrapper-scope declarations/redeclarations and binding writes of `require`, `module`,
`exports` or `arguments` refuse, including block/loop `var` and writes from closures. Genuine
nested locals, ordinary-function arguments and exports property writes remain supported.
Executable `with` always refuses.

Process carriers, including known global aliases, only admit statically named `argv`, `env`,
`exitCode`, `execPath`, `on`, `once`, `removeListener`, `kill`, `pid`, `stdout`, `stderr`, `version`,
`geteuid` and `cwd`. Process-object escape and other/computed members refuse; `process.env[key]`
remains supported. Executable `eval`/`Function` references and `getBuiltinModule` members refuse.

This static subset is not arbitrary-JavaScript capability proof. Reflective constructor/global/
wrapper recovery (including function-level `this`, constructor chains, caller/callee and stack
recovery) and dependencies created by generated code are outside its analysis. Both runners
intentionally evaluate inventoried workflow source as sloppy `AsyncFunction` bodies. The validator
parses workflow source as modules; top-level `this` can therefore be global at execution and stays
within the function-level `this` exclusion above. Legitimate
`child_process` launches, admitted signals (`kill`/`pid`), environment access with subprocesses
and network globals are not confinement mechanisms. `worker_threads` acquisition refuses, but
these checks do not prove universal process/worker confinement. The initiating adapter supplies
the parser, never an unvalidated inspected export; live bootstrap reuse retains its initiating
trust root until the validated executor is re-executed.

Ordinary live resume requires identical package inputs but tolerates incidental Node/Python/Git
version differences; observed versions remain provenance. Pinned resume retains strict runtime,
revision and package equality. Whole-package fingerprints are incompatible with older checkpoints
that used a different fingerprint or package: keep their original compatible plugin/executor and
artifacts to inspect or resume them. Nothing migrates, rewrites or resets old evidence. Relocated
pins keep prior locations and compare cache entries by package identity rather than pathname.
Executor context remains only in control processes; candidate checks run candidate bytes as their
subject without replacing the executor.

Provider semantics: [Codex configuration](https://developers.openai.com/codex/config-reference/),
[Claude permissions](https://code.claude.com/docs/en/permissions),
[plugin components](https://code.claude.com/docs/en/plugins-reference),
[CLI controls](https://code.claude.com/docs/en/cli-reference),
[hooks](https://code.claude.com/docs/en/hooks) and
[sandbox scope](https://code.claude.com/docs/en/sandboxing).

Use `--explain` to inspect the resolved process before implementation:

```text
$dark-factory --explain Add cancellation support
$dark-factory --workflow pair --explain Implement the retry policy
$dark-factory --strategy pair Implement the retry policy
```

Factory explanation runs its read-only intake, then returns the tier, strategy, participants,
reviewers, required CLIs, verification setting, limits, and expected deliverable. Missing plans,
split decisions, and tier disagreements still take precedence. Explanation of an explicit Pair,
Council, or Ensemble performs no model turns. It does not run setup, preflight, or verification,
and does not claim readiness. Architecture explicitly says it returns a plan without building.

`--prepare` is the offline counterpart: no model turn, no run directory, no account change.
It lists each vendor reachable from the request with the roles it could fill, checks that its
CLI answers `--version` (the same sandbox and Gemini-settings probe setup makes), and checks
that absolute `plan` documents exist. Tracked changes absent from HEAD are a warning, because
setup decides them for the run's mode. Authentication is reported as unknown. Every new single
run makes the same check first and stops with status `preflight` before intake when anything
blocks, so a missing CLI no longer costs an intake turn. Resume and Run-plan are not prepared.
The same controls are available as object arguments in Claude Code.

`maxTurns` (`--max-turns`) limits workflow model turns, including orchestration and explicit
recovery turns. Provider transport retries within a turn remain governed by that CLI helper.
`maxRunMin` (`--max-run-min`) requires the standalone runner, which cancels active jobs at the deadline.
Native Claude workflows reject this option before launching work because they have no replay-safe
clock; use `maxTurns` there, or launch through `dark-factory-codex` for a time limit. Run-plan uses
that runner from both hosts and retains its time limits. `--timeout-min` remains the
per-turn deadline, and `--concurrency` bounds simultaneous turns in Codex. These are limits,
not price forecasts. Exhausted required work remains incomplete. An optional retrospective
that could not run does not erase a completed review. Codex retains spent turns and active
elapsed time across resumes; time spent waiting between invocations is excluded.
Codex also retains `--concurrency` and `--timeout-min` across resumes. Supply either flag on
resume to override its saved value; that override becomes the default for subsequent resumes.

For Council and Factory's independent tiers, opt into repeated repairs with:

```json
{"task":"Fix the boundary case","repair":{"maxPasses":2,"minor":"block"},"maxTurns":60,"maxRunMin":45}
```

Each repair is measured, then reviewed in fresh contexts and separate checkouts. Existing
findings retain stable IDs and evidence. The loop stops on readiness, unchanged artifacts and
verification outcomes, missing review, or the repair limit (1–20 passes). Reworded notes and
reordered findings or criteria do not count as repair progress. The default minor policy
requires actionable minor findings to close; `minor: "report"` retains them in the report without
making them repair obligations. Preferences remain suggestions. Simple uses this fresh-review
loop by default with one repair pass and retains its escalation rules. Council, Fix, Feature,
and Architecture retain their original audit path unless `repair` is supplied. Pair continues
to use its separate design-and-code `maxReviews` budget and strict finding closure.

Codex saves a checkpoint when all in-flight operations at a boundary have completed successfully:

```sh
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc
node plugins/dark-factory/bin/dark-factory-codex --resume /project/.council/host-abc --args-file answers.json
```

A resume validates the engine, repository HEAD, tracked working/index changes, reference bytes,
tracked and unignored worktree files, snapshot refs, and saved evidence before reusing any operation. Completed
operations replay without model calls; new reviews remain fresh. A lock prevents two hosts
from continuing the same run. The same task and execution options must be retained. Allowed
updates are appended answers to the paused run's question IDs, `tierConfirmed`, `noSplit`,
`explain`, run-wide budgets, and explicit concurrency or per-turn timeout overrides. For a debate question the host preserves its `afterRound`. Pair author questions are free text; incorporate those answers into `context` in a new run.

Host metadata and results use atomic file replacement. Resume recovers an unterminated final
event record before appending more events, preserving all preceding records and their turn
counts. A valid final record without a newline is retained; malformed completed records still
stop resume with a diagnostic.

If an interrupted write changed a worktree, or inputs/evidence changed, resume fails with the
mismatch and leaves all files intact. Start a new run in that case; no checkpoint is silently
reset and no dependent review is reused. Ignored dependency directories and external toolchains are not frozen by the checkpoint; start a new run if those inputs change. An interruption before the first successful boundary
may have no checkpoint. A new run after a changed task should carry the full questions and
answers in `context`, rather than old question IDs. `hostRunDir`, `checkpoint`, and `hostEvents`
in the result identify the saved artifacts.

## Ensemble: reviewed alternatives

```text
/dark-factory:ensemble Compare fixes for the iterator boundary
$dark-factory --workflow ensemble --seats sol,astra Compare fixes for the iterator boundary
```

Ensemble uses the shared setup, separate worktrees, neutral snapshot checks, verification gate,
and host adapters. It retains its distinct stances and review lenses, followed by an advisory
comparison. It does not debate, repair, or select a winner. Specify `mode: "implement"` or
`"investigate"` when the wording is ambiguous.

Object arguments support `candidates` (2–6, default 4), `reviewers` (1–4, default 2; capped by
available lenses), and `models: {solve, review, compare}`. Claude defaults remain Sonnet solvers,
per-lens Sonnet/Opus reviewers, and an Opus comparison. Codex defaults use Sol solvers,
Sol/Astra reviewers, and an Astra comparison. Explicit `seats` chooses candidate models, using
the shared model catalog. If `candidates` is also supplied, its count must match `seats`.
References, criteria, verification, dirty-tree policy, explanation and run budgets are shared.

Each candidate includes its measured `final.snapshotRef`, `final.readiness`, review gaps, and
`delivery` status. Missing reviewers, stale reviewed trees, failed gates, or failed criteria
cannot become a ready candidate. The overall result remains `advisory` with delivery
`pending-selection` (Codex exit 2). Selecting an unchanged ready implementation allows its
candidate object to be saved as the delivery result for `verify-delivery`. A merged change
needs fresh measurement and independent review. With four candidates and two lenses the clean
path is now about 18 turns: setup, four solvers, four neutral checks, eight reviews, and comparison,
before external relay overhead or retries.

## Evaluate process value without model calls

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
Codex host's exact `elapsedMs`. Intake and setup run before `init`, so their time isn't counted.
The evaluator still excludes older estimates derived from `run.json` modification time. Token facts
use the same `records`/`byModel` format in both hosts; older native facts are also accepted.

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

## Factory and Pair verification and delivery

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

## Layout

    .claude-plugin/marketplace.json   the marketplace: lists the plugins in this repo
    plugins/dark-factory/             the plugin, and the only thing that ships
      .claude-plugin/plugin.json
      workflows/                      pair.js, factory.js, council.js, ensemble.js (built from src/)
      bin/dark-factory                the helper CLI the agents call
      bin/dark-factory-codex          the Codex host runner
      skills/dark-factory/            the Codex skill and its relative launcher
    install-codex.sh                  link the skill into a project or user skill directory
    src/ tools/ test/                 development: sources, build, tests

A new workflow goes in `plugins/dark-factory/workflows/` and runs as `/dark-factory:<meta.name>`.

## The factory

`/dark-factory:factory` is the entry point for work that should be done end to end with independent review
when it isn't obvious how much process the work needs. It decides that first, then runs the
cheapest process that plausibly suffices, and hands the work up when the evidence says that
wasn't enough.

    /dark-factory:factory Add a debug log line with the retry count in Fetcher::retry
    /dark-factory:factory --tier fix Find why the sync drops the last page

| tier | what runs | rough cost |
|---|---|---|
| `simple` | Sonnet implements, the neutral check, Codex Astra reviews, at most one fix pass | 6–9 agent turns |
| `fix` | the council with two seats, Opus and Astra: blind attempts, debate, audit | 15–25 |
| `feature` | Opus and Astra plan it blind and debate the plans; the chosen plan's author builds it in checked increments; a three-lens audit | 25–40 |
| `architecture` | Opus, Astra and Sonnet design it blind and debate the designs; the chosen design's author writes a milestone plan; a three-lens review and one revision; nothing is built | 35–50 |

The table describes the independent strategy. Factory can also select Pair for scoped implementations with one clear approach. Use `strategy: "independent"` to retain the tier's competing-attempt process, or `strategy: "pair"` with `pair: {author, reviewer, maxReviews}` to request Pair. Task tier and collaboration strategy are reported separately. Explicit independent-process options (`seats`, `simple`, `panel`, `spec`, `audit`, `roles`, or `evidence`) keep automatic routing on the independent strategy; combining them with an explicit Pair strategy is rejected rather than silently discarding them.

The model names below describe the Claude profile. Codex uses its own OpenAI defaults while
keeping the same stages and rules; explicit `seats`, `simple`, `panel`, `spec`, `audit`, and
`roles` options override the Codex defaults.

- **Intake.** An Opus agent reads the task, any document it names and the code, without
  running anything, and returns a tier, a mode, its reasons and the signals it went on
  (files touched, public API, across modules, test coverage, ambiguity). It picks the lowest
  tier that plausibly suffices, because a tier too low costs a few turns and a tier too high
  costs dozens. An ambiguous request is never Simple, and Simple and Feature are for changes
  only (an investigation goes to fix, a design to architecture). One connected piece of work too
  big for one feature (more than about 4 increments, or a design decision to settle before it
  can be planned) also goes to architecture; separate pieces go to `needs-split` instead. Intake
  also stops the run with `needs-plan` when the task depends on a document it can't find.
- **A task of several pieces.** When the task bundles work that stands on its own (a checklist,
  fixes with separate causes, one commit per item), intake stops the run with `needs-split`
  before anything is created and lists the pieces: each a self-contained task, an estimated
  tier, and the earlier pieces it builds on. One run would debate and review all of them
  together at the cost of the hardest. The main session asks you once: run each piece as its
  own `/dark-factory:factory` run, in order, committing each before the next (every run starts from HEAD),
  or rerun with `noSplit: true` to run the whole task as one. Each piece's run has its own
  intake, so the estimated tiers aren't pinned.
- **A pinned tier.** `tier` (or `--tier` at the start of a string task) sets the tier. Intake
  still runs, blind to the pin. When it would pick another tier, the run stops with
  `needs-tier` before anything is created, and the main session asks you once. Rerun with
  `tierConfirmed: true` to keep yours, or with intake's tier. Intake's prompt doesn't contain
  the pin, so it replays from cache either way. A kept tier is where the run starts, not a
  ceiling.
- **Escalation**, automatic, upward only, in the same run. Simple hands the work up when:

  | trigger | when | to |
  |---|---|---|
  | `too-big` | the implementer says it isn't a simple change | its tier (fix or feature) |
  | `over-budget` | the round-0 change exceeds `maxLines` (200) changed lines or `maxFiles` (8) files | feature |
  | `design-finding` | the panel upholds a blocker or major judgment finding about the approach | feature, before any fix |
  | `verify-failed`, `blocked` | after the fix pass, the verification command still fails, or the result is blocked | fix |

  Feature hands the work to architecture, before anything is built, when its chosen plan lists
  more than 4 increments (`too-many-increments`): that is work for milestones, not one build.

  A failed agent is not evidence about the task, so it never escalates. The higher tier runs
  its own setup (a fresh run directory, its own criteria, the spec review) and starts blind:
  its seats are told why the work was handed up, with the upheld findings, the failing tests
  and the failing tail, but they aren't shown the earlier change or plan. The result is the
  higher tier's, with the report opening on "Escalated from Simple" (or Feature). A run handed
  up twice, Simple to Feature to Architecture, reports both steps.
- **The Feature tier** spends its independence on the plans, where it is cheap, and builds once:
  1. **Setup and the spec review**, as in the council (two seats: Opus and Astra unless you pass
     `seats`).
  2. **Plans, blind.** Each seat writes a plan, not code: the approach and the alternatives, the
     changes file by file, how each criterion will be met and tested, the risks, and at most 4
     increments, each leaving the verification command passing. Worktrees stay untouched.
     Every claim about the existing code cites file:line, and the checkers verify those
     citations (nothing is measured yet).
  3. **The debate** on the plans, with the council's rounds, votes and scorecard. Findings are
     plan defects: a step that relies on code that isn't there, a criterion left uncovered, an
     increment that would break the suite.
  4. **The final plan.** The chosen plan's author merges in the best of the others (credited)
     and lists its increments. There is no ratification: the audit reviews the change itself.
  5. **The build.** The same author builds it in its worktree, one increment per turn, each
     followed by the neutral check (snapshot `inc<N>`, the verification command, its claims).
     A failing check, a turn that returned nothing and findings still standing go into the next
     turn's prompt. A plan listing more than 4 increments goes to the Architecture tier instead.
  6. **The audit**, through three lenses: correctness (Codex Astra), design (Claude Opus) and
     **tests** (Claude Sonnet, IDs `XT1`, `TXT1`), which mutates the change to find behaviour no
     test would catch. `audit: {tests: 'haiku'}` swaps it. Then the council's one fix pass (a
     failing verification command also earns it) and the auditors' re-review of the fix.

  The report covers the plan chosen and why, the plans, the planning debate, the build
  increment by increment, and the audit. A Simple run handed up to feature runs this flow.
- **The Architecture tier** is for a request for a design or a plan, and for one connected piece
  of work too big for one feature. It builds nothing: it hands back milestones, each ready to be
  a factory run of its own.
  1. **Setup and the spec review**, as in the council, in design mode. The criteria say what the
     design must cover and decide. Three seats, Opus, Astra and Sonnet, unless you pass `seats`:
     design is where diversity has paid off (the one design run in `retros/` produced four
     different designs, and its finalists were Sonnet's and Astra's).
  2. **Designs, blind**, each ending in milestones: each one reviewable and committable by
     itself, leaving the system working, and small enough for one feature build (at most 4
     increments). Claims about the code cite file:line, and the checkers verify them.
  3. **The debate** on the designs. Findings are design defects: code that isn't there, a
     criterion left uncovered, a milestone that would leave the system broken or needs what only
     a later one delivers.
  4. **The milestone plan.** The chosen design's author merges in the best of the others
     (credited) and lists at most 8 milestones: a title, the milestone as a self-contained task,
     draft criteria, the earlier milestones it builds on, a tier (simple or feature), and what
     works once it lands. There is no ratification: the review checks the plan.
  5. **The review**, by reviewers who never saw the debate, through three lenses: **grounding**
     (Codex Astra, IDs `XG1`: does the plan match the code as it is), **sequencing** (Claude Opus,
     `XS1`: does each milestone leave the system working, and are the order, dependencies and
     sizes sound) and **risk and alternatives** (Gemini Flash, `XK1`: what could sink it, and
     whether a design the council didn't choose is better, for the plan or one milestone; only
     this lens reads the other designs). They read the plan and the repository, write nothing,
     and say which milestone each finding is about. Gemini is the only model in the run that
     wrote no design, and a reviewer that fails costs a gap in the review, not the run;
     `audit: {risk: 'sonnet'}` swaps it (the preflight stops the run if agy can't start). Then
     the audit's triage, one revision by the author (which lists the milestones again), and the
     reviewers' re-review of the revision.
  6. **The result** lists `milestones[]`, each with the review findings still open against it and
     `args` for its own run: its task with the draft criteria and those findings, the final
     design as its `plan` document, its tier, `tierConfirmed: true` and `noSplit: true`. The
     main session shows them and offers to run them one at a time, in order, committing each
     before the next. Nothing chains automatically. Keep the run directory until the milestones
     are done (`cleanup` without `--all` keeps the room), since each milestone run reads the
     design from it.

  The report covers the design chosen and why, the designs, the debate, the milestone plan and
  the review.
- **The Simple tier** reuses the council's machinery: the setup agent (1–3 criteria, one
  worktree), the neutral checker, the audit with a single `review` lens (IDs `XR1`, `TXR1`), the
  panel for blocker and major findings, and the audit's one fix pass. A failing verification
  command also earns the fix pass. Every repair receives a fresh independent code review as well as neutral verification. The default repair budget is one pass; `repair: {maxPasses: 2}` allows a bounded additional pass. `simple: {implementer, reviewer, maxLines, maxFiles}` changes it, and
  every `/dark-factory:council` argument passes through to the council tiers.
- **Facts on every run.** Each factory run puts a JSON facts block in its retro payload: tier,
  how it was chosen, intake's signals, the escalation (from the tier it started at, with each
  step when there were two), readiness, turns by role, review findings, the number of
  milestones for an architecture run, and hints that the tier was too high (seats that agreed
  blind, a clean audit on a small diff).
  The model retro runs only on notable runs: every council tier, an escalation, an overruled
  intake, a result that isn't ready, a fabrication or a relay failure. A clean Simple run instead
  gets a Haiku turn that saves the facts (`dark-factory retro --facts-only`).
  `dark-factory retro --summary` tallies `retros/*.facts.json` by starting tier, which is what the
  intake rubric is tuned from.

## Choosing the models

Claude, Codex and Gemini are separate accounts with separate limits. When one runs out, pick
the lineup yourself, for example with Codex Sol in place of Gemini:

    /dark-factory:council --seats opus,sonnet,astra,sol Fix the cancellation in ...

or, from a session, `Workflow({name: 'council', args: {task: '...', seats: ['opus', 'sonnet', 'astra', 'sol']}})`.
Asking in words ("run the council with Sol instead of Gemini") works too. The launching session
passes `seats`.

| seat | model | vendor |
|---|---|---|
| `opus`, `sonnet`, `fable`, `haiku` | Claude | Claude Code subagents |
| `astra`, `sol`, `luna` | gpt-6-astra, gpt-6.1-sol, gpt-6-luna | Codex CLI |
| `gemini` | Gemini 3.8 Flash | Antigravity CLI (`agy`) |
| `gemini-pro` | Gemini 3.1 Pro (low and high effort only) | Antigravity CLI |
| `codex:<slug>`, `gemini:<slug>` | any model the CLI offers (`agy models` lists Gemini's) | |

Use 2–6 seats. Consensus needs votes from at least two vendors whenever the lineup has more
than one vendor.

It is the sibling of `/dark-factory:ensemble`. Ensemble returns ranked candidates for you to pick from; the
council argues until it agrees, and falls back to an evidence scorecard when it can't.

## How a run goes

1. **Setup.** One Opus agent first runs `dark-factory preflight` for the Codex and Gemini CLIs the
   lineup and panel need, and stops the run, before anything is created, if one can't start
   from this session (with the fix, or the seat to swap). Then it creates the run directory and
   a git worktree per seat, finds the verification command, measures the baseline, and writes
   3–7 acceptance criteria *before anyone starts*, so nobody can redefine success halfway
   through. Each criterion must be checkable from inside a seat's sandbox.
2. **Spec review** (every mode; `spec: false` skips it). Every later check measures against the
   criteria, so a criterion that is wrong lets a wrong result pass all of them. Before any seat
   starts, two reviewers who see only the task, the code and the setup's criteria look for
   problems, each through one lens: **coverage** (Codex Astra: missed edge cases and error
   paths, regressions the criteria would allow, criteria wrong about the code, a verification
   command that wouldn't catch a breakage) and **intent** (Claude Opus: ambiguity,
   contradictions, scope creep or gaps against the task, uncheckable criteria). Each finding is a
   *fact* (the code, documents or task settle it) or a *decision* (only you can).
   - **The panel rules** on every finding: accept, reject, or decision. A finding is amended
     only if every adjudicator accepts it; any decision vote makes it a question; accept against
     reject is disputed and left alone. Widening the scope counts as a defect.
   - **One Opus turn amends** the criteria (and the verification command, re-measuring the
     baseline if it changes). It never rewords criteria you passed in `criteria`.
   - **Questions only you can answer** are settled autonomously on the most conservative reading
     (keeps existing behaviour, easiest to undo, closes off the fewest options). The criteria
     follow it, seats are told it, and the report opens with an "Assumptions to check" section,
     one yes-or-no line each. With `spec: 'ask'` the run instead stops with `needs-user` before
     any seat starts, and resumes from cache with your answers as `clarifications`.

   A clean review costs 3 turns (two reviewers and a relay); one with findings adds the panel
   (3 turns with its relay) and the amendment. The report gets a "Specification review" section.
3. **Solve, blind.** Each seat works alone in its own worktree and posts to the shared room.
   Seats are anonymous letters, assigned by a per-run shuffle. In implement mode, if every
   seat's checked snapshot is the same tree and the verification command passes on it, there is
   nothing to debate: the council skips to synthesis by the copy highest on the scorecard.
4. **Debate rounds** (default 2, max 3). Each seat reads the other positions and the ledger,
   then files findings, challenges claims, concedes, adopts ideas (credited), revises, and votes
   on which position should ship. From round 2 it starts from what changed since it last looked.
5. **Neutral checks after every round.** A Sonnet checker per position re-runs the
   verification command and every published test against it, in a disposable checkout of the
   snapshot it just took (never the seat's live worktree), and rules on each claim:
   VERIFIED, REFUTED, FABRICATED or UNRESOLVED. Disputed load-bearing claims go to a two-vendor
   panel (a fresh Opus and a fresh Astra by default; set `panel`). If the panel splits, the claim is UNRESOLVED.
   A checker that returns nothing gets one retry.
6. **Stop rule** (code, not a model): consensus when ⌈2N/3⌉ seats vote for the same
   non-disqualified position, with votes from at least two vendors among them. If a round changes
   nothing, or the last round ends without consensus, a scorecard picks the base.
   Otherwise the field narrows before the next round (see below). Two experiments, both off
   unless you turn them on per run, change when or how agreement counts: `ballot` and
   `approval` (see [Arguments](#arguments)).
7. **Synthesis.** The winning author folds in amendments, fixes standing findings and
   credits adopted ideas.
8. **Ratification.** The other seats endorse or object. Blocking fact objections go to the
   panel, and upheld ones get one fix pass. Judgment objections are reported as dissent.
9. **Readiness.** Separately from how it was chosen, the final version is reported as
   *ready*, *blocked* (an unmet criterion, a failing suite or published test, a fabricated
   verification, an upheld blocker or major) or *incomplete* (no check, an unrun suite, an
   unjudged criterion, an unresolved or one-adjudicator ruling, a missing review). Readiness is
   reported only; it never changes which position was chosen.
10. **Audit** (implement mode; `audit: false` skips it). Every reviewer so far took part in the
   debate, or ruled only on claims somebody made, so a problem nobody raised gets past them all,
   and agreement among seats that share a frame proves little. Two auditors who never saw the
   debate now review the final version, each through one lens: **correctness** (Codex Astra:
   edge cases, regressions, error paths, whether the tests would catch the change's loss) and
   **design** (Claude Opus: abstractions, simplicity, fit with the codebase, test level, and a
   change-tolerance probe that traces where two or three plausible next changes would land).
   Each gets the task, the criteria, the final diff and its own checkout. The room is off limits.
   A correctness finding should come with a failing test, published like a seat's.
   - **Triage** reuses the checks: a checker re-measures the final version with the auditors'
     tests and rules on minor fact findings, and the panel rules on blocker and major ones. A
     judgment finding the panel agrees on becomes a fact, upheld or refuted. A split leaves it
     a judgment call. Minor judgment findings go to the author as suggestions.
   - **One fix pass** when anything is upheld, disputed or failing. The winning author fixes
     it, or declines with evidence, and the final version is checked again.
   - **Re-review of the fix only.** The auditors read the fix's delta for defects it introduced.
     Blocker and major ones go to the panel and are reported, never fixed: the loop is capped
     at one cycle, so it ends.

   A clean audit costs 3 turns (two auditors and a relay; nothing to rule on, so no re-check);
   one with findings, about 10 more, plus their relays. Readiness then reflects the last check, and an auditor that
   returned nothing leaves it *incomplete*. The report gets an "Independent audit" section listing each finding and how it
   ended. The default panel is also Opus and Astra, but fresh ones: an adjudicator never sees
   the audit it rules on.

Escalation: the council settles judgment calls itself. It stops to ask you only when ⌈2N/3⌉
seats (3 of 4) raise or second the same question about the request itself. Questions that
don't reach that bar are reported as assumptions.

## Working from a plan

Seats work in git worktrees checked out from HEAD, so they can't see anything uncommitted: a
plan from plan mode (saved under `~/.claude/plans/`), an untracked `PLAN.md`, a bug checklist.
The council handles that in three layers:

1. **The launching session passes the plan.** The workflow's description tells the main
   session to call it with the plan's absolute path and to say in the task which part to do,
   without pasting the document:

       Workflow({name: 'council', args: {task: 'Do item 13 on the bug checklist',
                                         plan: ['/abs/path/BUG_CHECK_LIST.md']}})

2. **Setup snapshots it.** `dark-factory init --ref` copies each document into `<run>/refs/`, byte
   for byte, with no model retyping it, and records whether the worktrees have it. Setup also
   looks for documents the task names, such as "item 13 on BUG_CHECK_LIST.md", and snapshots
   those too. The acceptance criteria are written from the documents as well as the task.
   Every seat, checker, panel member and the final author is pointed at the snapshots. Seats
   are told not to copy them into the worktree, and not to cite them (file names, step or item
   numbers) in code, comments or tests.
3. **No guessing.** If the task depends on a plan the council can't find, including "the plan"
   with no file named, it stops before any seat starts. The main session is told to find the
   plan (one made in the same conversation is under `~/.claude/plans/`) and rerun with `plan`,
   or to ask you if it can't tell which plan is meant.

## Scoring

All scores are computed by the script from the checkers' and panel's rulings.

**Positions** (deciding what ships when there is no consensus) are ranked in strict order:

1. Disqualified last: the verification command fails (when it passed at baseline), or the
   round's verification claim was fabricated.
2. Fewest standing blocker findings, then fewest standing major findings.
3. Highest pass rate on valid published tests.
4. Most acceptance criteria met.
5. Fewest standing minor findings.
6. Votes from other seats.
7. Author credibility.
8. Smaller diff.

**Seats** (whom to trust) record:

- fabricated and wrong claims
- findings upheld and refuted
- challenges won and lost
- a refutation score, where upheld findings earn by severity and refuted ones cost 1.5× as much
- ideas adopted by others and ideas that made it into the final version
- tests published and valid
- capitulations (changed position with nothing verified behind it)
- ignored findings (left a verified blocker or major unaddressed)

## Keeping context focused

Reading three rival solutions every round is where context would grow, so the moderator keeps
each seat's reading to what the decision needs:

- **Pointers, not pastes.** Prompts list the paths of posts and diffs. Seats open what they
  need. The ledger digest is capped: one line per position, ledger entries cut to about 260
  characters, and at most 30 refuted and 30 other checked claims.
- **What changed, from round 2.** Each checker run snapshots the seat's tree and writes
  `rN/<seat>.delta.diff`, the change since the seat's previous round. Readers start from that
  and the post's "Changes this round" section, and open the full post or diff only when needed.
  Ratifiers also get `final/<seat>.delta.diff`, the change since the version they last reviewed.
- **The field narrows.** After a debate round without consensus, the two positions ranked
  highest on the scorecard stay in contention, as does any position another seat voted for and
  any whose author has a verified blocker or major finding against one that stays. The other
  authors become reviewers: they stop revising, and they critique, publish tests and vote for a
  contender. Reviewers' positions are no longer measured or read, and findings against them
  are no longer filed. With 2 or 3 seats this rarely triggers; turn it off with `narrow: false`.
- **Memory for Claude seats.** Claude seats are fresh agents each turn, so each one returns
  private notes of under about 400 words (key file:line references, what it verified, its read
  on each position). The notes are pasted into that seat's next prompt and nobody else sees
  them. Codex and Gemini seats keep their own thread instead.
- **Length limits.** Posts should stay under about 800 words (implement), 1,500
  (investigate) or 2,000 (design). Only the post file counts: long material the task asks for,
  such as exact edits or logs, goes in separate files in the room. Checkers count the words, and
  the digest flags a post that runs over.
- **Fewer, sharper claims.** Each turn records at most 12 claims: every verification claim, plus
  the facts that name an acceptance criterion they bear on. Checkers verify every claim, and
  incidental facts nearly always came back verified, so they stay in the post, unchecked. A diff of more than 400 changed lines is offered with its per-file summary
  (`rN/<seat>.stat`) first.
- **Narrow neutral roles.** Each checker sees only the claims about one position; each panel
  member sees only the disputed claims.

## Arguments

`/dark-factory:council <task>` passes a string. From a session, `Workflow({name: 'council', args: {...}})`
accepts:

| arg | default | |
|---|---|---|
| `task` | required | |
| `plan` | | path or list of paths: a plan or other document the work follows; snapshotted for every seat |
| `mode` | auto | `implement`, `investigate` or `design`. Unless given, setup picks it after reading the task and its documents: a bug fix or "do the next item" on a checklist is implement |
| `seats` | `['opus','sonnet','astra','gemini']` | a list or a comma-separated string; see [Choosing the models](#choosing-the-models). A string task may start with `--seats a,b,c,d` |
| `rounds` | 2 | debate rounds, 1–3 |
| `effort` | `high` | for every seat, or per seat: `{astra: 'xhigh'}`. Codex also accepts `ultra`. Gemini maps the level to the nearest one the model has (Flash: low, medium, high), since agy names it in the model slug |
| `context` | | extra context for every seat |
| `criteria` | written by setup | your own acceptance criteria, as a list of strings |
| `verify` | found by setup | the verification command |
| `repo` | session cwd | run against another repository |
| `consensusAt`, `escalateAt` | ⌈2N/3⌉ | |
| `panel` | `['opus','astra']` | adjudicators for disputed load-bearing claims |
| `checkModel` | `sonnet` | |
| `allowDirty` | false | implement mode refuses uncommitted tracked changes, since worktrees branch from HEAD |
| `narrow` | true | after a round without consensus, positions with no support leave contention and their authors review |
| `retro` | true | every agent may leave a process note, and a retro agent suggests workflow changes at the end; see [Process retro](#process-retro) |
| `timeoutMin` | 90 | deadline for a Codex or Gemini turn, in minutes: one number, or per phase `{spec, solve, debate, final, ratify, panel, ballot, audit}`. A turn that hits it is not retried |
| `spec` | `{coverage: 'astra', intent: 'opus'}` | the spec review before any seat starts (step 2). `'ask'` stops for your answer on questions only you can settle instead of assuming; an object swaps a lens's model, sets `effort`, or `ask: true`; `false` skips it |
| `audit` | `{correctness: 'astra', design: 'opus'}` | implement mode: the independent audit of the final version (step 10). Swap a lens's model, e.g. `{design: 'sonnet'}`, or set `effort` for both; `false` skips it |
| `ballot` | false | experiment: when a round ends one vote short of consensus (and another round is left), every seat votes again once that round's checks are in, instead of debating a full round more |
| `approval` | false | experiment: seats also list the other positions they could accept. With no strict consensus, a position chosen first by another seat, and chosen or accepted by ⌈2N/3⌉ seats from two vendors, with no verified blocker or major, carries the round; acceptors' amendments go to the final author |
| `clarifications` | | `[{id, answer, afterRound}]`, used when resuming after an escalation, or `[{id, answer}]` after the spec review asked |

## Pieces

- `plugins/dark-factory/bin/dark-factory-codex`: the local Codex host for the generated factory
  and council workflows. Its runtime adapter launches the helper directly, writes exact prompt
  files, validates structured results, and records progress. The skill's launcher resolves the
  runner relative to its real installed path, so prompts do not depend on an installation path.
- `plugins/dark-factory/workflows/council.js` and `factory.js`: the moderators. `factory.js` is the same
  engine with intake, the Simple tier (`src/simple.js`), the Feature tier (`src/feature.js`), the
  Architecture tier (`src/architecture.js`) and `src/main-factory.js` (routing, and `escalate()`)
  on top. They
  hold the turn order, the ledger, the stop rule, the scorecards and every prompt, and never
  judge. Both are **generated** from `src/` by `tools/build.mjs` (the workflow runtime allows no
  imports, so each has to be one file), and are
  committed so it can be diffed and run without a build. Edit `src/`, then `make build`:
  - `src/lib/*.js`: the pure half. Every function takes the state object `S` (built by
    `newState(parseConfig(args))`) as its first argument and calls nothing from the runtime:
    config and seats, the state queries, every prompt, the ingestion and rulings, consensus,
    narrowing, ranking and readiness, and the report.
  - `src/boot.js`, `schemas.js`, `turns.js`, `council.js`: the half that uses `agent()`,
    `parallel()` and `log()`: the agent turns and relays, the checks, and the round loop
    (`councilRun()` in `council.js`, which `main-council.js` calls). Its stages,
    `councilSetup()`, `debateStage()` and `synthesize()`, are what `featureRun()` and
    `architectureRun()` reuse; the Architecture tier's review is `runAudit()` with its own
    prompts and a revision that returns the milestones.
  - `src/lib/tiers.js`: the factory's pure half: tier parsing and routing, the pushback, the
    escalation triggers, brief and chain, the Feature tier's increments, report and result, the
    Architecture tier's milestones (and each one's run args), report and result, the run facts.
  - `src/00-meta.js`, `src/00-meta-factory.js`: each workflow's `meta` (it must stay a plain
    literal) and header comment.
  - `tools/sources.mjs` lists each built workflow's files in order.
- `bin/dark-factory`: deterministic plumbing, since workflow scripts have no shell. It handles
  worktrees, snapshots (`refs/council/<run>/<seat>-<round>`), suite and cross-test runs, and
  Codex turns. Seats leave their change uncommitted unless the task asks for commits; a snapshot
  keeps a seat's commits and puts anything uncommitted in one council commit on top. A Codex
  seat can commit because its worktree's git dir and the object store are writable roots of its
  sandbox; agy's sandbox can't write them, so a Gemini seat describes its commits instead. A
  Codex panel or spec reviewer must not change the repository, but Codex's read-only sandbox
  forbids even temp files (zsh heredocs, Rscript), so it runs in workspace-write from an empty
  scratch directory under the run: it reads everything and writes only there and to temp. Long work runs as detached jobs, polled with `dark-factory wait`, so it outlives the
  Bash tool's 10-minute limit.
- **Codex and Gemini seats.** Each turn goes through a Haiku relay agent, since a workflow script can't
  run commands itself. The relay runs `dark-factory seat-run`, which reads the prompt from the
  relay's own transcript (Claude Code saves every agent's prompt), checks its hash, and runs
  `codex exec` or `agy -p` (or, on later turns, resumes the seat's Codex thread or agy
  conversation). No model copies the prompt: in
  the first live run, Haiku dropped a line of a 13 KB prompt three times. Copying it by hand is
  only the fallback, hash-checked, with Sonnet as the second relay. Codex and Gemini seats keep
  their own memory across rounds, and after round 0 they get only the round-specific part of
  the prompt.
- **What the relay reports.** The relay returns the CLI's outcome as fields (`status`
  done/error/sandboxed, `error`, `errorClass`, `seconds`) and is told that any error text comes
  from the other model, not from its own Bash call. The workflow acts on those fields, never on
  the wording. (In one run a Gemini "Malformed function call" came back labelled "sandboxed",
  and Gemini was blocked for the rest of the run.) `seat-run` retries a capacity error or a
  malformed tool call by the vendor's model once inside the job, never a timeout or a used-up
  quota, and runs an identical failed turn at most twice. Each external turn's output schema
  pins a per-turn tag (`turn`, a one-value enum), so a stale answer from an earlier turn is
  rejected.
- **The run directory**, `<repo>/.council/<runId>/`, kept out of git through `.git/info/exclude`:
  - `room/` holds the transcript: `r0..r3/<seat>.md` posts, `<seat>.diff`, `<seat>.stat`,
    `<seat>.delta.diff`, `final/`, `ratify/`, the audit's `audit/<lens>.md`, `final3/` (its
    fix pass, or the Architecture tier's revision) and `reaudit/`, and `tests/<ID>/` (seats'
    tests, and auditors' as `TXC1`, `TXD1`). The Architecture tier's reviewers write no files:
    their reviews are in the result.
  - `refs/` holds the snapshots of the plan and other reference documents.
  - `wt/<seat>` and `snap/` are worktrees (`snap/audit-<lens>` is an auditor's checkout); `scratch/` holds the short-lived checkouts the
    suite and cross-tests run in.
  - `jobs/` holds Codex, Gemini and measurement jobs.
  - `usage.jsonl` records Codex and Gemini token use.
  - `retro.md` and `retro-data.md` hold the process retro and the notes it drew on.

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

## After a run

The main session reads the final version, spot-checks its load-bearing claims, and reports:

1. **A summary in its own words**: which model's work the council went with and why, what
   the other models proposed, and how it ended, followed by the debate topics, one line each
   saying how each was settled.
2. **The council's report** (`report.markdown`), computed by the script from the ledger, the
   votes and the rulings, with every seat named by its model:
   - **Assumptions to check**, first, when the spec review settled a question about the request
     without you: the result is built on them.
   - **Chosen, and why.** Consensus (who voted for it, with every seat's stated reason) or the
     scorecard. Also the criterion that put it above the runner-up, or, when the vote overrode a
     higher-ranked position, which one and on what. And its evidence when chosen.
   - **The positions.** Each seat's opening and closing position and its fate: chosen, its
     rank, or when it left contention.
   - **How the debate went.** Round by round: findings filed and how they were ruled,
     disputes, revisions, adopted ideas, votes, narrowing, and how it ended.
   - **The debates.** Up to 10, most severe first. Each one gives the point, who disputed it and
     why, the ruling (checker, panel, or judgment call), and the outcome (conceded, fixed, or
     still standing).
   - **How it turned out.** Readiness first, then the final version, ideas folded in from other seats, what the
     author declined and why, the neutral check, ratification and objections, and what is
     still open.
   - **Problems during the run**, such as a seat that failed, Codex or agy blocked by the sandbox,
     or a Gemini turn that agy cut short.
3. **The scorecards.**
4. **What the spot-check found.**
5. **A suggested commit message** (implement mode), written by the main session from the final
   diff in the repository's own style: concise, one imperative subject line, a body only when
   needed. It describes the change itself, with no references to plan documents, to the
   council, or to models, and no attribution lines. If the author committed (the task asked for
   commits), the main session cherry-picks those commits instead of applying the diff.
6. **The process retro** (`retro.markdown`): what the council suggests changing in this
   workflow. It's about the council workflow itself, not your project; see below.

If the council stops to ask you a question, you get the debate so far with it.

Nothing touches your tree until you approve; then the final diff is applied with `git apply`.

    dark-factory usage   --run-dir <runDir>   # tokens: Codex and Gemini per model, Claude agents per model and role
    dark-factory jobs    --run-dir <runDir>   # job status, for debugging
    dark-factory cleanup --run-dir <runDir>   # drop worktrees + refs, keep the room
    dark-factory cleanup --run-dir <runDir> --all

## Process retro

For now, while the workflow is being tuned, each run reviews its own process. Turn it off with
`retro: false`.

- **Notes during the run, not a retro at the end.** Every agent's output has a `process` field:
  at most two sentences on what in that turn's instructions, inputs or tools got in its way,
  naming the instruction or input, or `""`. That covers seats, checkers, the panel, relays,
  setup and question clustering. Notes are taken as they happen because Claude seats are fresh
  agents each turn and wouldn't remember an earlier turn at the end.
- **One retro agent** (Sonnet) gets the notes, facts the script computed, and the report. The
  facts cover turns per role, turns that returned nothing, relay attempts that failed, posts
  over the length limit, the ledger, and problems during the run. It can open the room, the
  Codex job logs and the workflow source. It weighs the notes instead of counting them,
  discounting requests for more of everything and the losing seat's complaints about scoring.
  It returns up to 3 things to keep and 3–5 concrete changes, each tied to evidence from the run.
- **Saved outside the run**, since `cleanup --all` deletes it. The agent writes
  `<run>/retro.md`, then `dark-factory retro` copies it to `retros/<runId>-<repo>.md` in this repo when the
  plugin is installed from a checkout (gitignored), otherwise under `~/.claude/dark-factory/retros/`. It attaches the exact notes and facts, read from the retro agent's saved
  transcript and hash-checked, as `seat-run` does for relays. If the sandbox blocks the write,
  the agent reruns the command outside it, which the allow rule permits.

One note is a lead and the same note across turns or runs is a pattern, so read `retros/`
across several runs before changing anything. Transcripts still explain a failure better than
any note: no seat would have diagnosed the relay indentation bug.

## Install and test

    ./install.sh                 # once: builds from src/, installs this checkout as the plugin, removes pre-plugin copies
    make build                   # after editing src/; then /reload-plugins or a new session (the plugin is read live)
    make check                   # all code, host, and installer gates; no models or installed Claude plugin required
    make installed               # separately check that the local Claude plugin is this checkout
    make hooks                   # run `make check` before every commit (there is no remote for CI)

The pieces of `make check`:

    node test/sim.mjs            # the real script against stub agents, and bin/dark-factory against a stub agy and real git; 27 scenarios
    SIM_ONLY=scenarioBallot,scenarioMeasure node test/sim.mjs   # just those
    node --test test/logic.mjs test/pair.mjs # decision logic and Pair scenarios through both hosts
    node --test test/host-logic.mjs test/codex-runner.mjs test/codex-install.mjs # Codex routing, runner, and installation with stub CLIs
    python3 -B -m unittest discover -s test -p 'test_*.py'      # bin/dark-factory's pure functions
    node test/static.mjs         # scripts parse, `meta` is a plain literal, src/lib stays pure
    node test/hash-parity.mjs    # the JS and Python prompt hashes agree
    node tools/build.mjs --check # the built workflows are what src/ builds to

**Prompt golden files.** `test/golden/<run>/<kind>.txt` holds the rendered prompt of each kind
(setup, solve, debate, checker, panel, ratify, relay and so on) for fixed scenarios, and the
sim compares against them. The prompts are the product, so a change to one shows up as a
failure naming the line. After an intended change, run `UPDATE_GOLDEN=1 node test/sim.mjs` and
read `git diff test/golden` before committing. The CLI's polling intervals can be shortened
for tests with `COUNCIL_JOB_POLL`, `COUNCIL_TRANSCRIPT_POLL` and `COUNCIL_TRANSCRIPT_WAIT`.

`plugins/dark-factory/workflows/ensemble.js` is generated from the shared sources, like the other workflows.

Requirements: Claude Code with the Workflow tool, the `codex` CLI and the Antigravity CLI
(`agy`) logged in, `python3`, and `git`. Implement mode needs a repository with at least one
commit. Without one of the CLIs, pick a lineup without its seats.

**Permission (required for Codex and Gemini seats).** Neither CLI can run inside Claude Code's
Bash sandbox: each writes to its home directory (`~/.codex`, `~/.gemini`) as it starts, and
needs the network. `dark-factory seat-run` detects
this; the relay runs the command outside the sandbox from the first try. That needs an allow
rule in `~/.claude/settings.json`, which also stops the relay and checker agents prompting:

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

Per the Claude Code docs, an allow rule also approves running the commands it matches outside
the sandbox, and it applies before auto mode's classifier. Without it, setup's preflight
finds the CLI stuck in the sandbox and stops the run before any seat starts, saying how to fix
it or which seat to swap.

**agy settings (required for Gemini seats).** Headless agy can't ask for permission, so it
denies every command and file edit unless `~/.gemini/antigravity-cli/settings.json` has
`"toolPermission": "proceed-in-sandbox"`. Commands then run without prompting inside agy's
sandbox, which has no network and can only write where a grant allows. This setting is global,
so it applies to interactive agy sessions too; `seat-run` refuses to start a Gemini turn without
it. `seat-run` adds the one grant a run needs, `write_file(<repo>/.council)`, the first time a
repository has a Gemini seat.

## Gotchas

- On macOS every helper job and every standalone run starts `caffeinate -i -w <pid>`, so idle
  sleep doesn't stall a long measurement or CLI turn; it exits when the job does. `-i` prevents
  idle sleep only: closing the lid still sleeps the machine. Set `DARK_FACTORY_KEEP_AWAKE=0` to
  turn it off.
- agy reports `SUCCESS` with exit code 0 in several failures, so `bin/dark-factory` checks every
  Gemini result. It catches:
  - a command or edit it denied, which ends the turn. The runner resumes the conversation once,
    saying so; a second denial fails the turn. The usual cause is git: a worktree keeps its git
    data under the main checkout, which agy's sandbox can't read, so a seat that runs git asks
    to leave the sandbox. Gemini seats are told not to run git and never to ask;
  - an unknown conversation id, where agy quietly starts a new conversation;
  - a resumed turn answered in plain text, where agy hands back the *previous* turn's
    structured output. The runner asks once, in the same conversation, for structured output,
    and fails the turn if it still doesn't match the schema.
- agy's sandbox blocks shell writes anywhere under the directory agy starts in, and from inside
  the repository it blocks even reads under `.council/`. So a Gemini seat starts in an empty
  directory under `$TMPDIR/council-agy/`, and its prompt names the worktree by absolute path.

- A Codex or Gemini turn that fails because the model is at capacity or rate-limited is retried
  once, after 90 seconds, inside the job. A used-up quota is not retried: swap the vendor's
  seats out with `--seats`.
- Projects often gitignore their `CLAUDE.md`, so a worktree checked out from HEAD wouldn't have
  it. `dark-factory init` copies an ignored `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` or `GEMINI.md`
  into each worktree, and snapshots leave them out of the diffs. Project-specific tool tips
  (memory limits, cache paths) belong there.
- Seats are told to run tests and gates themselves, with output going to a log, and that a
  CLAUDE.md rule to delegate gate runs to a subagent is meant for the main session. Seats have
  no subagents, and `claude -p` can't log in from a Codex or agy sandbox.
- In the Claude host, a question answered mid-run counts only from the round after it was
  escalated, so the resumed run replays earlier rounds from cache. The Codex host starts a new
  run: append each full question and answer to `context`, since question IDs can change.
- `codex exec` waits forever on an open stdin pipe. `bin/dark-factory` always feeds it a file.
- Ignored dependency directories (`vendor/`, `node_modules/`) are copied into each worktree
  with APFS clones (`cp -c`), not symlinked. A symlinked `vendor/` makes Composer autoload the
  *main* tree's classes.
- Cost: roughly 30–50 agent turns per run at the defaults. On the toy smoke test below, a Codex
  turn used 74–101k input tokens (65–78% cached), nearly all of it Codex's own fixed overhead:
  the whole room was about 5k tokens. That run used 22 agents, about 840k Claude subagent
  tokens, and 525k Codex input tokens (6k output) over six Codex turns, and took 4.3 minutes.
- `codex exec resume` reports usage as the thread's running total, not the turn's.
  `bin/dark-factory` subtracts the previous total, so `dark-factory usage` is per turn.

## Smoke test, 2026-10-11

On a toy `median()` bug (even-length lists wrong; the function also sorts the caller's list in
place), with all four seats at `effort: 'low'` and `rounds: 1`:

- Setup wrote five criteria before any seat started.
- All four fixes passed every published test.
- The seats split on a genuine judgment call, which they recorded as judgment, not as a defect:
  - Astra and Sol kept the in-place sort ("out of scope").
  - Opus and Sonnet sorted a copy.
- The 2–2 vote went to the scorecard, which ranked Opus's position first.
- Opus wrote the final version and adopted Astra's extra tests.
- All three others endorsed it, with their preference recorded as dissent.
