const PAIR_STRINGS = { type: 'array', items: { type: 'string' } }
const PAIR_CRITERION_ID = { type: 'string', description: 'The bare criterion ID, such as C1, never its text.' }
// A criterion the run checks only against a stand-in, and how the user checks it against the real thing.
const PAIR_LIVE_CHECK = { type: 'object', properties: {
  criterion: PAIR_CRITERION_ID,
  check: { type: 'string', description: 'The command or action that checks the criterion against the real thing.' },
  reason: { type: 'string', description: 'Why the stand-in cannot show how the real thing behaves.' },
} }
const PAIR_SETUP_SCHEMA = strict({ type: 'object', properties: {
  ...SETUP_SCHEMA.properties,
  status: { type: 'string', enum: ['ok', 'dirty', 'needs-plan', 'needs-commit', 'needs-user', 'preflight', 'error'] },
  repositoryNotes: { type: 'string', description: 'Repository observations, proposed interpretations, and actual tool/configuration paths; never replacement requirements.' },
  questions: PAIR_STRINGS,
  head: { type: 'string', description: 'The original full base commit from init.head / run.json; never a later snapshot.' },
  unverifiable: { type: 'array', description: 'Criteria (supplied or written) that evidence available inside this run cannot fully meet; [] when every criterion can be checked.',
    items: { type: 'object', properties: { criterion: { type: 'string' }, reason: { type: 'string' },
      origin: { type: 'string', enum: ['supplied', 'written'], description: 'supplied: given in the task, criteria or a reference document, in substance; written: drafted by setup.' } } } },
  liveChecks: { type: 'array', description: 'Criteria the run can check only against a stand-in for something outside it that can behave differently (a network service, credentials, a certificate store, an external CLI\'s login); [] when there are none.',
    items: PAIR_LIVE_CHECK },
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
    attempted: { type: 'boolean' }, ran: { type: 'boolean' }, passed: { type: 'boolean' },
    hasExitCode: { type: 'boolean' }, exitCode: { type: 'integer', description: 'Meaningful only when hasExitCode is true.' },
    signal: { type: 'integer', description: 'Signal number, or zero if none.' }, timedOut: { type: 'boolean' },
    seconds: { type: 'number' }, log: { type: 'string' }, launchError: { type: 'string' },
    mutated: PAIR_STRINGS,
    reused: { type: 'boolean', description: 'A base execution reused from an earlier measurement with the same inputs.' },
  } } },
  elapsedSec: { type: 'number' },
} }

const PAIR_AUTHOR_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'needs-user', 'blocked'] },
  summary: { type: 'string' }, design: { type: 'string' }, notes: { type: 'string' },
  testContract: PAIR_CONTRACT, replayMapping: PAIR_REPLAY_MAPPING,
  addressed: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, action: { type: 'string', enum: ['changed', 'disputed'] }, response: { type: 'string' }, evidence: { type: 'string' },
  } } },
  readings: { type: 'array', description: 'New readings only: each place this turn\'s work reads a requirement, criterion or approved contract check other than literally; [] when it follows everything literally.',
    items: { type: 'object', properties: {
      requirement: { type: 'string', description: 'A criterion ID, or the requirement\'s own words in quotes.' },
      literal: { type: 'string', description: 'What the requirement literally says.' },
      reading: { type: 'string', description: 'How the work reads it.' }, reason: { type: 'string' },
    } } },
  liveChecks: { type: 'array', description: 'New entries only: criteria this turn\'s design or implementation makes rest on something outside the run that it checks only against a stand-in; [] otherwise.',
    items: PAIR_LIVE_CHECK },
  questions: { type: 'array', items: { type: 'string' } },
} })

const PAIR_REVIEW_SCHEMA = strict({ type: 'object', properties: {
  version: { type: 'string' }, complete: { type: 'boolean' }, summary: { type: 'string' },
  requiresDesignRevision: { type: 'boolean' },
  challenges: { type: 'array', items: { type: 'object', properties: {
    criterion: PAIR_CRITERION_ID, wrongImplementation: { type: 'string' }, rejectingCheckIds: PAIR_STRINGS,
  } } },
  findings: { type: 'array', items: { type: 'object', properties: {
    severity: SEVERITY, statement: { type: 'string' }, evidence: { type: 'string' },
  } } },
  resolutions: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, status: { type: 'string', enum: ['open', 'fixed', 'refuted'] }, evidence: { type: 'string' },
  } } },
  rulings: { type: 'array', description: 'Exactly one for each reading still proposed in the readings ledger; [] when none is.',
    items: { type: 'object', properties: {
      id: { type: 'string' }, ruling: { type: 'string', enum: ['accepted', 'rejected', 'needs-user'] }, evidence: { type: 'string' },
    } } },
  questions: { type: 'array', description: 'Only for a conflict only the user can settle; [] otherwise. A question stops the run.',
    items: { type: 'object', properties: {
      question: { type: 'string', description: 'The question, citing the finding or reading ID, with the options you see.' },
      quoted: { ...PAIR_STRINGS, description: 'The exact words of each requirement involved.' },
    } } },
  criteria: { type: 'array', items: { type: 'object', properties: {
    ...CHECK_SCHEMA.properties.criteria.items.properties, criterion: PAIR_CRITERION_ID,
  } } },
  suggestions: { type: 'array', items: { type: 'string' } },
} })

const PAIR_MEASURE_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'error'] }, error: { type: 'string' },
  scratchError: { type: 'string', description: 'Why the disposable verification checkout failed; empty when it succeeded.' },
  snapshot: { type: 'object', properties: { ref: { type: 'string' }, tree: { type: 'string' }, diff: { type: 'string' } } },
  suite: { type: 'object', properties: { ran: { type: 'boolean' }, passed: { type: 'boolean' }, command: { type: 'string' },
    failureKind: { type: 'string' }, log: { type: 'string' },
    overrides: { type: 'array', description: 'The explicit env overrides from verification.json the gate ran with, sorted by name.',
      items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } } } },
  replay: PAIR_REPLAY_RESULT,
} })

// The native resume record and check (dark-factory resume-check), copied as printed.
const PAIR_RESUME_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['ok', 'refused', 'error'] }, reason: { type: 'string' },
} })
