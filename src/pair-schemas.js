const PAIR_STRINGS = { type: 'array', items: { type: 'string' } }
const PAIR_SETUP_SCHEMA = strict({ type: 'object', properties: {
  ...SETUP_SCHEMA.properties,
  status: { type: 'string', enum: ['ok', 'dirty', 'needs-plan', 'needs-user', 'preflight', 'error'] },
  repositoryNotes: { type: 'string', description: 'Repository observations, proposed interpretations, and actual tool/configuration paths; never replacement requirements.' },
  questions: PAIR_STRINGS,
  head: { type: 'string', description: 'The original full base commit from init.head / run.json; never a later snapshot.' },
} })
const PAIR_CONTRACT = { type: 'object', properties: {
  testRoots: { type: 'array', items: { type: 'object', properties: {
    path: { type: 'string' }, evidence: { type: 'string' },
  } } },
  checks: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, criteria: PAIR_STRINGS,
    kind: { type: 'string', enum: ['test', 'gate', 'inspection'] },
    purpose: { type: 'string', enum: ['changed', 'preserved'] },
    scenario: { type: 'string' }, expected: { type: 'string' }, boundaries: { type: 'string' },
    file: { type: 'string' }, command: { type: 'string' }, fixtures: PAIR_STRINGS,
    inspection: { type: 'string' }, reason: { type: 'string' },
  } } },
} }
const PAIR_REPLAY_MAPPING = { type: 'array', items: { type: 'object', properties: {
  file: { type: 'string' }, command: { type: 'string' }, checkIds: PAIR_STRINGS, fixtures: PAIR_STRINGS,
} } }
const PAIR_REPLAY_RESULT = { type: 'object', properties: {
  base: { type: 'string' }, snapshot: { type: 'string' }, snapshotTree: { type: 'string' },
  testRoots: PAIR_STRINGS, mapping: PAIR_REPLAY_MAPPING,
  changes: { type: 'array', items: { type: 'object', properties: {
    status: { type: 'string' }, path: { type: 'string' }, previousPath: { type: 'string' },
  } } },
  exclusions: { type: 'array', items: { type: 'object', properties: {
    path: { type: 'string' }, reason: { type: 'string' },
  } } },
  records: { type: 'array', items: { type: 'object', properties: {
    side: { type: 'string', enum: ['base', 'final'] }, revision: { type: 'string' }, tree: { type: 'string' },
    file: { type: 'string' }, command: { type: 'string' }, checkIds: PAIR_STRINGS,
    cwd: { type: 'string' }, attempted: { type: 'boolean' }, ran: { type: 'boolean' }, passed: { type: 'boolean' },
    hasExitCode: { type: 'boolean' }, exitCode: { type: 'integer', description: 'Meaningful only when hasExitCode is true.' },
    signal: { type: 'integer', description: 'Signal number, or zero if none.' }, timedOut: { type: 'boolean' },
    seconds: { type: 'number' }, log: { type: 'string' }, logSha256: { type: 'string' }, tail: { type: 'string' }, launchError: { type: 'string' },
    mutated: PAIR_STRINGS,
  } } },
  elapsedSec: { type: 'number' },
} }

const PAIR_AUTHOR_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'needs-user', 'blocked'] },
  summary: { type: 'string' }, design: { type: 'string' }, notes: { type: 'string' },
  testContract: PAIR_CONTRACT, replayMapping: PAIR_REPLAY_MAPPING,
  addressed: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, response: { type: 'string' }, evidence: { type: 'string' },
  } } },
  questions: { type: 'array', items: { type: 'string' } },
} })

const PAIR_REVIEW_SCHEMA = strict({ type: 'object', properties: {
  version: { type: 'string' }, complete: { type: 'boolean' }, summary: { type: 'string' },
  requiresDesignRevision: { type: 'boolean' },
  challenges: { type: 'array', items: { type: 'object', properties: {
    criterion: { type: 'string' }, wrongImplementation: { type: 'string' }, rejectingCheckIds: PAIR_STRINGS,
  } } },
  findings: { type: 'array', items: { type: 'object', properties: {
    severity: SEVERITY, statement: { type: 'string' }, evidence: { type: 'string' },
  } } },
  resolutions: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, status: { type: 'string', enum: ['open', 'fixed', 'refuted'] }, evidence: { type: 'string' },
  } } },
  criteria: CHECK_SCHEMA.properties.criteria,
  suggestions: { type: 'array', items: { type: 'string' } },
} })

const PAIR_MEASURE_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'error'] }, error: { type: 'string' },
  snapshot: { type: 'object', properties: { ref: { type: 'string' }, tree: { type: 'string' }, diff: { type: 'string' } } },
  suite: { type: 'object', properties: { ...CHECK_SCHEMA.properties.suite.properties, command: { type: 'string' }, failureKind: { type: 'string' } } },
  replay: PAIR_REPLAY_RESULT,
} })
