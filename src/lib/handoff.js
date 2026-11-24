// Factory's handoff to a child workflow.
const HANDOFF_VERSION = 1
const HANDOFF_CHILD = { pair: 'pair', independent: 'council' }
const HANDOFF_FIELDS = ['version', 'strategy', 'tier', 'factory', 'carried', 'control']
const HANDOFF_HISTORY = ['turnLog', 'processNotes', 'notes', 'relayFailures', 'vendorTimes']

function childWorkflow(h) {
  return workflowCall(HANDOFF_CHILD[h.strategy])
}

function factoryHandoff(S, control) {
  return {
    version: HANDOFF_VERSION,
    strategy: S.factory.strategy,
    tier: S.factory.tier,
    factory: S.factory,
    carried: carriedState(S),
    control,
  }
}

// The envelope crosses as JSON, which loses what JSON cannot write: a number past the double range
// (JSON.parse reads 1e309 as Infinity), NaN, -0 and an undefined field. handoffWire copies the
// envelope with each of these as a tagged object and readHandoff restores it, so the child reads
// exactly what Factory held. An object of Factory's own with the tag key is wrapped, never misread.
const HANDOFF_WIRE = '$factoryWire'
const HANDOFF_WIRE_VALUES = { Infinity, '-Infinity': -Infinity, NaN, '-0': -0, undefined }
const HANDOFF_BAD_WIRE = Object.freeze({})

function handoffWire(value) {
  if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) {
    return { [HANDOFF_WIRE]: Object.is(value, -0) ? '-0' : String(value) }
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Array.from(value, handoffWire)
  const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, handoffWire(entry)]))
  return Object.hasOwn(value, HANDOFF_WIRE) ? { [HANDOFF_WIRE]: 'object', value: copy } : copy
}

// Restores what handoffWire tagged, or returns HANDOFF_BAD_WIRE for a tag it never writes. An object
// with nothing to restore comes back as itself and a rebuilt one keeps every field, so the reader
// still sees a non-enumerable field as sent; a cycle, which the wire copy never writes, is followed
// no further than once.
function handoffUnwire(value, done = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value
  if (done.has(value)) return done.get(value)
  if (!Array.isArray(value) && Object.hasOwn(value, HANDOFF_WIRE)) {
    const tag = value[HANDOFF_WIRE], size = Reflect.ownKeys(value).length
    if (tag === 'object' && size === 2 && handoffRecord(value.value) && Object.hasOwn(value.value, HANDOFF_WIRE)) return handoffUnwireFields(value.value, done)
    return size === 1 && typeof tag === 'string' && Object.hasOwn(HANDOFF_WIRE_VALUES, tag) ? HANDOFF_WIRE_VALUES[tag] : HANDOFF_BAD_WIRE
  }
  return handoffUnwireFields(value, done)
}

function handoffUnwireFields(record, done) {
  if (done.has(record)) return done.get(record)
  done.set(record, record)
  let copy = null
  for (const key of Object.keys(record)) {
    const entry = handoffUnwire(record[key], done)
    if (entry === HANDOFF_BAD_WIRE) return HANDOFF_BAD_WIRE
    if (Object.is(entry, record[key])) continue
    copy ||= Array.isArray(record) ? record.slice() : Object.defineProperties({}, Object.fromEntries(
      Reflect.ownKeys(record).map(field => [field, { ...Object.getOwnPropertyDescriptor(record, field), configurable: true }])))
    Object.defineProperty(copy, key, { value: entry, writable: true, enumerable: true, configurable: true })
  }
  if (copy) done.set(record, copy)
  return copy || record
}

function factoryControl(requestControl, meterStart) {
  return {
    started: requestControl.started ?? null,
    turns: requestControl.turns,
    maxTurns: requestControl.maxTurns ?? null,
    maxRunMin: requestControl.maxRunMin ?? null,
    meterStart: Number.isFinite(meterStart) ? meterStart : null,
  }
}

function handoffControl(h) {
  return { ...h.control, delegated: true }
}

function handoffRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function handoffEdge(from, to) {
  return (from === 'simple' && (to === 'fix' || to === 'feature')) ||
    (from === 'feature' && to === 'architecture')
}

function handoffChainDefect(escalation, tier) {
  // Each accepted link moves backward to a lower tier, so a cycle cannot keep passing.
  for (let step = escalation; step !== null && step !== undefined; step = step.earlier) {
    if (!handoffRecord(step) || !handoffEdge(step.from, step.to)) return 'illegal escalation edge'
    if (step.to !== tier) return 'escalation chain does not lead to this tier'
    tier = step.from
  }
  return ''
}

function handoffCarriedDefect(carried) {
  if (!handoffRecord(carried)) return 'carried must be an object'
  const missing = HANDOFF_HISTORY.find(key => !Array.isArray(carried[key]))
  return missing ? `carried.${missing} must be an array` : ''
}

// Spreads copy only enumerable fields, so the reader rejects any other.
function handoffEnumerable(record) {
  return Reflect.ownKeys(record).every(key => Object.prototype.propertyIsEnumerable.call(record, key))
}

function handoffCap(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0)
}

// The goal brief the child renders into its prompts and report, as Factory accepted it before
// routing: absent, or a settled brief document with its saved file.
function handoffBriefDefect(factory) {
  if (factory.brief === undefined) return factory.briefFile === undefined ? '' : 'factory.briefFile without factory.brief'
  if (!validBriefDocument(factory.brief, 'settled')) return 'factory.brief must be a settled goal brief'
  const file = factory.briefFile
  if (typeof file !== 'string' || !file.startsWith('/') || !file.endsWith('/BRIEF.json')) return 'factory.briefFile must be the absolute path of a settled brief'
  return ''
}

// A time start and cap need the standalone runner's clock: Factory records the start exactly when
// its host has one, and a child runs on the same host.
function handoffClockDefect(control, clock) {
  if (clock) return control.started === null ? 'control.started must be set on a host with a clock' : ''
  if (control.started !== null) return 'control.started needs a clock, which the native workflow runtime lacks'
  if (control.maxRunMin !== null) return 'control.maxRunMin needs a clock, which the native workflow runtime lacks'
  return ''
}

// clock: whether the host reading the envelope has the standalone runner's clock.
function handoffDefect(h, workflow, clock) {
  if (!handoffRecord(h)) return 'envelope must be an object'
  const keys = Reflect.ownKeys(h)
  if (keys.some(key => !HANDOFF_FIELDS.includes(key))) return 'unknown envelope field'
  if (keys.length !== HANDOFF_FIELDS.length) return 'missing envelope field'
  if (!handoffEnumerable(h)) return 'non-enumerable envelope field'
  if (h.version !== HANDOFF_VERSION) return 'version must be 1'
  if (typeof h.strategy !== 'string' || !Object.hasOwn(HANDOFF_CHILD, h.strategy)) return 'unknown strategy'
  if (HANDOFF_CHILD[h.strategy] !== workflow) return 'strategy does not match child workflow'
  if (!TIERS.includes(h.tier)) return 'unknown tier'

  const factory = h.factory
  if (!handoffRecord(factory)) return 'factory must be an object'
  if (!handoffEnumerable(factory)) return 'non-enumerable factory field'
  if (factory.tier !== h.tier) return 'factory.tier does not match tier'
  if (factory.strategy !== h.strategy) return 'factory.strategy does not match strategy'
  if (!handoffRecord(factory.args)) return 'factory.args must be an object'
  if (!handoffEnumerable(factory.args)) return 'non-enumerable factory.args field'

  if (!handoffRecord(factory.intake)) return 'factory.intake must be an object'
  if (!TIERS.includes(factory.intake.tier)) return 'unknown factory.intake.tier'
  if (!MODES.includes(factory.intake.mode)) return 'unknown factory.intake.mode'
  if (!['intake', 'pinned', 'overruled'].includes(factory.chosenBy)) return 'unknown factory.chosenBy'
  if (h.strategy === 'pair') {
    if (h.tier === 'architecture') return 'Pair cannot run at Architecture'
    if (factory.escalation !== null) return 'Pair cannot run after escalation'
  }
  const escalationDefect = handoffChainDefect(factory.escalation, h.tier)
  if (escalationDefect) return escalationDefect
  const briefDefect = handoffBriefDefect(factory)
  if (briefDefect) return briefDefect

  const carriedDefect = handoffCarriedDefect(h.carried)
  if (carriedDefect) return carriedDefect
  const control = h.control
  if (!handoffRecord(control)) return 'control must be an object'
  if (!handoffEnumerable(control)) return 'non-enumerable control field'
  if (!Number.isInteger(control.turns) || control.turns < 0) return 'control.turns must be a non-negative integer'
  if (control.started !== null && !Number.isFinite(control.started)) return 'control.started must be finite or null'
  if (!handoffCap(control.maxTurns)) return 'control.maxTurns must be a positive safe integer or null'
  if (!handoffCap(control.maxRunMin)) return 'control.maxRunMin must be a positive safe integer or null'
  if (control.meterStart !== null && (!Number.isFinite(control.meterStart) || control.meterStart < 0)) {
    return 'control.meterStart must be finite and non-negative or null'
  }
  return handoffClockDefect(control, !!clock)
}

function readHandoff(args, workflow, clock) {
  if (!handoffRecord(args)) return null
  const keys = Reflect.ownKeys(args)
  if (keys.length !== 1 || keys[0] !== 'factoryHandoff') return null

  const handoff = handoffUnwire(args.factoryHandoff)
  const why = handoff === HANDOFF_BAD_WIRE ? 'malformed wire value' : handoffDefect(handoff, workflow, clock)
  if (why) throw new Error(`${workflow}: malformed factory handoff (${why}); this input comes only from dark-factory:factory.`)
  return handoff
}

function handoffState(h) {
  const factory = h.factory
  const state = newState(parseConfig(tierArgs(factory.args, h.tier, factory.intake), {
    workflow: 'factory', tier: h.tier, escalation: factory.escalation,
  }))
  return Object.assign(state, carriedState(h.carried), { factory: { ...factory } })
}

function handoffPairState(h) {
  const tierState = handoffState(h)
  const state = newState(factoryPairConfig(tierState))
  return Object.assign(state, carriedState(tierState), { factory: tierState.factory, pair: newPairState() })
}

function childFinal(result, usage) {
  return { factoryChild: 1, final: result, usage }
}

function childHandUp(S, handUp, turns) {
  const { to, trigger, why } = handUp
  const escalation = escalationBrief(S, handUp)
  const carried = carriedState(S)
  carried.notes = carried.notes.map(note =>
    /^\w+ attempt: /.test(note) ? note : `${capital(escalation.from)} attempt: ${note}`)
  return { factoryChild: 1, handUp: { to, trigger, why, escalation, carried, turns } }
}

function handoffHasKeys(record, fields) {
  const keys = Reflect.ownKeys(record)
  return keys.length === fields.length && keys.every(key => fields.includes(key))
}

// Briefs cross the workflow boundary by value. Object key order is immaterial.
function handoffValuesMatch(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const matches = seen.get(left) ?? new WeakSet()
  if (matches.has(right)) return true
  matches.add(right)
  seen.set(left, matches)
  const keys = Reflect.ownKeys(left)
  return keys.length === Reflect.ownKeys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && handoffValuesMatch(left[key], right[key], seen))
}

function childOutcome(h, out) {
  const fail = why => { throw new Error(`factory: unexpected result from ${childWorkflow(h)} (${why}).`) }
  if (!handoffRecord(out) || out.factoryChild !== 1) fail('invalid child result marker')
  if (handoffHasKeys(out, ['factoryChild', 'final', 'usage'])) {
    if (!handoffRecord(out.final)) fail('final must be an object')
    if (typeof out.usage !== 'boolean') fail('usage must be a boolean')
    return out
  }
  if (!handoffHasKeys(out, ['factoryChild', 'handUp'])) fail('invalid child result fields')

  const up = out.handUp
  if (!handoffRecord(up) || !handoffHasKeys(up, ['to', 'trigger', 'why', 'escalation', 'carried', 'turns'])) {
    fail('invalid handUp fields')
  }
  if (typeof up.trigger !== 'string' || typeof up.why !== 'string') fail('trigger and why must be strings')
  if (h.strategy !== 'independent') fail('only independent children can hand up')
  if (!handoffEdge(h.tier, up.to)) fail('illegal hand-up edge')
  if (!handoffRecord(up.escalation) || up.escalation.from !== h.tier || up.escalation.to !== up.to) {
    fail('escalation does not match hand-up edge')
  }
  // The next tier's prompts and the report render these fields as text.
  const esc = up.escalation
  const strings = list => Array.isArray(list) && list.every(entry => typeof entry === 'string')
  if (!strings(esc.findings) || !strings(esc.tests) || !strings(esc.criteria)) {
    fail('escalation findings, tests and criteria must be arrays of strings')
  }
  if (['trigger', 'why', 'runDir', 'suiteTail'].some(key => typeof esc[key] !== 'string')) {
    fail('escalation trigger, why, runDir and suiteTail must be strings')
  }
  const escalationDefect = handoffChainDefect(up.escalation, up.to)
  if (escalationDefect) fail(escalationDefect)
  if (!handoffValuesMatch(h.factory.escalation ?? null, up.escalation.earlier ?? null)) {
    fail('escalation.earlier does not match incoming escalation')
  }
  if (!Number.isInteger(up.turns) || up.turns < h.control.turns) fail('turns must be an integer at least as large as the incoming count')
  const carriedDefect = handoffCarriedDefect(up.carried)
  if (carriedDefect) fail(carriedDefect)
  return out
}

function nextHandoff(h, up) {
  return {
    version: h.version,
    strategy: h.strategy,
    tier: up.to,
    factory: { ...h.factory, tier: up.to, escalation: up.escalation },
    carried: carriedState(up.carried),
    control: { ...h.control, turns: up.turns },
  }
}

// Whether Factory adds its usage section to a child's final result: inline, finishRun appends it
// only to a report with markdown.
function hasReport(result) {
  return typeof result?.report?.markdown === 'string'
}

// The helper a child's report names: a Pair child reads a nested pair.cli first, as
// factoryPairConfig merges it; a council child reads Factory's own.
function handoffCli(h) {
  const args = h.factory.args
  return String((h.strategy === 'pair' ? { ...args, ...args.pair } : args).cli || 'dark-factory')
}
