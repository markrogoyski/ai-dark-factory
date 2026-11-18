# Running in Codex

[Documentation index](README.md) · [Project README](../README.md)

The skill runs the same factory/council JavaScript through a local Node runner. Routing,
escalation, verification, scoring and readiness stay in the shared engine; each model turn is a
separate CLI session the runner starts directly, with bounded concurrency and no Claude relay
agents. All four factory tiers, Pair, Council, Ensemble and Run-plan run on it.

## Requirements

Node, Python 3, Git, and authenticated `codex` and `claude` CLIs (the default Codex profile has
a Claude Opus seat; pass `--seats astra,sol` for an OpenAI-only run). Gemini seats also need
`agy`; OpenRouter seats (`openrouter:<model-id>`) need `claude` and `OPENROUTER_API_KEY`. Each
CLI keeps its normal permission controls.

Defaults: Simple uses Astra to implement and a fresh Astra session to review; Fix, Feature and
Architecture use Opus, Astra and Sol seats. [Choosing the models](models.md#defaults) lists every
role on both hosts, and the `roles` option for orchestration roles.

## Running without the skill

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

| Option | Effect |
|---|---|
| `--concurrency N` | bounds simultaneous model turns |
| `--timeout-min N` | sets turn deadlines |
| `--output result.json` | saves an extra copy of the final JSON |
| `--resume HOST_RUN_DIR` | replays validated completed operations and continues a saved checkpoint ([Process controls](process-controls.md#resume)); without it a rerun starts a new host run |

Progress goes to stderr, the final result to stdout. Each run keeps its arguments, events and
result in `hostRunDir` under the repository's `.council/`; `runDir` identifies the factory's
worktrees and evidence. Exit 0 is a completed ready result, 2 a decision or unresolved
readiness, 1 an execution failure. Check `final.readiness`, not just `status`.

The skill handles `needs-plan`, `needs-tier`, `needs-split` and `needs-user` as
[the factory](factory.md) describes. Seat sessions persist across turns within a run, and the
reviewed change stays in its worktree until delivered. Architecture returns reviewed milestones
and doesn't build them.

## Host-specific behavior

- **Denied tool calls.** A completed Claude turn with valid output can proceed after one. The
  report and host events keep the denial, linking to its details in the job's `out.json`. Denied
  checks never count as passing evidence; verification and independent review still decide
  readiness.
- **Missing structured output.** A solve or debate turn that fails after writing its post can be
  recovered once by resuming its saved session: read-only, low effort, three-minute deadline (or
  the original, if shorter). It needs a saved session, a nonempty post written during this turn,
  and an eligible error: authentication, quota, cancellation, sandbox, model and leak failures
  skip recovery. If recovery fails, the turn fails.
- **Headless seats can't grant permissions.** Their instructions require Edit/Write for file
  changes, foreground commands and no sleep polling.
- **No auto memory.** Headless Claude processes run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  resumed turns and fresh reviewers included. Claude's [auto memory is shared across
  worktrees](https://code.claude.com/docs/en/memory#storage-location); this keeps project notes
  out of independent sessions without changing account settings.
- **Pair baseline.** Pair's setup here is a sandboxed turn (workspace-write, no network), so it
  doesn't measure the baseline. The engine has the runner, which runs outside the models'
  sandboxes, measure the base revision with the run's `verify.sh` and `verification.json`, and
  uses that result. Setup is told not to add overrides for failures it sees only inside its
  sandbox, such as a refused socket bind; overrides the gate ran with appear in
  `final.suite.overrides` and the report. Council and the factory tiers still measure their
  baseline from the setup turn. See [Pair](pair.md).
