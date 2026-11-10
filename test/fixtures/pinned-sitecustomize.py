"""Test interpreter inheritance checks; never imported by the shipped helper itself."""
import os
import subprocess

_original = subprocess.Popen

class CheckedPopen(_original):
    def __init__(self, args, *positional, **kwargs):
        command = str(args[0]) if isinstance(args, (list, tuple)) and args else str(args)
        if any(s in command for s in ('node', 'python', 'dark-factory')):
            env = kwargs.get('env') or os.environ
            if 'pinned-preload.mjs' not in env.get('NODE_OPTIONS', '') or not env.get('PYTHONPATH'):
                raise RuntimeError('Subject subprocess lost observation preload before spawn')
        super().__init__(args, *positional, **kwargs)

subprocess.Popen = CheckedPopen
