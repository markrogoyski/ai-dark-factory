import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadLib, makeRun, addItem } from './lib.mjs'
import { validateResult } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { summarize } from '../plugins/dark-factory/lib/evaluate.mjs'

const L = loadLib()
const empty = s => s.enum ? s.enum[0] : s.type === 'object' ? Object.fromEntries(Object.entries(s.properties || {}).map(([k,v]) => [k,empty(v)])) : s.type === 'array' ? [] : s.type === 'string' ? '' : s.type === 'boolean' ? false : 0
const root = new URL('../', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function simulate(workflow, args = {}, behavior = {}) {
  const source = readFileSync(new URL(`plugins/dark-factory/workflows/${workflow}.js`, root), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
  const execute = new AsyncFunction('args','factoryRuntime','parallel','agent','phase','log',source)
  const calls = []; let repairs = 0, reviewCount = 0
  const run = '/repo/.council/demo', tree = () => String(behavior.stall ? 1 : repairs + 1).repeat(40)
  const criteria = [{ criterion: 'C1', status: 'met', note: 'Verified the boundary behavior.' }]
  const respond = async r => {
    calls.push(r)
    if (behavior.fail?.(r)) return null
    const v = empty(r.schema)
    if (r.role === 'intake') Object.assign(v, { status: 'ok', tier: 'simple', mode: 'implement', strategy: behavior.pair ? 'pair' : 'independent', reasons: 'Scoped implementation.' })
    else if (r.role === 'setup') Object.assign(v, { status: 'ok', runId: 'demo', runDir: run, repoRoot: '/repo', mode: 'implement', dirty: [], verify: 'check', baselinePasses: true, criteria: [{ id: 'C1', text: 'The boundary works.' }] })
    else if (r.role === 'checker') Object.assign(v, { measured: true, diff: { files: 1, added: 2, removed: 1, tree: tree() }, suite: { ran: true, passed: true, tail: 'pass' }, criteria,
      rulings: [...r.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', fixed: repairs && !behavior.stall ? 'yes' : 'no', note: 'Reproduced on the named snapshot.' })) })
    else if (r.role === 'panel') Object.assign(v, { rulings: [...r.prompt.matchAll(/^## \[([^\]]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'Confirmed defect.' })) })
    else if (r.role === 'auditor') {
      reviewCount++
      Object.assign(v, { summary: 'Checked the exact revision.', findings: reviewCount <= (behavior.findings || 0) ? [{ severity: 'major', kind: 'fact', statement: `Defect ${behavior.stall ? 1 : reviewCount}`, evidence: 'file.js:1 reproduces the wrong boundary.' }] : [] })
    } else if (r.role === 'seat') {
      if (r.key?.includes('repair')) repairs++
      if ('summary' in v) Object.assign(v, { summary: behavior.stall ? 'unchanged' : `revision ${repairs}` })
      if ('approach' in v) Object.assign(v, { approach: 'Fix the boundary.', worktreePath: r.cwd, verification: 'check passed', diff: 'diff', confidence: 4 })
    } else if (r.role === 'author') Object.assign(v, { status: 'done', design: 'Fix and test the boundary.', summary: 'Implemented.' })
    else if (r.role === 'reviewer' && 'version' in v) Object.assign(v, { complete: true, version: r.prompt.match(/^Version: (.+)$/m)[1], criteria, requiresDesignRevision: false })
    else if (r.role === 'reviewer') Object.assign(v, { complete: true, snapshotTree: tree(), criteria, verdict: 'sound', score: 8 })
    else if (r.role === 'compare') Object.assign(v, { ranking: [{ candidate: 1, rank: 1, why: 'Smallest complete change.' }], recommendation: 'adopt-one', mergePlan: 'No merge needed.' })
    if (behavior.modify) behavior.modify(v, r)
    validateResult(v, r.schema)
    return v
  }
  const runtime = {
    ...(behavior.clock ? { now: behavior.clock } : {}),
    agent: respond,
    turn: async r => { const result = await respond(r); return result && { status: 'done', result } },
    measure: async ({ label }) => ({ status: 'done', snapshot: { ref: `refs/council/demo/A-${label}`, tree: tree(), diff: `${run}/room/${label}/A.diff` }, suite: { ran: true, passed: true, tail: 'pass', command: 'check' } }),
  }
  const nativeAgent = (prompt, opts) => {
    const role = opts.label === 'setup' ? 'setup' : opts.label.startsWith('check ') ? 'checker'
      : opts.label.startsWith('r0:') ? 'seat' : opts.label.startsWith('ensemble-') ? 'reviewer' : opts.label === 'compare' ? 'compare' : null
    assert.ok(role, `Unexpected native call: ${opts.label}`)
    return respond({ ...opts, prompt, role, cwd: '/repo', vendor: 'claude' })
  }
  const result = await execute({ task: 'Fix the boundary', host: behavior.native ? 'claude' : 'codex', retro: false, ...args }, behavior.native ? null : runtime,
    async jobs => { const all = await Promise.allSettled(jobs.map(f => f())); const bad = all.find(x => x.status === 'rejected'); if (bad) throw bad.reason; return all.map(x => x.value) },
    behavior.native ? nativeAgent : () => { throw new Error('Unexpected native call') }, () => {}, () => {})
  return { result, calls, repairs }
}

test('factory can choose Pair independently of the complexity tier', async () => {
  const { result, calls } = await simulate('factory', {}, { pair: true })
  assert.equal(result.strategy, 'pair'); assert.equal(result.tier, 'simple')
  assert.equal(result.final.readiness.state, 'ready')
  assert.ok(calls.some(c => c.role === 'author'))
  assert.ok(!calls.some(c => ['panel','auditor'].includes(c.role)))
  assert.equal(result.metrics.strategy, 'pair')
})

test('explain performs only intake for Factory and no turns for explicit Pair or Ensemble', async () => {
  for (const workflow of ['factory', 'pair', 'ensemble']) {
    const { result, calls } = await simulate(workflow, { explain: true })
    assert.equal(result.status, 'explained'); assert.equal(result.execution, 'not-started')
    assert.deepEqual(calls.map(c => c.role), workflow === 'factory' ? ['intake'] : [])
    assert.ok(result.plan.requiredCLIs.includes('codex'))
    assert.equal(result.final.readiness.state, 'not-assessed')
  }
})

test('bounded repairs review every revision freshly and report the exact final snapshot', async () => {
  const { result, calls, repairs } = await simulate('factory', { repair: { maxPasses: 2 } }, { findings: 2 })
  assert.equal(repairs, 2, JSON.stringify(result))
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result.final.readiness))
  assert.match(result.final.snapshotRef, /A-repair2$/)
  const reviews = calls.filter(c => c.role === 'auditor')
  assert.equal(reviews.length, 3)
  assert.ok(reviews.every(r => r.fresh))
  assert.equal(new Set(reviews.map(r => r.threadKey)).size, 3)
  assert.ok(reviews[2].prompt.includes('/repair2/'))
})

test('stalled Simple repairs escalate with unresolved evidence and exhausted budgets remain incomplete', async () => {
  const stalled = await simulate('factory', { repair: { maxPasses: 4 } }, { findings: 1, stall: true })
  // Simple may escalate; evidence must never become a ready result merely because a repair ran.
  assert.equal(stalled.repairs, 1)
  assert.equal(stalled.result.factory.escalation.trigger, 'blocked')
  const capped = await simulate('pair', { maxTurns: 2 })
  assert.equal(capped.calls.length, 2)
  assert.equal(capped.result.final.readiness.state, 'incomplete')
  assert.match(capped.result.stopReason, /budget exhausted/)
})

test('unchanged repairs stop despite fresh checker wording', async () => {
  let checks = 0
  const stalled = await simulate('factory', { repair: { maxPasses: 4 } }, {
    findings: 1, stall: true,
    modify: (v, r) => { if (r.role === 'checker') v.criteria = v.criteria.map(c => ({ ...c, note: `Rechecked the same behavior, observation ${++checks}.` })) },
  })
  assert.equal(stalled.repairs, 1, 'rephrased evidence must not spend the remaining repair budget')
  assert.equal(stalled.result.factory.escalation.trigger, 'blocked')
})

test('repair progress ignores prose and order but detects changed artifacts and verification outcomes', () => {
  const { L, S } = makeRun()
  const p = S.pos.A
  p.tree = { hash: 'a'.repeat(40) }
  p.criteria = [{ criterion: 'C1', status: 'unmet', note: 'Wrong boundary.' }, { criterion: 'C2', status: 'met', note: 'Checked.' }]
  p.suite = { ran: true, passed: false, tail: 'Failed once.' }
  const finding = addItem(L, S, { author: 'XC', target: 'A', kind: 'finding', severity: 'major', status: 'verified' })
  const other = addItem(L, S, { author: 'XD', target: 'A', kind: 'finding', severity: 'major', status: 'verified' })
  const test = addItem(L, S, { id: 'TXC1', author: 'XC', target: 'A', kind: 'test', status: 'verified' })
  S.testResults[test.id] = { A: 'fail' }
  const signature = L.repairSignature(S, 'A')
  p.summary = 'A different account of the same work.'; p.suite.tail = 'Still failed.'
  p.criteria.reverse(); p.criteria.forEach(c => { c.note = 'Reworded evidence.' })
  finding.statement = 'A clearer description.'; finding.evidence = 'Reworded reproduction.'; S.ledger.reverse()
  assert.equal(L.repairSignature(S, 'A'), signature)
  const changes = [
    [() => { p.tree.hash = 'b'.repeat(40) }, () => { p.tree.hash = 'a'.repeat(40) }],
    [() => { finding.fixed = true }, () => { finding.fixed = false }],
    [() => { other.status = 'refuted' }, () => { other.status = 'verified' }],
    [() => { p.criteria.find(c => c.criterion === 'C1').status = 'met' }, () => { p.criteria.find(c => c.criterion === 'C1').status = 'unmet' }],
    [() => { p.suite.passed = true }, () => { p.suite.passed = false }],
    [() => { S.testResults[test.id].A = 'pass' }, () => { S.testResults[test.id].A = 'fail' }],
  ]
  for (const [change, restore] of changes) {
    change(); assert.notEqual(L.repairSignature(S, 'A'), signature); restore()
    assert.equal(L.repairSignature(S, 'A'), signature)
  }
  delete p.tree; p.artifactHash = 'design-hash-1'
  const design = L.repairSignature(S, 'A')
  p.summary = 'New summary of unchanged design.'
  assert.equal(L.repairSignature(S, 'A'), design)
  p.artifactHash = 'design-hash-2'
  assert.notEqual(L.repairSignature(S, 'A'), design)
})

test('Ensemble measures independent candidates and leaves choice and delivery explicit', async () => {
  const { result, calls } = await simulate('ensemble', { candidates: 2 })
  assert.equal(result.status, 'advisory', JSON.stringify(result))
  assert.equal(result.candidates.length, 2)
  assert.ok(result.candidates.every(c => c.final.readiness.state === 'ready'), JSON.stringify(result.candidates))
  assert.equal(new Set(result.candidates.map(c => c.final.worktree)).size, 2)
  assert.equal(result.delivery.status, 'pending-selection')
  assert.notEqual(result.final.readiness.state, 'ready')
  assert.deepEqual(result.metrics.candidates, { total: 2, ready: 2 })
  assert.ok(calls.filter(c => c.role === 'reviewer').every(c => c.fresh && c.checkout?.endsWith('-r0')))
})

test('Ensemble cannot hide a missing review, stale snapshot, or failed criterion', async () => {
  for (const behavior of [
    { fail: r => r.role === 'reviewer' },
    { modify: (v, r) => { if (r.role === 'reviewer') v.snapshotTree = 'f'.repeat(40) } },
    { modify: (v, r) => { if (r.role === 'reviewer') v.criteria[0].status = 'unmet' } },
  ]) {
    const { result } = await simulate('ensemble', { candidates: 2 }, behavior)
    assert.ok(result.candidates.every(c => c.final.readiness.state !== 'ready'))
  }
})

test('Ensemble runs through native Claude agents when the Codex adapter is absent', async () => {
  const { result, calls } = await simulate('ensemble', { candidates: 2 }, { native: true })
  assert.equal(result.status, 'advisory')
  assert.ok(result.candidates.every(c => c.final.readiness.state === 'ready'))
  assert.ok(calls.every(c => c.vendor === 'claude'))
  assert.deepEqual(calls.filter(c => c.role === 'seat').map(c => c.model), ['sonnet', 'sonnet'])
  assert.equal(calls.filter(c => c.role === 'reviewer').length, 4)
  assert.equal(result.metrics.host, 'claude')
})

test('repair policy validates bounds and lets callers report minor suggestions explicitly', () => {
  assert.throws(() => L.parseControls({ repair: { maxPasses: 0 } }), /maxPasses/)
  assert.throws(() => L.parseControls({ repair: { minor: 'ignore' } }), /minor/)
  assert.equal(L.parseControls({ repair: { minor: 'report' } }).repair.minor, 'report')
})

test('native string flags resolve controls without becoming part of the task', () => {
  const raw = L.parseArgs('--explain --strategy pair --max-turns 20 --repair-passes 2 Fix it')
  assert.equal(raw.task, 'Fix it'); assert.equal(raw.explain, true)
  assert.equal(L.parseControls(raw).maxTurns, 20)
  assert.equal(L.parseControls(raw).repair.maxPasses, 2)
  const pair = L.parsePairConfig('--author sol --explain --max-reviews 5 --max-turns 12 Fix it')
  assert.equal(pair.raw.explain, true); assert.equal(pair.pairOptions.maxReviews, 5)
  assert.equal(pair.controls.maxTurns, 12)
  const ensemble = L.parseEnsembleConfig('--candidates 2 --explain Fix it')
  assert.equal(ensemble.lineup.length, 2); assert.equal(ensemble.raw.explain, true)
})

test('explicit independent model choices are never silently discarded by Pair routing', () => {
  const state = { raw: { seats: ['astra', 'sol'] }, factory: { tier: 'feature' } }
  assert.equal(L.factoryStrategy(state, { strategy: 'pair', mode: 'implement' }), 'independent')
  state.raw.strategy = 'pair'
  assert.throws(() => L.factoryStrategy(state, { mode: 'implement' }), /does not accept seats/)
})

test('run time admission budget stops before another model turn', async () => {
  let tick = 1
  const { result, calls } = await simulate('pair', { maxRunMin: 1 }, { clock: () => tick++ === 1 ? 1 : 60002 })
  assert.equal(calls.length, 0)
  assert.equal(result.final.readiness.state, 'incomplete')
  assert.match(result.stopReason, /time budget/)
})

test('offline evaluation distinguishes missing evidence, failed delivery and matched tasks', () => {
  const metrics = { version: 1, host: 'codex', workflow: 'pair', strategy: 'pair', taskId: 'boundary', variant: 'baseline', turns: 4, elapsedMs: null, readiness: 'ready', findingsByStage: { code: { found: 1, fixed: 1 } } }
  const rows = [{ source: 'one', result: { metrics } }, { source: 'two', result: { metrics: { ...metrics, turns: 6, readiness: 'blocked' } }, delivery: { status: 'failed' } }]
  const out = summarize(rows), group = Object.values(out.groups)[0]
  assert.equal(group.turnsPerReadyResult, 10)
  assert.equal(group.deliveryUnknown, 1); assert.equal(group.deliveryFailed, 1)
  assert.equal(group.elapsedMsPerReadyResult, null); assert.equal(group.tokenMeasuredRuns, 0)
  assert.equal(Object.values(out.matchedTasks['boundary@revision-unknown'])[0].runs, 2)
})

test('evaluation counts specification amendments and advisory candidates separately from readiness', async () => {
  const state = L.newState(L.parseConfig({ task: 'Fix it' }))
  state.spec.findings.push({ id: 'S1', status: 'accepted' }, { id: 'S2', status: 'rejected' })
  state.spec.applied.push({ id: 'S1' })
  assert.deepEqual(JSON.parse(JSON.stringify(L.evaluationFacts(state, {}, null, 0).findingsByStage.specification)), { found: 2, upheld: 1, refuted: 1, amended: 1 })
  const { result } = await simulate('ensemble', { candidates: 2 }, { modify: (v, r) => {
    if (r.role === 'reviewer') { v.verdict = 'flawed-but-fixable'; v.defects = [{ severity: 'major', description: 'Boundary is wrong.', evidence: 'file.js:1' }] }
  } })
  assert.equal(result.metrics.findingsByStage.ensembleReview.found, 4)
  const group = Object.values(summarize([{ source: 'ensemble', result }]).groups)[0]
  assert.equal(group.candidates, 2); assert.equal(group.readyCandidates, 0); assert.equal(group.ready, 0)
  assert.equal(group.turnsPerReadyCandidate, null)
})
