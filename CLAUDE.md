# CLAUDE.md

The README is the user-facing reference (README § Pieces covers the architecture). The notes
below are rules for changing this repo.

## Editing

- The repo is a plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin,
  `plugins/dark-factory/`. Only that directory ships to users; `src/`, `tools/` and `test/` are
  development only. A new workflow goes in `plugins/dark-factory/workflows/` and runs as
  `/dark-factory:<meta.name>`.
- `plugins/dark-factory/workflows/council.js`, `factory.js`, `pair.js`, `ensemble.js`, and `run-plan.js` are generated from `src/` (the file
  lists are in `tools/sources.mjs`). Edit `src/`, then `make build`. Never edit a built file.
- Agents call the helper by its bare name, `dark-factory`: the plugin's `bin/` is on their PATH.
  Never write an install path into a prompt; the plugin's directory changes between installs.
- `src/lib/*.js` stays pure: each function takes the state `S` first and calls no runtime
  (`agent`, `parallel`, `log`). Runtime calls go in `src/boot.js`, `turns.js`, `council.js`, `simple.js` and
  the `main-*.js` entry files.
- `meta` in `src/00-meta.js` and `src/00-meta-factory.js` must stay a plain literal.
- `/council` must not change when the factory does: factory-only behaviour goes behind `S.tier`,
  `S.factory` or `S.workflowName`, and the council's goldens stay byte-identical.
- All five workflows are generated. Run-plan scheduling and policy stay in `src/`; its process,
  filesystem, and Git operations stay in the shipped runtime adapter. Ensemble keeps its advisory selection policy in `src/`
  while sharing setup, measurement, and runtime adapters.
- Prompts are the product. A prompt change fails the golden tests, which is intended: run
  `UPDATE_GOLDEN=1 node test/sim.mjs`, then read `git diff test/golden` before committing.
- The prompt hash exists twice, in `src/lib/util.js` and in `bin/dark-factory`. Change both
  together (`test/hash-parity.mjs` checks that they match).

## Verifying

- `make check` runs every gate (no models). `SIM_ONLY=scenarioX node test/sim.mjs` runs one
  sim scenario.
- `./install.sh` installs this checkout as the plugin, once. The installed plugin is read from
  `plugins/dark-factory/` live, so an edit needs only `make build`, then `/reload-plugins` or a
  new session.

## Tuning the workflow

- Before changing the workflow because of a retro note, read several files in `retros/`.
  One note is a lead; the same note across several runs is a pattern. When a failure
  happened, the transcripts usually explain it better than the notes do.

## Commits

One imperative line in the style of `git log`, with a body only when needed. Don't mention
plan documents, and don't add attribution lines.
