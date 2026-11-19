# Installing

[Documentation index](README.md) · [Project README](../README.md)

## Install in Claude Code

### Requirements

Claude Code with the Workflow tool, `git`, `python3` and Node on PATH, and a Git repository with
at least one commit. The default lineups also use other vendors' CLIs, each installed and logged in:

| CLI | needed for | without it |
|---|---|---|
| [`codex`](https://github.com/openai/codex) | Codex seats (`astra`, `sol`, `luna`): the default Pair reviewer, the Simple tier's reviewer, council and audit seats | pick a lineup without Codex seats |
| `agy` (Antigravity CLI) | Gemini seats (`gemini`, `argon`, `neon`): one default council seat | pick a lineup without Gemini seats |

OpenRouter seats (`openrouter:<model-id>`) need `OPENROUTER_API_KEY`; see
[Choosing the models](models.md#openrouter-seats).

### Install the plugin

The repo is a Claude Code plugin marketplace with one plugin, `dark-factory`. In a session:

    /plugin marketplace add markrogoyski/ai-dark-factory
    /plugin install dark-factory@ai-dark-factory

Start a new session (or run `/reload-plugins`). That adds `/dark-factory:pair`,
`/dark-factory:factory`, `/dark-factory:council`, `/dark-factory:ensemble` and
`/dark-factory:run-plan`, and puts the helper the agents run, `dark-factory`, on their PATH.

### Permission (required)

A plugin can't grant permissions, so add this to `~/.claude/settings.json` yourself:

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

It stops the relay and checker agents prompting mid-run. Codex and Gemini seats depend on it:
neither CLI can run inside Claude Code's Bash sandbox, because each writes to its home directory
(`~/.codex`, `~/.gemini`) as it starts and needs the network. `dark-factory seat-run` detects
this and the relay runs the command outside the sandbox from the first try (per the Claude Code
docs, an allow rule approves running matching commands outside the sandbox, and applies before
auto mode's classifier). Without the rule, setup's preflight finds the CLI stuck in the sandbox
and stops the run before any seat starts, saying how to fix it or which seat to swap.

### agy settings (required for Gemini seats)

Headless agy can't ask for permission, so it denies every command and file edit unless
`~/.gemini/antigravity-cli/settings.json` has:

    "toolPermission": "proceed-in-sandbox"

Commands then run without prompting inside agy's sandbox, which has no network and can only write
where a grant allows. The setting is global, so it applies to interactive agy sessions too.
`seat-run` refuses to start a Gemini turn without it, and adds the one grant a run needs,
`write_file(<repo>/.council)`, the first time a repository has a Gemini seat.

### Claude only

Without `codex` and `agy`, choose Claude models explicitly:

    /dark-factory:pair --author opus --reviewer sonnet Implement the retry policy
    /dark-factory:council --seats opus,sonnet Fix the cancellation in ...

The factory's defaults use Codex in several roles (the Simple reviewer, the panel, the spec
review and the audit), so a Claude-only factory run has to move each of them; see
[Swapping a vendor](models.md#swapping-a-vendor).

### Update and uninstall

    /plugin marketplace update ai-dark-factory
    /plugin update dark-factory@ai-dark-factory
    /plugin uninstall dark-factory@ai-dark-factory

## Install in Codex

Codex uses dark-factory as a skill linked from a local checkout. Clone the repository somewhere
it can stay, then install the skill in the project where you want it:

```sh
git clone https://github.com/markrogoyski/ai-dark-factory.git ~/ai-dark-factory
~/ai-dark-factory/install-codex.sh --repo /path/to/project
```

- With no `--repo`, the installer uses the current Git repository. `--user` installs in
  `~/.agents/skills` for use across projects.
- It symlinks the shipped skill, so keep the checkout in place. It doesn't replace an existing
  skill from another location or change account settings.
- Codex discovers the skill automatically; start a new session if it doesn't appear.

Requirements: Node, Python 3, Git, and authenticated `codex` and `claude` CLIs (plus `agy` for
Gemini seats, with the [agy settings](#agy-settings-required-for-gemini-seats) above). Runner
options, resume, and the standalone CLI are in [Running in Codex](codex.md).

To update, `git pull` in the checkout; the next session uses the new version. To uninstall,
remove the link (`.agents/skills/dark-factory` in the project, or `~/.agents/skills/dark-factory`)
and the checkout.

## Working on dark-factory itself

Run `./install.sh` once to install this checkout as the plugin, then `make build` after editing
`src/` and `make check` before committing; see [Development](development.md).
