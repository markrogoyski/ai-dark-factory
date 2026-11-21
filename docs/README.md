# Documentation

[Project README](../README.md): what dark-factory is, how to install it, and a first run.

## Workflows

- [Factory](factory.md): intake picks a tier (Simple, Fix, Feature, Architecture) or Pair, and escalates on evidence.
- [Pair](pair.md): one author and one independent reviewer, from design through implementation.
- [Council](council.md): seats solve blind, debate on an evidence ledger, and converge; scoring, arguments and the end-of-run report.
- [Ensemble](ensemble.md): independent candidates, cross-reviewed and ranked for you to pick or merge.
- [Run-plan](run-plan.md): execute a plan of tasks across runs, committing each verified task.

## Using them

- [Installing](install.md): requirements, the permission rule and agy settings, Claude-only use, Codex, update and uninstall.
- [Reading a result](results.md): following a run as it goes (`dark-factory watch`), statuses, readiness, delivery, and what to do next.
- [Choosing the models](models.md): seat names, each host's defaults, swapping a vendor, and rough cost per run.
- [Running in Codex](codex.md): the Codex skill and the standalone runner.
- [Process controls, explanation, and resume](process-controls.md): `--explain`, `--prepare`, budgets, repairs, checkpoints.
- [Verification and delivery](verification-and-delivery.md): the gate, measurement, `apply` and `verify-delivery`.

## Measuring and tuning

- [Evaluating process value](evaluation.md): metrics and the offline evaluator.
- [Process retro](process-retro.md): the per-run retrospective.

## Internals

- [Architecture](architecture.md): how the workflows fit together, shared guarantees, plugin layout, and the run directory.
- [Pinning the engine](engine-pinning.md): running a frozen plugin export for a self-update; the [admission reference](engine-pinning-reference.md) has the full policy.
- [Development](development.md): building, testing and golden prompts.
- [Gotchas and troubleshooting](gotchas.md): platform and CLI quirks, and where to look when a run fails.
