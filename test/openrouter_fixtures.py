"""The OpenRouter failure envelopes the tests classify.

Two were recorded from `claude -p` (2.1.325) against OpenRouter and are kept byte for byte:
fixtures/openrouter/auth-401.stdout.json (an invalid key) and bad-model.stdout.json (an unknown model
ID). 402, 429 and 5xx could not be triggered on demand, so they are DERIVED from the recorded 400
envelope by changing only api_error_status, api_error_type and result.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, 'fixtures', 'openrouter')
RECORDED = {401: os.path.join(FIXTURES, 'auth-401.stdout.json'), 400: os.path.join(FIXTURES, 'bad-model.stdout.json')}
RECORDED_SHA256 = {401: '85cb6f56a2bab946737f85eca2597d762e8fde136e356cd872470df89bf47ee7',
                   400: '92de7ce22f3bb5c749285a28bcc79b966b9aade34bc284caea44ced12e5e0d60'}
DERIVED_FROM = 400
DERIVED_FIELDS = ('api_error_status', 'api_error_type', 'result')
DERIVED = {
    402: ('billing_error', 'API Error: 402 Insufficient credits. Add more using https://openrouter.ai/settings/credits'),
    429: ('rate_limit_error', 'API Error: 429 Rate limit exceeded'),
    502: ('api_error', 'API Error: 502 Provider returned error'),
    503: ('api_error', 'API Error: 503 No available providers'),
}


def recorded(status):
    with open(RECORDED[status], 'rb') as f:
        return f.read()


def derived(status):
    """{'label': 'derived ...', 'envelope': dict, 'bytes': the envelope as claude prints it}."""
    envelope = json.loads(recorded(DERIVED_FROM))
    kind, result = DERIVED[status]
    envelope.update(api_error_status=status, api_error_type=kind, result=result)
    return {'label': f'derived from the recorded {DERIVED_FROM} envelope (only {", ".join(DERIVED_FIELDS)} changed)',
            'envelope': envelope, 'bytes': (json.dumps(envelope, separators=(',', ':')) + '\n').encode()}


def envelope(status):
    """The bytes claude prints for this status: recorded when there is a recording, else derived."""
    return recorded(status) if status in RECORDED else derived(status)['bytes']
