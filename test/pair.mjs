// Shared pair engine exercised through both hosts, with no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLib } from './lib.mjs'
import { validateResult } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { contract, mapping, challenges, replay } from './fixtures/pair-contract.mjs'

const L = loadLib()
const root = new URL('../', import.meta.url)
const source = readFileSync(new URL('plugins/dark-factory/workflows/pair.js', root), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime', source)

function defaults(schema) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, defaults(v)]))
  if (schema.type === 'array') return []
  if (schema.type === 'string') return ''
  if (schema.type === 'boolean') return false
  return 0
}

const setup = () => ({ status: 'ok', mode: 'implement', runId: 'pair-test', runDir: '/repo/.council/pair-test', repoRoot: '/repo',
  head: 'b'.repeat(40),
  criteria: [{ id: 'C1', text: 'The requested behavior works.' }], refs: [], dirty: [], verify: 'node test.cjs', baselinePasses: true })
const measurement = (label, tree = 'a'.repeat(40)) => ({ status: 'done', error: '', snapshot: {
  ref: `refs/council/pair-test/A-${label}`, tree, diff: `/repo/.council/pair-test/room/${label}/A.diff`,
}, suite: { ran: true, passed: true, failureKind: '', tail: 'pass', command: 'node test.cjs' }, replay: replay(tree) })
const finding = statement => ({ severity: 'minor', statement, evidence: 'src/example.js:12 lacks the required case.' })

async function run(options = {}) {
  const calls = [], measurements = [], phases = []
  let reviewNumber = 0
  async function respond(prompt, schema, meta) {
    let value = defaults(schema)
    const kind = 'runDir' in schema.properties ? 'setup' : 'design' in schema.properties ? 'author'
      : 'version' in schema.properties ? 'review' : 'snapshot' in schema.properties ? 'measure' : 'unknown'
    const call = { ...meta, kind, prompt, schema }
    calls.push(call)
    if (kind === 'setup') Object.assign(value, setup(), options.setup)
    else if (kind === 'author') {
      Object.assign(value, { status: 'done', summary: 'Implemented the behavior.', design: 'Implement the behavior and cover it with tests.', notes: 'Continue with the boundary case.' })
      Object.assign(value, { testContract: contract(), replayMapping: mapping() })
      if (options.author) value = await options.author(value, call)
    } else if (kind === 'review') {
      Object.assign(value, { version: prompt.match(/^Version: (.+)$/m)[1], complete: true, summary: 'Reviewed.',
        requiresDesignRevision: false, criteria: [{ criterion: 'C1', status: 'met', note: 'Checked the behavior against the criterion.' }] })
      value.challenges = /# Review stage: design/.test(prompt) ? challenges() : []
      reviewNumber++
      if (options.review) value = await options.review(value, reviewNumber, call)
    } else if (kind === 'measure') {
      const label = prompt.match(/--label '([^']+)'/)[1]
      const replay = JSON.parse(prompt.match(/--replay-json '([^']+)'/)[1])
      Object.assign(value, await measure({ label, replay }))
    } else throw new Error(`Unexpected turn: ${kind}`)
    if (value === null) return null
    validateResult(value, schema)
    return value
  }
  async function measure(request) {
    measurements.push(request)
    const value = measurement(request.label, options.sameTree ? 'a'.repeat(40) : String(measurements.length).repeat(40))
    return options.measure ? options.measure(value, measurements.length) : value
  }
  async function agent(prompt, opts) {
    const match = prompt.match(/=====BEGIN PAYLOAD \S+=====\n([\s\S]*)\n=====END PAYLOAD/)
    if (!match) return respond(prompt, opts.schema, opts)
    const payload = match[1]
    const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const value = await respond(payload, schema, { ...opts, relay: true })
    return value && { status: 'done', result: value, seconds: 1 }
  }
  const runtime = options.native ? undefined : {
    agent: request => respond(request.prompt, request.schema, request),
    turn: async request => {
      const value = await respond(request.prompt, request.schema, request)
      return value && { status: 'done', result: value }
    }, measure,
  }
  const result = await execute(agent, () => { throw new Error('Pair must not launch a panel') }, null,
    title => phases.push(title), () => {}, { task: 'Implement the behavior', repo: '/repo', ...(options.native ? {} : { host: 'codex' }), ...options.args }, {}, null, runtime)
  return { result, calls, measurements, phases }
}

test('pair selects the author and opposite-vendor reviewer without council roles', () => {
  let c = L.parsePairConfig('Implement it')
  assert.equal(c.lineup[0].key, 'opus')
  assert.equal(c.auditors[0].key, 'astra')
  c = L.parsePairConfig({ task: 'Implement it', host: 'codex' })
  assert.equal(c.lineup[0].key, 'sol')
  assert.equal(c.auditors[0].key, 'opus')
  assert.deepEqual(L.externalVendors(c).sort(), ['claude', 'codex'])
  c = L.parsePairConfig('--author astra --reviewer sonnet --max-reviews 12 Implement it')
  assert.equal(c.lineup[0].key, 'astra')
  assert.equal(c.auditors[0].key, 'sonnet')
  assert.equal(c.pairOptions.maxReviews, 12)
  assert.deepEqual(c.panel, [])
  assert.deepEqual(c.specReviewers, [])
  for (const maxReviews of [0, 1, 101, 2.2, 'oops']) assert.throws(() => L.parsePairConfig({ task: 'x', maxReviews }), /maxReviews/)
  for (const key of ['tier', 'seats', 'audit', 'roles', 'evidence']) assert.throws(() => L.parsePairConfig({ task: 'x', [key]: false }), /not a pair option/)
})

test('pair completes design and code review in both hosts with fresh independent reviews', async () => {
  for (const native of [false, true]) {
    const { result, calls, measurements } = await run({ native })
    assert.equal(result.status, 'done')
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(result.delivery.status, 'pending')
    assert.equal(result.artifactType, 'dark-factory-result')
    assert.equal(result.artifactVersion, 1)
    assert.equal(result.summary.artifactType, 'dark-factory-summary')
    assert.equal(result.summary.artifactVersion, 1)
    assert.equal(calls.filter(c => c.kind === 'author').length, 2)
    assert.equal(calls.filter(c => c.kind === 'review').length, 2)
    assert.equal(result.summaryFile, undefined, 'persistence belongs to the host adapter')
    assert.equal(result.final.snapshotTree, '1'.repeat(40))
    assert.equal(result.final.snapshotRef, 'refs/council/pair-test/A-pair-code-2')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code'])
    assert.equal(measurements.length, 1)
    assert.deepEqual(measurements[0].replay, { testRoots: ['tests'], mapping: mapping() })
    assert.deepEqual(result.testContract, contract())
    assert.deepEqual(result.final.replay, replay(result.final.snapshotTree))
    const reviews = calls.filter(c => c.kind === 'review')
    const authors = calls.filter(c => c.kind === 'author')
    if (!native) {
      assert.ok(reviews.every(r => r.fresh && r.vendor === 'claude'))
      assert.equal(new Set(reviews.map(r => r.threadKey)).size, 2)
      assert.equal(new Set(authors.map(r => r.threadKey)).size, 1)
      assert.ok(authors.every(r => r.vendor === 'codex' && !r.fresh))
    } else assert.ok(reviews.every(r => r.relay))
    assert.ok(reviews.every(r => !r.prompt.includes('Continue with the boundary case.')), 'private notes never enter reviews')
    assert.match(authors[1].prompt, /Continue with the boundary case/)
    assert.ok(!calls.some(c => ['intake', 'panel', 'retro'].includes(c.role)))
  }
})

test('pair repeatedly fixes both stages, retaining findings until reviewer closure', async () => {
  const { result, calls } = await run({ review: (r, n) => {
    if (n === 1) r.findings = [finding('Design omits an edge case.')]
    if (n === 2) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The design now covers the boundary.' }]
    if (n === 3) r.findings = [finding('Implementation misses the boundary.')]
    if (n === 4) r.findings = [finding('Another case needs a regression test.')]
    if (n === 5) r.resolutions = ['P2', 'P3'].map(id => ({ id, status: 'fixed', evidence: 'Inspected code and regression tests.' }))
    return r
  } })
  assert.equal(result.status, 'done')
  assert.equal(result.reviews.length, 5)
  assert.ok(result.findings.every(f => f.status === 'fixed'))
  assert.equal(calls.filter(c => c.kind === 'author').length, 5)
  assert.equal(result.final.snapshotTree, '3'.repeat(40))
})

test('author claims and omission cannot close findings; unchanged work stalls', async () => {
  const { result } = await run({ sameTree: true, author: a => ({ ...a, addressed: [{ id: 'P1', response: 'Fixed.', evidence: 'Trust me.' }] }),
    review: (r, n) => { if (n === 2) r.findings = [finding('Still broken.')]; return r } })
  assert.equal(result.status, 'blocked')
  assert.match(result.stopReason, /stalled/)
  assert.equal(result.findings[0].status, 'open')
})

test('a clean review cannot hide failing or missing verification', async () => {
  for (const ran of [true, false]) {
    const { result } = await run({ args: { maxReviews: 3 }, measure: m => ({ ...m, suite: { ...m.suite, ran, passed: false, tail: 'failed' } }) })
    assert.notEqual(result.final.readiness.state, 'ready')
    assert.match(result.stopReason, ran ? /budget exhausted/ : /verification evidence remains incomplete/)
    assert.ok([...result.final.readiness.blocked, ...result.final.readiness.incomplete].some(s => /verification/i.test(s)))
  }
})

test('failed, incomplete, stale and unsupported reviews cannot approve', async () => {
  for (const change of [() => null, r => ({ ...r, complete: false }), r => ({ ...r, version: 'old' }),
    r => ({ ...r, resolutions: [{ id: 'P99', status: 'fixed', evidence: 'Invented ID.' }] }),
    r => ({ ...r, criteria: [] }), r => ({ ...r, criteria: [r.criteria[0], r.criteria[0]] })]) {
    const { result } = await run({ args: { maxReviews: 2 }, review: change })
    assert.notEqual(result.final.readiness.state, 'ready')
    assert.notEqual(result.status, 'done')
  }
})

test('measurement failure and a mismatched snapshot never reach code review', async () => {
  for (const change of [m => ({ ...m, status: 'error', error: 'Gate unavailable.' }), m => ({ ...m, snapshot: { ...m.snapshot, ref: 'other-ref' } }),
    m => ({ ...m, suite: { ...m.suite, command: 'true' } }), () => { throw new Error('Transport failed') }]) {
    const { result, calls } = await run({ measure: change })
    assert.equal(result.status, 'failed')
    assert.equal(calls.filter(c => c.kind === 'review').length, 1)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
})

test('budget exhaustion after design approval cannot report unbuilt work as ready', async () => {
  const { result } = await run({ args: { maxReviews: 2 }, review: (r, n) => {
    if (n === 1) r.findings = [finding('Missing design detail.')]
    else r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The revised design covers it.' }]
    return r
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(result.final.snapshotRef, null)
  assert.notEqual(result.final.readiness.state, 'ready')
})

test('code findings can reopen design review without being closed by a plan', async () => {
  const { result, calls } = await run({ review: (r, n) => {
    if (n === 2) { r.findings = [finding('Approach cannot handle streaming.')]; r.requiresDesignRevision = true }
    if (n === 4) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The new implementation handles streams.' }]
    return r
  } })
  assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code', 'design', 'code'])
  assert.equal(result.status, 'done')
  assert.equal(result.findings[0].history[0].review, 4)
  assert.equal(calls.filter(c => c.kind === 'review')[2].checkout, 'A-pair-code-2', 'revised design review sees current implementation')
})

test('dirty trees, absent references and missing criteria stop before author turns', async () => {
  for (const fixture of [{ dirty: [' M source.js'] }, { criteria: [] }, { refs: [{ source: '/plan', path: '/outside/plan', inWorktrees: false }] }]) {
    const { result, calls } = await run({ setup: fixture })
    assert.equal(result.status, 'blocked')
    assert.equal(calls.filter(c => c.kind === 'author').length, 0)
  }
  const { result } = await run({ args: { allowDirty: true }, setup: { dirty: [' M source.js'] } })
  assert.equal(result.status, 'done')
})

test('author questions and failures return unresolved results without inventing review approval', async () => {
  for (const status of ['needs-user', 'blocked']) {
    const { result } = await run({ author: a => ({ ...a, status, questions: ['Which compatibility behavior is required?'] }) })
    assert.equal(result.status, status)
    assert.equal(result.questions.length, 1)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
  const { result } = await run({ author: () => null })
  assert.equal(result.status, 'failed')
})

test('pair prompts have reviewed golden coverage', async () => {
  const { calls } = await run({ native: true, review: (r, n) => {
    if (n === 1) r.findings = [finding('Cover the boundary case.')]
    if (n === 2) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The boundary appears in the design.' }]
    return r
  } })
  const dir = new URL('test/golden/pair/', root)
  if (process.env.UPDATE_GOLDEN) mkdirSync(dir, { recursive: true })
  for (const [i, call] of calls.entries()) {
    const file = new URL(`${i}-${call.kind}.txt`, dir)
    const value = call.prompt.replace(/\n*$/, '\n')
    if (process.env.UPDATE_GOLDEN) writeFileSync(file, value)
    else assert.equal(value, readFileSync(file, 'utf8'), `Prompt changed: ${fileURLToPath(file)}`)
  }
})

test('design challenges must uniquely cover every criterion with substantive valid references', async () => {
  for (const change of [() => [], c => [c[0], c[0]], c => [{ ...c[0], criterion: 'invented' }],
    c => [{ ...c[0], wrongImplementation: ' ' }], c => [{ ...c[0], rejectingCheckIds: [] }],
    c => [{ ...c[0], rejectingCheckIds: ['missing'] }], c => [{ ...c[0], rejectingCheckIds: ['T1', 'T1'] }]]) {
    const { result, measurements, calls } = await run({ review: r => ({ ...r, challenges: change(r.challenges) }) })
    assert.notEqual(result.status, 'done')
    assert.equal(measurements.length, 0)
    assert.match(result.stopReason, /challenge/i)
    assert.equal(calls.filter(c => c.kind === 'review').length, 2, 'one bounded correction before stopping')
  }
  const state = { criteria: [{ id: 'C1' }, { id: 'C2' }], pair: { testContract: contract() } }
  const inspect = { ...contract().checks[0], id: 'I1', criteria: ['C2'], kind: 'inspection', file: '', command: '',
    inspection: 'Read the API reference and compare the named parameters to the exported signature.', reason: 'A prose-only requirement.' }
  state.pair.testContract.checks.push(inspect)
  const review = { challenges: [...challenges(), { criterion: 'C2', wrongImplementation: 'Document the wrong parameter order.', rejectingCheckIds: ['I1'] }] }
  assert.equal(L.pairChallengeError(state, review), null)
  review.challenges[1].rejectingCheckIds = ['T1']
  assert.match(L.pairChallengeError(state, review), /covering that criterion/)
  state.pair.testContract.checks[2].reason = ''
  assert.match(L.pairContractError(state, state.pair.testContract), /reason/)
})

test('one invalid author contract gets corrected without spending a review or losing the design', async () => {
  for (const native of [false, true]) for (const mutate of [
    c => { c.testRoots[0].evidence = '' }, c => { c.checks[0].criteria = ['UNKNOWN'] },
    c => { c.checks[0].fixtures = ['src/helper.js'] }, c => { c.checks[0].boundaries = '' },
  ]) {
    let authors = 0
    const { result, calls } = await run({ native, author: a => { if (++authors === 1) mutate(a.testContract); return a } })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code'])
    const turns = calls.filter(c => c.kind === 'author')
    assert.equal(turns.length, 3)
    assert.match(turns[1].prompt, /Correct the previous output/)
    assert.match(turns[1].prompt, /Implement the behavior and cover it with tests/)
    assert.notEqual(turns[0].label, turns[1].label)
    assert.match(result.notes.join(' '), /one author correction/)
  }
  const { result, calls } = await run({ author: a => { a.testContract.checks[0].boundaries = ''; return a } })
  assert.notEqual(result.status, 'done')
  assert.equal(calls.filter(c => c.kind === 'author').length, 2)
  assert.equal(result.reviews.length, 0)
})

test('malformed challenges get one fresh correction and remain subject to the turn budget', async () => {
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, review: (r, n) => ({ ...r, challenges: n === 1 ? [] : r.challenges }) })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code'])
    const reviews = calls.filter(c => c.kind === 'review')
    assert.equal(reviews.length, 3)
    assert.match(reviews[1].prompt, /Correct the previous structured review/)
    if (!native) {
      assert.ok(reviews.every(r => r.fresh))
      assert.equal(new Set(reviews.map(r => r.threadKey)).size, 3)
    }
  }
  const { result, calls } = await run({ args: { maxTurns: 2 }, author: a => { a.testContract.checks = []; return a } })
  assert.notEqual(result.status, 'done')
  assert.match(result.stopReason, /turn budget/)
  assert.equal(calls.filter(c => c.kind === 'author').length, 1)
})

test('reviewers can identify a missing rejecting check and obtain a design revision', async () => {
  for (const native of [false, true]) for (const rejection of ['criterion', 'finding', 'design']) {
    const { result, calls } = await run({ native, review: (r, n) => {
      if (n === 1) {
        r.challenges[0].rejectingCheckIds = []
        if (rejection === 'finding') r.findings = [finding('The contract cannot reject the wrong boundary value.')]
        else if (rejection === 'criterion') r.criteria[0] = { criterion: 'C1', status: 'partial', note: 'No contracted check distinguishes the boundary.' }
        else { r.requiresDesignRevision = true; r.summary = 'Revise the contract to reject the wrong boundary value.' }
      }
      if (n === 2 && rejection === 'finding') r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The revised check rejects the wrong boundary.' }]
      return r
    } })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'design', 'code'])
    assert.deepEqual(result.reviews[0].challenges[0].rejectingCheckIds, [])
    assert.ok(!calls.some(c => c.prompt.includes('# Correct the previous structured review')))
    assert.equal(result.findings.length, rejection === 'finding' ? 1 : 0)
    if (rejection === 'finding') assert.equal(result.findings[0].status, 'fixed')
  }
})

test('contract identity binds design review and malformed contracts cannot pass', async () => {
  const state = { pair: { ...L.newPairState(), design: 'Design', testContract: contract() } }
  const version = L.pairVersion(state)
  state.pair.testContract.checks[0].expected = 'Different expectation'
  assert.notEqual(L.pairVersion(state), version)
  for (const mutate of [c => { c.checks = [] }, c => { c.checks.push(c.checks[0]) },
    c => { c.testRoots[0].path = '.' }, c => { c.testRoots[0].evidence = '' },
    c => { c.checks[0].file = '../source.cjs' }, c => { c.checks[0].expected = '' }]) {
    const { result } = await run({ author: a => { mutate(a.testContract); return a } })
    assert.notEqual(result.status, 'done')
  }
})

test('base fatal, pass, timeout and tool errors remain raw evidence for both reviewers', async () => {
  for (const native of [true, false]) for (const outcome of ['fatal', 'pass', 'timeout', 'tool-error', 'launch-error']) {
    const { result, calls } = await run({ native, measure: m => {
      const b = m.replay.records[0]
      if (outcome === 'fatal') { b.exitCode = 255; b.tail = 'Fatal: new API not found before test discovery' }
      if (outcome === 'pass') { b.exitCode = 0; b.passed = true }
      if (outcome === 'timeout') { b.timedOut = true; b.exitCode = -9; b.signal = 9 }
      if (outcome === 'tool-error') { b.exitCode = 127; b.tail = 'tool not found' }
      if (outcome === 'launch-error') { b.ran = false; b.hasExitCode = false; b.launchError = 'cannot spawn' }
      return m
    } })
    assert.equal(result.final.readiness.state, 'ready', outcome)
    assert.equal(result.reviews.length, 2)
    const code = calls.filter(c => c.kind === 'review').at(-1)
    assert.ok(code.prompt.includes(JSON.stringify(result.final.replay.records[0])))
    assert.match(code.prompt, /contract is a floor/)
    assert.ok(result.final.replay.records.some(r => r.side === 'base' && r.checkIds.includes('T2') && r.passed))
  }
})

test('missing replay obligations and failed final executions prevent readiness despite approval', async () => {
  for (const native of [true, false]) for (const outcome of ['wrong-base', 'missing-base', 'unscheduled-base', 'empty-base', 'empty-final', 'missing-final', 'failed-final', 'missing-mapping', 'wrong-tree', 'wrong-command', 'mutated-final']) {
    const { result } = await run({ native, args: { maxReviews: 2 }, measure: m => {
      if (outcome === 'missing-base') m.replay.records = m.replay.records.filter(r => r.side !== 'base')
      if (outcome === 'unscheduled-base') m.replay.records[0].attempted = false
      if (outcome === 'wrong-base') {
        m.replay.base = 'f'.repeat(40)
        for (const r of m.replay.records.filter(r => r.side === 'base')) r.revision = m.replay.base
      }
      if (outcome === 'empty-base') m.replay.records[0].hasExitCode = false
      if (outcome === 'empty-final') m.replay.records[1].hasExitCode = false
      if (outcome === 'missing-final') m.replay.records = m.replay.records.filter(r => r.side !== 'final')
      if (outcome === 'failed-final') { m.replay.records[1].exitCode = 1; m.replay.records[1].passed = false }
      if (outcome === 'mutated-final') m.replay.records[1].mutated = ['source.cjs']
      if (outcome === 'missing-mapping') m.replay.mapping = []
      if (outcome === 'wrong-tree') m.replay.snapshotTree = 'f'.repeat(40)
      if (outcome === 'wrong-command') m.replay.records[1].command = 'true'
      return m
    } })
    assert.notEqual(result.status, 'done', outcome)
    assert.equal(result.final.readiness.state, ['failed-final', 'mutated-final'].includes(outcome) ? 'blocked' : 'incomplete', outcome)
  }
  const { result } = await run({ args: { maxReviews: 2 }, author: a => ({ ...a, replayMapping: [] }), measure: m => {
    m.replay.mapping = []; m.replay.records = []; return m
  } })
  assert.match(result.final.readiness.incomplete.join(' '), /No replay mapping for T1/)
})

test('setup proposals preserve the original task for author and reviewer and conflicts park immediately', async () => {
  const { result, calls } = await run({ setup: { repositoryNotes: 'CHANGELOG.md:3 already has the heading. Proposal: append to it.' } })
  assert.equal(result.final.readiness.state, 'ready')
  for (const c of calls.filter(c => ['author', 'review'].includes(c.kind))) {
    assert.match(c.prompt, /# Task\n\nImplement the behavior/)
    assert.match(c.prompt, /CHANGELOG.md:3/)
  }
  assert.equal(result.task, 'Implement the behavior')
  assert.ok(!('effectiveTask' in calls[0].schema.properties))
  assert.match(calls.find(c => c.kind === 'review').prompt, /setup notes cannot waive requirements/)
  const blocked = await run({ setup: { status: 'needs-user', error: 'Two incompatible requirements.', questions: ['Which signature is required?'] } })
  assert.equal(blocked.result.status, 'needs-user')
  assert.deepEqual(blocked.result.questions, ['Which signature is required?'])
  assert.equal(blocked.calls.filter(c => c.kind === 'author').length, 0)
})

test('a whole-suite preservation obligation uses exact snapshot gate evidence without a directory replay', async () => {
  const author = value => {
    value.testContract.checks.push({ ...value.testContract.checks[1], id: 'SUITE', kind: 'gate', file: '', command: 'node test.cjs' })
    return value
  }
  const { result, measurements } = await run({ author })
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result.final.readiness))
  assert.equal(measurements.length, 1)
  assert.ok(measurements[0].replay.mapping.every(e => e.file !== 'tests'))
  for (const command of ['', 'other gate']) {
    const rejected = await run({ author: v => { author(v); v.testContract.checks.at(-1).command = command; return v } })
    assert.notEqual(rejected.result.final.readiness.state, 'ready')
    assert.equal(rejected.measurements.length, 0)
  }
})

test('invalid executable mappings stop before measurement and cannot spend another review', async () => {
  const { result, measurements } = await run({ author: v => { v.replayMapping[0].file = 'tests'; return v } })
  assert.equal(measurements.length, 0)
  assert.match(result.stopReason, /Whole-suite obligations use kind=gate/)
  assert.notEqual(result.final.readiness.state, 'ready')
})

test('clean review with missing evidence returns incomplete without another author or reviewer', async () => {
  const { result, calls, measurements } = await run({ args: { maxReviews: 8 }, measure: m => { m.replay.records = []; return m } })
  assert.equal(result.final.readiness.state, 'incomplete')
  assert.doesNotMatch(result.stopReason, /stalled/)
  assert.equal(calls.filter(c => c.kind === 'review').length, 2)
  assert.equal(calls.filter(c => c.kind === 'author').length, 2)
  assert.equal(measurements.length, 1)
})

test('infrastructure-only failure does not cycle through further author turns', async () => {
  const { result, calls } = await run({ measure: m => { m.suite.passed = false; m.suite.failureKind = 'infrastructure'; return m },
    review: (r, n) => { if (n === 2) r.findings = [finding('Gate socket infrastructure failed.')]; return r } })
  assert.match(result.stopReason, /Verification infrastructure failed/)
  assert.equal(result.reviews.length, 2)
  assert.equal(calls.filter(c => c.kind === 'author').length, 2)
})

test('repeated identical findings retain their identity and do not defeat stall detection', async () => {
  const { result } = await run({ sameTree: true, review: r => { r.findings = [finding('Resolve the same conflict.')]; return r } })
  assert.match(result.stopReason, /stalled/)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].id, 'P1')
})


test('unchanged unmet criteria and failed checks stall even without findings', async () => {
  for (const obligation of ['criterion', 'suite', 'replay']) {
    const { result } = await run({ sameTree: true, args: { maxReviews: 8 },
      review: (r, n) => { if (obligation === 'criterion' && n > 1) r.criteria[0].status = 'unmet'; return r },
      measure: m => {
        if (obligation === 'suite') m.suite.passed = false
        if (obligation === 'replay') m.replay.records.find(r => r.side === 'final').passed = false
        return m
      } })
    assert.match(result.stopReason, /stalled.*unmet criteria or verification results/, obligation)
    assert.equal(result.reviews.length, 3, obligation)
    assert.equal(result.findings.length, 0, obligation)
    assert.notEqual(result.final.readiness.state, 'ready', obligation)
  }
})

test('changed criterion and verification outcomes count as progress on the same tree', async () => {
  for (const obligation of ['criterion', 'suite']) {
    const { result } = await run({ sameTree: true, args: { maxReviews: 8 },
      review: (r, n) => { if (obligation === 'criterion' && n === 2) r.criteria[0].status = 'unmet'; return r },
      measure: (m, n) => { if (obligation === 'suite' && n === 1) m.suite.passed = false; return m } })
    assert.equal(result.status, 'done', obligation)
    assert.equal(result.reviews.length, 3, obligation)
    assert.doesNotMatch(result.stopReason, /stalled/, obligation)
  }
})

test('reviewers can reword an existing finding through its ID without duplicating it', async () => {
  let revision = 0
  const { result } = await run({ review: (r, n) => {
    if (n === 1) r.findings = [finding('The boundary case lacks coverage.')]
    if (n === 2) r.resolutions = [{ id: 'P1', status: 'open', evidence: 'The new case still accepts a wrong upper limit.' }]
    if (n === 3) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The boundary assertion now rejects the upper-limit defect.' }]
    return r
  }, author: a => ({ ...a, design: a.design + ++revision }) })
  assert.equal(result.status, 'done')
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].id, 'P1')
  assert.equal(result.findings[0].status, 'fixed')
})
