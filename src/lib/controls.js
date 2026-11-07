// Request-wide policy. Runtime clocks and execution stay in the adapters.
function boundedInteger(value, fallback, name, max = 10000) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}.`)
  return n
}

function parseControls(raw) {
  const repair = raw.repair === undefined ? null : raw.repair
  if (repair !== null && (!repair || typeof repair !== 'object' || Array.isArray(repair))) throw new Error('repair must be an object.')
  if (repair?.minor !== undefined && !['block', 'report'].includes(repair.minor)) throw new Error('repair.minor must be block or report.')
  return {
    maxTurns: boundedInteger(raw.maxTurns, null, 'maxTurns'),
    maxRunMin: boundedInteger(raw.maxRunMin, null, 'maxRunMin', 10080),
    repair: repair && { maxPasses: boundedInteger(repair.maxPasses, 2, 'repair.maxPasses', 20), minor: repair.minor || 'block' },
  }
}

function factoryStrategy(S, intake) {
  const requested = S.raw.strategy || 'auto'
  if (!['auto', 'pair', 'independent'].includes(requested)) throw new Error('strategy must be auto, pair, or independent.')
  const independentOptions = ['seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence'].filter(k => S.raw[k] !== undefined)
  if (requested === 'pair' && independentOptions.length) throw new Error(`Pair strategy does not accept ${independentOptions.join(', ')}; configure participants with pair: {author, reviewer, maxReviews}.`)
  const tier = S.factory.tier
  if (requested === 'pair' && (intake.mode !== 'implement' || tier === 'architecture')) throw new Error('Pair strategy requires an implementation below Architecture.')
  return requested === 'pair' || (requested === 'auto' && !independentOptions.length && intake.strategy === 'pair' && intake.mode === 'implement' && tier !== 'architecture') ? 'pair' : 'independent'
}

function factoryPairConfig(S) {
  const raw = { ...S.raw, ...S.raw.pair }
  for (const key of ['tier', 'seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence', 'strategy', 'pair']) delete raw[key]
  return parsePairConfig(raw)
}

function executionPlan(S) {
  const people = xs => xs.map(s => ({ model: s.key, vendor: s.vendor, effort: s.effort }))
  return {
    workflow: S.factory ? 'factory' : S.workflowName, tier: S.factory?.tier || S.tier, strategy: S.factory?.strategy || (S.pairOptions ? 'pair' : 'independent'),
    mode: S.mode, output: S.workflowName === 'ensemble' ? 'measured, independently reviewed candidates and advisory ranking; no automatic selection' : S.mode === 'implement' ? 'reviewed implementation in a worktree; delivery pending' : S.tier === 'architecture' ? 'reviewed design and milestones; no implementation' : S.mode,
    participants: people(S.lineup), reviewers: people(S.auditors), panel: people(S.panel), specification: people(S.specReviewers),
    roles: Object.fromEntries(Object.entries(S.roles || {}).map(([role, s]) => [role, { model: s.key, vendor: s.vendor }])),
    requiredCLIs: externalVendors(S).map(v => v === 'gemini' ? 'agy' : v),
    verification: S.verify || S.raw.verify || 'discovered during setup; not yet run',
    limits: { ...S.controls, repair: S.controls.repair || (S.tier === 'simple' ? { maxPasses: 1, minor: 'block' } : null), maxReviews: S.pairOptions?.maxReviews || null, rounds: S.pairOptions ? null : S.rounds },
    effort: S.pairOptions ? 'Setup, design and code turns, up to the review budget; measurements between code revisions.'
      : 'Depends on findings, retries and escalation. Limits are caps, not cost forecasts.',
    intake: S.factory?.intake || null,
  }
}

function explanation(S) {
  return { status: 'explained', task: S.task, plan: executionPlan(S), execution: 'not-started', final: { readiness: { state: 'not-assessed', blocked: [], incomplete: ['Explanation only; no implementation or review ran.'] } } }
}

function repairTodo(S, W) {
  const found = S.ledger.filter(c => c.kind === 'finding' && c.target === W && !c.withdrawn && !c.fixed)
  const actionable = found.filter(c => !c.judgment && (S.controls.repair?.minor !== 'report' || W8[c.severity] >= 2))
  const criteria = (S.pos[W]?.criteria || []).filter(c => c.status === 'unmet')
  const todo = { criteria, upheld: actionable.filter(c => c.status === 'verified'), disputed: actionable.filter(c => c.status === 'unresolved' || c.status === 'open'),
    suggestions: found.filter(c => c.judgment), failing: validTests(S).filter(t => S.testResults[t.id]?.[W] && S.testResults[t.id][W] !== 'pass'),
    suite: S.mode === 'implement' && S.verify && S.pos[W]?.suite?.ran && !S.pos[W].suite.passed ? S.pos[W].suite.tail || 'failed' : '' }
  todo.needed = !!(todo.criteria.length || todo.upheld.length || todo.disputed.length || todo.failing.length || todo.suite)
  return todo
}

function repairSignature(S, W) {
  const p = S.pos[W], todo = repairTodo(S, W)
  // Prose and response order are not progress. Track measured bytes, stable obligations,
  // and verification outcomes, including reproductions that change without a new tree.
  return JSON.stringify([p.tree?.hash || p.artifactHash || null,
    [...todo.upheld, ...todo.disputed].map(c => [c.id, c.severity, c.status]).sort(),
    (p.criteria || []).map(c => [c.criterion, c.status]).sort(),
    validTests(S).map(t => [t.id, S.testResults[t.id]?.[W] || 'missing']).sort(),
    p.suite?.ran, p.suite?.passed])
}
