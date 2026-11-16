# Engine pinning: admission reference

[Documentation index](README.md) · [Project README](../README.md) · [Pinning the engine](engine-pinning.md)

The rules a pinned run checks before and during work. Anything not listed as supported refuses.
[Pinning the engine](engine-pinning.md) covers when and how to use it.

## Export and package identity

A new export reads Git blobs and modes from the source checkout's HEAD; dirty, untracked or
ignored shipped inputs refuse. The export contains `plugin/` and an external `manifest.json`.
Its versioned SHA-256 digest covers the **whole shipped plugin** (workflow, helper, runner,
parser, publication adapter and schema bytes) by raw relative path, content and Git mode,
including symlink targets. Escaping or unresolved links refuse; legitimate internal symlinks are
supported. No installation is performed.

Publication builds and validates a private sibling staging directory, then performs a native
exclusive rename. The public destination is absent or complete; existing files, directories and
symlinks are never replaced. Platforms or filesystems without an exclusive rename refuse. A crash
may leave private staging for inspection; retries do not sweep staging owned by other
invocations. This guarantees atomic visibility, not power-loss durability.

Every regular export file and its external manifest must be owned by the effective user and have
exactly one hardlink. Exports create independent files from committed blobs. Publication, reuse
and guarded validation read through checked no-follow descriptors and refuse added links without
deleting an existing export or its evidence. Subprocesses explicitly close extra inherited
descriptors or pass only stdin, stdout and stderr; workspace and linked-worktree Git access stay
available. These checks do not establish an atomic filesystem or policy boundary, and do not
protect against every alias race, IPC channel or account owner.

The same package guards helper calls, detached jobs, checkpoints, delivery and authoritative
evaluation. Package, runtime or evidence drift refuses and preserves earlier artifacts and spent
usage. Executor context stays in control processes; candidate checks run candidate bytes as their
subject without replacing the executor.

## Provider admission

Admission requires only the providers the configuration can reach. Pair checks its author and
reviewer; Ensemble also checks its comparison and review models, in implement and investigate
modes alike; Factory includes intake, permitted strategies, tiers, escalation and conditional
control roles. Task prose never selects a provider. Concrete seats are checked again at
execution, retry, tool and resume boundaries. This narrowing applies only to pinned adapter
admission and preflight, not to native prompts or ordinary preflight.

Provider settings are interpreted by shared typed policy, with read-only adapter observations:

| Provider | Supported ordinary inputs | Conservative limits |
| --- | --- | --- |
| Codex | Model/reasoning/personality/TUI presentation; project trust; selected inline user profiles; sandbox root lists; approval routing | Invocation pins escalation to `never`. Only trusted project layers apply. Unknown executable features, hooks, MCP and custom providers refuse. Mandatory requirements must allow the invocation. Nonempty default rules/plugin activation sources and hook files refuse until their executable policy is supported. Separate named-profile files refuse until their precedence is supported. |
| Claude | Model/effort/theme presentation; permission rules, bounded file patterns and additional directories; inspected enabled plugins | Explicit tool list, mandatory Bash sandbox, slash-command disabling and strict empty MCP configuration apply per invocation. Unknown startup capabilities refuse. |
| OpenRouter | Observed as the Claude CLI plus its endpoint base URL, which is part of the hashed security object. Its only user layer is the seat's run-owned configuration directory (`settings.json`, `.claude.json` and plugins there); `~/.claude`, `$CLAUDE_CONFIG_DIR` and `~/.claude.json` are never read | As for Claude. An empty `allowedTools` list for the worktree in that directory's `.claude.json` adds no layer (it grants nothing); any other entry is observed as for Claude. |
| agy | Conservative directory/write-rule interpretation for observations | Production pinning is unsupported; no account grants are created. |

Known temporary-root overlap refuses before provider probes, settings reads or export writes.
Relative grants conservatively include their config-directory, working-directory and repository
bases; project Codex paths use the documented `.codex/` base. Default, Git and temp grants stay
in the possible write-root union; deny rules do not subtract them.

User and project MCP files and legacy project MCP grants are observed in addition to plugin
manifests. Managed Claude drop-in directories are unsupported, including empty ones. Unreadable
sources and unknown versions report the redacted provider and source categories that prevented
admission. Mutable mandatory executable policy cannot be made safe by a blocking ConfigChange
hook and refuses. Opaque or unavailable enforcement facts refuse. The local version probe cannot
establish that no server or MDM policy is delivered, so production Claude pinning refuses on that
unknown. The offline bounded observations establish policy and adapter behaviour, not account
enforcement. ConfigChange requires the documented 2.1.49+ hook family. No managed controls are
overridden.

Typed observation support includes Codex notice acknowledgements and migration maps, plugin
activation maps and marketplace source descriptors, plus Claude's renderer, auto-mode rule object
and marketplace source variants. Notice and renderer changes are presentation. Auto-mode rules
are inactive only under the invocation's fixed plan/acceptEdits permission mode; unknown
transitions refuse. Activation, catalog sources and executable components stay security-relevant.
A typed catalog is not proof that refresh is bounded: unavailable refresh or activation
observations, active unresolved Codex plugins, MCP overrides and command or header helpers refuse
specifically. Inspection never fetches or executes a catalog. Bounded offline component fixtures
do not establish production plugin support.

## Claude plugins

An enabled dark-factory-shaped Claude plugin can contain `bin/`, `lib/`, `schemas/`, native
workflows, skills, commands, agents and output styles. Passive executables can run only through
bounded Bash. Native workflow tools and delegation are absent, and slash commands and skills are
disabled for the pinned invocation. Pure style instructions are presentation. Active arbitrary
command hooks, MCP/LSP processes, startup agents, credential helpers and unresolved components
refuse; inspection never executes plugin scripts. Pinned status-line commands are replaced by a
no-op. The adapter's own N/job-bound PreToolUse and ConfigChange guards are required engine code;
source settings cannot claim their origin or gain an exemption by copying their command text.

Pinned headless Claude blocks failed validation with exit 2 and prefixes the frozen helper's
`bin` in the actual Bash input, including after provider-side PATH replacement. A synchronous
ConfigChange guard also checks substantive non-managed reloads. Claude's shell sandbox does not
contain arbitrary hooks or helper processes, so the refusals above remain necessary.

## Codex profiles

Codex project profile definitions cannot narrow user grants. Every profile definition in an
applicable trusted project layer contributes its write roots to a conservative union and is
checked for unsupported executable or security keys, even when the project selects another
profile or no user profile is selected. This does not attest Codex's profile merge semantics.
Untrusted project layers are inapplicable; inactive user profiles stay outside the selected
profile. Project Codex settings cannot select or redefine user profiles to hide write grants.

## Settings identity and invalidation

Settings identity uses a versioned canonical effective security projection; raw source hashes
remain provenance. Formatting, key order and unrelated presentation edits keep compatibility.
Changes to write bounds, permission capabilities, trust or source applicability, executable
plugin bytes or modes, activation, or guard enforcement invalidate the admission. Every boundary
rereads sources.

A persistent approval that changes watched security settings or capabilities invalidates a
running job; a one-time approval that writes no watched input does not. Invalidation preserves
the earlier evidence and usage and requires a compatible executor and inputs or a new run, never
a reset.

Admission emits redacted watched-source, role and capability diagnostics to stderr before
provider probes, followed by admission or refusal before work starts. Source scopes and ordinal
labels identify watched inputs without printing paths, setting values, commands, headers or
credentials. Unknown capabilities are refusals.

## Import closure

Import closure is parsed as JavaScript. Supported forms are static imports and re-exports,
literal dynamic imports, direct CJS literal `require`, and the canonical ESM
`import {createRequire} from 'node:module'` with `const require = createRequire(import.meta.url)`.
Local targets must be explicit inventoried files. Validation distinguishes ESM file URLs from
literal CJS paths: it checks actual decoded in-package ESM targets and explicit CJS files, and
keeps literal percent-directory names. Query, fragment, computed, attribute/loader and
unsupported external dependency forms refuse, as does unsupported grammar within the covered
forms. Inert prompt, comment and template text contributes no dependencies; executable template
expressions are checked. The package has no `package.json`; adding an ancestor module-type
override is outside the supported layout.

## Builtins and globals

Only the exact builtins `child_process`, `crypto`, `fs`, `module`, `os`, `path` and `url` are
admitted, with an optional `node:` prefix and no subpath wildcard. `module` permits only
side-effect imports or static named `createRequire`/`isBuiltin` imports. Module-object
acquisition, renamed factories, loader aliases, exports or rebinding, and unsupported indirect
calls refuse.

The CJS wrapper's `require` permits only direct literal calls; wrapper `module` permits only
`module.exports` and `typeof module`; wrapper-resolving `arguments` refuses, including through
arrows. Wrapper-scope declarations, redeclarations and binding writes of `require`, `module`,
`exports` or `arguments` refuse, including block or loop `var` and writes from closures. Genuine
nested locals, ordinary-function `arguments` and `exports` property writes are supported.
Executable `with` always refuses.

Process carriers, including known global aliases, admit only the statically named members `argv`,
`env`, `exitCode`, `execPath`, `on`, `once`, `removeListener`, `kill`, `pid`, `stdout`,
`stderr`, `version`, `geteuid` and `cwd`. Process-object escape and other or computed members
refuse; `process.env[key]` is supported. Executable `eval`/`Function` references and
`getBuiltinModule` members refuse. `worker_threads` acquisition refuses.

## Limits of the analysis

This static subset is not a proof of arbitrary-JavaScript capability. Reflective constructor,
global or wrapper recovery (function-level `this`, constructor chains, caller/callee, stack
recovery) and dependencies created by generated code are outside it. Both runners evaluate
inventoried workflow source as sloppy `AsyncFunction` bodies, while the validator parses it as
modules, so top-level `this` can be global at execution; that falls under the function-level
`this` exclusion. Legitimate `child_process` launches, the admitted signals (`kill`/`pid`),
environment access with subprocesses and network globals are not confinement mechanisms, and
these checks do not prove process or worker confinement. The initiating adapter supplies the
parser, never an unvalidated inspected export; live bootstrap reuse keeps its initiating trust
root until the validated executor is re-executed.

Neither the hashes nor these controls defend against a malicious account or interpreter owner.
Configuration support is limited and does not establish authentication, host approval or live
enforcement. Offline regressions use temporary repositories, stub CLIs and explicitly catalogued
raw observations; there is no production test profile. Offline validation adds measurable
overhead to guarded calls and to pause and resume.

## Resume compatibility

Ordinary live resume requires identical package inputs but tolerates incidental Node, Python or
Git version differences; observed versions remain provenance. Pinned resume requires strict
runtime, revision and package equality. Whole-package fingerprints are incompatible with older
checkpoints that used a different fingerprint or package: keep their original compatible plugin
or executor and artifacts to inspect or resume them. Nothing migrates, rewrites or resets old
evidence. Legacy results stay readable; an active unpinned run cannot migrate into pinning.
Relocated pins keep their earlier locations and compare cache entries by package identity rather
than pathname.

## Provider documentation

[Codex configuration](https://developers.openai.com/codex/config-reference/),
[Claude permissions](https://code.claude.com/docs/en/permissions),
[plugin components](https://code.claude.com/docs/en/plugins-reference),
[CLI controls](https://code.claude.com/docs/en/cli-reference),
[hooks](https://code.claude.com/docs/en/hooks) and
[sandbox scope](https://code.claude.com/docs/en/sandboxing).
