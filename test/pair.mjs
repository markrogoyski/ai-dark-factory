// Shared pair engine exercised through both hosts, with no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadLib } from './lib.mjs'
import { validateResult } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { contract, mapping, challenges, replay, helperRecord } from './fixtures/pair-contract.mjs'

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
}, suite: { ran: true, passed: true, command: 'node test.cjs', failureKind: '', log: `/repo/.council/pair-test/logs/suite-A-${label}.log` }, replay: replay(tree) })
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
    }, measure: async request => helperRecord(await measure(request)),
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
  assert.equal(c.lineup[0].key, 'astra')
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
    const { result } = await run({ args: { maxReviews: 3 }, measure: m => ({ ...m, suite: { ...m.suite, ran, passed: false } }) })
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
  for (const native of [false, true]) for (const change of [m => ({ ...m, status: 'error', error: 'Gate unavailable.' }), m => ({ ...m, snapshot: { ...m.snapshot, ref: 'other-ref' } }),
    m => ({ ...m, snapshot: { ...m.snapshot, diff: '/elsewhere/A.diff' } }), m => ({ ...m, snapshot: { ...m.snapshot, tree: 'not-a-tree' } }),
    m => ({ ...m, suite: { ...m.suite, command: 'true' } }), () => { throw new Error('Transport failed') }]) {
    const { result, calls } = await run({ native, measure: change })
    assert.equal(result.status, 'failed', String(change))
    assert.equal(calls.filter(c => c.kind === 'review').length, 1)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
  // The runtime's full record is cut to the engine's view; a gap in it becomes an empty value the
  // checks reject, never a default that passes.
  for (const change of [() => ({ status: 'running' }), m => ({ ...m, status: 'failed' }), ({ snapshot, ...m }) => m, m => ({ ...m, snapshot: { ref: m.snapshot.ref } })]) {
    const { result, calls } = await run({ measure: change })
    assert.equal(result.status, 'failed', String(change))
    assert.equal(calls.filter(c => c.kind === 'review').length, 1)
  }
})

// The native transport retyped the whole record, output tails included (about 22k characters, 1-3
// minutes of Opus output a measurement). It now copies the helper's brief result; the tails stay in
// the job's status.json, which the author and reviewer prompts name.
test('the native transport copies the brief measurement and both hosts see the same one', async () => {
  const seen = {}
  for (const native of [true, false]) {
    const { result, calls } = await run({ native })
    const measure = calls.find(c => c.kind === 'measure')
    if (native) {
      assert.match(measure.prompt, /dark-factory measure .* --brief --max-wait 5\n/)
      assert.match(measure.prompt, /dark-factory wait .* --brief --max-wait 5 until/)
      assert.equal(measure.model, 'opus')
      const record = measure.schema.properties.replay.properties.records.items.properties
      for (const key of ['tail', 'cwd', 'logSha256']) assert.ok(!(key in record), key)
      assert.ok(!('tail' in measure.schema.properties.suite.properties))
    } else assert.equal(measure, undefined)
    const code = calls.filter(c => c.kind === 'review').at(-1)
    assert.ok(code.prompt.includes("read that in the helper's full record, /repo/.council/pair-test/jobs/measure-A-pair-code-2/status.json,"))
    assert.ok(!code.prompt.includes('raw output') && !code.prompt.includes('logSha256') && !code.prompt.includes('/scratch/'))
    seen[native] = { suite: result.final.suite, replay: result.final.replay, prompt: code.prompt.match(/^\{"status".*$/m)[0] }
  }
  assert.deepEqual(seen[true], seen[false])
  assert.deepEqual(seen[true].suite, { ran: true, passed: true, command: 'node test.cjs', failureKind: '', log: '/repo/.council/pair-test/logs/suite-A-pair-code-2.log' })
  const { calls } = await run({ native: true, review: (r, n) => { if (n === 2) r.findings = [finding('Cover the boundary.')]; return r } })
  const authors = calls.filter(c => c.kind === 'author')
  assert.ok(authors[2].prompt.includes('The measurement leaves out what each execution printed: read it in /repo/.council/pair-test/jobs/measure-A-pair-code-2/status.json,'))
  assert.ok(!authors[0].prompt.includes('The measurement leaves out') && !authors[1].prompt.includes('The measurement leaves out'), 'no measurement before the first code turn')
})

test('the helper prints the same brief measurement the engine reads', async () => {
  const { calls } = await run({ native: true })
  const schema = calls.find(c => c.kind === 'measure').schema
  const full = helperRecord(measurement('pair-code-2', '1'.repeat(40)))
  delete full.replay.records[0].reused
  full.replay.records[1].exitCode = null
  delete full.suite.failureKind
  full.replay.changes = [{ status: 'M', path: 'tests/changed.cjs' }]
  const dir = mkdtempSync(join(tmpdir(), 'pair-brief-'))
  mkdirSync(join(dir, 'jobs', 'measure-A-pair-code-2'), { recursive: true })
  writeFileSync(join(dir, 'jobs', 'measure-A-pair-code-2', 'status.json'), JSON.stringify(full))
  const cli = fileURLToPath(new URL('plugins/dark-factory/bin/dark-factory', root))
  const printed = JSON.parse(execFileSync(cli, ['wait', '--run-dir', dir, '--job', 'measure-A-pair-code-2', '--brief', '--max-wait', '0'], { encoding: 'utf8' }).trim().split('\n').at(-1))
  validateResult(printed, schema)
  assert.deepEqual(printed, L.pairMeasurementView(null, full, schema))
  assert.equal(printed.replay.records[0].reused, false)
  assert.equal(printed.replay.records[1].exitCode, 0)
  assert.equal(printed.replay.changes[0].previousPath, '')
  assert.ok(JSON.stringify(full).length > JSON.stringify(printed).length)
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
      if (outcome === 'fatal') b.exitCode = 255
      if (outcome === 'pass') { b.exitCode = 0; b.passed = true }
      if (outcome === 'timeout') { b.timedOut = true; b.exitCode = -9; b.signal = 9 }
      if (outcome === 'tool-error') b.exitCode = 127
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

test('setup that finds a criterion unverifiable inside the run stops before any author turn', async () => {
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, setup: { unverifiable: [{ criterion: 'C1', reason: 'Needs the deployed service to answer.' }] } })
    assert.equal(result.status, 'needs-user')
    assert.equal(result.questions.length, 1)
    assert.match(result.questions[0], /^C1 .*The requested behavior works.*deployed service.*Rewrite it/)
    assert.equal(calls.filter(c => c.kind === 'author').length, 0)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
  const { result, calls } = await run({ setup: { unverifiable: [] } })
  assert.equal(result.status, 'done')
  // On the standalone runner a Claude setup turn's sandbox refused phpstan's local port bind, and
  // setup called the gate unverifiable though the helper runs it outside that sandbox.
  assert.match(calls.find(c => c.kind === 'setup').prompt, /fails only inside your own sandbox \(a refused port bind.*does not make a criterion unverifiable/)
})

// Sonnet setup stopped a run as unverifiable on "make coverage ... may not be runnable" with pcov
// installed; reviews flagged substring exception-message assertions in 8 of 24 runs.
test('setup lists only criteria it checked cannot be met, and design asserts specified messages exactly', async () => {
  const state = L.newState(L.parsePairConfig('Fix it'))
  const setup = L.pairSetupPrompt(state)
  assert.match(setup, /List in unverifiable only the criteria, supplied or written by you, that you have established cannot be fully met/)
  assert.match(setup, /post-delivery, production or live-service evidence/)
  assert.match(setup, /might be missing, check it with one command first \(for example `php -m \| grep -i pcov`/)
  assert.match(setup, /Doubt alone \("may not be runnable"\) is not a reason: record it in repositoryNotes/)
  const { calls } = await run({ native: true })
  const [design, code] = [calls.find(c => c.kind === 'author' && /# Stage: design/.test(c.prompt)), calls.find(c => c.kind === 'author' && /# Stage: implementation/.test(c.prompt))]
  const rule = /specifies an exception or error message, the planned check asserts that exact message: equality on the caught message, a match anchored at both ends, or the framework's exact-equality form \(in PHPUnit, assertSame on the caught exception's getMessage\(\)\)\. Substring matchers \(PHPUnit's expectExceptionMessage among them\) and unanchored or \$-anchored patterns do not count/
  assert.match(design.prompt, rule)
  assert.doesNotMatch(code.prompt, rule)
  // Neither rule reaches the council's setup.
  assert.doesNotMatch(L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix it' }))), /unverifiable|exception or error message/)
})

// A native timeline starts at init, and in the runtime "cli" runs 19-140 s of setup came before it.
test('native Pair setup reads the time first and passes it to init; the runner and other workflows do not', () => {
  const start = /run `date -u \+%Y-%m-%dT%H:%M:%SZ` and keep what it prints/
  const init = /init --repo '\/repo' --seats A --factory --started-at <the time you read before you started>/
  const native = L.pairSetupPrompt(L.newState(L.parsePairConfig({ task: 'Fix it', repo: '/repo' })))
  assert.match(native, start)
  assert.match(native, init)
  assert.ok(native.search(start) < native.indexOf('## Step 0'), 'the time is read before preflight')
  const factoryPair = L.pairSetupPrompt(L.newState(L.factoryPairConfig({ raw: { task: 'Fix it', repo: '/repo' }, roles: {}, retro: false })))
  assert.match(factoryPair, init)
  for (const prompt of [
    L.pairSetupPrompt(L.newState(L.parsePairConfig({ task: 'Fix it', repo: '/repo', host: 'codex' }))),
    L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix it', repo: '/repo' }))),
    L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix it', repo: '/repo' }, { workflow: 'factory', tier: 'simple' }))),
  ]) assert.doesNotMatch(prompt, /started-at|date -u/)
})

test('codex-host pair setup runs as the author at medium effort unless effort is given', async () => {
  let { calls } = await run()
  let setupCall = calls.find(c => c.kind === 'setup')
  assert.equal(setupCall.model, L.parsePairConfig({ task: 'x', host: 'codex' }).lineup[0].model)
  assert.equal(setupCall.effort, 'medium')
  ;({ calls } = await run({ args: { effort: 'xhigh' } }))
  assert.equal(calls.find(c => c.kind === 'setup').effort, 'xhigh')
  assert.equal(L.parsePairConfig({ task: 'x', host: 'codex' }).roles.setup.effort, 'medium')
  assert.equal(L.parsePairConfig({ task: 'x', host: 'codex', effort: 'high' }).roles.setup.effort, 'high')
})

// Sonnet setup dropped a stated coverage criterion and stopped on a guessed-missing tool where Opus
// setup did neither, so setup runs on Opus unless a Codex author sets up on the standalone runtime.
test('pair setup runs on Opus for Claude Code and for weaker Claude authors on the runner', async () => {
  for (const args of [{}, { author: 'sonnet' }, { author: 'sol', reviewer: 'astra' }, { author: 'haiku', reviewer: 'sonnet' }]) {
    const { calls } = await run({ native: true, args })
    const setupCall = calls.find(c => c.kind === 'setup')
    assert.deepEqual([setupCall.model, setupCall.effort], ['opus', 'medium'], JSON.stringify(args))
    // The measurement transport still prefers a selected Claude participant, else Haiku.
    const native = [args.author || 'opus', args.reviewer].find(k => ['opus', 'sonnet', 'haiku'].includes(k))
    assert.equal(calls.find(c => c.kind === 'measure').model, native || 'haiku', JSON.stringify(args))
    assert.equal(L.parsePairConfig({ task: 'x', ...args }).roles.setup.key, 'opus')
  }
  for (const args of [{ author: 'sonnet' }, { author: 'opus' }, { author: 'haiku', reviewer: 'astra' }]) {
    const { calls } = await run({ args })
    const setupCall = calls.find(c => c.kind === 'setup')
    assert.deepEqual([setupCall.model, setupCall.effort], ['opus', 'medium'], JSON.stringify(args))
  }
  // A Codex author keeps its own setup, and an explicit effort still sets setup's effort.
  let { calls } = await run({ args: { author: 'sol' } })
  assert.deepEqual([calls.find(c => c.kind === 'setup').model, calls.find(c => c.kind === 'setup').effort], ['gpt-6.1-sol', 'medium'])
  assert.equal(L.parsePairConfig({ task: 'x', host: 'codex' }).roles.setup.key, 'astra')
  ;({ calls } = await run({ args: { author: 'sonnet', effort: 'xhigh' } }))
  assert.deepEqual([calls.find(c => c.kind === 'setup').model, calls.find(c => c.kind === 'setup').effort], ['opus', 'xhigh'])
  assert.deepEqual(['key', 'effort'].map(k => L.parsePairConfig({ task: 'x', host: 'codex', author: 'sonnet', effort: { sonnet: 'low' } }).roles.setup[k]), ['opus', 'low'])
  // Factory's pair strategy builds its config through the same rule.
  for (const [host, author, expected] of [['claude', undefined, 'opus'], ['claude', 'sol', 'opus'], ['codex', 'sonnet', 'opus'], ['codex', undefined, 'astra']]) {
    const S = { raw: { task: 'x', host, ...(author ? { pair: { author } } : {}) }, roles: {}, retro: false }
    assert.equal(L.factoryPairConfig(S).roles.setup.key, expected, `${host} ${author}`)
  }
})

test('runtime "cli" hands the whole native run to one transport turn with explicit participants', async () => {
  const calls = []
  const agent = async (prompt, opts) => { calls.push({ prompt, opts }); return { result: JSON.stringify({ status: 'done', host: 'codex' }), error: '' } }
  const go = args => execute(agent, () => { throw new Error('no panel') }, null, () => {}, () => {}, args, {}, null, undefined)
  const result = await go({ task: 'Implement the behavior', repo: '/repo', runtime: 'cli', resume: '/repo/.council/host-x' })
  assert.deepEqual(result, { status: 'done', host: 'codex' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.model, 'sonnet')
  const json = JSON.parse(calls[0].prompt.match(/^\{.*\}$/m)[0])
  assert.deepEqual(json, { task: 'Implement the behavior', repo: '/repo', author: 'opus', reviewer: 'astra' })
  assert.match(calls[0].prompt, /rm -f ARGS.out ARGS.log ARGS.exit; dark-factory-codex --workflow pair --brief --args-file ARGS --cwd '\/repo' --resume '\/repo\/.council\/host-x' < \/dev\/null > ARGS.out 2> ARGS.log; echo \$\? > ARGS.exit/)
  // The runner starts vendor CLIs that the Bash tool's sandbox blocks, and this Claude Code build
  // has no TaskOutput tool: an improvised pgrep wait matched its own command line until timeout.
  assert.equal((calls[0].prompt.match(/dangerouslyDisableSandbox: true/g) || []).length, 2)
  // A reused args path left the last run's exit code beside it, and the wait returned at once.
  assert.match(calls[0].prompt, /\[ -s ARGS.exit \] && \[ ARGS.exit -nt ARGS \]/)
  assert.doesNotMatch(calls[0].prompt, /TaskOutput/)
  calls.length = 0
  await go('--runtime cli --author sonnet Implement it')
  assert.deepEqual(JSON.parse(calls[0].prompt.match(/^\{.*\}$/m)[0]), { task: 'Implement it', author: 'sonnet', reviewer: 'astra' })
  await assert.rejects(go({ task: 'x', runtime: 'native' }), /runtime must be "cli"/)
  await assert.rejects(go({ task: 'x', resume: '/r' }), /resume/)
  await assert.rejects(execute(agent, null, null, () => {}, () => {}, { task: 'x', runtime: 'cli' }, {}, null, { agent() {}, turn() {}, measure() {} }), /only in Claude Code/)
})
