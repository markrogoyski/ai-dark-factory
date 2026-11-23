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
  // Run-plan's request to ask about unresolved requirements also applies to Pair
  // setup; it is not a request for a separate specification-review panel.
  const independentOptions = ['seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence'].filter(k => S.raw[k] !== undefined && !(k === 'spec' && S.raw[k] === 'ask'))
  if (requested === 'pair' && independentOptions.length) throw new Error(`Pair strategy does not accept ${independentOptions.join(', ')}; configure participants with pair: {author, reviewer, maxReviews}.`)
  const tier = S.factory.tier
  if (requested === 'pair' && (intake.mode !== 'implement' || tier === 'architecture')) throw new Error('Pair strategy requires an implementation below Architecture.')
  return requested === 'pair' || (requested === 'auto' && !independentOptions.length && intake.strategy === 'pair' && intake.mode === 'implement' && tier !== 'architecture') ? 'pair' : 'independent'
}

function factoryPairConfig(S) {
  const raw = { ...S.raw, ...S.raw.pair }
  // design: false is a standalone /pair option; the factory's pair strategy always designs first.
  for (const key of ['tier', 'seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence', 'strategy', 'pair', 'design']) delete raw[key]
  // The factory's spec option configures the council's review; pair: {spec} configures Pair's.
  if (S.raw.pair?.spec !== undefined) raw.spec = S.raw.pair.spec
  // The factory's retro setting applies, since its facts are what the router is tuned from, and
  // the retro and record turns use the factory's roles in the Codex host.
  const config = parsePairConfig(raw)
  const keep = Object.fromEntries(['retro', 'record'].filter(r => S.roles && S.roles[r]).map(r => [r, S.roles[r]]))
  return { ...config, retro: S.retro, roles: { ...config.roles, ...keep } }
}

function executionPlan(S) {
  const people = xs => xs.map(s => ({ model: s.key, vendor: s.vendor, effort: s.effort }))
  return {
    workflow: S.factory ? 'factory' : S.workflowName, tier: S.factory?.tier || S.tier, strategy: S.factory?.strategy || (S.pairOptions ? 'pair' : 'independent'),
    mode: S.mode, output: S.workflowName === 'ensemble' ? 'measured, independently reviewed candidates and advisory ranking; no automatic selection' : S.mode === 'implement' ? 'reviewed implementation in a worktree; delivery pending' : S.tier === 'architecture' ? 'reviewed design and milestones; no implementation' : S.mode,
    participants: people(S.lineup), reviewers: people(S.auditors), panel: people(S.panel), specification: people(S.specReviewers),
    roles: Object.fromEntries(Object.entries(S.roles || {}).map(([role, s]) => [role, { model: s.key, vendor: s.vendor }])),
    requiredCLIs: preflightTargets(S).map(v => v === 'gemini' ? 'agy' : v),
    verification: S.verify || S.raw.verify || 'discovered during setup; not yet run',
    limits: { ...S.controls, repair: S.controls.repair || (S.tier === 'simple' ? { maxPasses: 1, minor: 'block' } : null), maxReviews: S.pairOptions?.maxReviews || null, rounds: S.pairOptions ? null : S.rounds },
    effort: S.pairOptions ? `Setup${S.specReviewers.length ? ', a spec review' : ''}, ${S.pairOptions.design === false ? 'no design stage; ' : 'design and '}code turns, up to the review budget; measurements between code revisions.`
      : 'Depends on findings, retries and escalation. Limits are caps, not cost forecasts.',
    intake: S.factory?.intake || null,
  }
}

// history: the past runs the runtime read (pastRuns() in turns.js), or null where it can read none.
function explanation(S, history = null) {
  const plan = executionPlan(S)
  return { status: 'explained', task: S.task, plan: { ...plan, estimate: historyEstimate(S, plan, history) }, execution: 'not-started', final: { readiness: { state: 'not-assessed', blocked: [], incomplete: ['Explanation only; no implementation or review ran.'] } } }
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

// Story lines (tellStory) for the independent review: the Simple tier's implementer, each review
// and its rulings, each repair pass, and why the loop stopped. runAudit's audit and fix pass use
// the same item wording.
const storyWords = (s, n) => oneLine(s, n).replace(/[.\s]+$/, '')

function storyItem(c) {
  return `${c.id} (${c.kind === 'test' ? 'test' : `${c.severity}${c.judgment ? ', judgment' : ''}`}) ${storyWords(c.statement, 140)}`
}

function storyRuling(c) {
  if (c.withdrawn) return 'withdrawn'
  if (c.judgment || c.status === 'judgment') return 'a judgment call'
  return { verified: c.kind === 'finding' ? 'upheld' : 'a valid test', refuted: 'refuted', fabricated: 'ruled fabricated', unresolved: 'unresolved' }[c.status] || 'not ruled on'
}

function storyGate(S, L) {
  const p = S.pos[L]
  if (S.mode !== 'implement' || !S.verify) return ''
  return !p?.suite ? 'The gate was not measured.' : !p.suite.ran ? 'The gate did not run.' : p.suite.passed ? 'The gate passed.' : 'The gate failed.'
}

function storyTodo(todo) {
  const ids = xs => xs.map(c => c.id).join(', ')
  return [todo.upheld.length && `${ids(todo.upheld)} upheld`, todo.disputed.length && `${ids(todo.disputed)} unresolved`,
    todo.failing?.length && `failing tests ${ids(todo.failing)}`, todo.criteria?.length && `${todo.criteria.map(c => c.criterion).join(', ')} unmet`,
    todo.suite && 'the failing gate'].filter(Boolean).join('; ')
}

function setupStoryLine(S) {
  const ids = S.criteria.map(c => c.id)
  const gate = S.mode !== 'implement' ? '' : !S.verify ? '; no automated gate'
    : `; gate \`${oneLine(S.verify, 160)}\` ${S.baselineOk ? 'passing at base' : `already failing at base (${storyWords(S.baselineNote, 200)})`}`
  return `Setup: ${ids.length} acceptance ${ids.length === 1 ? 'criterion' : 'criteria'} (${ids.join(', ') || 'none'})${gate}.`
}

function solveStoryLine(S, W) {
  const st = S.pos[W.L]?.stats
  return `${W.name} implemented the change${st ? ` (+${st.added}/−${st.removed} in ${plural(st.files, 'file')})` : ''}. ${storyGate(S, W.L)}`.trim()
}

// After a review's items are ruled on. `items`: the ledger entries it filed; `earlier`: the
// previous review's to-do list, whose items this review may have closed.
function reviewStoryLine(S, n, items, todo, earlier = null) {
  const head = `Review ${n} by ${S.auditors.map(a => a.name).join(', ')}`
  const closed = earlier ? [...earlier.upheld, ...earlier.disputed].filter(c => c.fixed || c.withdrawn || c.status === 'refuted').map(c => c.id) : []
  const found = items.length ? `${items.map(c => `${storyItem(c)}: ${storyRuling(c)}`).join('; ')}.` : 'Nothing new.'
  return `${head}: ${closed.length ? `Closed ${closed.join(', ')}. ` : ''}${found} ${todo.needed ? `To fix: ${storyTodo(todo)}.` : 'Nothing to fix.'}`
}

function repairStoryLine(S, W, round, fix, label) {
  const done = (fix?.addressed || []).filter(x => x?.ref).map(x => idOf(x.ref))
  const declined = S.declined.filter(d => d.round === round)
  return [`${W.name} ${label}.`, done.length && `Addressed ${done.join(', ')}.`,
    ...declined.map(d => `Declined ${idOf(d.ref)}: ${storyWords(d.why, 200) || 'no reason given'}.`), storyGate(S, W.L)].filter(Boolean).join(' ')
}
