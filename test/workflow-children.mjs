// The child workflows Factory hands a routed tier to, run as the native workflow() host runs them
// (test/fixtures/workflow-host.mjs). No models are called.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadLib } from './lib.mjs'
import { PARAMS, runCandidate, workflowHost } from './fixtures/workflow-host.mjs'

const L = loadLib()
const INTAKE = (tier, strategy, o = {}) => ({ status: 'ok', tier, mode: 'implement', strategy, reasons: `it looks like ${tier} work`, planMissing: '', signals: {}, split: [], ...o })
const host = (over = {}) => ({ agent: async () => { throw new Error('no agent turn expected') }, parallel: async () => { throw new Error('no panel expected') },
  pipeline: null, phase: () => {}, log: () => {}, budget: {}, factoryRuntime: undefined, ...over })

// Stand-in children in a scratch directory: each returns what the host passed it.
function scratchChildren(sources) {
  const dir = mkdtempSync(join(tmpdir(), 'df-children-'))
  for (const [name, body] of Object.entries(sources)) writeFileSync(join(dir, `${name}.js`), `export const meta = { name: '${name}' }\n${body}`)
  return dir
}
const BRIEF = { outcome: 'Fix the parser.', purpose: 'Read empty input safely.', scope: 'Parser.', nonGoals: 'Other inputs.',
  acceptanceExamples: ['Empty input parses safely.'], verification: 'Run the parser tests.', delegated: ['testing', 'implementation', 'internal design'] }
const echo = `return { names: { ${PARAMS.join(', ')} }, count: arguments.length }`

test('the child host passes exactly the native parameters, sharing the caller\'s runtime', async () => {
  assert.deepEqual(PARAMS, ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime'])
  const h = host({ pipeline: async () => null, factoryRuntime: { agent() {}, turn() {}, measure() {} }, budget: { spent: () => 7 } })
  const wf = workflowHost(h, { dir: scratchChildren({ council: echo }) })
  const args = { task: 'Fix it' }
  const out = await wf.workflow('dark-factory:council', args)
  assert.equal(out.count, PARAMS.length)
  for (const name of ['agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'factoryRuntime']) assert.equal(out.names[name], h[name], name)
  assert.deepEqual(out.names.args, args)
  assert.notEqual(out.names.args, args, 'the child gets a copy')
  assert.equal(typeof out.names.workflow, 'function')
})

test('the child host throws on an unknown child and on a nested workflow() call', async () => {
  const dir = scratchChildren({ council: `return await workflow('dark-factory:pair', {})`, pair: echo, factory: echo })
  const wf = workflowHost(host(), { dir })
  for (const name of ['dark-factory:factory', 'dark-factory:ensemble', 'council', 'dark-factory:', null]) {
    await assert.rejects(wf.workflow(name, {}), /^Error: Unknown workflow: /, String(name))
  }
  await assert.rejects(wf.workflow('dark-factory:council', { task: 'x' }), { message: 'workflow() cannot be called inside a child workflow' })
  assert.deepEqual(wf.ran.map(r => r.name), ['dark-factory:council'], 'an unknown name runs nothing')
})

test('the child host copies args and records each child it ran', async () => {
  const dir = scratchChildren({ council: `args.nested.value = 'child'; args.added = true; return args`, pair: echo })
  const wf = workflowHost(host(), { dir })
  const args = { task: 'Fix it', nested: { value: 'caller' }, list: [1, { two: 2 }] }
  const before = structuredClone(args)
  const out = await wf.workflow('dark-factory:council', args)
  assert.deepEqual(args, before, 'a child changing its args leaves the caller\'s unchanged')
  assert.deepEqual([out.nested.value, out.added], ['child', true])
  await wf.workflow('dark-factory:pair', { factoryHandoff: { version: 1 } })
  assert.deepEqual(wf.ran, [
    { name: 'dark-factory:council', args: before },
    { name: 'dark-factory:pair', args: { factoryHandoff: { version: 1 } } },
  ])
  // The runtime passes args as JSON: what JSON would change is refused, and no child runs.
  for (const bad of [{ task: 'x', gone: undefined }, { task: 'x', rounds: Infinity }]) {
    await assert.rejects(wf.workflow('dark-factory:council', bad), { message: 'workflow(dark-factory:council): args do not survive JSON unchanged' })
  }
  assert.equal(wf.ran.length, 2)
})

test('the child host runs the built council and pair workflows', async () => {
  const wf = workflowHost(host())
  for (const child of ['council', 'pair']) {
    const out = await wf.workflow(`dark-factory:${child}`, { task: 'Fix the parser', explain: true })
    assert.equal(out.status, 'explained', child)
  }
  assert.deepEqual(wf.ran.map(r => r.name), ['dark-factory:council', 'dark-factory:pair'])
})

test('the delegating Factory hands each routed tier to the child its strategy names, with an envelope it accepts', async () => {
  for (const [tier, strategy, child] of [['simple', 'pair', 'pair'], ['simple', 'independent', 'council'], ['fix', 'independent', 'council'],
    ['feature', 'pair', 'pair'], ['feature', 'independent', 'council'], ['architecture', 'independent', 'council']]) {
    const logs = [], labels = []
    const h = host({ log: line => logs.push(line), budget: { spent: () => 5000 + 1000 * labels.length },
      agent: async (prompt, opts) => { labels.push(opts.label); return INTAKE(tier, strategy, tier === 'architecture' ? { mode: 'design' } : {}) } })
    // An explanation: the child reads the envelope and returns without a turn of its own.
    const { result, ran, returned } = await runCandidate(h, { task: 'Fix the parser', brief: false, explain: true }, { dispatches: () => labels.length })
    const why = `${tier} ${strategy}`
    assert.equal(result.status, 'explained', why)
    assert.deepEqual(labels, ['intake'], why)
    assert.ok(logs.some(l => l.startsWith(`factory: tier ${tier} (intake): `)), `${why}: Factory logs the routing line`)
    assert.deepEqual(ran.map(r => r.name), [`dark-factory:${child}`], why)
    assert.deepEqual(returned.map(r => r.dispatches), [0], why)
    const handoff = ran[0].args.factoryHandoff
    assert.deepEqual(Object.keys(ran[0].args), ['factoryHandoff'], why)
    assert.deepEqual([handoff.version, handoff.tier, handoff.strategy, handoff.factory.tier, handoff.factory.chosenBy], [1, tier, strategy, tier, 'intake'], why)
    assert.deepEqual(handoff.control, { started: null, turns: 1, maxTurns: null, maxRunMin: null, meterStart: 5000 }, why)
    assert.equal(L.readHandoff({ factoryHandoff: handoff }, child), handoff, why)
  }
  // Factory's own stops before routing are its result, and no child runs.
  const h = host({ agent: async () => INTAKE('simple', 'pair', { status: 'needs-plan', planMissing: 'PLAN.md' }) })
  const { result, ran } = await runCandidate(h, { task: 'Do item 3 of the plan', brief: false })
  assert.deepEqual([result.status, ran], ['needs-plan', []])
})

// Valid envelopes as the delegating Factory passes them to workflow() for an executed route, for the
// boot table to break one field at a time. The child's first turn ends the run.
const SEEDED = new Error('the seed run ends at the child\'s first turn')
async function seed(tier, strategy) {
  const h = host({ agent: async (prompt, opts) => { if (opts.label === 'intake') return INTAKE(tier, strategy); throw SEEDED }, budget: { spent: () => 5000 } })
  const wf = workflowHost(h)
  await runCandidate(h, { task: 'Fix the parser', brief: false }, { wf }).catch(e => { if (e !== SEEDED) throw e })
  assert.deepEqual(wf.ran.map(r => r.name), [`dark-factory:${strategy === 'pair' ? 'pair' : 'council'}`])
  return wf.ran[0].args.factoryHandoff
}

// A child counts every native and hosted dispatch; none may happen before the envelope is read.
function counted(hosted, clock = false) {
  const counter = { n: 0 }
  const count = async () => { counter.n++; throw new Error('a dispatch reached the stub') }
  const runtime = hosted ? { agent: count, turn: count, measure: count, brief: count, usage: () => null, history: () => null, ...(clock ? { now: () => 0 } : {}) } : undefined
  return { counter, host: host({ agent: count, parallel: count, pipeline: count, factoryRuntime: runtime }) }
}

test('a malformed one-key factory handoff stops each child before any agent turn, on both hosts', async () => {
  const pair = await seed('simple', 'pair'), independent = await seed('fix', 'independent')
  const rows = other => [
    ['version must be 1', h => { h.version = 2 }],
    ['strategy does not match child workflow', () => structuredClone(other)],
    ['unknown envelope field', h => { h.extra = true }],
    ['unknown factory.intake.tier', h => { h.factory.intake.tier = 'huge' }],
    ['unknown factory.intake.mode', h => { h.factory.intake.mode = 'ship' }],
    ['carried.notes must be an array', h => { h.carried.notes = 'a note' }],
    ['control.turns must be a non-negative integer', h => { h.control.turns = -1 }],
    ['control.meterStart must be finite and non-negative or null', h => { h.control.meterStart = -1 }],
    // Neither host here has the standalone runner's clock.
    ['control.started needs a clock, which the native workflow runtime lacks', h => { h.control.started = 1000 }],
    ['control.maxRunMin needs a clock, which the native workflow runtime lacks', h => { h.control.maxRunMin = 1 }],
    ['factory.brief must be a settled goal brief', h => {
      const { acceptanceExamples, ...brief } = BRIEF
      Object.assign(h.factory, { brief: { version: 1, state: 'settled', decisions: [], brief }, briefFile: '/repo/.council/brief-x/BRIEF.json' })
    }],
  ]
  const table = {
    council: { valid: independent, rows: rows(pair) },
    pair: { valid: pair, rows: [...rows(independent),
      ['Pair cannot run at Architecture', h => { h.tier = 'architecture'; h.factory.tier = 'architecture' }],
      ['Pair cannot run after escalation', h => { h.tier = 'fix'; h.factory.tier = 'fix'; h.factory.escalation = { from: 'simple', to: 'fix', earlier: null } }]] },
  }
  for (const [child, { valid, rows }] of Object.entries(table)) {
    for (const hosted of [false, true]) {
      for (const [reason, mutate] of rows) {
        const why = `${child} ${hosted ? 'hosted' : 'native'}: ${reason}`
        const envelope = structuredClone(valid)
        const bad = mutate(envelope) || envelope
        const { counter, host: h } = counted(hosted)
        await assert.rejects(workflowHost(h).workflow(`dark-factory:${child}`, { factoryHandoff: bad }),
          { message: `${child}: malformed factory handoff (${reason}); this input comes only from dark-factory:factory.` }, why)
        assert.equal(counter.n, 0, why)
      }
      // The same envelope unbroken gets past boot to the child's first dispatch, which the child may
      // turn into a failed result or let throw.
      const { counter, host: h } = counted(hosted)
      await workflowHost(h).workflow(`dark-factory:${child}`, { factoryHandoff: structuredClone(valid) }).catch(e => assert.match(e.message, /a dispatch reached the stub/))
      assert.ok(counter.n > 0, `${child} ${hosted ? 'hosted' : 'native'}: the valid seed dispatches`)
    }
    // On a host with a clock, Factory would have recorded its start.
    const { counter, host: h } = counted(true, true)
    await assert.rejects(workflowHost(h).workflow(`dark-factory:${child}`, { factoryHandoff: structuredClone(valid) }),
      { message: `${child}: malformed factory handoff (control.started must be set on a host with a clock); this input comes only from dark-factory:factory.` }, `${child} clocked`)
    assert.equal(counter.n, 0, `${child} clocked`)
  }
})

// Factory's time budget, carried to the council child on a host with the standalone runner's clock:
// the child reads the time from Factory's start, so it stops where inline Factory stops, here before
// its first turn. Each clock read moves on half a minute: Factory's start, then one before each turn.
test('a carried time budget stops the council child where inline Factory stops', async () => {
  for (const tier of ['simple', 'fix']) {
    const arm = async via => {
      const logs = [], dispatches = []
      let reads = 0
      const dispatch = kind => async request => {
        dispatches.push([kind, request.label])
        return kind === 'agent' && request.label === 'intake' ? INTAKE(tier, 'independent') : assert.fail(`${via}: unexpected ${kind} ${request.label}`)
      }
      const runtime = { agent: dispatch('agent'), turn: dispatch('turn'), measure: dispatch('measure'), now: () => 30000 * reads++ }
      const h = host({ log: line => logs.push(line), factoryRuntime: runtime })
      const args = { task: 'Fix the parser', brief: false, maxRunMin: 1 }
      const out = via === 'inline' ? { result: await workflowHost(h, { children: ['factory'] }).workflow('dark-factory:factory', args), ran: [] }
        : await runCandidate(h, args)
      return { ...out, logs, dispatches, reads }
    }
    const inline = await arm('inline'), child = await arm('candidate')
    assert.deepEqual([inline.result.status, inline.result.stopReason, inline.dispatches], ['blocked', 'Run time budget exhausted (1 minutes).', [['agent', 'intake']]], tier)
    assert.deepEqual(child.ran.map(r => r.name), ['dark-factory:council'], tier)
    assert.deepEqual([child.dispatches, child.logs, child.reads], [inline.dispatches, inline.logs, inline.reads], tier)
    assert.equal(JSON.stringify(child.result), JSON.stringify(inline.result), tier)
  }
})
