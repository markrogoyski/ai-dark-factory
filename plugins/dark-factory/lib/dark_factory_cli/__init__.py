"""The dark-factory helper, run through bin/dark-factory. See cli.py for the subcommands.

Importing cli imports every module, and with them the job runners they register in jobs.
"""

from .cli import main  # noqa: F401
