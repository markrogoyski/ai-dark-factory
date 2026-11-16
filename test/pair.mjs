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

// A copied value cut to the schema, each missing field taking its type's empty value, as a native
// transport copying the helper's brief returns it.
function fit(value, schema) {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k, s]) =>
    [k, fit(value && typeof value === 'object' && !Array.isArray(value) ? value[k] : undefined, s)]))
  if (schema.type === 'array') return Array.isArray(value) ? value.map(v => fit(v, schema.items)) : []
  return value ?? defaults(schema)
}

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
const reading = (over = {}) => ({ requirement: 'C1', literal: 'Runs on Node 20 and 22.', reading: 'Runs on at least Node 20 and 22.', reason: 'CI also tests Node 24.', ...over })
const liveCheck = (over = {}) => ({ criterion: 'C1', check: 'Run `node cli.js fetch` against the real API and confirm it prints the status.',
  reason: 'The tests stub the HTTP call, so TLS verification against the machine\'s certificate store never runs.', ...over })

// The runner's own measurement of the base revision (the full helper record).
const baseRecord = () => helperRecord({ status: 'done', error: '', snapshot: {
  ref: 'refs/council/pair-test/A-base', tree: 'b'.repeat(40), diff: '/repo/.council/pair-test/room/base/A.diff',
}, suite: { ran: true, passed: true, command: 'node test.cjs', failureKind: '', log: '/repo/.council/pair-test/logs/suite-A-base.log' } })

async function run(options = {}) {
  const calls = [], measurements = [], phases = [], baselines = [], events = []
  let reviewNumber = 0
  async function respond(prompt, schema, meta) {
    let value = defaults(schema)
    const kind = 'runDir' in schema.properties ? 'setup' : 'design' in schema.properties ? 'author'
      : 'version' in schema.properties ? 'review' : 'snapshot' in schema.properties ? 'measure' : 'worked' in schema.properties ? 'retro' : 'unknown'
    const call = { ...meta, kind, prompt, schema }
    calls.push(call)
    events.push(kind)
    if (kind === 'setup') Object.assign(value, setup(), options.setup)
    else if (kind === 'author') {
      Object.assign(value, { status: 'done', summary: 'Implemented the behavior.', design: 'Implement the behavior and cover it with tests.', notes: 'Continue with the boundary case.' })
      Object.assign(value, { testContract: contract(), replayMapping: mapping() })
      if (options.author) value = await options.author(value, call)
    } else if (kind === 'review') {
      Object.assign(value, { version: prompt.match(/^Version: (.+)$/m)[1], complete: true, summary: 'Reviewed.',
        requiresDesignRevision: false, criteria: [{ criterion: 'C1', status: 'met', note: 'Checked the behavior against the criterion.' }] })
      value.challenges = /Return exactly one structured challenge per criterion/.test(prompt) ? challenges() : []
      reviewNumber++
      if (options.review) value = await options.review(value, reviewNumber, call)
    } else if (kind === 'measure') {
      const label = prompt.match(/--label '([^']+)'/)[1]
      const replay = JSON.parse(prompt.match(/--replay-json '([^']+)'/)[1])
      value = fit(await measure({ label, replay }), schema)
    } else if (kind === 'retro') {
      Object.assign(value, { worked: [{ what: 'Fresh reviews', evidence: 'review pair-code-2' }], saved: '/x/retros/pair-test.md' })
      if (options.retro) value = await options.retro(value, call)
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
    if (!match || opts.label === 'retro') return respond(prompt, opts.schema, opts)
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
    }, measure: async request => {
      if (request.label === 'base') {
        baselines.push(request)
        events.push('measure:base')
        return options.baseline ? options.baseline(baseRecord(), baselines.length) : baseRecord()
      }
      const full = helperRecord(await measure(request))
      return options.record ? options.record(full) : full
    },
  }
  const result = await execute(agent, () => { throw new Error('Pair must not launch a panel') }, null,
    title => phases.push(title), () => {}, { task: 'Implement the behavior', repo: '/repo', ...(options.native ? {} : { host: 'codex' }), ...options.args }, {}, null, runtime)
  return { result, calls, measurements, phases, baselines, events }
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
  // The retro adds no CLI the pair does not already use.
  const retro = args => L.parsePairConfig({ task: 'x', host: 'codex', ...args }).roles.retro.key
  assert.deepEqual([retro({}), retro({ author: 'opus', reviewer: 'sonnet' }), retro({ author: 'gemini', reviewer: 'argon' }), L.parsePairConfig('x').roles.retro],
    ['astra', 'sonnet', 'gemini', undefined])
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
    assert.ok(!calls.some(c => ['intake', 'panel'].includes(c.role)))
    assert.equal(calls.at(-1).kind, 'retro', 'the process retro runs last')
    assert.equal(calls.filter(c => c.kind === 'retro').length, 1)
  }
})

test('a pair run ends with a process retro holding the author and reviewer notes; retro: false turns it off', async () => {
  for (const native of [false, true]) {
    const { result, calls, phases } = await run({ native,
      author: a => ({ ...a, process: 'The handoff omitted the base revision.' }),
      review: (r, n) => ({ ...r, process: n === 1 ? 'None.' : 'The measurement record path was hard to find.' }) })
    assert.equal(result.status, 'done')
    const notes = result.retro.notes.map(n => `${n.turn} ${n.role}: ${n.text}`)
    assert.deepEqual(notes, ['pair-design-1 author: The handoff omitted the base revision.', 'pair-code-2 author: The handoff omitted the base revision.',
      'review pair-code-2 reviewer: The measurement record path was hard to find.'], 'every author and reviewer note kept; "None." dropped')
    const authors = calls.filter(c => c.kind === 'author'), reviews = calls.filter(c => c.kind === 'review')
    assert.ok([...authors, ...reviews].every(c => c.schema.required.includes('process')), 'author and reviewer turns can leave a note')
    assert.ok([...authors, ...reviews].every(c => c.schema.properties.process.description.startsWith('Feedback on the pair process, not on the task: ')), 'the note is about the pair process')
    assert.ok(!calls.filter(c => c.kind === 'measure').some(c => 'process' in c.schema.properties), 'the measurement transport copies its result exactly')
    const retro = calls.find(c => c.kind === 'retro')
    assert.ok(retro.prompt.startsWith('You are running a short retrospective on one run of /pair, '), retro.prompt.slice(0, 120))
    assert.ok(retro.prompt.includes('- review pair-code-2 (reviewer, Codex Astra): The measurement record path was hard to find.') ||
      retro.prompt.includes('- review pair-code-2 (reviewer, Claude Opus): The measurement record path was hard to find.'), 'the notes reach the retro payload')
    assert.ok(retro.prompt.includes('- Outcome: the pair strategy'), 'the retro sees the pair facts')
    assert.ok(retro.prompt.includes('Your subject is the workflow\'s process') && retro.prompt.includes('\n# Pair retro: pair-test\n') && !retro.prompt.includes('Council retro'), 'the retro is about the pair, not a council')
    assert.ok(result.retro.markdown.startsWith('### Process retro\n\nThe run\'s notes on its own process, for tuning the /pair workflow.'), result.retro.markdown)
    assert.ok(result.retro.markdown.includes('Saved to `/x/retros/pair-test.md`'))
    assert.ok(result.forTheOrchestrator.endsWith(' Last, show retro.markdown as it is: notes on the workflow, not the user\'s project.'))
    assert.equal(phases.at(-1), 'Retro')
  }
  for (const native of [false, true]) {
    const { result, calls, phases } = await run({ native, args: { retro: false } })
    assert.equal(result.status, 'done')
    assert.ok(!calls.some(c => c.kind === 'retro'))
    assert.ok(!calls.some(c => 'process' in c.schema.properties), 'no process field without a retro')
    assert.equal(result.retro, undefined)
    assert.ok(!phases.includes('Retro'))
  }
  // A run setup stopped before it made a run directory has nothing to review.
  const { result, calls } = await run({ setup: { status: 'needs-user', error: 'Conflicting requirements.', questions: ['Which one?'] } })
  assert.equal(result.status, 'needs-user')
  assert.ok(!calls.some(c => c.kind === 'retro'))
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
  assert.deepEqual(seen[true].suite, { ran: true, passed: true, command: 'node test.cjs', failureKind: '', log: '/repo/.council/pair-test/logs/suite-A-pair-code-2.log', overrides: {} })
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
  const brief = () => JSON.parse(execFileSync(cli, ['wait', '--run-dir', dir, '--job', 'measure-A-pair-code-2', '--brief', '--max-wait', '0'], { encoding: 'utf8' }).trim().split('\n').at(-1))
  let printed = brief()
  validateResult(printed, schema)
  assert.deepEqual(printed, L.pairMeasurementView(null, full, schema))
  assert.equal(printed.replay.records[0].reused, false)
  assert.equal(printed.replay.records[1].exitCode, 0)
  assert.equal(printed.replay.changes[0].previousPath, '')
  assert.deepEqual(printed.suite.overrides, [])
  assert.ok(JSON.stringify(full).length > JSON.stringify(printed).length)
  // verification.json's explicit env, sorted by name, without the base environment.
  full.verification = { command: 'node test.cjs', env: { ZED: '1', ALPHA: 'x' }, baseEnv: { HOME: '/home/someone', PATH: '/usr/bin' } }
  writeFileSync(join(dir, 'jobs', 'measure-A-pair-code-2', 'status.json'), JSON.stringify(full))
  printed = brief()
  validateResult(printed, schema)
  assert.deepEqual(printed, L.pairMeasurementView(null, full, schema))
  assert.deepEqual(printed.suite.overrides, [{ name: 'ALPHA', value: 'x' }, { name: 'ZED', value: '1' }])
  assert.ok(!JSON.stringify(printed).includes('/home/someone'))
})

// On the standalone runtime setup is a sandboxed model turn (a Codex seat on the Codex host), where
// a refused socket bind fails a gate that passes outside it. The runner measures the base itself.
const designAuthor = calls => calls.find(c => c.kind === 'author').prompt
const RUNNER_PASSED = "The runner ran the verification command on the base revision, outside any model's sandbox, and it passed."

test('standalone pair takes a passing baseline from the runner, not from setup', async () => {
  const { result, calls, baselines, events, measurements } = await run({ setup: { baselinePasses: false, baselineNote: 'setup saw EPERM' } })
  assert.equal(result.status, 'done')
  assert.deepEqual(baselines, [{ run: { runId: 'pair-test', runDir: '/repo/.council/pair-test', repoRoot: '/repo', head: 'b'.repeat(40), room: '/repo/.council/pair-test/room' }, seat: 'A', label: 'base' }])
  assert.ok(!('replay' in baselines[0]))
  assert.deepEqual(events.slice(0, 3), ['setup', 'measure:base', 'author'])
  assert.deepEqual(calls.map(c => c.kind), ['setup', 'author', 'review', 'author', 'review', 'retro'], 'no model turn measures the base')
  assert.ok(designAuthor(calls).includes(RUNNER_PASSED))
  assert.ok(!calls.some(c => c.prompt.includes('setup saw EPERM')))
  assert.deepEqual(measurements.map(m => m.label), ['pair-code-2'])
  assert.equal(result.final.snapshotRef, 'refs/council/pair-test/A-pair-code-2')
  // No verification command: nothing to measure.
  const none = await run({ setup: { verify: '', baselinePasses: false } })
  assert.equal(none.baselines.length, 0)
  assert.ok(!designAuthor(none.calls).includes('base revision'))
})

test('standalone pair reports a failing runner baseline to the existing baseline handling', async () => {
  const long = n => 'x'.repeat(n)
  const tail = Array.from({ length: 12 }, (_, i) => `PHPUnit line ${i}: some  output\twith   spaces`).join('\n') + '\nFAILURES! Tests: 3, Failures: 1'
  const flatTail = tail.replace(/\s+/g, ' ').trim()
  assert.ok(tail.length > 400)
  const failing = (suite, extra = {}) => m => ({ ...m, ...extra, suite: { ...m.suite, ...suite } })
  const cases = [
    ['exit', failing({ passed: false, exitCode: 1, tail }),
      `the verification command exited 1; failing tail: …${flatTail.slice(flatTail.length - (300 - 'the verification command exited 1'.length - 16) + 1)}`],
    ['mismatch', failing({ command: long(500), tail: 'boom\nFAILURES!' }),
      `${`the baseline ran ${long(500)}`.slice(0, 119)}…; failing tail: boom FAILURES!`],
    ['error', m => ({ ...m, status: 'error', error: long(500), suite: undefined }),
      `${`the baseline measurement failed: ${long(500)}`.slice(0, 299)}…`],
    ['thrown', () => { throw new Error('helper vanished') }, 'the baseline measurement failed: helper vanished'],
    ['not run', failing({ ran: false, passed: false, failureKind: 'infrastructure', tail: '' }), 'the verification command did not run (infrastructure)'],
    ['timeout', failing({ passed: false, timedOut: true, exitCode: -9, tail: '' }), 'the verification command timed out'],
  ]
  for (const [name, baseline, note] of cases) {
    const { result, calls, baselines } = await run({ baseline, setup: { baselinePasses: true } })
    assert.equal(baselines.length, 1, name)
    const prompt = designAuthor(calls)
    const match = prompt.match(/and it failed: (.*?)\. Don't run it/)
    assert.ok(match, name)
    const shown = match[1]
    assert.ok(shown.length <= 300 && !shown.includes('\n'), name)
    assert.equal(shown, note, name)
    if (name === 'exit') assert.ok(shown.startsWith('the verification command exited 1; failing tail: …') && shown.endsWith('FAILURES! Tests: 3, Failures: 1'))
    if (name === 'mismatch') assert.ok(shown.indexOf('; failing tail: ') === 120 && shown[119] === '…' && shown.endsWith('; failing tail: boom FAILURES!'))
    if (name === 'error') assert.ok(shown.length === 300 && shown.endsWith('…') && !shown.includes('failing tail'))
    assert.equal(calls.filter(c => c.kind === 'author').length, 2, `${name}: the run continues to the author`)
    assert.equal(result.status, 'done', name)
  }
  // The rule and the limit, unit by unit.
  const S = L.newState(L.parsePairConfig({ task: 'x', host: 'codex' }))
  S.verify = 'node test.cjs'
  const record = suite => ({ status: 'done', suite: { ran: true, passed: true, command: 'node test.cjs', exitCode: 0, timedOut: false, tail: 'OK', ...suite } })
  assert.equal(L.pairBaselineResult(S, record({})), true)
  assert.deepEqual([S.baselineOk, S.baselineNote], [true, ''])
  assert.equal(L.pairBaselineResult(S, null), false)
  assert.equal(S.baselineNote, 'the baseline measurement returned nothing')
  for (const [m, note] of cases.slice(0, 2).map(([, f, n]) => [f(record({})), n]).concat(
    [[record({ passed: false, exitCode: 1, tail: '' }), 'the verification command exited 1']])) {
    assert.equal(L.pairBaselineResult(S, m), false)
    assert.equal(S.baselineNote, note)
  }
  for (const [reason, t] of [[long(600), ''], [long(600), long(600)], ['short', long(600)], ['a\n b', 'c\n\n d']]) {
    const note = L.pairBaselineNote(reason, t)
    assert.ok(note.length <= 300 && !note.includes('\n'), `${reason.length} ${t.length}`)
  }
  assert.equal(L.pairBaselineNote(long(600), '').length, 300)
  assert.equal(L.pairBaselineNote('a\n b', 'c\n\n d'), 'a b; failing tail: c d')
  assert.ok(L.pairBaselineNote(long(600), long(600)).endsWith('x'.repeat(163)))
  S.verify = ''
  assert.equal(L.pairBaselineResult(S, null), true)
})

test("native pair keeps setup's baseline and measures only the code", async () => {
  const failed = await run({ native: true, setup: { baselinePasses: false, baselineNote: 'Gate fails at base: 2 failures.' } })
  assert.equal(failed.calls[1].kind, 'author')
  assert.ok(!failed.calls.some(c => c.kind === 'measure' && /--label 'base'/.test(c.prompt)))
  assert.equal(failed.measurements.length, 1)
  assert.equal(failed.measurements[0].label, 'pair-code-2')
  assert.ok(failed.calls[1].prompt.includes('Setup ran the verification command on the base revision, and it failed: Gate fails at base: 2 failures.'))
  const passed = await run({ native: true, setup: { baselinePasses: true } })
  assert.equal(passed.calls[1].kind, 'author')
  assert.equal(passed.measurements.length, 1)
  assert.ok(passed.calls[1].prompt.includes('Setup ran the verification command on the base revision, and it passed.'))
})

test('only the standalone pair setup prompt hands the baseline to the runner', async () => {
  const standalone = (await run()).calls[0].prompt
  const S = L.newState(L.parsePairConfig({ task: 'Implement the behavior', repo: '/repo', host: 'codex' }))
  S.pair = L.newPairState()
  const unflagged = L.pairSetupPrompt(S)
  const replaced = unflagged
    .replace('Store sandbox-compatible execution settings as explicit string overrides in <runDir>/verification.json: {"env": {"VARIABLE": "value"}}.',
      'Write <runDir>/verification.json with the explicit string overrides the command needs in any environment: {"env": {"VARIABLE": "value"}}, or {"env": {}} when it needs none.')
    .replace('Preflight the exact command through neutral measurement below, including worker/socket/cache restrictions; shell-local exports are insufficient.',
      "Don't run or measure the command yourself: after you return, the runner measures the baseline in a disposable checkout outside your sandbox, with these overrides. Don't add overrides, PATH wrappers or debug flags for failures you see only inside your own sandbox, such as a refused socket bind or blocked network access.")
    .replace(/Then measure the baseline: dark-factory measure --run-dir <runDir> --seat A --label base \(if it prints status "running", poll with dark-factory wait --run-dir <runDir> --job measure-A-base\)\. Set baselinePasses to suite\.passed\. If the suite fails or doesn't run at baseline, put the reason and the failing tail in baselineNote\./,
      "Don't measure the baseline: the runner measures it outside your sandbox after you return, and its result replaces baselinePasses and baselineNote. Set baselinePasses to false and baselineNote to \"\".")
  assert.notEqual(replaced, unflagged)
  assert.equal(standalone, replaced)
  assert.doesNotMatch(standalone, /measure --run-dir/)
  assert.match(standalone, /the runner measures it outside your sandbox after you return/)
  assert.match(standalone, /Don't add overrides, PATH wrappers or debug flags for failures you see only inside your own sandbox, such as a refused socket bind/)
  assert.match(standalone, /Write it to <runDir>\/verify\.sh as just the command/)
  assert.match(standalone, /Write <runDir>\/verification\.json with the explicit string overrides/)
  const native = (await run({ native: true })).calls[0].prompt
  assert.match(native, /Then measure the baseline: dark-factory measure --run-dir <runDir> --seat A --label base /)
  assert.match(native, /Store sandbox-compatible execution settings/)
  assert.doesNotMatch(native, /runner measures/)
})

test('pair results report the verification overrides the gate ran with, without changing readiness', async () => {
  const line = names => `Verification overrides: the gate ran with explicit environment overrides from verification.json: ${names}.`
  for (const native of [false, true]) {
    const { result } = await run({ native })
    assert.deepEqual(result.final.suite.overrides, {})
    assert.deepEqual(result.summary.final.suite.overrides, {})
    assert.ok(!result.report.markdown.includes('Verification overrides'))
    assert.deepEqual([result.status, result.final.readiness.state], ['done', 'ready'])
  }
  const codex = await run({ record: r => ({ ...r, verification: { command: 'node test.cjs', env: { PHPSTAN_FLAGS: '--debug', PATH: '/run/bin:/usr/bin' }, baseEnv: { HOME: '/home/someone' } } }) })
  assert.deepEqual(codex.result.final.suite.overrides, { PATH: '/run/bin:/usr/bin', PHPSTAN_FLAGS: '--debug' })
  assert.ok(!JSON.stringify(codex.result.final.suite).includes('/home/someone'))
  assert.ok(codex.result.report.markdown.split('\n\n').includes(line('PATH, PHPSTAN_FLAGS')))
  assert.deepEqual(codex.result.summary.final.suite.overrides, { PATH: '/run/bin:/usr/bin', PHPSTAN_FLAGS: '--debug' })
  assert.deepEqual([codex.result.status, codex.result.final.readiness.state], ['done', 'ready'])
  const native = await run({ native: true, measure: m => ({ ...m, suite: { ...m.suite, overrides: [{ name: 'PHPSTAN_FLAGS', value: '--debug' }] } }) })
  assert.deepEqual(native.result.final.suite.overrides, { PHPSTAN_FLAGS: '--debug' })
  assert.ok(native.result.report.markdown.split('\n\n').includes(line('PHPSTAN_FLAGS')))
  assert.deepEqual([native.result.status, native.result.final.readiness.state], ['done', 'ready'])
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

test('design: false and --no-design skip the design stage; anything else is refused', () => {
  assert.equal(L.parsePairConfig('Implement it').pairOptions.design, true)
  assert.equal(L.parsePairConfig({ task: 'x', design: false }).pairOptions.design, false)
  for (const text of ['--no-design Write the plan', '--author astra --no-design --max-reviews 4 Write the plan', '--no-design --author astra Write the plan']) {
    const c = L.parsePairConfig(text)
    assert.equal(c.pairOptions.design, false, text)
    assert.equal(c.task, 'Write the plan', text)
  }
  assert.equal(L.parsePairConfig('--author astra Write --no-design notes').task, 'Write --no-design notes', 'only leading flags')
  assert.equal(L.parseArgs('--no-design Write the plan').task, '--no-design Write the plan', 'the switch is Pair-only')
  for (const design of ['false', 0, null]) assert.throws(() => L.parsePairConfig({ task: 'x', design }), /design must be true or false/)
  const factory = L.factoryPairConfig({ raw: { task: 'x', strategy: 'pair', pair: { design: false } }, roles: {} })
  assert.equal(factory.pairOptions.design, true, 'factory always designs first')
  // --no-retro is the string form of retro: false, also a Pair-only switch.
  assert.equal(L.parsePairConfig('Implement it').retro, true)
  for (const text of ['--no-retro Write the plan', '--no-design --no-retro Write the plan', '--author astra --no-retro --max-reviews 4 Write the plan']) {
    const c = L.parsePairConfig(text)
    assert.equal(c.retro, false, text)
    assert.ok(!c.roles.retro, text)
    assert.equal(c.task, 'Write the plan', text)
  }
  assert.equal(L.parsePairConfig({ task: 'x', retro: false }).retro, false)
  assert.equal(L.parseArgs('--no-retro Write the plan').task, '--no-retro Write the plan', 'the switch is Pair-only')
  assert.match(L.executionPlan({ ...L.parsePairConfig({ task: 'x', design: false }), controls: {} }).effort, /no design stage/)
})

test('without a design stage the author writes the deliverable and review starts at the measured snapshot', async () => {
  for (const native of [false, true]) {
    const { result, calls, measurements, phases } = await run({ native, args: { design: false } })
    assert.equal(result.status, 'done')
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(result.delivery.status, 'pending')
    assert.deepEqual(result.reviews.map(r => r.stage), ['code'])
    assert.ok(!phases.includes('Design') && !phases.includes('Review design'))
    const authors = calls.filter(c => c.kind === 'author'), reviews = calls.filter(c => c.kind === 'review')
    assert.equal(authors.length, 1)
    assert.equal(reviews.length, 1)
    assert.equal(authors[0].label, 'pair-code-1')
    assert.equal(result.final.snapshotRef, 'refs/council/pair-test/A-pair-code-1')
    assert.equal(measurements.length, 1)
    assert.deepEqual(measurements[0].replay, { testRoots: ['tests'], mapping: mapping() })
    assert.deepEqual(result.testContract, contract())
    assert.match(authors[0].prompt, /This run skips the design stage: write the deliverable itself/)
    assert.ok(!/approved design|reviewed design|# Current design/.test(authors[0].prompt))
    assert.match(reviews[0].prompt, /no one has reviewed the test contract above/)
    assert.ok(!/approved design|# Design\n|return the author to design review/.test(reviews[0].prompt))
    assert.match(reviews[0].prompt, /^Version: code:1{40}:[0-9a-f-]+$/m)
  }
})

test('without a design stage a design-revision request stays at the code stage', async () => {
  const { result, calls } = await run({ args: { design: false }, review: (r, n) => {
    if (n === 1) { r.findings = [finding('The approach cannot handle streaming.')]; r.requiresDesignRevision = true }
    if (n === 2) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The reworked implementation handles streams.' }]
    return r
  } })
  assert.equal(result.status, 'done')
  assert.deepEqual(result.reviews.map(r => r.stage), ['code', 'code'])
  assert.deepEqual(calls.filter(c => c.kind === 'author').map(c => c.label), ['pair-code-1', 'pair-code-2'])
  assert.match(calls.filter(c => c.kind === 'author')[1].prompt, /"requiresDesignRevision":true/)
})

test('without a design stage the author owns the contract: corrected once, kept when omitted, revisable', async () => {
  let authors = 0
  const corrected = await run({ args: { design: false }, author: a => { if (++authors === 1) a.testContract.checks[0].boundaries = ''; return a } })
  assert.equal(corrected.result.status, 'done')
  assert.deepEqual(corrected.calls.filter(c => c.kind === 'author').map(c => c.label), ['pair-code-1', 'pair-code-1-corrected'])
  assert.match(corrected.calls.filter(c => c.kind === 'author')[1].prompt, /could not accept your test contract or replay mapping/)
  assert.match(corrected.result.notes.join(' '), /one author correction/)
  const refused = await run({ args: { design: false }, author: a => { a.testContract.checks[0].boundaries = ''; return a } })
  assert.equal(refused.result.status, 'blocked')
  assert.equal(refused.result.reviews.length, 0)
  assert.equal(refused.measurements.length, 0)
  authors = 0
  const kept = await run({ args: { design: false }, author: a => { if (++authors > 1) a.testContract = { testRoots: [], checks: [] }; return a },
    review: (r, n) => { if (n === 1) r.findings = [finding('Cover the boundary.')]; else r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'Covered.' }]; return r } })
  assert.equal(kept.result.status, 'done')
  assert.deepEqual(kept.result.testContract, contract())
  const keptReviews = kept.calls.filter(c => c.kind === 'review')
  assert.match(keptReviews[0].prompt, /No review has challenged this contract yet\. Return exactly one structured challenge per criterion/)
  assert.match(keptReviews[1].prompt, /Return challenges=\[\] during code review\./, 'an unchanged contract is not challenged again')
  // A contract-only revision on the same tree is a new version, not a stall.
  authors = 0
  const revised = await run({ sameTree: true, args: { design: false }, author: a => { if (++authors > 1) a.testContract.checks[0].boundaries = 'Zero, one and the adjacent value.'; return a },
    review: (r, n) => { if (n === 1) r.findings = [finding('The boundary check omits one.')]; else r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The contract now covers one.' }]; return r } })
  assert.equal(revised.result.status, 'done')
  assert.equal(revised.result.testContract.checks[0].boundaries, 'Zero, one and the adjacent value.')
  const versions = revised.calls.filter(c => c.kind === 'review').map(c => c.prompt.match(/^Version: (.+)$/m)[1])
  assert.notEqual(versions[0], versions[1])
  assert.ok(revised.calls.filter(c => c.kind === 'review').every(c => /No review has challenged this contract yet/.test(c.prompt)), 'a changed contract is challenged again')
})

test('without a design stage a code review of a new contract must challenge every criterion', async () => {
  for (const native of [false, true]) {
    // Missing, then supplied on the one correction: the review counts once and the run completes.
    const corrected = await run({ native, args: { design: false }, review: (r, n) => ({ ...r, challenges: n === 1 ? [] : r.challenges }) })
    assert.equal(corrected.result.status, 'done')
    const reviews = corrected.calls.filter(c => c.kind === 'review')
    assert.equal(reviews.length, 2)
    assert.match(reviews[1].prompt, /This code review needs exactly one challenge for each acceptance criterion/)
    assert.deepEqual(corrected.result.reviews.map(r => r.stage), ['code'])
    assert.match(corrected.result.notes.join(' '), /one reviewer correction/)
  }
  for (const change of [() => [], c => [c[0], c[0]], c => [{ ...c[0], rejectingCheckIds: ['missing'] }], c => [{ ...c[0], wrongImplementation: ' ' }]]) {
    const { result, calls } = await run({ args: { design: false }, review: r => ({ ...r, challenges: change(r.challenges) }) })
    assert.equal(result.status, 'blocked', String(change))
    assert.match(result.stopReason, /challenge/i)
    assert.equal(calls.filter(c => c.kind === 'review').length, 2, 'one bounded correction before stopping')
    assert.equal(result.reviews.length, 0)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
  // A stray check beside a covering one is trimmed, as in design review, without a correction.
  const trimmed = await run({ args: { design: false }, review: r => { r.challenges[0].rejectingCheckIds = ['T1', 'T9']; return r } })
  assert.equal(trimmed.result.status, 'done')
  assert.equal(trimmed.calls.filter(c => c.kind === 'review').length, 1)
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
    assert.match(result.report.markdown, /\n\nQuestions for the user:\n\n1\. Which compatibility behavior is required\?$/)
  }
  const { result } = await run({ author: () => null })
  assert.equal(result.status, 'failed')
  assert.doesNotMatch(result.report.markdown, /Questions for the user/)
  assert.doesNotMatch((await run({})).result.report.markdown, /Questions for the user/)
})

test('pair prompts have reviewed golden coverage', async () => {
  let authors = 0
  const { calls } = await run({ native: true, setup: { liveChecks: [liveCheck()] }, author: a => ({ ...a, readings: ++authors === 1 ? [reading()] : [] }), review: (r, n) => {
    if (n === 1) {
      r.findings = [finding('Cover the boundary case.')]
      r.rulings = [{ id: 'R1', ruling: 'accepted', evidence: 'The task names no other environment; the minimum keeps its intent.' }]
    }
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

test('pair prompts without a design stage have reviewed golden coverage', async () => {
  const { calls } = await run({ native: true, args: { design: false }, review: (r, n) => {
    if (n === 1) r.findings = [finding('Cover the boundary case.')]
    if (n === 2) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The boundary test now exists.' }]
    return r
  } })
  const dir = new URL('test/golden/pair-no-design/', root)
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
  assert.equal(L.pairChallengeError(state, review), 'Challenge C2 cites T1, which covers C1. Cite only checks whose criteria include C2: I1.')
  review.challenges[1].rejectingCheckIds = ['T1', 'I1']
  assert.deepEqual(L.pairTrimChallenges(state, review), ['C2: T1'])
  assert.deepEqual(review.challenges[1].rejectingCheckIds, ['I1'])
  assert.equal(L.pairChallengeError(state, review), null)
  assert.match(L.pairChallengeError(state, { challenges: challenges() }), /Missing: C2\./)
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
  const blocked = await run({ setup: { status: 'needs-user', error: 'Two incompatible requirements.', questions: ['Which signature is required?', 'Keep\n  the old flag?'] } })
  assert.equal(blocked.result.status, 'needs-user')
  assert.deepEqual(blocked.result.questions, ['Which signature is required?', 'Keep\n  the old flag?'])
  assert.equal(blocked.calls.filter(c => c.kind === 'author').length, 0)
  // The report asks what the stop asks, each question on one line.
  assert.match(blocked.result.report.markdown, /\n\nTwo incompatible requirements\.\n\n(.|\n)*\n\nQuestions for the user:\n\n1\. Which signature is required\?\n2\. Keep the old flag\?(\n|$)/)
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

test('a challenge citing a check for another criterion beside a covering one needs no correction', async () => {
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, review: (r, n) => {
      if (n === 1) r.challenges[0].rejectingCheckIds = ['T1', 'OTHER']
      return r
    } })
    assert.equal(result.status, 'done')
    assert.equal(calls.filter(c => c.kind === 'review').length, 2)
    assert.equal(result.reviews[0].challenges[0].rejectingCheckIds.join(), 'T1')
    assert.ok(result.notes.some(n => /dropped rejecting checks .*C1: OTHER/.test(n)))
  }
})

test('a failed verification checkout stops after one code review as unverified, not as a finding', async () => {
  const error = "git worktree add failed: could not create directory of '.git/worktrees/A': Operation not permitted"
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, args: { maxReviews: 8 },
      measure: m => ({ ...m, scratchError: error, suite: { ...m.suite, ran: false, passed: false, failureKind: 'infrastructure', log: '' },
        replay: { ...m.replay, records: [] } }),
      review: (r, n) => { if (n === 2) r.criteria[0] = { criterion: 'C1', status: 'partial', note: 'The gate did not run.' }; return r } })
    const reviews = calls.filter(c => c.kind === 'review')
    assert.equal(reviews.length, 2)
    assert.match(reviews[1].prompt, /could not run because of the environment.*don't file a finding/s)
    assert.doesNotMatch(reviews[0].prompt, /could not run because of the environment/)
    assert.match(result.stopReason, /Verification infrastructure failed/)
    const ready = result.final.readiness
    assert.equal(ready.state, 'unverified')
    assert.deepEqual(ready.blocked, [])
    assert.equal(ready.infrastructure.length, 1)
    assert.ok(ready.infrastructure[0].includes('Operation not permitted'))
    assert.ok(ready.incomplete.includes('Criterion C1 is partial: The gate did not run.'))
    assert.equal(result.summary.final.readiness.state, 'unverified')
  }
  // An open finding still blocks; the infrastructure reason stays visible beside it.
  const { result } = await run({ measure: m => ({ ...m, scratchError: error, suite: { ...m.suite, ran: false, passed: false, failureKind: 'infrastructure' } }),
    review: (r, n) => { if (n === 2) r.findings = [finding('The boundary case is wrong.')]; return r } })
  assert.equal(result.final.readiness.state, 'blocked')
  assert.equal(result.final.readiness.infrastructure.length, 1)
})

test('a reviewer moving a criterion between partial and met on unchanged bytes does not defer the stall', async () => {
  const { result } = await run({ sameTree: true, args: { maxReviews: 8 }, review: (r, n) => {
    if (n === 2) r.findings = [finding('The boundary case is wrong.')]
    if (n > 2) r.resolutions = [{ id: 'P1', status: 'open', evidence: 'Still wrong.' }]
    r.criteria[0].status = n % 2 ? 'met' : 'partial'
    return r
  } })
  assert.match(result.stopReason, /stalled/)
  assert.equal(result.reviews.length, 3)
})

test('the result opens with its summary and names the cleanup command', async () => {
  const { result } = await run({})
  assert.equal(Object.keys(result)[0], 'summary')
  assert.equal(result.summary.cleanupAfterDelivery, "dark-factory cleanup --run-dir '/repo/.council/pair-test'")
  assert.match(result.forTheOrchestrator, /dark-factory cleanup --run-dir '\/repo\/\.council\/pair-test'/)
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
    const { result, calls } = await run({ native, setup: { unverifiable: [{ criterion: 'C1', origin: 'supplied', reason: 'Needs the deployed service to answer.' }] } })
    assert.equal(result.status, 'needs-user')
    assert.match(JSON.stringify(result.final.readiness), /cannot verify: C1 \(Needs the deployed service to answer\.\)/)
    assert.ok(result.notes.some(n => /C1 unverifiable.*Needs the deployed service/.test(n)))
    assert.equal(result.questions.length, 1)
    assert.match(result.questions[0], /^C1 .*The requested behavior works.*deployed service.*Rewrite it/)
    assert.ok(result.report.markdown.includes(`\n\nQuestions for the user:\n\n1. ${result.questions[0]}`), result.report.markdown)
    assert.equal(calls.filter(c => c.kind === 'author').length, 0)
    assert.notEqual(result.final.readiness.state, 'ready')
  }
  const { result, calls } = await run({ setup: { unverifiable: [] } })
  assert.equal(result.status, 'done')
  // On the standalone runner a Claude setup turn's sandbox refused phpstan's local port bind, and
  // setup called the gate unverifiable though the helper runs it outside that sandbox.
  assert.match(calls.find(c => c.kind === 'setup').prompt, /fails only inside your own sandbox \(a refused port bind.*does not make a criterion unverifiable/)
})

// IterTools-PHP: setup stopped to ask whether to rewrite or drop a criterion it had written itself,
// for a 64-bit limitation the plan already accepted.
test('a criterion setup wrote and could not check goes to the author to inspect, not to the user', async () => {
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, setup: { unverifiable: [{ criterion: 'C1', origin: 'written', reason: '32-bit rows cannot run on 64-bit PHP.' }] } })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.questions, [])
    assert.match(calls.find(c => c.kind === 'author').prompt, /could not find a run-time check for C1, which it wrote: 32-bit rows.*Check it by inspecting the code/)
  }
  const { result } = await run({ setup: { unverifiable: [{ criterion: 'C1', origin: 'supplied', reason: 'Needs production.' }] } })
  assert.equal(result.status, 'needs-user')
})

// IterTools-PHP: a fix copied Single::accumulate's argument checks into Stream; review tested only the
// listed cases and missed different messages for combined arguments.
test('mirrored behaviour gets a side-by-side check in design and review', async () => {
  const { calls } = await run({ native: true })
  assert.match(calls.find(c => c.kind === 'author' && /# Stage: design/.test(c.prompt)).prompt, /copies, mirrors or reimplements behaviour another function already has.*runs both on the same inputs side by side, including combinations of arguments/)
  const reviews = calls.filter(c => c.kind === 'review').map(c => c.prompt)
  assert.ok(reviews.some(p => /require a side-by-side check that the two agree/.test(p)))
  assert.ok(reviews.some(p => /run both on the same inputs beyond the listed cases, including combinations of arguments, and file any difference/.test(p)))
})

// Sonnet setup stopped a run as unverifiable on "make coverage ... may not be runnable" with pcov
// installed; reviews flagged substring exception-message assertions in 8 of 24 runs.
test('setup lists only criteria it checked cannot be met, and design asserts specified messages exactly', async () => {
  const state = L.newState(L.parsePairConfig('Fix it'))
  const setup = L.pairSetupPrompt(state)
  assert.match(setup, /List in unverifiable only the criteria that you have established cannot be fully met/)
  assert.match(setup, /You own the criteria you write: word each one so evidence inside this run can check it/)
  assert.match(setup, /A limitation that the task or a reference document explicitly accepts is not a gap/)
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

test('the factory\'s pair strategy describes its retro as a pair process, not a council', () => {
  const S = { ...L.newState(L.factoryPairConfig({ raw: { task: 'Fix it', repo: '/repo' }, roles: {} })), pair: L.newPairState(), factory: { tier: 'simple' },
    run: { runId: 'pair-test', runDir: '/repo/.council/pair-test', repoRoot: '/repo' }, cli: 'dark-factory' }
  const prompt = L.retroPrompt(S, 'Report.', 'Payload.', 'h')
  assert.ok(prompt.startsWith('You are running a short retrospective on one run of /factory, ') && prompt.includes('this run used the pair strategy instead'))
  assert.ok(prompt.includes('Your subject is the workflow\'s process') && prompt.includes('The author drafts the design') && prompt.includes('\n# Pair retro: pair-test\n'))
  assert.ok(!prompt.includes('Seats are the debating models'))
})

test('a review that names a criterion by its ID and text counts for that ID', async () => {
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, review: r => {
      r.criteria = r.criteria.map(a => ({ ...a, criterion: `${a.criterion}: The requested behavior works.` }))
      r.challenges = r.challenges.map(c => ({ ...c, criterion: `${c.criterion} - The requested behavior works.` }))
      return r
    } })
    assert.equal(result.status, 'done')
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(calls.filter(c => c.kind === 'review').length, 2, 'no correction turn was needed')
    assert.deepEqual(result.reviews.flatMap(r => r.criteria.map(a => a.criterion)), ['C1', 'C1'])
  }
  // Only an ID followed by a non-word character is taken: C1 does not claim C10's text.
  const state = { criteria: [{ id: 'C1' }, { id: 'C10' }] }
  const review = L.pairNormalizeReview(state, { criteria: [{ criterion: 'C10: ten' }, { criterion: ' C1 ' }, { criterion: 'C1x' }] })
  assert.deepEqual(review.criteria.map(a => a.criterion), ['C10', 'C1', 'C1x'])
})

test('a review with missing, unknown or repeated criterion IDs gets one reviewer correction', async () => {
  const state = { criteria: [{ id: 'C1' }, { id: 'C2' }] }
  assert.equal(L.pairCriteriaError(state, { criteria: [{ criterion: 'C1' }, { criterion: 'C2' }] }), null)
  assert.equal(L.pairCriteriaError(state, { criteria: [{ criterion: 'C1' }, { criterion: 'C1' }, { criterion: 'The second one' }] }),
    'The review needs exactly one criteria assessment for each acceptance criterion, under its bare ID (C1, C2). Missing: C2. Not a criterion ID: "The second one". Repeated: C1.')
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, review: (r, n) => { if (n === 2) r.criteria = [{ ...r.criteria[0], criterion: 'requested behavior' }]; return r } })
    assert.equal(result.status, 'done')
    const reviews = calls.filter(c => c.kind === 'review')
    assert.deepEqual(reviews.map(c => c.label.replace(/^review /, '').replace(/ \(relay\)$/, '')), ['pair-design-1', 'pair-code-2', 'pair-code-2-corrected'])
    assert.match(reviews[2].prompt, /Correct the previous structured review\nThe review needs exactly one criteria assessment/)
    assert.match(result.notes.join(' '), /Not a criterion ID: "requested behavior"\. Requested one reviewer correction/)
    const failed = await run({ native, review: (r, n) => { if (n >= 2) r.criteria = []; return r } })
    assert.equal(failed.result.status, 'blocked')
    assert.match(failed.result.stopReason, /Missing: C1\./)
    assert.equal(failed.calls.filter(c => c.kind === 'review').length, 3, 'one bounded correction before stopping')
  }
})

test('a Gemini reviewer is told that git fails in its sandbox; other reviewers are not', async () => {
  const gemini = await run({ args: { reviewer: 'gemini' } })
  const astra = await run({ args: { reviewer: 'astra', author: 'opus' } })
  const reviewPrompts = r => r.calls.filter(c => c.kind === 'review').map(c => c.prompt)
  for (const prompt of reviewPrompts(gemini)) assert.match(prompt, /Git commands fail in your sandbox/)
  for (const prompt of reviewPrompts(astra)) assert.doesNotMatch(prompt, /Git commands fail in your sandbox/)
})

test('a rejected reading becomes an open major finding; an accepted one is settled and carried into later prompts', async () => {
  for (const native of [false, true]) {
    let authors = 0
    const order = reading({ requirement: '"in the listed order"', literal: 'Print the names in the listed order.', reading: 'Print the names in any order.', reason: 'Callers sort them.' })
    const { result, calls } = await run({ native,
      author: a => ({ ...a, readings: ++authors === 1 ? [reading(), order] : authors === 2 ? [reading({ reading: ' Runs on at least  Node 20 and 22.' })] : [] }),
      review: (r, n) => {
        if (n === 1) r.rulings = [{ id: 'R1', ruling: 'accepted', evidence: 'The task names no upper bound; CI already runs Node 24.' },
          { id: 'R2', ruling: 'rejected', evidence: 'The CLI help documents the order; tests/order.cjs can check it.' }]
        if (n === 2) r.resolutions = [{ id: 'P1', status: 'fixed', evidence: 'The design now keeps the listed order.' }]
        return r
      } })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'design', 'code'])
    assert.deepEqual(result.readings.map(r => [r.id, r.status, r.stage, r.finding]), [['R1', 'accepted', 'design', ''], ['R2', 'rejected', 'design', 'P1']],
      'a reading repeated word for word is not proposed again')
    assert.deepEqual(result.readings[0].history, [{ review: 1, status: 'accepted', evidence: 'The task names no upper bound; CI already runs Node 24.' }])
    const [f] = result.findings
    assert.deepEqual([f.id, f.severity, f.stage, f.reading, f.status], ['P1', 'major', 'design', 'R2', 'fixed'])
    assert.equal(f.statement, 'Reading R2 was rejected: meet "in the listed order" as written, not as "Print the names in any order". The CLI help documents the order; tests/order.cjs can check it.')
    const authorPrompts = calls.filter(c => c.kind === 'author').map(c => c.prompt), reviewPrompts = calls.filter(c => c.kind === 'review').map(c => c.prompt)
    const ledger = prompt => JSON.parse(prompt.match(/\n# Readings ledger\n(.*)\n/)[1])
    assert.deepEqual(ledger(reviewPrompts[0]).map(r => r.status), ['proposed', 'proposed'])
    for (const prompt of [...authorPrompts.slice(1), ...reviewPrompts.slice(1)]) assert.deepEqual(ledger(prompt).map(r => [r.id, r.status]), [['R1', 'accepted'], ['R2', 'rejected']])
    assert.match(authorPrompts[1], /"id":"P1","stage":"design","status":"open"/)
    assert.match(result.report.markdown, /\n\nR1: reading accepted — C1 read as: Runs on at least Node 20 and 22\. \(The task names no upper bound; CI already runs Node 24\.\)\n\nR2: reading rejected — "in the listed order" read as: Print the names in any order\. \(.*\); finding P1/)
    assert.match(result.forTheOrchestrator, /Report the accepted readings/)
  }
  const plain = await run({})
  assert.deepEqual(plain.result.readings, [])
  assert.doesNotMatch(plain.result.forTheOrchestrator, /accepted readings/)
})

test('a review that misses, repeats or invents a reading ruling gets one reviewer correction', async () => {
  const state = { pair: { ...L.newPairState(), readings: [{ id: 'R1', status: 'proposed' }, { id: 'R2', status: 'accepted' }] } }
  const ok = { id: 'R1', ruling: 'accepted', evidence: 'The plan lists it as a minimum.' }
  assert.equal(L.pairRulingsError(state, { rulings: [ok] }), null)
  assert.equal(L.pairRulingsError(state, { rulings: [] }), 'The review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading (R1). Missing: R1.')
  assert.equal(L.pairRulingsError(state, { rulings: [{ ...ok, evidence: ' ' }, ok, { ...ok, id: 'R2' }, { ...ok, id: 'R9' }] }),
    'The review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading (R1). Not a proposed reading: "R2", "R9". Repeated: R1. Without a valid ruling or evidence: R1.')
  assert.equal(L.pairRulingsError({ pair: L.newPairState() }, { rulings: [ok] }),
    'The review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading (none is proposed, so rulings=[]). Not a proposed reading: "R1".')
  // Blank entries are not readings.
  const S = { pair: { ...L.newPairState(), label: 'pair-design-1' } }
  assert.deepEqual(L.pairIngestReadings(S, { readings: [reading(), reading({ requirement: ' ' }), reading({ reading: '' })] }), ['R1'])
  assert.deepEqual(S.pair.readings[0], { id: 'R1', stage: 'design', turn: 'pair-design-1', requirement: 'C1', literal: 'Runs on Node 20 and 22.',
    reading: 'Runs on at least Node 20 and 22.', reason: 'CI also tests Node 24.', status: 'proposed', evidence: '', finding: '', history: [] })
  for (const native of [false, true]) {
    let authors = 0
    const author = a => ({ ...a, readings: ++authors === 1 ? [reading()] : [] })
    const { result, calls } = await run({ native, author, review: (r, n) => { if (n === 2) r.rulings = [ok]; return r } })
    assert.equal(result.status, 'done')
    const reviews = calls.filter(c => c.kind === 'review')
    assert.equal(reviews.length, 3)
    assert.match(reviews[1].prompt, /Correct the previous structured review\nThe review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading \(R1\)\. Missing: R1\./)
    assert.match(result.notes.join(' '), /Missing: R1\. Requested one reviewer correction/)
    assert.equal(result.readings[0].status, 'accepted')
    authors = 0
    const failed = await run({ native, author, review: r => { r.rulings = [ok, { ...ok, id: 'R7' }]; return r } })
    assert.equal(failed.result.status, 'blocked')
    assert.match(failed.result.stopReason, /Not a proposed reading: "R7"\./)
    assert.equal(failed.calls.filter(c => c.kind === 'review').length, 2, 'one bounded correction before stopping')
    assert.equal(failed.result.readings[0].status, 'proposed', 'an invalid review rules on nothing')
    assert.ok(failed.result.final.readiness.incomplete.includes('Reading R1 has no ruling.'))
  }
})

test('a reviewer question stops the run for the user at once, with the review recorded and no further author turn', async () => {
  const conflict = { question: 'P1: tests/config.json is fixed by C1, but the isolation rule forbids writing it. Rename the file, or relax the rule for it?',
    quoted: ['C1: "The behavior reads tests/config.json."', 'CLAUDE.md: "Tests never write under tests/."'] }
  for (const native of [false, true]) for (const design of [true, false]) {
    const { result, calls } = await run({ native, args: { design }, review: (r, n) => {
      if (n === 1) Object.assign(r, { summary: 'C1 and the isolation rule conflict; the user must choose.', findings: [finding('C1 conflicts with the test isolation rule.')], questions: [conflict] })
      return r
    } })
    assert.equal(result.status, 'needs-user')
    assert.deepEqual(calls.filter(c => ['author', 'review'].includes(c.kind)).map(c => c.kind), ['author', 'review'], 'no author turn after the question')
    assert.equal(result.stopReason, 'C1 and the isolation rule conflict; the user must choose.')
    assert.deepEqual(result.questions, ['P1: tests/config.json is fixed by C1, but the isolation rule forbids writing it. Rename the file, or relax the rule for it? ' +
      'Requirements as written: C1: "The behavior reads tests/config.json."; CLAUDE.md: "Tests never write under tests/."'])
    assert.equal(result.reviews.length, 1, 'the review counts')
    assert.deepEqual(result.reviews[0].questions, [conflict])
    assert.deepEqual(result.findings.map(f => [f.id, f.status]), [['P1', 'open']])
    assert.equal(result.final.readiness.state, 'blocked')
    assert.ok(result.final.readiness.incomplete.includes('C1 and the isolation rule conflict; the user must choose.'))
    assert.equal(result.summary.questions.length, 1)
    assert.ok(result.report.markdown.includes('\n\nQuestions for the user:\n\n1. P1: tests/config.json is fixed by C1, but the isolation rule forbids writing it. Rename the file, or relax the rule for it? ' +
      'Requirements as written: C1: "The behavior reads tests/config.json."; CLAUDE.md: "Tests never write under tests/."\n\nP1: open — '), result.report.markdown)
  }
  // Without a summary the stop still says why.
  const { result } = await run({ review: r => ({ ...r, summary: ' ', questions: [conflict] }) })
  assert.equal(result.status, 'needs-user')
  assert.equal(result.stopReason, 'The reviewer found a conflict only the user can settle.')
})

test('a reading ruled needs-user stops the run beside the question that cites it; a question must quote its requirements', async () => {
  const ask = { question: 'R1 reads C1 as a minimum; the plan says "exactly". Keep the list exact, or allow Node 24?', quoted: ['C1: "Runs on Node 20 and 22."'] }
  for (const native of [false, true]) {
    let authors = 0
    const { result, calls } = await run({ native, author: a => ({ ...a, readings: ++authors === 1 ? [reading()] : [] }), review: r => {
      r.rulings = [{ id: 'R1', ruling: 'needs-user', evidence: 'The plan says "exactly"; CI runs Node 24 too.' }]
      r.questions = [ask]
      return r
    } })
    assert.equal(result.status, 'needs-user')
    assert.equal(calls.filter(c => c.kind === 'author').length, 1)
    assert.deepEqual(result.readings.map(r => [r.id, r.status, r.finding]), [['R1', 'needs-user', '']])
    assert.ok(result.final.readiness.incomplete.includes('Reading R1 needs a user decision.'))
    assert.match(result.report.markdown, /\n\nR1: reading needs-user — C1 read as: /)
  }
  const state = { pair: { ...L.newPairState(), readings: [{ id: 'R1', status: 'proposed' }, { id: 'R10', status: 'proposed' }] } }
  const ruling = id => ({ id, ruling: 'needs-user', evidence: 'The plan says "exactly".' })
  assert.equal(L.pairRulingsError(state, { rulings: [ruling('R1'), ruling('R10')], questions: [{ question: 'Exact or minimum?', quoted: ['R10 C1: "Runs on Node 20 and 22."'] }] }),
    'The review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading (R1, R10). Ruled needs-user with no question citing it: R1; ask the question, or accept or reject the reading.')
  assert.equal(L.pairRulingsError(state, { rulings: [ruling('R1'), ruling('R10')], questions: [{ question: 'R1 and R10: exact or minimum?', quoted: ['C1'] }] }), null)
  assert.equal(L.pairQuestionsError(state, { questions: [] }), null)
  assert.equal(L.pairQuestionsError(state, { questions: [ask, { ...ask, quoted: [' '] }, { ...ask, question: '' }] }),
    'Each question needs its text and, in quoted, the exact words of every requirement involved. Questions 2, 3 lack one or the other.')
  for (const native of [false, true]) {
    const { result, calls } = await run({ native, review: (r, n) => {
      if (n <= 2) r.questions = [{ ...ask, quoted: n === 1 ? [] : ask.quoted }]
      return r
    } })
    assert.equal(result.status, 'needs-user', 'the corrected review stops the run')
    const reviews = calls.filter(c => c.kind === 'review')
    assert.equal(reviews.length, 2)
    assert.match(reviews[1].prompt, /Correct the previous structured review\nEach question needs its text and, in quoted, the exact words of every requirement involved\. Question 1 lacks one or the other\./)
    assert.equal(calls.filter(c => c.kind === 'author').length, 1)
    let authors = 0
    const unasked = await run({ native, author: a => ({ ...a, readings: ++authors === 1 ? [reading()] : [] }),
      review: r => { r.rulings = [ruling('R1')]; return r } })
    assert.equal(unasked.result.status, 'blocked')
    assert.match(unasked.result.stopReason, /Ruled needs-user with no question citing it: R1;/)
    assert.equal(unasked.calls.filter(c => c.kind === 'review').length, 2, 'one bounded correction before stopping')
    assert.equal(unasked.result.readings[0].status, 'proposed')
  }
})

// An OpenRouter preflight passed review and the gate with its HTTP call stubbed, was reported ready,
// and failed on its first live call: python.org's Python has an empty CA store.
test('live checks from setup and the author reach the result and report; readiness stays ready', async () => {
  const tls = liveCheck(), login = liveCheck({ criterion: 'C2', check: 'Run `gh auth status` and then `node cli.js publish --dry-run`.', reason: 'The tests replace the gh CLI with a stub.' })
  const criteria = [{ id: 'C1', text: 'The requested behavior works.' }, { id: 'C2', text: 'Publishing uses the gh login.' }]
  const assess = r => ({ ...r, criteria: criteria.map(c => ({ criterion: c.id, status: 'met', note: 'Checked against the stub.' })),
    challenges: r.challenges.length ? criteria.map(c => ({ criterion: c.id, wrongImplementation: 'Skip it.', rejectingCheckIds: ['T1'] })) : [] })
  const covering = a => { for (const c of a.testContract.checks) c.criteria = ['C1', 'C2']; return a }
  for (const native of [false, true]) {
    let authors = 0
    const { result, calls } = await run({ native, setup: { criteria, liveChecks: [tls, { criterion: ' ', check: 'Nothing.', reason: '' }] },
      author: a => covering({ ...a, liveChecks: ++authors === 1 ? [{ ...tls, check: ` ${tls.check.replace(/ /g, '  ')} ` }, login] : [login] }), review: assess })
    assert.equal(result.status, 'done')
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(result.delivery.status, 'pending')
    const expected = [{ ...tls, source: 'setup' }, { ...login, source: 'pair-design-1' }]
    assert.deepEqual(result.liveChecks, expected, 'setup first, then the author\'s new entry; repeats and blank entries are dropped')
    assert.deepEqual(result.final.readiness.liveChecks, expected)
    assert.deepEqual(result.summary.final.readiness.liveChecks, expected)
    assert.ok(result.report.markdown.includes('\n\nReadiness: ready; live checks pending: C1, C2. Reviews: 2/8.\n\n' +
      `Live check for C1: ${tls.check} (${tls.reason})\n\nLive check for C2: ${login.check} (${login.reason})\n\nVerification: `), result.report.markdown)
    assert.match(result.forTheOrchestrator, /Before delivery, run each live check \(final\.readiness\.liveChecks\) against the real service or resource it names and report its outcome: a ready run with live checks pending is not done until they pass\./)
    // The author always sees the list; the reviewer reads it, once there is one, and leaves it alone.
    const ledger = prompt => JSON.parse(prompt.match(/\n# Live checks\n(.*)\n/)[1])
    const [design, code] = calls.filter(c => c.kind === 'author').map(c => c.prompt)
    assert.deepEqual(ledger(design), [expected[0]])
    assert.deepEqual(ledger(code), expected)
    for (const review of calls.filter(c => c.kind === 'review').map(c => c.prompt)) {
      assert.deepEqual(ledger(review), expected)
      assert.match(review, /Don't run the live checks \(you have no network\), and don't file the missing live result as a finding\./)
    }
  }
  const plain = await run({})
  assert.deepEqual([plain.result.liveChecks, plain.result.final.readiness.liveChecks], [[], []])
  assert.match(plain.result.report.markdown, /\n\nReadiness: ready\. Reviews: 2\/8\.\n\nVerification: /)
  assert.doesNotMatch(plain.result.forTheOrchestrator, /live check/)
  assert.match(plain.calls.find(c => c.kind === 'author').prompt, /\n# Live checks\n\[\]\n/)
  assert.ok(plain.calls.filter(c => c.kind === 'review').every(c => !c.prompt.includes('# Live checks')))
  // A run that stops still lists them, under its own readiness.
  const stopped = await run({ setup: { liveChecks: [tls] }, author: a => ({ ...a, status: 'needs-user', questions: ['Which API?'] }) })
  assert.equal(stopped.result.status, 'needs-user')
  assert.equal(stopped.result.final.readiness.state, 'incomplete')
  assert.ok(stopped.result.report.markdown.includes(`\n\nReadiness: incomplete; live checks pending: C1. Reviews: 0/8.\n\nLive check for C1: ${tls.check} (${tls.reason})\n\n`))
  assert.match(stopped.result.forTheOrchestrator, /run each live check/)
  // The setup and author prompts ask for them; neither reaches the council's setup.
  const setup = L.pairSetupPrompt(L.newState(L.parsePairConfig('Fix it')))
  assert.match(setup, /List in liveChecks each criterion that the run can check only against a stand-in for something outside it, where the real thing can behave differently/)
  assert.match(setup, /Don't list such a criterion in unverifiable: the run still checks it with the stand-in/)
  assert.doesNotMatch(L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix it' }))), /liveChecks|stand-in/)
  const S = { pair: L.newPairState() }
  assert.deepEqual(L.pairIngestLiveChecks(S, [tls, { ...tls, reason: 'Another reason.' }, { criterion: 'C1', check: ' ' }, null], 'setup').map(c => c.reason), [tls.reason, 'Another reason.'])
  assert.deepEqual(L.pairIngestLiveChecks(S, undefined, 'pair-design-1'), [])
})
