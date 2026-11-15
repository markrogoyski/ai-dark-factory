# Pinning the engine for a self-update

[Documentation index](README.md) · [Project README](../README.md)

When dark-factory works on its own source, the change under review could alter the engine that
is running the review. Pinning prevents that: the standalone runner executes a frozen export of
the committed plugin, kept outside the source checkout, the candidate repository and every seat's
write grants, so nothing a seat writes can change the executor.

```sh
node plugins/dark-factory/bin/dark-factory-codex --pin-engine /path/to/frozen-engine --cwd /path/to/candidate --workflow pair "Implement the change"
```

- **Choose the directory** by name, somewhere whose parents seats cannot write, including their
  implicit `/tmp` and `$TMPDIR` grants. A temporary root that overlaps a grant refuses before
  anything is probed or written.
- **Commit first.** The export is built from the source checkout's HEAD, so commit the generated
  plugin files (`make build`) before pinning; dirty, untracked or ignored shipped files refuse.
  The export holds `plugin/` and an external `manifest.json` whose digest covers the whole
  shipped plugin. Keep both. Reading Codex settings needs Python 3.11+.
- **What refuses.** Anything the admission policy can't account for stops the run before work
  starts, with redacted diagnostics on stderr: provider settings, plugins, hooks or MCP servers
  that could run code or widen write access; managed or unknown policy sources; Gemini seats
  (agy pinning is unsupported); and Run-plan, which pinning does not support. Unpinned runs are
  unaffected by these checks.
- **Reuse and relocation.** Pointing at an existing export validates and reuses it as the
  executor, even when the invoking checkout has moved on; it never promotes the candidate. A
  complete export can be moved: pass the new directory on resume. Publication is an exclusive
  rename, so the destination is either absent or complete, and nothing existing is replaced.
- **Resume** requires the same package, runtime and revision exactly. Drift refuses and keeps the
  earlier artifacts and spent usage; an unpinned run can't switch to pinning midway.

Pinning is not a sandbox. It protects the executor from the candidate, not from a malicious
account or interpreter owner, and publication guarantees atomic visibility, not durability
across a power loss. It installs nothing and changes no account settings.

The full admission policy (provider settings, plugin components, Codex profiles, the import and
builtin rules, and resume compatibility) is in
[Engine pinning: admission reference](engine-pinning-reference.md).
