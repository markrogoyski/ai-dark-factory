![AI Dark Factory Logo](https://github.com/markrogoyski/ai-dark-factory/blob/main/docs/image/AIDarkFactoryLogo.png?raw=true)

# AI Dark Factory

**Autonomous agent workflows that plan and implement on their own, checked by multi-agent review across models from different vendors.**

It is a workflow engine for Claude Code and Codex that has independent agents check each other's work, in three forms:

- **Pair**: one author and one independent reviewer.
- **Council**: several seats solve the task blind, debate it on an evidence ledger, and converge on one result.
- **Factory**: chooses how much process a task needs, from a single reviewed change up to a council.

The seats come from different vendors. The Claude entry point defaults to Claude Opus, Claude
Sonnet, Codex Astra and Gemini Hydrogen. The Codex entry point defaults to Claude Opus, Codex Astra
and Codex Sol seats with OpenAI reviewers, and also supports explicit Gemini seats.

For example, to have a council work out a subtle bug:

    /dark-factory:council Fix the race condition that lets two workers claim the same job

## The workflows at a glance

| workflow | use it for | who works | what you get back |
|---|---|---|---|
| [`factory`](docs/factory.md) | any task where you don't know how much review it needs: Factory sizes it for you | an intake agent reads the task and the code, then picks the lightest process that fits, from one reviewed change up to a council | the finished result; if the chosen process turns out too light, the run moves up to a heavier one on its own |
| [`pair`](docs/pair.md) | a scoped change one agent should own | one author, one reviewer in a fresh context per review | a reviewed, measured snapshot, or the open findings |
| [`council`](docs/council.md) | a subtle bug, a real trade-off, an investigation where the obvious answer may be wrong | 2–6 seats from several vendors solve blind, then debate | one converged result, or the scorecard's pick |
| [`ensemble`](docs/ensemble.md) | several independent attempts to choose from | 2–6 solvers with distinct stances, reviewed per lens | ranked candidates for you to pick or merge |
| [`run-plan`](docs/run-plan.md) | a whole plan of tasks, committed one by one | a Factory or Pair run per task, then a council acceptance check | local commits, parked questions, a final acceptance |

How they fit together:

```text
  run-plan    a plan of many tasks, worked one at a time
     |
     +-- each task, in dependency order, goes through factory or pair:
     |       reviewed and verified --> committed
     |       not ready -------------> parked; tasks that depend on it wait
     |
     '-- when every task is done, a council checks the whole plan was implemented

  factory     chooses how much process a task needs
     |
  an intake agent reads the task and the code, then picks:
     |
     +-- a small, clear change ----> Simple        one implementer, one reviewer
     |                                              (moves up to Fix or Feature if it struggles)
     +-- a subtle bug -------------> Fix           a council
     +-- a new feature ------------> Feature       two plans debated, then built in checked steps
     |                                              (moves up to Architecture if it is too big)
     +-- a design or a plan -------> Architecture  designs only, returns milestones to build
     '-- a scoped change, one owner -> Pair          one author, one reviewer

  council and ensemble are used on their own, as in the table above.
```

Every workflow shares the same guarantees. Seats work in their own git worktrees from HEAD.
Neutral checks run the verification gate on a snapshot, never on a live worktree. Reviewers work
in fresh contexts, and code, not a model, decides readiness. Nothing reaches your checkout until
it is delivered, by you or by a plan run you authorized to commit. [Architecture](docs/architecture.md#pieces) shows where
each part runs in Claude Code and in Codex. Model names in the diagrams are the Claude Code
defaults; the Codex profile substitutes OpenAI models for most roles
([both hosts' defaults](docs/models.md#defaults)).

## Install in Claude Code

**Requirements.** Claude Code with the Workflow tool, `git`, `python3` and Node on PATH, and
work in a Git repository with at least one commit. The default lineups also use other vendors'
CLIs, each installed and logged in:

| CLI | needed for | without it |
|---|---|---|
| [`codex`](https://github.com/openai/codex) | Codex seats (`astra`, `sol`, `luna`): the default Pair reviewer, the Simple tier's reviewer, council and audit seats | pick a lineup without Codex seats |
| `agy` (Antigravity CLI) | Gemini seats (`gemini`, `argon`): one default council seat | pick a lineup without Gemini seats |

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

The factory's defaults use Codex in several roles (the Simple reviewer, the panel, the spec
review and the audit), so a Claude-only factory run has to move each of them;
[Choosing the models](docs/models.md) has the full example, every seat name and each host's
defaults.

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

Each run works in git worktrees and reports a result with a `final.readiness`;
[Reading a result](docs/results.md) explains the statuses and what to do next. A ready change
stays in its worktree until you deliver it. In Claude Code, pass the workflow task's output
file (or a saved copy of the returned result) as `--result`; a Codex run saves
`<runDir>/result.json`, which both commands read by default:

    dark-factory apply           --run-dir <runDir> --result <task-output-or-result.json>
    dark-factory verify-delivery --run-dir <runDir> --result <task-output-or-result.json>
    dark-factory cleanup         --run-dir <runDir>    # once delivered: worktrees and refs; --all also removes the run directory

`apply` stages the reviewed snapshot without committing; `verify-delivery` checks the delivered
bytes and reruns the gate in your checkout. See [Verification and delivery](docs/verification-and-delivery.md).

Rough cost, in agent turns at the defaults:

| run | agent turns |
|---|---|
| factory, Simple tier | 6–9 |
| pair | 12–17 in recent runs (`maxReviews` caps the reviews at 8) |
| factory, Fix tier | 15–25 |
| ensemble, 4 candidates × 2 lenses | about 18, before relays and retries |
| factory, Feature tier | 25–40 |
| council | 30–50 |
| factory, Architecture tier | 35–50 |

Choose the models with `--seats` (council, ensemble) or `--author` and `--reviewer` (pair);
every seat name and default is in [Choosing the models](docs/models.md).

## Documentation

Everything beyond installation and a first run is in [`docs/`](docs/README.md):

| | |
|---|---|
| **Workflows** | [Factory](docs/factory.md) · [Pair](docs/pair.md) · [Council](docs/council.md) · [Ensemble](docs/ensemble.md) · [Run-plan](docs/run-plan.md) |
| **Using them** | [Reading a result](docs/results.md) · [Choosing the models](docs/models.md) · [Running in Codex](docs/codex.md) · [Process controls and resume](docs/process-controls.md) · [Verification and delivery](docs/verification-and-delivery.md) |
| **Measuring and tuning** | [Evaluating process value](docs/evaluation.md) · [Process retro](docs/process-retro.md) |
| **Internals** | [Architecture](docs/architecture.md) · [Pinning the engine](docs/engine-pinning.md) · [Development](docs/development.md) · [Gotchas and troubleshooting](docs/gotchas.md) |

To work on dark-factory itself, run `./install.sh` once, then `make build` after editing `src/`
and `make check` before committing; see [Development](docs/development.md).
