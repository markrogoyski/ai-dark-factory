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

Use 2–6 seats. Consensus needs votes from at least two vendors whenever the lineup has more
than one vendor.

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

In Claude Code, Codex and Gemini turns go through a Haiku relay agent (Sonnet as the fallback),
and the retro runs on Sonnet. On the Codex host the orchestration roles (`intake`, `setup`,
`checker`, `questions`, `spec`, `retro`, `record`) can be changed with `roles`, for example
`{"intake": "sol", "checker": {"model": "astra", "effort": "high"}}`.

## Swapping a vendor

Claude, Codex and Gemini are separate accounts with separate limits. When one runs out, or a
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
