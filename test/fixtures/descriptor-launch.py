import json
import os
import subprocess
import sys

sentinel, report, program, *arguments = sys.argv[1:]
descriptor = os.open(sentinel, os.O_RDWR | os.O_CREAT, 0o600)
os.dup2(descriptor, 59, inheritable=True)
os.write(59, b'parent')
with open(report, 'a') as stream:
    stream.write(json.dumps({'parentWritable': True, 'inheritable': os.get_inheritable(59)}) + '\n')
environment = dict(os.environ, DESCRIPTOR_FD='59', DESCRIPTOR_REPORT=report)
result = subprocess.run([program, *arguments], env=environment, close_fds=False, capture_output=True)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
