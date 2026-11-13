# Gotchas

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
- Cost: roughly 30–50 agent turns per run at the defaults. On the toy [smoke test](council.md#smoke-test-2026-10-11), a Codex
  turn used 74–101k input tokens (65–78% cached), nearly all of it Codex's own fixed overhead:
  the whole room was about 5k tokens. That run used 22 agents, about 840k Claude subagent
  tokens, and 525k Codex input tokens (6k output) over six Codex turns, and took 4.3 minutes.
- `codex exec resume` reports usage as the thread's running total, not the turn's.
  `bin/dark-factory` subtracts the previous total, so `dark-factory usage` is per turn.

