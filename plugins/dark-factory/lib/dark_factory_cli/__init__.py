"""The dark-factory helper, run through bin/dark-factory. See cli.py for the subcommands.

Importing the package loads every module and re-exports their names here, so tests and tools can
reach any function as dark_factory_cli.<name>. A function patched here is not seen by the modules
that call it; patch it in the module that calls it instead.
"""

from . import (common, pinning, setup, jobs, transcripts, sandbox, providers, snapshots, verification, measure,
               delivery, usage, retro, cli)

MODULES = (common, pinning, setup, jobs, transcripts, sandbox, providers, snapshots, verification, measure,
           delivery, usage, retro, cli)

for _module in MODULES:
    globals().update({k: v for k, v in vars(_module).items() if not k.startswith('__')})
del _module

from .cli import main  # noqa: E402
