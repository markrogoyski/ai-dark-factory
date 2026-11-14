"""Payload extraction from relay text and Claude transcripts."""

import json
import os
import time

from .common import TRANSCRIPT_POLL_SEC, prompt_hash


PAYLOAD_OPEN, PAYLOAD_CLOSE = '=====BEGIN PAYLOAD {}=====', '=====END PAYLOAD {}====='
TRANSCRIPT_MAX_AGE = 6 * 3600


def extract_payload(text, expect):
    """The payload between the markers for `expect`, without the indent the workflow harness puts
    in front of every line of an agent's prompt; None unless it hashes to `expect`."""
    lines = text.split('\n')
    begin, end = PAYLOAD_OPEN.format(expect), PAYLOAD_CLOSE.format(expect)
    starts = [i for i, line in enumerate(lines) if line.strip() == begin]
    ends = [i for i, line in enumerate(lines) if line.strip() == end]
    if not starts or not ends or ends[-1] <= starts[0]:
        return None
    first = lines[starts[0]]
    indent = first[:len(first) - len(first.lstrip(' \t'))]
    body = []
    for line in lines[starts[0] + 1:ends[-1]]:
        if line.startswith(indent):
            body.append(line[len(indent):])
        elif not line.strip():
            body.append('')
        else:
            return None
    payload = '\n'.join(body)
    return payload if prompt_hash(payload) == expect else None


def transcript_texts(path, needle):
    """Message texts in a Claude Code transcript (JSONL) that contain `needle`."""
    with open(path, 'rb') as f:
        data = f.read()
    raw_needle = needle.encode()
    if raw_needle not in data:
        return
    for raw in data.split(b'\n'):
        if raw_needle not in raw:
            continue
        try:
            content = json.loads(raw).get('message', {}).get('content')
        except (ValueError, AttributeError):
            continue
        if isinstance(content, str):
            yield content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and isinstance(block.get('text'), str):
                    yield block['text']


def payload_from_transcripts(expect, wait=10):
    """Claude Code saves every agent's prompt in its transcript, so read the relay's payload from
    there instead of having a model copy it: small models drop and add lines in long copies. The
    hash check makes this safe; None if no saved prompt matches."""
    base = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    root = os.path.join(base, 'projects')
    needle = PAYLOAD_OPEN.format(expect)
    deadline = time.time() + wait
    while True:
        now, found = time.time(), []
        for dirpath, _, names in os.walk(root):
            for name in names:
                if name.startswith('agent-') and name.endswith('.jsonl'):
                    path = os.path.join(dirpath, name)
                    try:
                        mtime = os.path.getmtime(path)
                    except OSError:
                        continue
                    if now - mtime < TRANSCRIPT_MAX_AGE:
                        found.append((mtime, path))
        for _, path in sorted(found, reverse=True):
            try:
                for text in transcript_texts(path, needle):
                    payload = extract_payload(text, expect)
                    if payload is not None:
                        return payload
            except OSError:
                continue
        if time.time() >= deadline:            # the transcript may not be flushed the instant the agent starts
            return None
        time.sleep(TRANSCRIPT_POLL_SEC)
