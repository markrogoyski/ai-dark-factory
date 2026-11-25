# Development

[Documentation index](README.md) · [Project README](../README.md)

To work on dark-factory itself, install your checkout as the Claude Code plugin in place of the
published one:

    ./install.sh                 # once: builds from src/, installs this checkout as the plugin, removes pre-plugin copies
    make build                   # after editing src/; then /reload-plugins or a new session (the plugin is read live)
    make check                   # (or plain `make`) all code, host, and installer gates; no models or installed Claude plugin required
    make installed               # separately check, with the `claude` CLI, that the local Claude plugin is this checkout
    make hooks                   # run `make check` before every commit (there is no CI); see below
    make unhooks                 # turn that off again
    make clean                   # remove __pycache__ and .pytest_cache left by ad hoc test runs

`make check` needs only Node, `python3` and `git`; requirements for the plugin itself, the
permission rule and agy settings are under [Installing](install.md#install-in-claude-code).
`NODE=… PYTHON=…` choose the interpreters that run the gates; scripts the tests start through
their shebangs still use `node` and `python3` from `PATH`.

## The pre-commit hook

`make hooks` sets `core.hooksPath=.githooks` in this clone's git config, not in a tracked file.
It lasts until `make unhooks` (or `git config --unset core.hooksPath`), is never turned on by
`make` or `make check`, and refuses to replace a hooks path you set yourself. The hook runs
`make check` on the working tree, so unstaged edits are tested too; `git commit --no-verify`
skips it once.

Git exports `GIT_INDEX_FILE` to a pre-commit hook, and `GIT_DIR` too from a linked worktree. The
Makefile unexports them and the helper drops them itself (`GIT_REPO_ENV` in
`dark_factory_cli/common.py`, mirrored in `lib/engine.mjs` and the Makefile;
`test/test_git_environment.py` keeps the three lists equal).

## The pieces of `make check`

The quick ones run first, then `unit` and `host-test` run side by side. `host-test` is one
`node --test` run whose files run in parallel, so it lasts about as long as its slowest file.

    make syntax                  # every script, runner, helper, test, fixture and shell script parses (static parses the workflows)
    node test/sim.mjs            # the real script against stub agents, and bin/dark-factory against a stub agy and real git
    SIM_ONLY=scenarioBallot,scenarioMeasure node test/sim.mjs   # just those
    node --test test/logic.mjs test/pair.mjs test/improvements.mjs # decision logic, and Pair scenarios through both hosts
    make host-test               # Codex routing, runner, installation, checkpoints, run-plan, engine pinning and provider policy, with stub CLIs
    python3 -B -m unittest discover -q -s test -p 'test_*.py'   # bin/dark-factory: pure functions, and jobs on temporary repositories
    node test/static.mjs         # scripts parse, `meta` is a plain literal, src/lib stays pure
    node test/hash-parity.mjs    # the JS and Python prompt hashes agree
    node tools/build.mjs --check # the built workflows and policy.mjs are what src/ builds to
    node tools/build.mjs --candidates # build each unshipped candidate (none now) in memory and report its size

`node tools/bench.mjs` prepares, validates, runs, grades and scans for contamination the
ground-truth tasks in `bench/` ([Benchmark](evaluation.md#benchmark)); only its `run --yes` calls
models. `test/bench.mjs`
covers it in `host-test` with stub CLIs.

`test/validation-overhead.mjs` times one pause and resume (about 30 s);
`VALIDATION_SAMPLES=3 node --test test/validation-overhead.mjs` takes three samples for a median.

## Prompt golden files

`test/golden/<run>/<kind>.txt` holds the rendered prompt of each kind (setup, solve, debate,
checker, panel, ratify, relay and so on) for fixed scenarios, and the sim compares against them.
The prompts are the product, so a change to one fails the sim with the line named. After an
intended change, run `UPDATE_GOLDEN=1 node test/sim.mjs` and read `git diff test/golden` before
committing. To shorten the CLI's polling intervals in tests, set `COUNCIL_JOB_POLL`,
`COUNCIL_TRANSCRIPT_POLL` and `COUNCIL_TRANSCRIPT_WAIT`.
