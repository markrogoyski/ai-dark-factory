const ENSEMBLE_SOLUTION_SCHEMA = strict( S.mode === 'implement' ? {
  type: 'object',
  properties: {
    approach:      { type: 'string', description: 'What you did and why, 2-4 sentences.' },
    worktreePath:  { type: 'string', description: 'Output of `git rev-parse --show-toplevel` in your worktree.' },
    filesChanged:  { type: 'array', items: { type: 'string' } },
    diff:          { type: 'string', description: 'Full unified diff of your change (git diff).' },
    verification:  { type: 'string', description: 'The exact commands you ran and the real tail of their output. Say plainly if you did not run them.' },
    risks:         { type: 'array', items: { type: 'string' }, description: 'What you are least sure about.' },
    confidence:    { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['approach', 'worktreePath', 'diff', 'verification', 'confidence'],
} : {
  type: 'object',
  properties: {
    answer:        { type: 'string', description: 'Your conclusion, stated directly.' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim:  { type: 'string' },
          source: { type: 'string', description: 'file:line, a git ref, or the command whose output supports it.' },
        },
        required: ['claim', 'source'],
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    confidence:    { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['answer', 'evidence', 'confidence'],
})

const ENSEMBLE_REVIEW_SCHEMA = strict( {
  type: 'object',
  properties: {
    complete: { type: 'boolean' },
    snapshotTree: { type: 'string' },
    criteria: CHECK_SCHEMA.properties.criteria,
    verdict: { type: 'string', enum: ['sound', 'flawed-but-fixable', 'broken'] },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity:    { type: 'string', enum: ['blocker', 'major', 'minor'] },
          description: { type: 'string' },
          evidence:    { type: 'string', description: 'Triggering input, command output, or file:line. No evidence, no defect.' },
        },
        required: ['severity', 'description'],
      },
    },
    bestIdea: { type: 'string', description: 'The single thing from this candidate worth keeping even if the candidate loses.' },
    score:    { type: 'integer', minimum: 0, maximum: 10 },
  },
  required: ['verdict', 'defects', 'score'],
})

const ENSEMBLE_COMPARE_SCHEMA = strict( {
  type: 'object',
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate: { type: 'integer' },
          rank:      { type: 'integer' },
          why:       { type: 'string' },
        },
        required: ['candidate', 'rank', 'why'],
      },
    },
    recommendation: { type: 'string', enum: ['adopt-one', 'merge', 'none-adequate'] },
    mergePlan:      { type: 'string', description: 'Concretely: take X from candidate i, Y from candidate j, and why.' },
    disagreements:  { type: 'array', items: { type: 'string' }, description: 'Where reviewers contradicted each other — the main agent should adjudicate these itself.' },
    openQuestions:  { type: 'array', items: { type: 'string' } },
  },
  required: ['ranking', 'recommendation', 'mergePlan'],
})
