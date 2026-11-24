import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLib } from './lib.mjs'

const L = loadLib()
const historyFields = ['turnLog', 'processNotes', 'notes', 'relayFailures', 'vendorTimes']

function routedState({ tier = 'fix', strategy = 'independent', args = {} } = {}) {
  const state = L.newState(L.parseConfig({ task: 'Fix the parser', ...args }, { workflow: 'factory' }))
  state.factory = {
    tier,
    strategy,
    chosenBy: 'intake',
    intake: { tier, mode: 'implement' },
    escalation: null,
    args: state.raw,
  }
  state.turnLog.push({ turn: 'intake', role: 'intake', vendor: 'claude', ok: true })
  state.processNotes.push({ turn: 'intake', role: 'intake', who: 'sonnet', text: 'Checked scope' })
  state.notes.push('Intake note')
  state.relayFailures.push({ turn: 'intake', model: 'm', status: 'relay ended', error: 'e' })
  state.vendorTimes.push({ turn: 'intake', vendor: 'codex', seconds: 12 })
  return state
}

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value))
}

function routedHandoff(options) {
  const state = routedState(options)
  const requestControl = { started: null, turns: 0, ...state.controls }
  return L.factoryHandoff(state, L.factoryControl(requestControl, 0))
}

test('the handoff declares the protocol version and qualified child workflows', () => {
  assert.equal(L.HANDOFF_VERSION, 1)
  assert.deepEqual(L.HANDOFF_CHILD, { pair: 'pair', independent: 'council' })
  assert.equal(L.childWorkflow({ strategy: 'pair' }), 'dark-factory:pair')
  assert.equal(L.childWorkflow({ strategy: 'independent' }), 'dark-factory:council')
})

test('factory control projects the wire fields and delegated control leaves it intact', () => {
  const state = routedState({ args: { maxTurns: 20, maxRunMin: 30, repair: { maxPasses: 2 } } })
  const requestControl = { started: 1000, turns: 2, ...state.controls }
  const control = Object.freeze(L.factoryControl(requestControl, 125.5))
  const expected = { started: 1000, turns: 2, maxTurns: 20, maxRunMin: 30, meterStart: 125.5 }
  assert.deepEqual(control, expected)
  assert.deepEqual(L.handoffControl({ control }), { ...expected, delegated: true })
  assert.deepEqual(control, expected)

  for (const reading of [null, undefined, Infinity, NaN, '125']) {
    assert.deepEqual(L.factoryControl({ turns: 0 }, reading), {
      started: null, turns: 0, maxTurns: null, maxRunMin: null, meterStart: null,
    })
  }
})

test('factory handoff carries the routed factory record, control and a copy of the history', () => {
  const state = routedState()
  const control = L.factoryControl({ started: null, turns: 1, ...state.controls }, 0)
  const envelope = L.factoryHandoff(state, control)
  const history = Object.fromEntries(historyFields.map(key => [key, state[key]]))

  assert.deepEqual(envelope, {
    version: 1, strategy: 'independent', tier: 'fix', factory: state.factory, carried: history, control,
  })
  assert.equal(envelope.factory, state.factory)
  assert.equal(envelope.control, control)
  for (const key of historyFields) assert.notEqual(envelope.carried[key], state[key], key)
})

test('the handoff tier and Pair states match the inline Factory rebuilds', () => {
  const state = routedState({
    strategy: 'pair',
    args: { host: 'codex', pair: { author: 'astra', reviewer: 'opus' } },
  })
  const factory = state.factory
  const control = L.factoryControl({ started: 1000, turns: 1, ...state.controls }, null)
  const envelope = roundTrip(L.factoryHandoff(state, control))

  const inlineTier = L.newState(L.parseConfig(L.tierArgs(state.raw, factory.tier, factory.intake), {
    workflow: 'factory', tier: factory.tier,
  }))
  Object.assign(inlineTier, L.carriedState(state), { factory })
  const childTier = L.handoffState(envelope)
  assert.deepEqual(childTier, inlineTier)
  assert.notEqual(childTier.factory, envelope.factory)
  for (const key of Object.keys(envelope.carried)) assert.notEqual(childTier[key], envelope.carried[key], key)

  const inlinePair = L.newState(L.factoryPairConfig(inlineTier))
  Object.assign(inlinePair, L.carriedState(inlineTier), { factory, pair: L.newPairState() })
  const childPair = L.handoffPairState(envelope)
  assert.equal(childPair.workflowName, 'pair')
  assert.equal(childPair.tier, 'pair')
  assert.deepEqual(childPair, inlinePair)
  const run = { runId: 'r', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
  for (const pair of [childPair, inlinePair]) Object.assign(pair, { run, cli: 'dark-factory' })
  const reportMd = '# Report'
  const payload = { turns: 1 }
  const hash = 'report-hash'
  assert.equal(
    L.retroPrompt(childPair, reportMd, payload, hash),
    L.retroPrompt(inlinePair, reportMd, payload, hash),
  )
  assert.deepEqual(L.executionPlan(childPair), L.executionPlan(inlinePair))
})

test('changing the meter reading changes only the handoff meter baseline', () => {
  const state = routedState()
  const requestControl = { started: null, turns: 1, ...state.controls }
  const first = L.factoryHandoff(state, L.factoryControl(requestControl, 100))
  const second = L.factoryHandoff(state, L.factoryControl(requestControl, 250))
  const { meterStart: firstMeter, ...firstControl } = first.control
  const { meterStart: secondMeter, ...secondControl } = second.control
  assert.equal(firstMeter, 100)
  assert.equal(secondMeter, 250)
  assert.notEqual(firstMeter, secondMeter)
  assert.deepEqual({ ...first, control: firstControl }, { ...second, control: secondControl })
})

test('only a sole own factoryHandoff key selects the delegated reader', () => {
  const envelope = roundTrip(routedHandoff())
  const ordinary = [
    'Fix the parser',
    { task: 'Fix the parser' },
    {},
    { task: 'Fix the parser', factoryHandoff: envelope },
    Object.create({ factoryHandoff: envelope }),
    { factoryHandoff: envelope, [Symbol('extra')]: true },
    Object.defineProperty({ factoryHandoff: envelope }, 'hidden', { value: true }),
    Object.assign([], { factoryHandoff: envelope }),
    null,
  ]
  for (const args of ordinary) assert.equal(L.readHandoff(args, 'council'), null)

  let reads = 0
  const reserved = Object.defineProperty({}, 'factoryHandoff', {
    get() { reads++; return envelope },
  })
  assert.equal(L.readHandoff(reserved, 'council'), envelope)
  assert.equal(reads, 1)
})

test('boot-shaped Factory controls round-trip for both strategies with and without caps', () => {
  for (const [strategy, workflow] of [['pair', 'pair'], ['independent', 'council']]) {
    for (const caps of [{}, { maxTurns: 20, maxRunMin: 30 }]) {
      const state = routedState({ strategy, args: { ...caps, repair: { maxPasses: 3 } } })
      const started = caps.maxRunMin ? 1000 : null
      const requestControl = { started, turns: 0, ...state.controls }
      assert.deepEqual(requestControl.repair, { maxPasses: 3, minor: 'block' })
      const control = L.factoryControl(requestControl, 25.5)
      assert.deepEqual(control, {
        started, turns: 0, maxTurns: caps.maxTurns ?? null, maxRunMin: caps.maxRunMin ?? null, meterStart: 25.5,
      })
      for (const chosenBy of ['intake', 'pinned', 'overruled']) {
        state.factory.chosenBy = chosenBy
        const envelope = roundTrip(L.factoryHandoff(state, control))
        assert.deepEqual(L.readHandoff({ factoryHandoff: envelope }, workflow, started !== null), envelope)
      }
    }
  }
})

test('nested extensions and non-negative integer turns survive the reader', () => {
  const envelope = routedHandoff()
  Object.assign(envelope.factory, { brief: { ...settledBrief(), extra: { nested: true } }, briefFile: '/r/.council/brief-x/BRIEF.json' })
  Object.assign(envelope.factory.args, { futureOption: true })
  Object.assign(envelope.carried, { extra: [] })
  Object.assign(envelope.control, { extra: 'preserved', turns: Number.MAX_SAFE_INTEGER + 1 })
  const carried = roundTrip(envelope)
  assert.equal(L.readHandoff({ factoryHandoff: carried }, 'council'), carried)
})

// A settled goal brief document, as Factory saves it before routing.
function settledBrief() {
  return { version: 1, state: 'settled', decisions: [{ id: 'B1', question: 'Which inputs?', answer: 'Empty input only.' }], brief: {
    outcome: 'Empty input parses.', purpose: 'Callers pass empty files.', scope: 'The parser.', nonGoals: 'Other inputs.',
    acceptanceExamples: ['An empty file parses to nothing.'], verification: 'Run the parser tests.', delegated: ['testing', 'implementation', 'internal design'] } }
}

function assertMalformedHandoff(factoryHandoff, workflow, reason, label, clock) {
  assert.throws(
    () => L.readHandoff({ factoryHandoff }, workflow, clock),
    { message: `${workflow}: malformed factory handoff (${reason}); this input comes only from dark-factory:factory.` },
    label,
  )
}

test('the reader reports the first malformed envelope field in the named error', () => {
  const cyclic = {}
  cyclic.self = cyclic
  const cases = [
    ['version', h => { h.version = 2 }, 'version must be 1'],
    ['cyclic version', h => { h.version = cyclic }, 'version must be 1'],
    ['unknown strategy', h => { h.strategy = 'auto' }, 'unknown strategy'],
    ['non-string strategy', h => { h.strategy = ['independent'] }, 'unknown strategy'],
    ['unknown field', h => { h.extra = true }, 'unknown envelope field'],
    ['unknown symbol', h => { h[Symbol('extra')] = true }, 'unknown envelope field'],
    ['hidden field', h => { Object.defineProperty(h, 'extra', { value: true }) }, 'unknown envelope field'],
    ['inherited version', h => { delete h.version; Object.setPrototypeOf(h, { version: 1 }) }, 'missing envelope field'],
    ['unknown tier', h => { h.tier = h.factory.tier = 'pair' }, 'unknown tier'],
    ['factory record', h => { h.factory = null }, 'factory must be an object'],
    ['string factory', h => { h.factory = 'factory' }, 'factory must be an object'],
    ['array factory', h => { h.factory = [] }, 'factory must be an object'],
    ['factory tier', h => { h.factory.tier = 'simple' }, 'factory.tier does not match tier'],
    ['factory strategy', h => { h.factory.strategy = 'pair' }, 'factory.strategy does not match strategy'],
    ['factory args', h => { h.factory.args = 'Fix the parser' }, 'factory.args must be an object'],
    ['array args', h => { h.factory.args = [] }, 'factory.args must be an object'],
    ['factory intake', h => { h.factory.intake = null }, 'factory.intake must be an object'],
    ['array intake', h => { h.factory.intake = [] }, 'factory.intake must be an object'],
    ['intake tier', h => { h.factory.intake.tier = 'pair' }, 'unknown factory.intake.tier'],
    ['intake mode', h => { h.factory.intake.mode = 'build' }, 'unknown factory.intake.mode'],
    ['chosenBy', h => { h.factory.chosenBy = 'manual' }, 'unknown factory.chosenBy'],
    ['carried record', h => { h.carried = [] }, 'carried must be an object'],
    ['control record', h => { h.control = [] }, 'control must be an object'],
  ]
  for (const key of historyFields) {
    cases.push([`missing ${key}`, h => { delete h.carried[key] }, `carried.${key} must be an array`])
  }
  for (const [label, mutate, reason] of cases) {
    const envelope = roundTrip(routedHandoff())
    mutate(envelope)
    assertMalformedHandoff(envelope, 'council', reason, label)
  }
  for (const value of [null, undefined, [], 'handoff']) {
    assertMalformedHandoff(value, 'council', 'envelope must be an object')
  }
})

test('the reader enforces control ranges without coercion', () => {
  const cases = [
    ['turns', [-1, 1.5, '2', Infinity, null, undefined], 'a non-negative integer'],
    ['started', ['1000', NaN, Infinity, undefined], 'finite or null'],
    ['maxTurns', [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1, undefined], 'a positive safe integer or null'],
    ['maxRunMin', [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1, undefined], 'a positive safe integer or null'],
    ['meterStart', [-1, NaN, Infinity, '2', undefined], 'finite and non-negative or null'],
  ]
  for (const [field, invalid, constraint] of cases) {
    for (const value of invalid) {
      const envelope = roundTrip(routedHandoff())
      envelope.control[field] = value
      assertMalformedHandoff(envelope, 'council', `control.${field} must be ${constraint}`, `${field}: ${value}`)
    }
  }
})

test('the reader enforces the child workflow and Pair routing restrictions', () => {
  const independent = roundTrip(routedHandoff())
  const pair = roundTrip(routedHandoff({ strategy: 'pair' }))
  assertMalformedHandoff(independent, 'pair', 'strategy does not match child workflow')
  assertMalformedHandoff(pair, 'council', 'strategy does not match child workflow')
  const architecture = roundTrip(routedHandoff({ strategy: 'pair', tier: 'architecture' }))
  assertMalformedHandoff(architecture, 'pair', 'Pair cannot run at Architecture')

  pair.factory.escalation = { from: 'simple', to: 'fix', earlier: null }
  assertMalformedHandoff(pair, 'pair', 'Pair cannot run after escalation')
  delete pair.factory.escalation
  assertMalformedHandoff(pair, 'pair', 'Pair cannot run after escalation')
})

test('the reader requires legal escalation links that connect and end at the envelope tier', () => {
  const envelope = routedHandoff({ tier: 'architecture' })
  const simpleToFeature = { from: 'simple', to: 'feature', earlier: null }
  const featureToArchitecture = { from: 'feature', to: 'architecture', earlier: simpleToFeature }
  envelope.factory.escalation = featureToArchitecture
  const linked = roundTrip(envelope)
  assert.equal(L.readHandoff({ factoryHandoff: linked }, 'council'), linked)
  delete envelope.factory.escalation
  assert.equal(L.readHandoff({ factoryHandoff: envelope }, 'council'), envelope)

  const cycle = { ...featureToArchitecture }
  cycle.earlier = cycle
  const cases = [
    ['non-object link', false, 'illegal escalation edge'],
    ['illegal edge', { from: 'feature', to: 'fix' }, 'illegal escalation edge'],
    ['wrong destination', simpleToFeature, 'escalation chain does not lead to this tier'],
    ['disconnected steps', { ...featureToArchitecture, earlier: { from: 'simple', to: 'fix' } },
      'escalation chain does not lead to this tier'],
    ['array source tier', roundTrip({ ...featureToArchitecture, from: ['feature'] }), 'illegal escalation edge'],
    ['cyclic link', cycle, 'escalation chain does not lead to this tier'],
  ]
  for (const [label, escalation, reason] of cases) {
    const malformed = { ...envelope, factory: { ...envelope.factory, escalation } }
    assertMalformedHandoff(malformed, 'council', reason, label)
  }
})

test('the reader and childOutcome allow exactly three escalation edges across all tier pairs', () => {
  const tiers = ['simple', 'fix', 'feature', 'architecture']
  const legal = new Set(['simple:fix', 'simple:feature', 'feature:architecture'])
  for (const from of tiers) {
    const source = routedHandoff({ tier: from })
    const state = L.handoffState(source)
    for (const to of tiers) {
      const edge = `${from}:${to}`
      const reply = L.childHandUp(state, { to, trigger: 'verify-failed', why: 'The gate failed' }, 1)
      const destination = routedHandoff({ tier: to })
      destination.factory.escalation = reply.handUp.escalation
      if (legal.has(edge)) {
        assert.equal(L.readHandoff({ factoryHandoff: destination }, 'council'), destination, edge)
        assert.equal(L.childOutcome(source, reply), reply, edge)
      } else {
        assertMalformedHandoff(destination, 'council', 'illegal escalation edge', edge)
        assert.throws(() => L.childOutcome(source, reply), {
          message: 'factory: unexpected result from dark-factory:council (illegal hand-up edge).',
        }, edge)
      }
    }
  }
})

test('final child outcomes have only the marker, result and usage flag', () => {
  const envelope = routedHandoff({ strategy: 'pair' })
  const result = { status: 'done', final: { readiness: { state: 'ready' } } }
  for (const usage of [true, false]) {
    const out = L.childFinal(result, usage)
    assert.deepEqual(out, { factoryChild: 1, final: result, usage })
    assert.equal(L.childOutcome(envelope, out), out)
  }

  const valid = L.childFinal(result, true)
  const cases = [
    [null, 'invalid child result marker'],
    [{ ...valid, factoryChild: '1' }, 'invalid child result marker'],
    [{ factoryChild: 1, final: result }, 'invalid child result fields'],
    [{ ...valid, handUp: {} }, 'invalid child result fields'],
    [{ ...valid, [Symbol('extra')]: true }, 'invalid child result fields'],
    [Object.defineProperty({ ...valid }, 'hidden', { value: true }), 'invalid child result fields'],
    [{ 'factoryChild,final': result, usage: true, factoryChild: 1 }, 'invalid child result fields'],
    [{ ...valid, final: [] }, 'final must be an object'],
    [{ ...valid, usage: 'true' }, 'usage must be a boolean'],
  ]
  for (const [out, reason] of cases) {
    assert.throws(() => L.childOutcome(envelope, out), {
      message: `factory: unexpected result from dark-factory:pair (${reason}).`,
    })
  }
})

test('childOutcome requires complete hand-ups with legal edges and nonregressing turns', () => {
  const simple = routedHandoff({ tier: 'simple' })
  simple.control.turns = 3
  const feature = routedHandoff({ tier: 'feature' })
  const out = L.childHandUp(L.handoffState(simple), {
    to: 'feature', trigger: 'design-finding', why: 'The work needs a design',
  }, 3)
  assert.equal(L.childOutcome(simple, out), out)
  const up = out.handUp
  const { why, ...withoutWhy } = up
  const cases = [
    [simple, withoutWhy, 'invalid handUp fields'],
    [simple, { ...up, [Symbol('extra')]: true }, 'invalid handUp fields'],
    [simple, { ...up, why: null }, 'trigger and why must be strings'],
    [simple, { ...up, trigger: 5 }, 'trigger and why must be strings'],
    [simple, { ...up, to: 'architecture' }, 'illegal hand-up edge'],
    [feature, { ...up, to: 'fix' }, 'illegal hand-up edge'],
    [simple, { ...up, escalation: null }, 'escalation does not match hand-up edge'],
    [simple, { ...up, escalation: { ...up.escalation, to: 'fix' } }, 'escalation does not match hand-up edge'],
    [simple, { ...up, escalation: { ...up.escalation, from: ['simple'] } }, 'escalation does not match hand-up edge'],
    [simple, { ...up, escalation: { ...up.escalation, earlier: { from: 'simple', to: 'fix' } } },
      'escalation chain does not lead to this tier'],
    [simple, { ...up, turns: 2 }, 'turns must be an integer at least as large as the incoming count'],
    [simple, { ...up, turns: 3.5 }, 'turns must be an integer at least as large as the incoming count'],
    [simple, { ...up, carried: { ...up.carried, notes: null } }, 'carried.notes must be an array'],
  ]
  for (const [envelope, handUp, reason] of cases) {
    assert.throws(() => L.childOutcome(envelope, { factoryChild: 1, handUp }), {
      message: `factory: unexpected result from dark-factory:council (${reason}).`,
    })
  }
  const pair = routedHandoff({ tier: 'simple', strategy: 'pair' })
  assert.throws(() => L.childOutcome(pair, out), {
    message: 'factory: unexpected result from dark-factory:pair (only independent children can hand up).',
  })
})

test('childOutcome rejects briefs that cannot render the next tier escalation prompt', () => {
  const simple = routedHandoff({ tier: 'simple' })
  const reply = L.childHandUp(L.handoffState(simple), {
    to: 'fix', trigger: 'verify-failed', why: 'The gate failed',
  }, 1)
  const next = L.nextHandoff(simple, L.childOutcome(simple, reply).handUp)
  assert.match(L.escalationBlock(L.handoffState(next)), /The gate failed/)
  const defects = [
    [['findings', 'tests', 'criteria'], [undefined, {}, ['major: ok', {}], [{ toString: null }], [null], [7]],
      'escalation findings, tests and criteria must be arrays of strings'],
    [['trigger', 'why', 'runDir', 'suiteTail'], [undefined, null, 7, { a: 1 }, ['text']],
      'escalation trigger, why, runDir and suiteTail must be strings'],
  ]
  for (const [fields, values, reason] of defects) {
    for (const field of fields) {
      for (const value of values) {
        const broken = roundTrip(reply)
        if (value === undefined) delete broken.handUp.escalation[field]
        else broken.handUp.escalation[field] = value
        assert.throws(() => L.childOutcome(simple, broken), {
          message: `factory: unexpected result from dark-factory:council (${reason}).`,
        }, `${field}: ${JSON.stringify(value)}`)
      }
    }
  }
})

test('a first hop from an envelope without factory.escalation is accepted and advanced', () => {
  const simple = routedHandoff({ tier: 'simple' })
  delete simple.factory.escalation
  assert.equal(L.readHandoff({ factoryHandoff: simple }, 'council'), simple)
  const reply = roundTrip(L.childHandUp(L.handoffState(simple), {
    to: 'fix', trigger: 'verify-failed', why: 'The gate failed',
  }, 1))
  assert.equal(reply.handUp.escalation.earlier, null)
  assert.equal(L.childOutcome(simple, reply), reply)
  const next = L.nextHandoff(simple, reply.handUp)
  assert.equal(L.readHandoff({ factoryHandoff: next }, 'council'), next)
})

test('the reader rejects non-enumerable envelope, factory and control fields, which a spread would drop', () => {
  const cases = [
    [h => h, 'version', 'non-enumerable envelope field'],
    [h => h, 'strategy', 'non-enumerable envelope field'],
    [h => h.factory, 'escalation', 'non-enumerable factory field'],
    [h => h.factory, 'args', 'non-enumerable factory field'],
    [h => h.control, 'maxTurns', 'non-enumerable control field'],
    [h => h.factory.args, 'task', 'non-enumerable factory.args field'],
  ]
  for (const [target, key, reason] of cases) {
    const envelope = routedHandoff({ tier: 'simple' })
    const record = target(envelope)
    Object.defineProperty(record, key, { value: record[key], enumerable: false })
    assert.throws(() => L.readHandoff({ factoryHandoff: envelope }, 'council'), {
      message: `council: malformed factory handoff (${reason}); this input comes only from dark-factory:factory.`,
    }, key)
  }
})

test('childOutcome keeps the incoming earlier brief by value, regardless of key order', () => {
  const simple = routedHandoff({ tier: 'simple' })
  const first = L.childHandUp(L.handoffState(simple), {
    to: 'feature', trigger: 'design-finding', why: 'The work needs a design',
  }, 1)
  const feature = L.nextHandoff(simple, L.childOutcome(simple, first).handUp)
  const reply = roundTrip(L.childHandUp(L.handoffState(feature), {
    to: 'architecture', trigger: 'too-many-increments', why: 'The design needs milestones',
  }, 2))
  const earlier = reply.handUp.escalation.earlier
  reply.handUp.escalation.earlier = Object.fromEntries(Object.entries(earlier).reverse())
  assert.equal(L.childOutcome(feature, reply), reply)
  for (const replacement of [null, { ...earlier, why: 'Changed history' }, { ...earlier, findings: ['Changed evidence'] }]) {
    reply.handUp.escalation.earlier = replacement
    assert.throws(() => L.childOutcome(feature, reply), {
      message: 'factory: unexpected result from dark-factory:council (escalation.earlier does not match incoming escalation).',
    })
  }
})

function checkEscalation(envelope, handUp, turns, notes) {
  const attempt = L.handoffState(envelope)
  const from = attempt.tier
  attempt.notes.push(`Note from ${from}`)
  attempt.run = { runDir: `/r/${from}`, room: `/r/${from}/room` }
  attempt.criteria = [{ id: 'C1', text: `Check ${from}` }]
  attempt.pos.A = { suite: { ran: true, passed: false, tail: `Gate failed in ${from}` } }
  const previousNotes = attempt.notes.slice()
  const previousEnvelope = roundTrip(envelope)
  const brief = L.escalationBrief(attempt, handUp)
  assert.deepEqual(brief.criteria, [`C1: Check ${from}`])
  assert.equal(brief.suiteTail, `Gate failed in ${from}`)
  assert.deepEqual(brief.earlier, envelope.factory.escalation)

  const carried = { ...L.carriedState(attempt), notes }
  const out = L.childHandUp(attempt, handUp, turns)
  assert.deepEqual(out, { factoryChild: 1, handUp: { ...handUp, escalation: brief, carried, turns } })
  assert.deepEqual(attempt.notes, previousNotes)
  const accepted = L.childOutcome(envelope, roundTrip(out))
  const next = L.nextHandoff(envelope, accepted.handUp)
  const factory = { ...attempt.factory, tier: handUp.to, escalation: brief }
  assert.deepEqual(next, {
    version: envelope.version,
    strategy: envelope.strategy,
    tier: handUp.to,
    factory,
    carried,
    control: { ...envelope.control, turns },
  })
  for (const key of historyFields) {
    assert.notEqual(out.handUp.carried[key], attempt[key], key)
    assert.notEqual(next.carried[key], accepted.handUp.carried[key], key)
  }
  assert.deepEqual(envelope, previousEnvelope)

  const received = L.readHandoff({ factoryHandoff: roundTrip(next) }, 'council', next.control.started !== null)
  const state = L.handoffState(received)
  const inline = L.newState(L.parseConfig(L.tierArgs(factory.args, handUp.to, factory.intake), {
    workflow: attempt.workflowName, tier: handUp.to, escalation: brief,
  }))
  Object.assign(inline, carried, { factory })
  assert.equal(state.tier, handUp.to)
  assert.deepEqual(state.escalation, brief)
  assert.deepEqual(state, inline)
  return received
}

test('Simple to Fix and Simple to Feature to Architecture keep the inline escalation state', () => {
  const simple = routedHandoff({ tier: 'simple', args: { maxTurns: 20, maxRunMin: 30 } })
  Object.assign(simple.control, { started: 1000, turns: 2, meterStart: 125.5, extension: 'preserved' })
  simple.carried.notes.push('Simple attempt: Already labelled')
  const simpleNotes = ['Simple attempt: Intake note', 'Simple attempt: Already labelled', 'Simple attempt: Note from simple']

  checkEscalation(simple, { to: 'fix', trigger: 'verify-failed', why: 'The gate failed' }, 4, simpleNotes)
  const feature = checkEscalation(simple, {
    to: 'feature', trigger: 'design-finding', why: 'The work needs a design',
  }, 5, simpleNotes)
  const architecture = checkEscalation(feature, {
    to: 'architecture', trigger: 'too-many-increments', why: 'The design needs milestones',
  }, 8, [...simpleNotes, 'Feature attempt: Note from feature'])
  assert.deepEqual(architecture.factory.escalation.earlier, feature.factory.escalation)
})

// The child renders the carried brief into its prompts and report, so the reader takes it only as
// Factory accepted it before routing: absent, or settled with its saved file.
test('the reader takes a carried goal brief only as Factory saved it', () => {
  const withBrief = (brief, briefFile = '/r/.council/brief-x/BRIEF.json') => {
    const envelope = roundTrip(routedHandoff())
    Object.assign(envelope.factory, { brief, briefFile })
    return envelope
  }
  const good = withBrief(settledBrief())
  assert.equal(L.readHandoff({ factoryHandoff: good }, 'council'), good)
  const broken = (change) => { const doc = settledBrief(); change(doc); return doc }
  const rows = [
    ['no acceptance examples', withBrief(broken(d => { delete d.brief.acceptanceExamples })), 'factory.brief must be a settled goal brief'],
    ['empty acceptance examples', withBrief(broken(d => { d.brief.acceptanceExamples = [] })), 'factory.brief must be a settled goal brief'],
    ['blank outcome', withBrief(broken(d => { d.brief.outcome = ' ' })), 'factory.brief must be a settled goal brief'],
    ['delegated not a list', withBrief(broken(d => { d.brief.delegated = 'testing' })), 'factory.brief must be a settled goal brief'],
    ['provisional', withBrief(broken(d => { d.state = 'provisional' })), 'factory.brief must be a settled goal brief'],
    ['wrong version', withBrief(broken(d => { d.version = 2 })), 'factory.brief must be a settled goal brief'],
    ['decision without an answer', withBrief(broken(d => { d.decisions[0].answer = '' })), 'factory.brief must be a settled goal brief'],
    ['decisions not a list', withBrief(broken(d => { d.decisions = null })), 'factory.brief must be a settled goal brief'],
    ['null brief', withBrief(null), 'factory.brief must be a settled goal brief'],
    ['relative file', withBrief(settledBrief(), 'brief-x/BRIEF.json'), 'factory.briefFile must be the absolute path of a settled brief'],
    ['provisional file', withBrief(settledBrief(), '/r/.council/brief-x/BRIEF.provisional.json'), 'factory.briefFile must be the absolute path of a settled brief'],
  ]
  const fileless = withBrief(settledBrief())
  delete fileless.factory.briefFile
  rows.push(['missing file', fileless, 'factory.briefFile must be the absolute path of a settled brief'])
  const orphan = roundTrip(routedHandoff())
  orphan.factory.briefFile = '/r/.council/brief-x/BRIEF.json'
  rows.push(['file without brief', orphan, 'factory.briefFile without factory.brief'])
  for (const [label, envelope, reason] of rows) assertMalformedHandoff(envelope, 'council', reason, label)
})

// Only the standalone runner has a clock. Factory records its start exactly when its host has one,
// and its child runs on the same host, so a start or a time cap must match the reader's host.
test('the reader matches the control clock to the host', () => {
  const at = (control, clock) => {
    const envelope = roundTrip(routedHandoff({ args: control.maxRunMin ? { maxRunMin: control.maxRunMin } : {} }))
    Object.assign(envelope.control, control)
    return [envelope, clock]
  }
  for (const [envelope, clock] of [at({ started: null }, false), at({ started: 0 }, true), at({ started: 1000, maxRunMin: 30 }, true)]) {
    assert.equal(L.readHandoff({ factoryHandoff: envelope }, 'council', clock), envelope)
  }
  const rows = [
    ['native start', at({ started: 1000 }, false), 'control.started needs a clock, which the native workflow runtime lacks'],
    ['native start and cap', at({ started: 1000, maxRunMin: 30 }, false), 'control.started needs a clock, which the native workflow runtime lacks'],
    ['native cap', at({ maxRunMin: 30 }, false), 'control.maxRunMin needs a clock, which the native workflow runtime lacks'],
    ['clocked host, no start', at({ started: null }, true), 'control.started must be set on a host with a clock'],
    ['clocked host, cap without start', at({ started: null, maxRunMin: 30 }, true), 'control.started must be set on a host with a clock'],
  ]
  for (const [label, [envelope, clock], reason] of rows) {
    for (const workflow of ['council', 'pair']) {
      const routed = workflow === 'pair' ? Object.assign(envelope, { strategy: 'pair', factory: { ...envelope.factory, strategy: 'pair' } }) : envelope
      assertMalformedHandoff(roundTrip(routed), workflow, reason, `${workflow} ${label}`, clock)
    }
  }
})

// Inline, finishRun appends Factory's usage section to a report whose markdown is a string, even an
// empty one, and to nothing else.
test('hasReport is true exactly for a report with string markdown', () => {
  for (const result of [{ report: { markdown: '' } }, { report: { markdown: '### Done' } }]) assert.equal(L.hasReport(result), true, JSON.stringify(result))
  for (const result of [{ report: {} }, { report: null }, { report: { markdown: 5 } }, { report: { markdown: null } }, {}, null, undefined]) {
    assert.equal(L.hasReport(result), false, JSON.stringify(result))
  }
})
