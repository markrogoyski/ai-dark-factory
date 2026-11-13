# Pinning the engine for a self-update

[Documentation index](README.md) · [Project README](../README.md)

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
