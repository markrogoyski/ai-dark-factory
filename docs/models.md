# Choosing the models

[Documentation index](README.md) · [Project README](../README.md)

Claude, Codex and Gemini are separate accounts with separate limits. When one runs out, pick
the lineup yourself, for example with Codex Sol in place of Gemini:

    /dark-factory:council --seats opus,sonnet,astra,sol Fix the cancellation in ...

or, from a session, `Workflow({name: 'council', args: {task: '...', seats: ['opus', 'sonnet', 'astra', 'sol']}})`.
Asking in words ("run the council with Sol instead of Gemini") works too. The launching session
passes `seats`.

| seat | model | vendor |
|---|---|---|
| `opus`, `sonnet`, `fable`, `haiku` | Claude | Claude Code subagents |
| `astra`, `sol`, `luna` | gpt-6-astra, gpt-6.1-sol, gpt-6-luna | Codex CLI |
| `gemini` | Gemini 4 Hydrogen | Antigravity CLI (`agy`) |
| `argon` | Gemini 4 Argon (low, medium and high effort only); only when asked for | Antigravity CLI |
| `codex:<slug>`, `gemini:<slug>` | any model the CLI offers (`agy models` lists Gemini's) | |

Use 2–6 seats. Consensus needs votes from at least two vendors whenever the lineup has more
than one vendor.

It is the sibling of `/dark-factory:ensemble`. Ensemble returns ranked candidates for you to pick from; the
council argues until it agrees, and falls back to an evidence scorecard when it can't.

