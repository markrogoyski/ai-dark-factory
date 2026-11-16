# Choosing the models

[Documentation index](README.md) · [Project README](../README.md)

## Seat names

| seat | model | runs through |
|---|---|---|
| `opus`, `sonnet`, `fable`, `haiku` | Claude | Claude Code subagents (native), `claude -p` (Codex host) |
| `astra`, `sol`, `luna` | gpt-6-astra, gpt-6.1-sol, gpt-6-luna | Codex CLI |
| `gemini` | Gemini 4 Hydrogen | Antigravity CLI (`agy`) |
| `argon` | Gemini 4 Argon (low, medium and high effort only); only when asked for | Antigravity CLI |
| `codex:<model-id>`, `gemini:<model-id>` | any model the CLI offers (`agy models` lists Gemini's) | |
| `openrouter:<model-id>` | any model OpenRouter lists, e.g. `openrouter:deepseek/deepseek-v4-pro`; only when asked for | `claude -p` against OpenRouter's Anthropic-compatible endpoint (see [OpenRouter seats](#openrouter-seats)) |

Use 2–6 seats. Consensus needs votes from at least two vendors whenever the lineup has more
than one vendor. An OpenRouter seat's vote counts toward the number of votes needed, but it
never supplies a vendor of its own: `opus, astra, openrouter:x` still needs a Claude vote and a
Codex vote, and `opus, sonnet, openrouter:x` is a one-vendor lineup for this rule.

## Defaults

The same workflow picks different defaults depending on the host that launches it.

| role | Claude Code | Codex |
|---|---|---|
| council seats | `opus`, `sonnet`, `astra`, `gemini` | `opus`, `astra`, `sol` |
| council panel | `opus`, `astra` | `astra`, `sol` |
| spec review (coverage, intent) | `astra`, `opus` | `astra`, `astra` |
| audit (correctness, design) | `astra`, `opus` | `astra`, `astra` |
| Feature tests lens | `sonnet` | `luna` |
| Architecture review (grounding, sequencing, risk) | `astra`, `opus`, `gemini` | `astra`, `astra`, `luna` |
| factory Simple (implementer, reviewer) | `sonnet`, `astra` | `astra`, `astra` (a fresh session) |
| factory Fix and Feature seats | `opus`, `astra` | `opus`, `astra`, `sol` |
| factory Architecture seats | `opus`, `astra`, `sonnet` | `opus`, `astra`, `sol` |
| intake, setup | `opus` | `astra` |
| checker | `sonnet` | `astra` |
| pair (author, reviewer) | `opus`, `astra` | `astra`, `opus` |
| ensemble (solvers, reviewers, compare) | `sonnet`, Sonnet or Opus per lens, `opus` | `astra`, `astra`, `astra` |
| run-plan tasks | the Codex column, on both hosts | |

In Claude Code, Codex, Gemini and OpenRouter turns go through a Haiku relay agent (Sonnet as the fallback),
and the retro runs on Sonnet. On the Codex host the orchestration roles (`intake`, `setup`,
`checker`, `questions`, `spec`, `retro`, `record`) can be changed with `roles`, for example
`{"intake": "sol", "checker": {"model": "astra", "effort": "high"}}`.

## Swapping a vendor

Claude, Codex, Gemini and OpenRouter are separate accounts with separate limits. When one runs out, or a
CLI isn't installed, pick the lineup yourself, for example with Codex Sol in place of Gemini:

    /dark-factory:council --seats opus,sonnet,astra,sol Fix the cancellation in ...

or, from a session, `Workflow({name: 'council', args: {task: '...', seats: ['opus', 'sonnet', 'astra', 'sol']}})`.
Asking in words ("run the council with Sol instead of Gemini") works too: the launching
session passes `seats`.

`seats` sets the debating seats only. The other roles in the table keep their defaults, so a
lineup without a vendor also has to move that vendor's other roles:

| option | sets |
|---|---|
| `seats` | council, Fix, Feature and Architecture seats; ensemble candidates |
| `panel` | the adjudicators |
| `spec: {coverage, intent}` | the spec reviewers (`false` skips the spec review) |
| `audit: {correctness, design, tests, risk}` | the audit and review lenses (`false` skips the audit) |
| `simple: {implementer, reviewer}` | the factory's Simple tier |
| `author`, `reviewer` | pair |
| `models: {solve, review, compare}` | ensemble |

A Claude-only factory run in Claude Code, for example, moves every Codex and Gemini default:

    Workflow({name: 'factory', args: {task: '...', seats: ['opus', 'sonnet'], panel: ['opus', 'sonnet'],
      spec: {coverage: 'sonnet'}, audit: {correctness: 'sonnet', grounding: 'sonnet', risk: 'sonnet'},
      simple: {reviewer: 'opus'}}})

Passing `seats` (or any other independent-process option) also keeps the factory off its Pair
strategy, whose reviewer would otherwise default to Astra.

Setup's preflight checks every CLI the resolved lineup needs and stops the run before any seat
starts if one can't run, naming the seat to swap. `--prepare` runs the same check with no model
turn; see [Process controls](process-controls.md).

An OpenRouter seat goes wherever a seat name does (`seats`, `panel`, `spec`, `audit`, `simple`,
pair `author` and `reviewer`, ensemble `seats` and `models`, Codex-host `roles`). To swap one out,
name another seat in its place; to use one in place of a vendor that ran out, name it the same
way, for example `--seats opus,sonnet,openrouter:moonshotai/kimi-k2`. Remember that it adds no
vendor to the consensus rule.

## OpenRouter seats

`openrouter:<model-id>` runs the Claude CLI (`claude -p`, as the Claude provider runs it) with its
API pointed at OpenRouter, for that one process: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
the key as `ANTHROPIC_AUTH_TOKEN`, an empty `ANTHROPIC_API_KEY`, the model ID for `--model` and
for every Claude model alias (so no background call reaches a Claude model through OpenRouter),
and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Claude Code's tools, sandbox and permission
rules are the ones a Claude seat gets. In Claude Code the turn goes through the relay and
`dark-factory seat-run --vendor openrouter`, never a native subagent; on the Codex host through the
same helper. Token use is recorded per turn in `usage.jsonl`; Claude Code's dollar figure is wrong
for these models and is never reported.

- **The key.** Export `OPENROUTER_API_KEY` in the environment that starts the helper (the Claude
  Code session or `dark-factory-codex`). It is read at each turn and never written to argv,
  `spec.json`, prompts, job directories, the room, `usage.jsonl`, logs, errors or reports. Like
  any exported variable, the other vendors' CLIs and the verification command inherit it from
  the helper's environment.
- **Preflight.** `dark-factory preflight --vendors openrouter:<model-id>` (which setup and
  `--prepare` run for you) checks that `claude` is on `PATH`, that `OPENROUTER_API_KEY` is set,
  that OpenRouter accepts it (`GET https://openrouter.ai/api/v1/key` answers 200) and that it
  lists every model asked for (`GET https://openrouter.ai/api/v1/models`). A bad key would
  otherwise cost about three minutes per seat in Claude Code's own retries.
- **Failures.** OpenRouter's HTTP status, from the envelope Claude prints, decides: 401 (the key),
  402 (out of credits) and 400 `invalid_request_error` (no such model) end the seat without a
  retry and name the status and message; 429 and 5xx get the usual single capacity retry.
- **Its own Claude configuration.** Each OpenRouter seat gets a `CLAUDE_CONFIG_DIR` of its own,
  `<runDir>/openrouter/<seat>/config` (mode 0700; a Codex-host role's is under the host run's
  directory), made by the helper outside the sandbox and kept across that seat's turns, so
  resumes and fix passes find their session. It is in no directory the seat can write, and a
  turn is refused if any part of that path is a symbolic link. Your
  global `CLAUDE.md`, hooks, plugins, MCP servers and Claude login never reach the provider. The
  seat's Bash tool runs with the token unset (`CLAUDE_ENV_FILE`), so no command the model runs
  can read or write it.
- **Privacy.** The seat's prompts, the code it reads and the tool output it sees go to OpenRouter
  and to the provider that serves the model, under their terms, not Anthropic's.
- **What remains.** Claude Code keeps the seat's full session transcripts in that configuration
  directory, and the helper can't stop Claude writing whatever the endpoint sends back into
  them; if the endpoint ever echoed the key, a transcript would hold it. After every OpenRouter
  turn the helper searches that directory, the job directory and the files the turn changed for
  the key; a copy is redacted in place and the turn fails with error class `leak` (not retried).
  A file or directory left read-only or unreadable is opened up for the search and given its
  mode back; one the helper still can't read or rewrite fails the turn the same way, so a
  search that couldn't finish never passes a turn.
  `dark-factory cleanup --run-dir <runDir>` deletes these directories, with or without `--all`,
  opening up any the seat or the search left without owner permissions; a directory it still
  can't delete is named in `openrouterConfigsRemaining` and the cleanup exits with an error.
  The search reads raw bytes, so it can't see inside Git's compressed objects; the Bash unset is
  what keeps the key out of a commit.
