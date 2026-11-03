// Codex host configuration and the adapter boundary. No models or CLIs are called.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLib } from './lib.mjs'
import { LIB } from '../tools/sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const L = loadLib()
const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }

function harness(runtime, args = { task: 'Fix the parser', host: 'codex' }) {
  const source = [...LIB, 'src/boot.js', 'src/schemas.js', 'src/turns.js'].map(f => readFileSync(join(root, f), 'utf8')).join('\n')
  const load = new Function('factoryRuntime', 'agent', 'parallel', 'log', 'phase', 'args', source +
    '\nreturn { state: S, ask, seatTurn, externalTurn, panelRun, recordFacts, runRetro };')
  return load(runtime, () => { throw new Error('unexpected Claude runtime call') }, jobs => Promise.all(jobs.map(f => f())), () => {}, () => {}, args)
}

const run = { runId: 'test-host', runDir: '/repo/.council/test-host', room: '/repo/.council/test-host/room', repoRoot: '/repo' }
const turnOptions = { key: 'A-r0', threadKey: 'A', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high', role: 'seat',
  sandbox: 'workspace-write', cwd: `${run.runDir}/wt/A`, writable: [run.room], fresh: false }
const done = request => ({ status: 'done', result: { summary: 'completed', turn: request.schema.properties.turn.enum[0] }, elapsedSec: 3 })

describe('Codex host configuration', () => {
  test('every tier defaults to an Opus seat beside Codex models, with Codex roles and reviewers', () => {
    const raw = { task: 'Add a parser', host: 'codex' }
    for (const tier of ['simple', 'fix', 'feature', 'architecture']) {
      const args = L.tierArgs(raw, tier, { mode: 'implement' })
      const config = L.parseConfig(args, { workflow: 'factory', tier })
      assert.deepEqual(L.externalVendors(config).sort(), tier === 'simple' ? ['codex'] : ['claude', 'codex'])
      for (const member of [...config.lineup, ...config.panel, ...config.specReviewers, ...config.auditors]) {
        assert.equal(member.vendor, member.key === 'opus' ? 'claude' : 'codex')
        assert.equal(L.external(member), true)
      }
      assert.equal(config.roles.intake.key, 'astra')
      assert.equal(config.roles.setup.key, 'sol')
      assert.equal(config.checkModel, 'sol')
      if (tier === 'simple') assert.deepEqual([config.lineup[0].key, config.auditors[0].key], ['sol', 'astra'])
      if (tier !== 'simple') assert.deepEqual(config.lineup.map(s => s.key), ['opus', 'astra', 'sol'])
    }
  })

  test('explicit providers, roles, and Simple limits survive intake rebuilding', () => {
    const raw = { task: 'Fix parser', host: 'codex', simple: { implementer: 'opus', reviewer: 'sol', maxLines: 37, maxFiles: 2 },
      roles: { intake: 'sonnet', checker: { model: 'codex:custom-model', effort: 'high' } }, panel: ['opus', 'sol'] }
    const config = L.parseConfig(L.tierArgs(raw, 'simple', { mode: 'implement' }), { workflow: 'factory', tier: 'simple' })
    assert.deepEqual(config.simple, raw.simple)
    assert.equal(config.lineup[0].vendor, 'claude')
    assert.equal(L.external(config.lineup[0]), true, 'Claude also uses the CLI session in the Codex host')
    assert.equal(config.roles.intake.model, 'sonnet')
    assert.equal(config.roles.checker.model, 'custom-model')
    assert.equal(config.roles.checker.effort, 'high')
    assert.deepEqual(L.externalVendors(config), ['claude', 'codex'])
  })

  test('escalation retains host/roles but adopts the higher tier seats', () => {
    const raw = { task: 'Fix parser', host: 'codex', roles: { setup: 'astra' }, simple: { implementer: 'luna' } }
    const featureArgs = L.tierArgs(raw, 'feature', { mode: 'implement' })
    const config = L.parseConfig(featureArgs, { workflow: 'factory', tier: 'feature' })
    assert.equal(config.host, 'codex')
    assert.equal(config.roles.setup.key, 'astra')
    assert.deepEqual(config.lineup.map(s => s.key), ['opus', 'astra', 'sol'])
    assert.equal(config.simple, null)
    assert.equal(featureArgs.simple, undefined)
  })

  test('explicit seats, audits, spec, and panel members keep their selected providers', () => {
    const config = L.parseConfig({ task: 'Fix parser', host: 'codex', seats: ['opus', 'sol'],
      audit: { correctness: 'gemini', design: 'sonnet' }, spec: { coverage: 'opus', intent: 'luna' }, panel: ['sonnet', 'astra'] })
    assert.deepEqual(config.lineup.map(s => s.vendor), ['claude', 'codex'])
    assert.deepEqual(config.auditors.map(s => s.vendor), ['gemini', 'claude'])
    assert.deepEqual(config.specReviewers.map(s => s.vendor), ['claude', 'codex'])
    assert.deepEqual(config.panel.map(s => s.vendor), ['claude', 'codex'])
  })

  test('invalid role and model choices fail before agents run', () => {
    assert.throws(() => L.parseConfig({ task: 'Fix parser', host: 'codex', roles: { checkre: 'sol' } }), /unknown role/)
    assert.throws(() => L.parseConfig({ task: 'Fix parser', host: 'codex', roles: { checker: 'missing' } }), /unknown seat/)
    assert.throws(() => L.parseConfig({ task: 'Fix parser', host: 'codex', roles: { checker: { model: 'sol', effort: 'invalid' } } }), /effort/)
  })

  test('setup run IDs are optional for legacy hosts and validate their host-owned prefix', () => {
    assert.equal(L.setupRunId(L.newState(L.parseConfig({ task: 'Fix parser' }))), null)
    assert.equal(L.setupRunId(L.newState(L.parseConfig({ task: 'Fix parser', host: 'codex' }))), null)
    assert.equal(L.setupRunId(L.newState(L.parseConfig({ task: 'Fix parser', host: 'codex', hostRunId: 'host-unique' }))), 'host-unique-council')
    for (const prefix of ['../outside', 'a/b', 'a;echo bad', '', 17]) {
      const state = L.newState(L.parseConfig({ task: 'Fix parser', host: 'codex', hostRunId: prefix }))
      assert.throws(() => L.setupRunId(state), /hostRunId/)
    }
  })

  test('the absent-host configuration retains Claude defaults and prompts', () => {
    const config = L.parseConfig({ task: 'Fix parser' })
    assert.deepEqual(config.lineup.map(s => s.key), ['opus', 'sonnet', 'astra', 'gemini'])
    assert.deepEqual(config.roles, {})
    assert.equal(config.checkModel, 'sonnet')
    assert.equal(L.external(config.lineup[0]), false)
    assert.deepEqual(L.tierArgs({ task: 'Fix parser' }, 'feature', null).seats, ['opus', 'astra'])
    assert.match(L.setupPrompt(L.newState(config)), /dangerouslyDisableSandbox/)
    assert.doesNotMatch(L.setupPrompt(L.newState(L.parseConfig({ task: 'Fix parser', host: 'codex' }))), /dangerouslyDisableSandbox/)
  })
})

describe('runtime adapter boundary', () => {
  test('orchestration roles use resolved models and fresh contexts', async () => {
    const calls = []
    const h = harness({ agent: async request => { calls.push(request); return { summary: 'read', process: '' } } },
      { task: 'Fix parser', host: 'codex', roles: { intake: { model: 'sol', effort: 'high' } } })
    await h.ask('read the task', { label: 'intake', phase: 'Intake', model: 'opus', effort: 'medium', schema }, 'intake')
    h.state.run = run
    await h.ask('check snapshot', { label: 'check r0:A', phase: 'Solve', model: 'sonnet', effort: 'medium', schema }, 'checker')
    assert.equal(calls[0].vendor, 'codex')
    assert.equal(calls[0].model, 'gpt-6.1-sol')
    assert.equal(calls[0].effort, 'high')
    assert.equal(calls[0].run, null)
    assert.equal(calls[1].run, run)
    assert.ok(calls.every(c => c.fresh && c.schema.properties.process))
    assert.deepEqual(h.state.turnLog.map(t => [t.role, t.vendor, t.ok]), [['intake', 'codex', true], ['checker', 'codex', true]])
  })

  test('direct turns retain exact prompt, tag, worktree, and thread identity without a relay', async () => {
    let captured
    const h = harness({ turn: async request => { captured = request; return done(request) } })
    h.state.run = run
    const result = await h.externalTurn(turnOptions, 'Read line one.\nKeep line two exactly.', schema, 'r0:A sol', 'Solve')
    assert.deepEqual(result, { summary: 'completed' })
    assert.equal(captured.cwd, turnOptions.cwd)
    assert.deepEqual(captured.writable, [run.room])
    assert.equal(captured.threadKey, 'A')
    assert.equal(captured.fresh, false)
    assert.match(captured.prompt, /^Read line one\.\nKeep line two exactly\./)
    assert.equal(captured.expect, L.promptHash(captured.prompt))
    assert.equal(h.state.turnLog.length, 1)
    assert.equal(h.state.turnLog[0].vendor, 'codex')
    assert.equal(h.state.vendorTimes[0].seconds, 3)
    assert.deepEqual(h.state.relayFailures, [])
  })

  test('Claude seats in Codex use their own CLI worktree and session', async () => {
    const calls = []
    const h = harness({ turn: async request => { calls.push(request); return done(request) } })
    h.state.run = run
    const member = { ...L.parseSeat('opus'), L: 'A', wt: `${run.runDir}/wt/A`, external: true }
    await h.seatTurn(member, 0, 'solve alone', schema)
    await h.seatTurn(member, 1, 'debate', schema)
    assert.deepEqual(calls.map(c => [c.vendor, c.threadKey, c.cwd]), [['claude', 'A', member.wt], ['claude', 'A', member.wt]])
    assert.deepEqual(calls.map(c => c.key), ['A-r0', 'A-r1'])
    assert.ok(calls.every(c => c.fresh === false))
  })

  test('stale output is rejected and a failed model is never logged as successful', async () => {
    const h = harness({ turn: async () => ({ status: 'done', result: { turn: 'old-turn', summary: 'stale' } }) })
    h.state.run = run
    assert.equal(await h.externalTurn(turnOptions, 'new prompt', schema, 'r0:A sol', 'Solve'), null)
    assert.equal(h.state.turnLog[0].ok, false)
    assert.match(h.state.notes[0], /earlier turn/)
  })

  test('native role diagnostics reach notes independently of model process feedback', async () => {
    const h = harness({ agent: async request => {
      request.onResult({ status: 'error', error: 'Invalid checker output',
        permissionDenials: { count: 1, tools: ['Bash'], source: '/run/jobs/check/out.json' } })
      return null
    } }, { task: 'Fix parser', host: 'codex', retro: false })
    assert.equal(await h.ask('check', { label: 'check r0:A', model: 'sonnet', schema }, 'checker'), null)
    assert.match(h.state.notes.join('\n'), /submission was not accepted/)
    assert.match(h.state.notes.join('\n'), /Invalid checker output/)
    assert.match(h.state.notes.join('\n'), /\/run\/jobs\/check\/out.json/)
  })

  test('sandbox failures block that vendor without adding a Claude permission instruction', async () => {
    let calls = 0
    const h = harness({ turn: async () => { calls++; return { status: 'sandboxed', error: 'cannot access account state' } } })
    h.state.run = run
    assert.equal(await h.externalTurn(turnOptions, 'first', schema, 'r0:A sol', 'Solve'), null)
    assert.equal(await h.externalTurn(turnOptions, 'second', schema, 'r1:A sol', 'Round 1'), null)
    assert.equal(calls, 1)
    assert.equal(h.state.blocked.codex, true)
    assert.doesNotMatch(h.state.notes.join('\n'), /\.claude\/settings/)
  })

  test('native and external adapter exceptions become failed turns', async () => {
    const h = harness({ agent: async () => { throw new Error('bad structured output') }, turn: async () => { throw new Error('process failed') } })
    h.state.run = run
    assert.equal(await h.ask('read', { label: 'intake', model: 'opus', schema }, 'intake'), null)
    assert.equal(await h.externalTurn(turnOptions, 'solve', schema, 'r0:A sol', 'Solve'), null)
    assert.equal(h.state.turnLog.filter(t => !t.ok).length, 2)
    assert.match(h.state.notes.join('\n'), /bad structured output/)
    assert.match(h.state.notes.join('\n'), /process failed/)
  })

  test('facts recording supplies the exact payload as a runtime-owned file', async () => {
    let request
    const h = harness({ agent: async value => { request = value; return { saved: '/saved', error: '' } } })
    h.state.run = run
    const payload = 'Facts with `literal code` and unicode α\n'
    const result = await h.recordFacts(payload)
    assert.equal(request.payload, payload)
    assert.equal(request.payloadFile, `${run.runDir}/retro-data.md`)
    assert.match(request.prompt, /--payload-file/)
    assert.doesNotMatch(request.prompt, /dangerouslyDisableSandbox|BEGIN PAYLOAD/)
    assert.equal(request.role, 'record')
    assert.equal(result.saved, '/saved')
    assert.equal(h.state.turnLog[0].vendor, 'codex')
  })
})

// Exercise the generated factory itself through the new adapter, including the existing
// decision code. Schema-shaped canned agent results provide evidence; no filesystem is mocked
// inside the engine, because its filesystem work belongs to the adapter tested separately.
function emptyResult(schema) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, s]) => [k, emptyResult(s)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'integer' || schema.type === 'number') return 0
  return ''
}

async function factoryFlow(tier, { escalate = false, oversizedPlan = false, failedReview = false, deniedProbe = false,
  failedSeat = false, deniedVerification = false, evidenceStatus = 'complete', args = {} } = {}) {
  const calls = [], phases = []
  let setups = 0
  const runtime = {
    agent: async request => {
      calls.push(request)
      const result = emptyResult(request.schema)
      if (request.role === 'intake') return { ...result, status: 'ok', tier, mode: tier === 'architecture' ? 'design' : 'implement', reasons: 'fixture' }
      if (request.role === 'setup') {
        setups++
        const id = request.setupRunId || `host-flow-${setups}`
        return { ...result, status: 'ok', mode: tier === 'architecture' || setups === 2 && oversizedPlan ? 'design' : 'implement',
          runId: id, runDir: `/repo/.council/${id}`, repoRoot: '/repo', verify: 'make test', baselinePasses: true,
          criteria: [{ id: 'C1', text: 'the parser is correct' }] }
      }
      if (request.role === 'checker') {
        const measured = request.prompt.includes('# Step 1 — measure')
        const letter = request.label.match(/:([A-F])/)[1]
        return { ...result, measured, diff: { files: measured ? 1 : 0, added: measured ? 1 : 0, removed: 0, tree: measured ? letter.toLowerCase().repeat(40) : '' },
          suite: { ran: measured && !deniedVerification, passed: measured && !deniedVerification,
            tail: deniedVerification ? 'Required verification denied; no result' : measured ? 'OK' : '' }, postWords: 200,
          criteria: [{ criterion: 'C1', status: 'met', note: 'checked' }] }
      }
      if (request.role === 'record' || request.role === 'retro') return { ...result, saved: '/repo/.council/facts', error: '' }
      throw new Error(`unexpected native role ${request.role}`)
    },
    turn: async request => {
      calls.push(request)
      if (failedReview && request.role === 'auditor') return { status: 'error', error: 'reviewer unavailable' }
      if (failedSeat && request.role === 'seat' && request.vendor === 'claude') return { status: 'error', error: 'Claude turn interrupted' }
      const result = emptyResult(request.schema)
      if (request.role === 'auditor' && request.schema.properties.evidenceReview) {
        result.evidenceReview = { status: request.prompt.includes('You own the historical acceptance check') ? evidenceStatus : 'not-assigned', note: 'Historical artifact check.' }
        if (evidenceStatus === null) delete result.evidenceReview
      }
      if (request.role === 'seat') {
        result.summary = `position ${request.threadKey}`
        if (request.schema.properties.confidence) result.confidence = 4
        if (request.schema.properties.vote) result.vote = { ship: 'A', reason: 'best supported', amendments: [] }
        if (request.schema.properties.endorse) result.endorse = true
        if (request.schema.properties.increments) result.increments = Array.from({ length: oversizedPlan ? 5 : 2 }, (_, i) => ({ title: `Step ${i + 1}`, delivers: 'parser behavior' }))
        if (request.schema.properties.milestones) result.milestones = [{ title: 'Parser', task: 'Implement the parser', criteria: ['Correct behavior'], after: [], tier: 'simple', working: 'The parser handles input' }]
        if (escalate && request.schema.properties.tooBig) result.tooBig = { tier: 'feature', reason: 'the API needs design work' }
      }
      return { status: 'done', result, elapsedSec: 1,
        ...(deniedProbe && request.role === 'seat' && request.vendor === 'claude' && /-r0$/.test(request.key)
          ? { permissionDenials: { count: 2, tools: ['Bash'], source: `${request.run.runDir}/jobs/${request.key}/out.json` } } : {}) }
    },
  }
  const source = readFileSync(join(root, 'plugins/dark-factory/workflows/factory.js'), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const factory = new AsyncFunction('factoryRuntime', 'agent', 'parallel', 'phase', 'log', 'args', source)
  const result = await factory(runtime, () => { throw new Error('Claude runtime was called') },
    jobs => Promise.all(jobs.map(f => f())), phase => phases.push(phase), () => {}, { task: 'Improve the parser', host: 'codex', ...args })
  return { result, calls, phases }
}

test('historical evidence gaps keep clean factory audits incomplete', async () => {
  for (const evidenceStatus of ['incomplete', null]) {
    const { result } = await factoryFlow('feature', { evidenceStatus, args: { evidence: true } })
    assert.equal(result.final.readiness.state, 'incomplete')
    assert.ok(result.final.readiness.incomplete.some(x => x.includes('historical evidence review incomplete: tests')))
    assert.equal(result.audit.fixPass, false)
    assert.equal(result.delivery.status, 'pending')
  }
  const { result, calls } = await factoryFlow('feature', { args: { evidence: true } })
  assert.equal(result.final.readiness.state, 'ready')
  const check = calls.find(c => c.role === 'checker' && c.prompt.includes('# Step 1 — measure'))
  assert.ok(check.prompt.includes('--max-wait 5'))
  assert.ok(!check.prompt.includes('timeout 600000'))
  const owner = calls.find(c => c.role === 'auditor' && c.prompt.includes('You own the historical acceptance check'))
  assert.ok(owner.prompt.includes('dark-factory evidence --run-dir'))
  assert.ok(owner.prompt.includes("Don't open anything else under"))
})

describe('Codex factory phase routing', () => {
  test('completed Claude design with denials reaches debate and independent review with two seats', async () => {
    const { result, calls, phases } = await factoryFlow('architecture', {
      deniedProbe: true, args: { seats: ['sonnet', 'astra'], retro: false },
    })
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(calls.filter(c => c.role === 'seat' && /-r0$/.test(c.key)).length, 2)
    assert.ok(calls.some(c => c.role === 'seat' && /-r1$/.test(c.key)))
    assert.ok(calls.some(c => c.role === 'auditor' && c.fresh))
    assert.ok(!phases.includes('Build'))
    assert.match(result.notes.join('\n'), /2 tool permission denial.*Bash/)
    assert.match(result.notes.join('\n'), /accepted for verification and review/)
    assert.match(result.notes.join('\n'), /out.json/)
  })

  test('a genuinely failed seat still stops a two-seat run with an accurate reason', async () => {
    const { result, calls } = await factoryFlow('architecture', {
      failedSeat: true, args: { seats: ['sonnet', 'astra'] },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, /fewer than two seat submissions were accepted/)
    assert.match(result.notes.join('\n'), /Claude turn interrupted/)
    assert.ok(!calls.some(c => c.role === 'auditor'))
  })

  test('accepting a submission with denials cannot make missing required verification ready', async () => {
    const { result } = await factoryFlow('simple', {
      deniedProbe: true, deniedVerification: true,
      args: { simple: { implementer: 'sonnet', reviewer: 'astra' } },
    })
    assert.notEqual(result.final.readiness.state, 'ready')
    assert.match(result.notes.join('\n'), /tool permission denial/)
  })

  for (const tier of ['simple', 'fix', 'feature', 'architecture']) {
    test(`${tier} completes through the shared engine and direct adapter`, async () => {
      const { result, calls, phases } = await factoryFlow(tier)
      assert.equal(result.factory.tier, tier)
      assert.equal(result.final.readiness.state, 'ready')
      assert.ok(calls.every(c => c.vendor === (c.role === 'seat' && c.model === 'opus' ? 'claude' : 'codex')))
      assert.ok(calls.filter(c => ['intake', 'setup', 'checker'].includes(c.role)).every(c => c.fresh === true))
      assert.ok(calls.filter(c => c.role === 'auditor').every(c => c.fresh === true && c.threadKey.startsWith('audit-')))
      assert.equal(calls.filter(c => c.role === 'seat' && /-r0$/.test(c.key)).length, tier === 'simple' ? 1 : 3)
      assert.equal(phases.includes('Spec'), tier !== 'simple')
      assert.equal(phases.includes('Build'), tier === 'feature')
      assert.equal(phases.includes('Ratify'), tier === 'fix')
      assert.equal(calls.filter(c => c.role === 'seat' && /-inc\d+$/.test(c.key)).length, tier === 'feature' ? 2 : 0)
      assert.doesNotMatch(result.forTheOrchestrator, /Workflow\(|Sonnet subagent/)
      if (tier === 'architecture') {
        assert.equal(result.milestones.length, 1)
        assert.equal(result.milestones[0].args.host, 'codex')
        assert.ok(calls.filter(c => c.role === 'auditor').every(c => c.sandbox === 'read-only' && !c.checkout))
      }
    })
  }

  test('Simple escalation starts fresh worktrees and keeps Codex role overrides', async () => {
    const { result, calls } = await factoryFlow('simple', { escalate: true, args: { roles: { checker: 'astra' } } })
    assert.equal(result.factory.tier, 'feature')
    assert.equal(result.factory.startedAt, 'simple')
    assert.equal(result.escalated, true)
    assert.equal(calls.filter(c => c.role === 'setup').length, 2)
    assert.ok(calls.filter(c => c.role === 'checker').every(c => c.model === 'gpt-6-astra'))
    const attempts = calls.filter(c => c.role === 'seat' && /-r0$/.test(c.key))
    assert.equal(attempts.length, 4)
    assert.notEqual(attempts[0].run.runDir, attempts[1].run.runDir)
    assert.match(attempts[1].prompt, /You aren't shown the earlier change|You are not shown that attempt's change/)
  })

  test('concurrent host runs and immediate escalations receive distinct setup IDs', async () => {
    const runs = await Promise.all(['host-first', 'host-second'].map(hostRunId => factoryFlow('simple', { escalate: true, args: { hostRunId } })))
    const setups = runs.flatMap(r => r.calls.filter(c => c.role === 'setup'))
    assert.deepEqual(setups.map(c => c.setupRunId), ['host-first-simple', 'host-first-feature', 'host-second-simple', 'host-second-feature'])
    for (const request of setups) assert.ok(request.prompt.includes(`--run-id '${request.setupRunId}'`))
    assert.equal(runs[0].result.runDir, '/repo/.council/host-first-feature')
    assert.equal(runs[1].result.runDir, '/repo/.council/host-second-feature')
  })

  test('an oversized feature plan escalates to architecture before any build', async () => {
    const { result, calls, phases } = await factoryFlow('feature', { oversizedPlan: true })
    assert.equal(result.factory.tier, 'architecture')
    assert.equal(result.factory.startedAt, 'feature')
    assert.equal(result.factory.escalation.trigger, 'too-many-increments')
    assert.equal(calls.filter(c => c.role === 'setup').length, 2)
    assert.equal(calls.filter(c => c.role === 'seat' && /-r0$/.test(c.key)).length, 6)
    assert.equal(phases.includes('Build'), false)
    assert.ok(calls.every(c => c.vendor === (c.role === 'seat' && c.model === 'opus' ? 'claude' : 'codex')))
  })

  test('a failed independent review leaves an incomplete result and does not trigger escalation', async () => {
    const { result, calls } = await factoryFlow('simple', { failedReview: true })
    assert.equal(result.factory.tier, 'simple')
    assert.equal(result.final.readiness.state, 'incomplete')
    assert.ok(result.final.readiness.incomplete.some(x => /review|audit/.test(x)))
    assert.equal(calls.filter(c => c.role === 'setup').length, 1)
    assert.ok(result.notes.some(x => x.includes('reviewer unavailable')))
  })

  test('hosted Claude seats receive continuation prompts without stateless notes instructions', async () => {
    const { result, calls } = await factoryFlow('fix', { args: { seats: ['opus', 'sol'] } })
    assert.equal(result.final.readiness.state, 'ready')
    const claude = calls.filter(c => c.role === 'seat' && c.vendor === 'claude')
    assert.ok(claude.length >= 3)
    for (const request of claude) {
      assert.doesNotMatch(request.prompt, /Finally, fill `notes`|start every turn with no memory/)
      assert.equal(request.schema.properties.notes, undefined)
    }
  })

  test('milestones retain the original selected models and Simple overrides', async () => {
    const options = { seats: ['opus', 'sol'], simple: { implementer: 'luna', reviewer: 'sonnet', maxFiles: 2, maxLines: 41 },
      roles: { checker: 'astra' }, rounds: 3, narrow: false, retro: false }
    const { result } = await factoryFlow('architecture', { args: options })
    const milestone = result.milestones[0].args
    for (const [key, value] of Object.entries(options)) assert.deepEqual(milestone[key], value, key)
    const config = L.parseConfig(L.tierArgs(milestone, 'simple', { mode: 'implement' }), { workflow: 'factory', tier: 'simple' })
    assert.equal(config.lineup[0].key, 'luna')
    assert.equal(config.auditors[0].key, 'sonnet')
    assert.equal(config.simple.maxLines, 41)
    assert.equal(config.roles.checker.key, 'astra')
  })
})
