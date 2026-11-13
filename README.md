# AI Dark Factory

**Autonomous agent workflows that plan and implement on their own, checked by multi-agent review across models from different vendors.**

It is a workflow engine for Claude Code and Codex, with three ways to get that review:

- **Pair**: one author and one independent reviewer.
- **Council**: several seats solve the task blind, debate it on an evidence ledger, and converge on one result.
- **Factory**: chooses how much process a task needs, from a single reviewed change up to a council.

The seats come from different vendors. The Claude entry point defaults to Claude Opus, Claude
Sonnet, Codex Astra and Gemini Flash. The Codex entry point defaults to Claude Opus, Codex Astra
and Codex Sol seats with OpenAI reviewers, and also supports explicit Gemini seats.

For example, to have a council work out a subtle bug:

    /dark-factory:council Fix the race condition that lets two workers claim the same job

## The workflows at a glance

| workflow | use it for | who works | what you get back |
|---|---|---|---|
| [`factory`](docs/factory.md) | implementation, investigation or design when it isn't obvious how much process it needs | an Opus intake picks a tier (or Pair), then that process runs | the chosen process's result, escalated in the same run if the tier was too low |
| [`pair`](docs/pair.md) | a scoped change one agent should own | one author, one reviewer in a fresh context per review | a reviewed, measured snapshot, or the open findings |
| [`council`](docs/council.md) | a subtle bug, a real trade-off, an investigation where the obvious answer may be wrong | 2–6 seats from several vendors solve blind, then debate | one converged result, or the scorecard's pick |
| [`ensemble`](docs/ensemble.md) | several independent attempts to choose from | 2–6 solvers with distinct stances, reviewed per lens | ranked candidates for you to pick or merge |
| [`run-plan`](docs/run-plan.md) | a whole plan of tasks, committed one by one | a Factory or Pair run per task, then a council acceptance check | local commits, parked questions, a final acceptance |

How they fit together:

```text
  /dark-factory:run-plan    plan.json: tasks in dependency order, then acceptance
     |
     +-- each eligible task --> a factory or pair run --> ready? --yes--> apply, verify, commit
     |                                                      '----no-----> park; dependents wait
     '-- every task done -----> council investigation: is the whole plan implemented?

  /dark-factory:factory
     |
  intake (Opus, read-only) picks a tier and a strategy
     |
     +-- pair strategy ------------------------> Pair
     +-- simple -------> Simple ---------------> (escalates to Fix or Feature)
     +-- fix ----------> Council, two seats
     +-- feature ------> Feature --------------> (escalates to Architecture)
     +-- architecture -> Architecture            (designs only: returns milestones)

  /dark-factory:pair        one author and one reviewer, looping until review passes
  /dark-factory:council     seats solve blind, debate on a ledger, converge on one result
  /dark-factory:ensemble    independent candidates, reviewed and ranked for you to choose
```

Every workflow shares the same guarantees. Seats work in their own git worktrees from HEAD.
Neutral checks run the verification gate on a snapshot, never on a live worktree. Reviewers work
in fresh contexts, and code, not a model, decides readiness. Nothing reaches your checkout until
it is delivered, by you or by a plan run you authorized to commit. [Architecture](docs/architecture.md#pieces) shows where
each part runs in Claude Code and in Codex. Model names in the diagrams are the Claude Code
defaults; the Codex profile substitutes OpenAI models for most roles, as each section says.

## Install in Claude Code

**Requirements.** Claude Code with the Workflow tool, `git`, `python3` and Node on PATH, and
work in a Git repository with at least one commit. The default lineups also use other vendors'
CLIs, each installed and logged in:

| CLI | needed for | without it |
|---|---|---|
| [`codex`](https://github.com/openai/codex) | Codex seats (`astra`, `sol`, `luna`): the default Pair reviewer, the Simple tier's reviewer, council and audit seats | pick a lineup without Codex seats |
| `agy` (Antigravity CLI) | Gemini seats (`gemini`, `gemini-pro`): one default council seat | pick a lineup without Gemini seats |

**Install.** The repo is a Claude Code plugin marketplace with one plugin, `dark-factory`. In a
Claude Code session:

    /plugin marketplace add markrogoyski/ai-dark-factory
    /plugin install dark-factory@ai-dark-factory

Start a new session (or run `/reload-plugins`). That adds `/dark-factory:pair`,
`/dark-factory:factory`, `/dark-factory:council`, `/dark-factory:ensemble` and
`/dark-factory:run-plan`, and puts the helper the agents run, `dark-factory`, on their PATH.

**Permission (required).** A plugin can't grant permissions, so add this to
`~/.claude/settings.json` yourself:

    "permissions": { "allow": [ "Bash(dark-factory:*)" ] }

It stops the relay and checker agents prompting mid-run, and Codex and Gemini seats depend on
it: neither CLI can run inside Claude Code's Bash sandbox, because each writes to its home
directory (`~/.codex`, `~/.gemini`) as it starts and needs the network. `dark-factory seat-run`
detects this, and the relay runs the command outside the sandbox from the first try. Per the
Claude Code docs, an allow rule also approves running the commands it matches outside the
sandbox, and it applies before auto mode's classifier. Without it, setup's preflight finds the
CLI stuck in the sandbox and stops the run before any seat starts, saying how to fix it or which
seat to swap.

**agy settings (required for Gemini seats).** Headless agy can't ask for permission, so it
denies every command and file edit unless `~/.gemini/antigravity-cli/settings.json` has
`"toolPermission": "proceed-in-sandbox"`. Commands then run without prompting inside agy's
sandbox, which has no network and can only write where a grant allows. This setting is global,
so it applies to interactive agy sessions too; `seat-run` refuses to start a Gemini turn without
it. `seat-run` adds the one grant a run needs, `write_file(<repo>/.council)`, the first time a
repository has a Gemini seat.

**Claude only.** Without `codex` and `agy`, choose Claude models explicitly:

    /dark-factory:pair --author opus --reviewer sonnet Implement the retry policy
    /dark-factory:council --seats opus,sonnet Fix the cancellation in ...

[Choosing the models](docs/models.md) lists every seat name.

**Try it.** In a repository with a clean working tree, with `codex` installed (the Simple tier's
reviewer is Codex Astra):

    /dark-factory:factory Add a debug log line with the retry count in Fetcher::retry

**Update and uninstall.**

    /plugin marketplace update ai-dark-factory
    /plugin update dark-factory@ai-dark-factory
    /plugin uninstall dark-factory@ai-dark-factory

## Install in Codex

Codex uses dark-factory as a skill linked from a local checkout. Clone the repository somewhere
it can stay, then install the skill in the project where you want to use it:

```sh
git clone https://github.com/markrogoyski/ai-dark-factory.git ~/ai-dark-factory
~/ai-dark-factory/install-codex.sh --repo /path/to/project
```

With no `--repo`, the installer uses the current Git repository. `install-codex.sh --user`
installs in `~/.agents/skills` for use across projects. It creates a symlink to the shipped skill,
so keep the checkout in place. It does not replace an existing skill from another location or
change account settings. Codex discovers the skill automatically; start a new session if it
doesn't appear.

To update, `git pull` in the checkout: the link points at it, so the next session uses the new
version. To uninstall, remove the link, `.agents/skills/dark-factory` in the project (or
`~/.agents/skills/dark-factory`), and the checkout.

Then, in Codex:

```text
$dark-factory Add a debug log line with the retry count in Fetcher::retry
$dark-factory --tier fix Find why the sync drops the last page
$dark-factory --workflow pair Implement the retry policy
```

Node, Python 3, Git, and authenticated `codex` and `claude` CLIs are required (`agy` too for
Gemini seats). Runner options, resume, and the standalone CLI are in
[Running in Codex](docs/codex.md).

## Using the workflows

    /dark-factory:factory   Add a debug log line with the retry count in Fetcher::retry
    /dark-factory:pair      Implement the retry policy
    /dark-factory:council   Fix the race condition that lets two workers claim the same job
    /dark-factory:ensemble  Compare fixes for the iterator boundary
    /dark-factory:run-plan  {planFile: "/absolute/path/plan.json", repo: "/path/to/project"}

Each run works in git worktrees and reports a result with a `final.readiness`. A ready change
stays in its worktree until you deliver it. The Codex runtime saves the full result as
`<runDir>/result.json`; a native Claude Code run returns it inline, so save that JSON to a file
first, then pass it to both commands:

    dark-factory apply --run-dir <runDir> --result <saved-result.json>
    dark-factory verify-delivery --run-dir <runDir> --result <saved-result.json>

For a Codex run, use `<runDir>/result.json` as the result file; `apply` also defaults to it.

Roughly 30-50 agent turns for a council run, 6-9 for a Simple factory change. Choose the
models with `--seats` (council, ensemble) or `--author` and `--reviewer` (pair); every seat name
is in [Choosing the models](docs/models.md).

## Documentation

Everything beyond installation and a first run is in [`docs/`](docs/README.md):

| | |
|---|---|
| **Workflows** | [Factory](docs/factory.md) · [Pair](docs/pair.md) · [Council](docs/council.md) · [Ensemble](docs/ensemble.md) · [Run-plan](docs/run-plan.md) |
| **Using them** | [Choosing the models](docs/models.md) · [Running in Codex](docs/codex.md) · [Process controls and resume](docs/process-controls.md) · [Verification and delivery](docs/verification-and-delivery.md) |
| **Measuring and tuning** | [Evaluating process value](docs/evaluation.md) · [Process retro](docs/process-retro.md) |
| **Internals** | [Architecture](docs/architecture.md) · [Pinning the engine](docs/engine-pinning.md) · [Development](docs/development.md) · [Gotchas](docs/gotchas.md) |

To work on dark-factory itself, run `./install.sh` once, then `make build` after editing `src/`
and `make check` before committing; see [Development](docs/development.md).
