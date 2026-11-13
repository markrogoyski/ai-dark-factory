# Running in Codex

[Documentation index](README.md) · [Project README](../README.md)

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

Simple uses Astra to implement and a fresh Astra session to review. Fix, Feature and
Architecture use Opus, Astra and Sol seats. Orchestration roles can be changed through
`roles`, for example `{"intake": "sol", "checker": {"model": "astra", "effort": "high"}}`.

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
factory decisions described in [The factory](factory.md). Reruns normally start a new host run. Use `--resume HOST_RUN_DIR` to replay validated completed operations and continue a saved checkpoint; see [Process controls](process-controls.md). Seat sessions persist across turns within a run.
The reviewed change stays in its worktree until delivered to the main checkout. Architecture
returns reviewed milestones and does not automatically build them.
