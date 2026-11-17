# Gotchas and troubleshooting

[Documentation index](README.md) · [Project README](../README.md)

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
- A Codex, Gemini or OpenRouter turn that fails because the model is at capacity or rate-limited
  is retried once, after 90 seconds, inside the job. A used-up quota is not retried: swap the
  vendor's seats out with `--seats`. An OpenRouter seat is classed by OpenRouter's HTTP status:
  401, 402 and an unknown model end it, 429 and 5xx are retried.
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
- Claude's own sandbox refuses to write files such as `.gitmodules` anywhere, so when the
  standalone runner's Claude setup turn runs `dark-factory init` and copying an ignored
  dependency directory hits one, init leaves those files out and names each on stderr.
- `codex exec resume` reports usage as the thread's running total, not the turn's.
  `bin/dark-factory` subtracts the previous total, so `dark-factory usage` is per turn.

## Troubleshooting

- **Start with the run's own record.** `final.readiness` and the report's "Problems during the
  run" section name most failures; [Reading a result](results.md) explains the statuses.
  `dark-factory jobs --run-dir <runDir>` lists every Codex, Gemini, OpenRouter and measurement job with its
  status, and each job's `<runDir>/jobs/<key>/` holds its prompt, `status.json`, `out.json` and stderr.
  `dark-factory usage --run-dir <runDir>` shows tokens per model and role.
- **An agent or relay "returned nothing".** In Claude Code the cause is in the workflow's state
  file, not the run directory: `~/.claude/projects/<project>/<session-id>/workflows/wf_<id>.json`.
  Its `workflowProgress[]` entries with `state: "error"` carry the `error` text, for example
  `blocked by safety classifier`, with `blocked: true`. A blocked agent leaves no transcript,
  and a blocked relay leaves no `jobs/<key>/` directory, because the vendor CLI never ran; don't
  read that as a Codex, Gemini or OpenRouter failure.
- **A Codex, Gemini or OpenRouter seat fails at once.** Run `--prepare` (Codex host) or check the
  `Bash(dark-factory:*)` allow rule and the agy settings under
  [Installing](install.md#permission-required); setup's preflight names the
  CLI it couldn't start.
- **A resume is refused.** Resume checks the engine, HEAD, tracked changes, reference bytes and
  saved evidence, and refuses on any mismatch rather than reset; start a new run, carrying any
  answers in `context`. See [Process controls](process-controls.md#resume).
