// Shared pair engine exercised through both hosts, with no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLib } from './lib.mjs'
import { validateResult } from '../plugins/dark-factory/lib/codex-runner.mjs'

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
  criteria: [{ id: 'C1', text: 'The requested behavior works.' }], refs: [], dirty: [], verify: 'node test.cjs', baselinePasses: true })
const measurement = (label, tree = 'a'.repeat(40)) => ({ status: 'done', error: '', snapshot: {
  ref: `refs/council/pair-test/A-${label}`, tree, diff: `/repo/.council/pair-test/room/${label}/A.diff`,
}, suite: { ran: true, passed: true, tail: 'pass', command: 'node test.cjs' } })
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
      if (options.author) value = await options.author(value, call)
    } else if (kind === 'review') {
      Object.assign(value, { version: prompt.match(/^Version: (.+)$/m)[1], complete: true, summary: 'Reviewed.',
        requiresDesignRevision: false, criteria: [{ criterion: 'C1', status: 'met', note: 'Checked the behavior against the criterion.' }] })
      reviewNumber++
      if (options.review) value = await options.review(value, reviewNumber, call)
    } else if (kind === 'measure') {
      const label = prompt.match(/--label '([^']+)'/)[1]
      Object.assign(value, await measure({ label }))
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
    assert.equal(result.final.snapshotTree, '1'.repeat(40))
    assert.equal(result.final.snapshotRef, 'refs/council/pair-test/A-pair-code-2')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code'])
    assert.equal(measurements.length, 1)
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
    assert.match(result.stopReason, /budget exhausted/)
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
