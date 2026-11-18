# Engine pinning: admission reference

[Documentation index](README.md) · [Project README](../README.md) · [Pinning the engine](engine-pinning.md)

The rules a pinned run checks before and during work. Anything not listed as supported refuses.
[Pinning the engine](engine-pinning.md) covers when and how to use it.

## Export and package identity

- **Source.** A new export reads Git blobs and modes from the source checkout's HEAD. Dirty,
  untracked or ignored shipped inputs refuse. Nothing is installed.
- **Contents.** `plugin/` and an external `manifest.json`. Its versioned SHA-256 digest covers the
  **whole shipped plugin** (workflow, helper, runner, parser, publication adapter, schemas) by raw
  relative path, content and Git mode, including symlink targets. Escaping or unresolved links
  refuse; internal symlinks are supported.
- **Publication.** Built and validated in a private sibling staging directory, then published with
  a native exclusive rename: the destination is absent or complete, and existing files,
  directories and symlinks are never replaced. A filesystem without exclusive rename refuses. A
  crash may leave staging for inspection; retries don't sweep staging owned by other invocations.
  This is atomic visibility, not power-loss durability.
- **Files.** Every regular export file and its manifest must be owned by the effective user and have
  exactly one hardlink. Reads use checked no-follow descriptors; added links refuse without
  deleting an existing export or its evidence. Subprocesses close extra inherited descriptors or
  pass only stdin, stdout and stderr. This is not an atomic filesystem or policy boundary and
  doesn't cover every alias race, IPC channel or account owner.
- **Guarded operations.** The same package guards helper calls, detached jobs, checkpoints, delivery
  and authoritative evaluation. Package, runtime or evidence drift refuses and keeps earlier
  artifacts and spent usage. Candidate checks run candidate bytes without replacing the executor.

## Provider admission

Admission requires only the providers the configuration can reach: Pair's author and reviewer;
Ensemble's seats plus its comparison and review models (both modes); Factory's intake, permitted
strategies, tiers, escalation and conditional control roles. Task prose never selects a provider.
Concrete seats are checked again at execution, retry, tool and resume boundaries. This narrowing
applies only to pinned admission and preflight, not to native prompts or ordinary preflight.

| Provider | Supported ordinary inputs | Conservative limits |
| --- | --- | --- |
| Codex | Model, reasoning, personality and TUI presentation; project trust; selected inline user profiles; sandbox root lists; approval routing | Invocation pins escalation to `never`. Only trusted project layers apply. Unknown executable features, hooks, MCP and custom providers refuse. Mandatory requirements must allow the invocation. Nonempty default rules, plugin activation sources, hook files and separate named-profile files refuse until their policy is supported. |
| Claude | Model, effort and theme presentation; permission rules, bounded file patterns and additional directories; inspected enabled plugins | Explicit tool list, mandatory Bash sandbox, slash-command disabling and strict empty MCP configuration apply per invocation. Unknown startup capabilities refuse. |
| OpenRouter | Observed as the Claude CLI plus its endpoint base URL (part of the hashed security object). The only user layer is the seat's run-owned configuration directory (`settings.json`, `.claude.json`, plugins); `~/.claude`, `$CLAUDE_CONFIG_DIR` and `~/.claude.json` are never read | As for Claude. An empty `allowedTools` list for the worktree in that directory's `.claude.json` adds no layer; any other entry is observed as for Claude. |
| agy | Conservative directory and write-rule interpretation | Production pinning is unsupported; no account grants are created. |

**Write roots and sources**

- A known temporary-root overlap refuses before provider probes, settings reads or export writes.
- Relative grants include their config-directory, working-directory and repository bases; project
  Codex paths use the `.codex/` base. Default, Git and temp grants stay in the possible write-root
  union; deny rules don't subtract them.
- User and project MCP files and legacy project MCP grants are observed alongside plugin manifests.
- Managed Claude drop-in directories are unsupported, even empty ones.
- Unreadable sources and unknown versions report redacted provider and source categories.

**Enforcement facts**

- Mutable mandatory executable policy can't be made safe by a blocking ConfigChange hook and
  refuses, as do opaque or unavailable enforcement facts.
- The local version probe can't show that no server or MDM policy is delivered, so production Claude
  pinning refuses on that unknown. Offline observations establish policy and adapter behaviour, not
  account enforcement.
- ConfigChange needs the 2.1.49+ hook family. No managed controls are overridden.

**Typed observations** cover Codex notice acknowledgements, migration maps, plugin activation maps
and marketplace source descriptors, and Claude's renderer, auto-mode rule object and marketplace
source variants.

- Notice and renderer changes are presentation. Activation, catalog sources and executable
  components stay security-relevant.
- Auto-mode rules are inactive only under the invocation's fixed plan/acceptEdits permission mode;
  unknown transitions refuse.
- Unavailable refresh or activation observations, active unresolved Codex plugins, MCP overrides,
  and command or header helpers refuse. Inspection never fetches or executes a catalog.

## Claude plugins

An enabled dark-factory-shaped plugin can contain `bin/`, `lib/`, `schemas/`, native workflows,
skills, commands, agents and output styles.

- Passive executables run only through bounded Bash. Native workflow tools and delegation are
  absent; slash commands and skills are disabled. Pure style instructions are presentation. Pinned
  status-line commands become a no-op.
- **Refuse:** active arbitrary command hooks, MCP/LSP processes, startup agents, credential helpers
  and unresolved components. Inspection never executes plugin scripts. Claude's shell sandbox
  doesn't contain arbitrary hooks or helper processes, hence these refusals.
- The adapter's own N/job-bound PreToolUse and ConfigChange guards are required engine code; source
  settings can't claim their origin or gain an exemption by copying their command text.
- Pinned headless Claude blocks failed validation with exit 2 and prefixes the frozen helper's `bin`
  in the actual Bash input, even after provider-side PATH replacement. A synchronous ConfigChange
  guard checks substantive non-managed reloads.

## Codex profiles

Project profile definitions can't narrow user grants. Every profile definition in an applicable
trusted project layer adds its write roots to a conservative union and is checked for unsupported
executable or security keys, even when the project selects another profile or none. This doesn't
attest Codex's profile merge semantics. Untrusted project layers are inapplicable, inactive user
profiles stay outside the selected profile, and project settings can't select or redefine user
profiles to hide write grants.

## Settings identity and invalidation

Identity is a versioned canonical effective security projection; raw source hashes are provenance.
Formatting, key order and unrelated presentation edits keep compatibility. Changes to write bounds,
permission capabilities, trust or source applicability, executable plugin bytes or modes,
activation, or guard enforcement invalidate the admission. Every boundary rereads sources.

A persistent approval that changes watched security settings or capabilities invalidates a running
job; a one-time approval that writes no watched input doesn't. Invalidation keeps earlier evidence
and usage and needs a compatible executor and inputs or a new run, never a reset.

Before work starts, admission prints redacted watched-source, role and capability diagnostics to
stderr, then the admission or refusal. Source scopes and ordinal labels stand in for paths, values,
commands, headers and credentials. Unknown capabilities refuse.

## Import closure

Import closure is parsed as JavaScript.

- **Supported:** static imports and re-exports; literal dynamic imports; direct CJS literal
  `require`; and the canonical ESM `import {createRequire} from 'node:module'` with
  `const require = createRequire(import.meta.url)`. Local targets must be explicit inventoried
  files (ESM file URLs are decoded and checked as in-package targets; literal percent-directory
  names are kept).
- **Refuse:** query, fragment, computed, attribute/loader and unsupported external dependency
  forms, and unsupported grammar within the covered forms.
- Inert prompt, comment and template text adds no dependencies; executable template expressions are
  checked.
- The package has no `package.json`; an ancestor module-type override is outside the supported
  layout.

## Builtins and globals

- **Builtins.** Only `child_process`, `crypto`, `fs`, `module`, `os`, `path` and `url`, with an
  optional `node:` prefix and no subpath wildcard. `module` allows only side-effect imports or
  static named `createRequire`/`isBuiltin` imports. Module-object acquisition, renamed factories,
  loader aliases, exports or rebinding, and unsupported indirect calls refuse.
- **CJS wrapper.** `require` allows only direct literal calls; `module` only `module.exports` and
  `typeof module`. Refuse: wrapper-resolving `arguments` (even through arrows), and wrapper-scope
  declarations, redeclarations or binding writes of `require`, `module`, `exports` or `arguments`
  (including block or loop `var` and writes from closures). Genuine nested locals,
  ordinary-function `arguments` and `exports` property writes are supported. Executable `with`
  always refuses.
- **Process** (including known global aliases). Only the statically named members `argv`, `env`,
  `exitCode`, `execPath`, `on`, `once`, `removeListener`, `kill`, `pid`, `stdout`, `stderr`,
  `version`, `geteuid` and `cwd`. Process-object escape and other or computed members refuse;
  `process.env[key]` is supported.
- **Also refuse:** executable `eval`/`Function` references, `getBuiltinModule` members and
  `worker_threads` acquisition.

## Limits of the analysis

This static subset is not a proof of arbitrary-JavaScript capability.

- **Outside it:** reflective constructor, global or wrapper recovery (function-level `this`,
  constructor chains, caller/callee, stack recovery) and dependencies created by generated code.
  Both runners evaluate workflow source as sloppy `AsyncFunction` bodies while the validator parses
  modules, so top-level `this` can be global at execution; this falls under the `this` exclusion.
- **Not confinement:** legitimate `child_process` launches, `kill`/`pid`, environment access with
  subprocesses, and network globals.
- The initiating adapter supplies the parser, never an unvalidated inspected export; live bootstrap
  reuse keeps its initiating trust root until the validated executor is re-executed.
- Neither the hashes nor these controls defend against a malicious account or interpreter owner, and
  configuration support doesn't establish authentication, host approval or live enforcement.
- Offline validation adds measurable overhead to guarded calls and to pause and resume.

## Resume compatibility

- **Ordinary live resume** needs identical package inputs but tolerates incidental Node, Python or
  Git version differences (versions stay as provenance).
- **Pinned resume** needs strict runtime, revision and package equality.
- Checkpoints from a different fingerprint or package are incompatible with whole-package
  fingerprints: keep their original plugin or executor and artifacts to inspect or resume them.
  Nothing migrates, rewrites or resets old evidence; legacy results stay readable.
- An active unpinned run can't migrate into pinning.
- Relocated pins keep their earlier locations and compare cache entries by package identity, not
  pathname.

## Provider documentation

[Codex configuration](https://developers.openai.com/codex/config-reference/),
[Claude permissions](https://code.claude.com/docs/en/permissions),
[plugin components](https://code.claude.com/docs/en/plugins-reference),
[CLI controls](https://code.claude.com/docs/en/cli-reference),
[hooks](https://code.claude.com/docs/en/hooks) and
[sandbox scope](https://code.claude.com/docs/en/sandboxing).
