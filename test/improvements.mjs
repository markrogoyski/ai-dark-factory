import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLib, makeRun, addItem } from './lib.mjs'
import { summarize, evaluateFiles, fillNativeMetrics } from '../plugins/dark-factory/lib/evaluate.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulate } from './fixtures/simulate.mjs'

const L = loadLib()

test('factory can choose Pair independently of the complexity tier', async () => {
  const { result, calls } = await simulate('factory', {}, { pair: true })
  assert.equal(result.strategy, 'pair'); assert.equal(result.tier, 'simple')
  assert.equal(result.final.readiness.state, 'ready')
  assert.ok(calls.some(c => c.role === 'author'))
  assert.ok(!calls.some(c => ['panel','auditor'].includes(c.role)))
  assert.equal(result.metrics.strategy, 'pair')
})

test('a factory pair run records its facts with the factory roles and reuses the measured gate', async () => {
  const { result, calls } = await simulate('factory', { retro: undefined }, { pair: true })
  const record = calls.find(c => c.role === 'record')
  assert.ok(record, 'the pair strategy records the run facts')
  assert.ok(record.payload.includes('the pair strategy') && record.payload.includes('Verification command: `check`'))
  assert.equal(result.strategy, 'pair'); assert.ok(result.retro && result.retro.recorded)
  assert.ok(calls.some(c => c.role === 'author' && 'process' in c.schema.properties), 'pair turns can leave process notes')
  const design = calls.find(c => c.role === 'author')
  assert.ok(design.prompt.includes('Setup ran the verification command on the base revision, and it passed'))
  const codeReview = calls.filter(c => c.role === 'reviewer').at(-1)
  assert.ok(codeReview.prompt.includes("don't rerun the verification command"))
})

test('a standalone pair run still has no retro', async () => {
  const { result, calls } = await simulate('pair', { retro: undefined })
  assert.ok(!calls.some(c => ['record', 'retro'].includes(c.role)))
  assert.equal(result.retro, undefined)
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

test('native workflows reject unsupported elapsed limits without reading the wall clock', async () => {
  const saved = Date.now
  Date.now = () => { throw new Error('Native workflows cannot read Date.now') }
  try {
    for (const workflow of ['factory', 'council', 'pair', 'ensemble']) {
      await assert.rejects(() => simulate(workflow, { maxRunMin: 1 }, { native: true }), /maxRunMin requires the standalone.*replay-safe clock/)
    }
    assert.equal((await simulate('ensemble', { candidates: 2, maxTurns: 1 }, { native: true })).result.status, 'blocked')
  } finally { Date.now = saved }
})

test('Pair measurements propagate checkpoint mismatches and host limits remain run limits', async () => {
  const error = Object.assign(new Error('Checkpoint request changed'), { code: 'CHECKPOINT_MISMATCH' })
  await assert.rejects(() => simulate('pair', {}, { measureError: error }), e => e === error)
  const limit = Object.assign(new Error('Run turn budget exhausted (2).'), { code: 'RUN_LIMIT' })
  const { result, calls } = await simulate('pair', {}, { error: limit })
  assert.equal(calls.length, 1)
  assert.equal(result.status, 'blocked')
  assert.equal(result.stopReason, limit.message)
})

test('a new approach defect in the final Simple repair review escalates with its evidence', async () => {
  let reviews = 0
  const { result, repairs, calls } = await simulate('factory', {}, {
    findings: 2,
    modify: (v, r) => {
      if (r.role === 'auditor' && ++reviews === 2) v.findings[0].kind = 'judgment'
    },
  })
  assert.equal(repairs, 1)
  assert.equal(result.factory.escalation.trigger, 'design-finding')
  assert.equal(result.factory.escalation.to, 'feature')
  assert.ok(calls.some(c => c.role === 'seat' && c.prompt.includes('Upheld finding: major: Defect 2')))
})

test('evaluation reads both native token formats and excludes legacy idle-inclusive timing', () => {
  const metrics = { version: 1, host: 'claude', workflow: 'factory', strategy: 'independent', turns: 1, readiness: 'ready',
    elapsedMs: 1000000, elapsedFrom: 'setup' }
  const tokens = { external: { model: { turns: 1, input_tokens: 10 } }, claude: { model: { messages: 2, input_tokens: 5, output_tokens: 3 } } }
  const rows = [tokens, { records: 3, byModel: { model: { input_tokens: 15, output_tokens: 3 } } }, { external: {}, claude: {} }]
    .map((tokens, i) => ({ source: String(i), result: { metrics: { ...metrics, tokens } } }))
  const group = Object.values(summarize(rows).groups)[0]
  assert.equal(group.timedRuns, 0)
  assert.equal(group.tokenMeasuredRuns, 2)
  assert.deepEqual(group.tokensByModel, { model: { input_tokens: 30, output_tokens: 6 } })
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

test('each ensemble review condition independently decides candidate readiness', async () => {
  const states = async modify => {
    const { result } = await simulate('ensemble', { candidates: 2 }, { modify: (v, r) => { if (r.role === 'reviewer') modify(v) } })
    return result.candidates.map(c => c.final.readiness.state)
  }
  const defect = severity => [{ severity, description: 'Boundary is wrong.', evidence: 'file.js:1' }]
  assert.deepEqual(await states(() => {}), ['ready', 'ready'])
  assert.deepEqual(await states(v => { v.defects = defect('minor') }), ['ready', 'ready'])
  assert.deepEqual(await states(v => { v.verdict = 'flawed-but-fixable' }), ['blocked', 'blocked'])
  assert.deepEqual(await states(v => { v.defects = defect('major') }), ['blocked', 'blocked'])
  assert.deepEqual(await states(v => { v.defects = defect('blocker') }), ['blocked', 'blocked'])
  assert.deepEqual(await states(v => { v.criteria = [{ ...v.criteria[0], status: 'unmet' }] }), ['blocked', 'blocked'])
  assert.deepEqual(await states(v => { v.criteria = [{ ...v.criteria[0], note: '' }] }), ['incomplete', 'incomplete'])
  assert.deepEqual(await states(v => { v.criteria = [] }), ['incomplete', 'incomplete'])
  assert.deepEqual(await states(v => { v.criteria = [v.criteria[0], v.criteria[0]] }), ['incomplete', 'incomplete'])
})

test('run-plan specification questions do not force independent attempts after intake selects Pair', async () => {
  const { result, calls } = await simulate('factory', { spec: 'ask' }, { pair: true })
  assert.equal(result.strategy, 'pair')
  assert.equal(result.final.readiness.state, 'ready')
  assert.ok(!calls.some(c => ['panel', 'auditor'].includes(c.role)))
})


test('intake prompts remain stable when resume caps increase on either host', () => {
  for (const host of ['claude', 'codex']) {
    const intakeLimits = host === 'codex' ? { maxTurns: 20, maxRunMin: 60 } : undefined
    const state = maxTurns => makeRun({ args: { host, maxTurns, ...(intakeLimits ? { intakeLimits } : {}) } }).S
    const before = L.intakePrompt(state(20)), after = L.intakePrompt(state(40))
    assert.equal(after, before)
    if (host === 'codex') assert.match(before, /60 minutes and 20 model turns/)
    else assert.doesNotMatch(before, /# Execution budget/)
  }
})

test('factory and pair setup turn uncovered required checks into criteria; council and supplied criteria do not', () => {
  const rule = /Don't drop a requirement because no command can check it/
  const pair = L.newState(L.parsePairConfig('Fix it'))
  assert.match(L.pairSetupPrompt(pair), rule)
  const simple = L.newState(L.parseConfig({ task: 'Fix it' }, { workflow: 'factory', tier: 'simple' }))
  assert.match(L.setupPrompt(simple), rule)
  assert.doesNotMatch(L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix it' }))), rule)
  assert.doesNotMatch(L.pairSetupPrompt(L.newState(L.parsePairConfig({ task: 'Fix it', criteria: ['It works.'] }))), rule)
})

test('evaluation times a native result from its helper timeline and prefers a recorded elapsedMs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-eval-'))
  const at = minute => new Date(Date.UTC(2026, 10, 11, 12, minute)).toISOString()
  writeFileSync(join(dir, 'timeline.jsonl'), [[0, 'init'], [2, 'job-start', 'review-pair-design-1'], [40, 'job-end', 'review-pair-design-1'], [45, 'measure']]
    .map(([m, event, job]) => JSON.stringify({ at: at(m), event, job: job || null })).join('\n') + '\n')
  const base = { version: 1, workflow: 'pair', strategy: 'pair', turns: 4, readiness: 'ready' }
  const write = (name, metrics) => { const file = join(dir, name); writeFileSync(file, JSON.stringify({ runDir: dir, metrics })); return file }
  const native = write('native.json', { ...base, host: 'claude', elapsedMs: null })
  let group = Object.values(evaluateFiles([native]).groups)[0]
  assert.equal(group.elapsedMs, 45 * 60_000)
  assert.deepEqual(group.elapsedSources, { 'helper-timeline': 1 })
  const recorded = write('recorded.json', { ...base, host: 'codex', elapsedMs: 1234 })
  group = Object.values(evaluateFiles([recorded]).groups)[0]
  assert.equal(group.elapsedMs, 1234)
  assert.deepEqual(group.elapsedSources, { recorded: 1 })
})

// Native results record tokens: null; the helper's usage.jsonl holds the external CLI turns only.
test('evaluation reads a native result\'s helper usage, labelled as excluding native Claude turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-eval-'))
  writeFileSync(join(dir, 'usage.jsonl'), [
    { job: 'review-pair-design-1', seat: 'PR', model: 'gpt-6-astra', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, seconds: 30 },
    { job: 'review-pair-code-2', seat: 'PR', model: 'gpt-6-astra', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 }, seconds: 20 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const base = { version: 1, workflow: 'pair', strategy: 'pair', turns: 4, readiness: 'ready', elapsedMs: 1000 }
  const write = (name, result) => { const file = join(dir, name); writeFileSync(file, JSON.stringify({ runDir: dir, ...result })); return file }
  const native = fillNativeMetrics({ runDir: dir, metrics: { ...base, host: 'claude', tokens: null } }).metrics
  assert.deepEqual(native.tokens, { records: 2, byModel: { 'gpt-6-astra': { input_tokens: 150, cached_input_tokens: 60, output_tokens: 15 } } })
  assert.equal(native.tokenSource, 'helper-usage')
  assert.equal(native.nativeClaudeTurnsIncluded, false)
  let group = Object.values(evaluateFiles([write('native.json', { metrics: { ...base, host: 'claude', tokens: null } })]).groups)[0]
  assert.equal(group.tokenMeasuredRuns, 1)
  assert.deepEqual(group.tokenSources, { 'helper-usage': 1 })
  assert.deepEqual(group.tokensByModel, { 'gpt-6-astra': { input_tokens: 150, cached_input_tokens: 60, output_tokens: 15 } })
  // Recorded totals (the Codex host and runtime "cli", or native facts already filled by retro) stay as recorded.
  const recordedTokens = { records: 3, byModel: { opus: { input_tokens: 7, output_tokens: 2 } } }
  for (const host of ['codex', 'claude']) {
    group = Object.values(evaluateFiles([write(`${host}.json`, { metrics: { ...base, host, tokens: recordedTokens } })]).groups)[0]
    assert.deepEqual(group.tokensByModel, recordedTokens.byModel, host)
    assert.deepEqual(group.tokenSources, { recorded: 1 }, host)
  }
  // A Codex result without tokens is not filled from the run directory.
  group = Object.values(evaluateFiles([write('codex-null.json', { metrics: { ...base, host: 'codex', tokens: null } })]).groups)[0]
  assert.equal(group.tokenMeasuredRuns, 0)
  assert.deepEqual(group.tokenSources, {})
  // An unreadable usage.jsonl is reported, not fatal.
  writeFileSync(join(dir, 'usage.jsonl'), '{not json\n')
  const broken = fillNativeMetrics({ runDir: dir, metrics: { ...base, host: 'claude', tokens: null } }).metrics
  assert.equal(broken.tokens, null)
  assert.match(broken.tokenError, /JSON/)
})

const freshState = () => L.newState(L.parseConfig({ task: 'Fix the parser' }))

// The history a rebuilt factory state keeps: see carriedState in src/lib/state.js.
const CARRIED = ['notes', 'processNotes', 'relayFailures', 'turnLog', 'vendorTimes']

test('carriedState carries the diagnostic history and nothing else', () => {
  const S = freshState()
  S.turnLog.push({ turn: 'intake', role: 'intake', vendor: 'claude', ok: true })
  S.processNotes.push({ turn: 'intake', role: 'intake', who: 'opus', text: 'slow' })
  S.notes.push('a note')
  S.relayFailures.push({ turn: 'x', model: 'm', status: 'relay ended', error: 'e' })
  S.vendorTimes.push({ turn: 'x', vendor: 'codex', seconds: 12 })
  const c = L.carriedState(S)
  assert.deepEqual(Object.keys(c).sort(), CARRIED)
  for (const k of CARRIED) assert.deepEqual(c[k], S[k], k)
})

test('carriedState copies the arrays, so the discarded state cannot alias the new one', () => {
  const S = freshState()
  S.relayFailures.push({ turn: 'x', model: 'm', status: 'relay ended', error: 'e' })
  const c = L.carriedState(S)
  for (const k of CARRIED) assert.notEqual(c[k], S[k], k)
  S.relayFailures.push({ turn: 'y' })
  assert.equal(c.relayFailures.length, 1)
})

test('per-attempt state is not carried: a rebuilt state starts clean apart from the history', () => {
  const old = freshState()
  old.relayFailures.push({ turn: 'x', model: 'm', status: 'relay ended', error: 'e' })
  old.ledger.push({ id: '1A1' }); old.byId['1A1'] = old.ledger[0]
  old.criteria.push({ id: 'C1', text: 'c' }); old.verify = 'make test'; old.baselineOk = false
  old.seats.push({ L: 'A', active: true }); old.pos.A = { round: 1 }; old.votes[1] = { A: {} }
  old.blocked.codex = true; old.longPosts.push({ turn: 'r1A', words: 9999 }); old.lastRound = 3
  old.run = { runId: 'r', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
  const next = freshState()
  Object.assign(next, L.carriedState(old))
  assert.deepEqual(next.relayFailures, old.relayFailures)
  const clean = freshState()
  for (const k of Object.keys(clean).filter(k => !CARRIED.includes(k))) assert.deepEqual(next[k], clean[k], `${k} starts clean`)
})
