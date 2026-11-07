const PAIR_AUTHOR_SCHEMA = strict({ type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'needs-user', 'blocked'] },
  summary: { type: 'string' }, design: { type: 'string' }, notes: { type: 'string' },
  addressed: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, response: { type: 'string' }, evidence: { type: 'string' },
  } } },
  questions: { type: 'array', items: { type: 'string' } },
} })

const PAIR_REVIEW_SCHEMA = strict({ type: 'object', properties: {
  version: { type: 'string' }, complete: { type: 'boolean' }, summary: { type: 'string' },
  requiresDesignRevision: { type: 'boolean' },
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
  suite: { type: 'object', properties: { ...CHECK_SCHEMA.properties.suite.properties, command: { type: 'string' } } },
} })
