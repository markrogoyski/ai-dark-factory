# Development

[Documentation index](README.md) · [Project README](../README.md)

To work on dark-factory itself, install your checkout as the Claude Code plugin in place of the
published one:

    ./install.sh                 # once: builds from src/, installs this checkout as the plugin, removes pre-plugin copies
    make build                   # after editing src/; then /reload-plugins or a new session (the plugin is read live)
    make check                   # all code, host, and installer gates; no models or installed Claude plugin required
    make installed               # separately check that the local Claude plugin is this checkout
    make hooks                   # run `make check` before every commit (there is no CI)

The pieces of `make check`:

    make syntax                  # every script, runner and helper parses
    node test/sim.mjs            # the real script against stub agents, and bin/dark-factory against a stub agy and real git; 42 scenarios
    SIM_ONLY=scenarioBallot,scenarioMeasure node test/sim.mjs   # just those
    node --test test/logic.mjs test/pair.mjs test/improvements.mjs # decision logic, and Pair scenarios through both hosts
    make host-test               # Codex routing, runner, installation, checkpoints, run-plan, engine pinning and provider policy, with stub CLIs
    python3 -B -m unittest discover -s test -p 'test_*.py'      # bin/dark-factory: pure functions, and jobs on temporary repositories
    node test/static.mjs         # scripts parse, `meta` is a plain literal, src/lib stays pure
    node test/hash-parity.mjs    # the JS and Python prompt hashes agree
    node tools/build.mjs --check # the built workflows and policy.mjs are what src/ builds to

**Prompt golden files.** `test/golden/<run>/<kind>.txt` holds the rendered prompt of each kind
(setup, solve, debate, checker, panel, ratify, relay and so on) for fixed scenarios, and the
sim compares against them. The prompts are the product, so a change to one shows up as a
failure naming the line. After an intended change, run `UPDATE_GOLDEN=1 node test/sim.mjs` and
read `git diff test/golden` before committing. The CLI's polling intervals can be shortened
for tests with `COUNCIL_JOB_POLL`, `COUNCIL_TRANSCRIPT_POLL` and `COUNCIL_TRANSCRIPT_WAIT`.

`plugins/dark-factory/workflows/ensemble.js` is generated from the shared sources, like the other workflows.

Requirements, the permission rule and agy settings are under
[Install in Claude Code](../README.md#install-in-claude-code); `make check` itself needs only Node,
`python3` and `git`.

