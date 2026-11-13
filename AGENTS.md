# Repository instructions

Read [CLAUDE.md](CLAUDE.md) for the shared editing, generation, verification, and commit
conventions. They apply to changes made through either host. The README documents installation for
both Claude Code and Codex, and `docs/` documents user-facing behavior.

- Keep factory decisions in the shared `src/` engine. Add host-specific execution to the runtime
  adapter; preserve the existing Claude behavior when the Codex host is absent.
- The Codex runner, helper, and skill all ship under `plugins/dark-factory/`. The skill's launcher
  resolves its runner relative to the installed skill; do not embed a checkout or user-home path.
- Keep the independent attempts, separate worktrees, fresh review contexts, and code-enforced
  readiness rules when changing either runtime.
- Test process execution and installation with temporary repositories and stub CLIs. Ordinary
  regression checks must not consume model calls or change account settings.
