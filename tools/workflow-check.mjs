// Check native Workflow behavior with isolated df-probe plugins.
//   node tools/workflow-check.mjs [--config-dir <dir>] [--verdict <path>]
//   node tools/workflow-check.mjs --manual L1-j --transcript <file> [--verdict <path>]
//   node tools/workflow-check.mjs --factory --config-dir <dir> [--verdict <path>]
//   node tools/workflow-check.mjs --factory --manual L2-iv --control <file> --candidate <file> [--verdict <path>]
// --factory judges each leg on its own (its stop, a resume in its own setup directory, an all-cached
// replay), then compares the candidate with its independent inline control on the handoff protocol
// only: status, stop kind, resume target, replayed prefix, first fresh agent and run layout
// (compareLegs in factory-evidence.mjs).
import { isDeepStrictEqual } from 'node:util'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { handoffProtocol } from './handoff-protocol.mjs'
import { L2_REQUIRED, RUN_ID, factoryResultFor, journalGrowth, launched } from './workflow-evidence.mjs'
export { L2_REQUIRED }

// L1 verdict IDs shared by the probe and the offline gate.
export const L1_REQUIRED = Object.freeze(['L1-a', 'L1-b1', 'L1-b3', 'L1-c', 'L1-d', 'L1-d2', 'L1-i', 'L1-j'])
export const L1_RECORDED = Object.freeze(['L1-e', 'L1-f', 'L1-g'])
const L1_INFORMATIONAL = ['L1-b2', 'L1-h']
const CANCEL = 'L1-j'
const CANCEL_WORKFLOW = 'df-probe:cancel'
const UPGRADE_WORKFLOW = 'df-probe:upgrade'
const UPGRADE_MARKER = 'upgrade-v2'
const VERDICT = fileURLToPath(new URL('./native-verdict.json', import.meta.url))
const REPO = fileURLToPath(new URL('../', import.meta.url))
const PLUGIN = 'df-probe'
const MARKET = 'df-probe-local'
const DEADLINE_MS = 180_000
const FACTORY_DEADLINE_MS = 30 * 60_000
const FACTORY_PLUGIN = 'dark-factory'
const FACTORY_WORKFLOW = `${FACTORY_PLUGIN}:factory`

function json(text) {
  try { return JSON.parse(text) } catch { return null }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'string') return value
  return typeof value?.text === 'string' ? value.text : ''
}
const sessionOf = event => event.session_id ?? event.sessionId

function workflowOutput(event, part, text) {
  const data = event.tool_use_result ?? event.toolUseResult ?? json(text)
  if (isObject(data) && data.status) return data
  if (part.is_error) return null
  // The saved conversation may have the display text instead of the structured launch.
  const taskId = /^Workflow launched in background\. Task ID: (\S+)/m.exec(text)?.[1]
  const runId = /^Run ID: (wf_[A-Za-z0-9_-]+)\s*$/m.exec(text)?.[1]
  return taskId && runId ? { status: 'async_launched', taskId, runId } : null
}

export function createStreamParser() {
  const uses = new Map()
  const calls = [], terminals = [], controls = [], results = []
  let remainder = '', line = 0, sessionId
  function read(raw) {
    line++
    const event = json(raw)
    if (!isObject(event)) return
    if (event.type === 'system' && event.subtype === 'init') sessionId = sessionOf(event)
    const session = sessionOf(event) ?? sessionId
    if (event.type === 'result') results.push({ event, line })
    if (event.type === 'control_response') controls.push({ response: event.response, line })
    if (event.type === 'system' && event.subtype === 'task_notification') {
      terminals.push({ session, taskId: event.task_id, toolUseId: event.tool_use_id, status: event.status, result: event.result, line })
    }
    const parts = event.message?.content
    if (!Array.isArray(parts)) return
    for (const part of parts) {
      if (event.type === 'assistant' && part?.type === 'tool_use' && part.name === 'Workflow' && typeof part.id === 'string') {
        uses.set(part.id, { toolUseId: part.id, input: part.input, session, line })
      }
      if (event.type !== 'user' || part?.type !== 'tool_result') continue
      const use = uses.get(part.tool_use_id)
      if (!use || use.session !== session) continue
      uses.delete(part.tool_use_id)
      const text = textOf(part.content)
      // An event-level structured payload is only attributable when the event has one tool result.
      const singleResult = parts.filter(block => block?.type === 'tool_result').length === 1
      const output = workflowOutput(singleResult ? event : {}, part, text)
      calls.push({ ...use, output, text, error: part.is_error === true || Boolean(output?.error), resultLine: line })
    }
  }
  return {
    calls, terminals, controls, results,
    push(chunk) {
      const lines = (remainder + chunk).split('\n')
      remainder = lines.pop()
      for (const complete of lines) read(complete)
    },
    finish() {
      if (remainder) read(remainder)
      remainder = ''
    },
  }
}

export function parseStream(text) {
  const stream = createStreamParser()
  stream.push(text)
  stream.finish()
  const { calls, terminals, controls, results } = stream
  return { calls, terminals, controls, results }
}

export function terminalFor(call, terminals) {
  if (!launched(call)) return undefined
  return terminals.find(terminal => terminal.session === call.session && terminal.line > call.line &&
    terminal.taskId === call.output.taskId && (!terminal.toolUseId || terminal.toolUseId === call.toolUseId) &&
    ['completed', 'failed', 'stopped', 'killed'].includes(terminal.status))
}

// Scripts can return this object or log the same JSON prefixed with DFPROBE.
export function probeObservation(payload, id, nonce) {
  const candidates = [payload?.result ?? payload, ...(Array.isArray(payload?.logs) ? payload.logs : [])]
  for (const candidate of candidates) {
    const raw = candidate?.message ?? candidate
    const decoded = typeof raw === 'string' ? json(raw) ?? raw : raw
    const record = typeof decoded === 'string' ? json(decoded.trim().replace(/^DFPROBE /, '')) : decoded
    if (record?.probe === id && record.nonce === nonce && isObject(record.observed)) return record.observed
  }
  return null
}

const result = (pass, observed, reason) => pass ? { status: 'pass', observed } : { status: 'fail', observed, reason }

export function judgeMeter(observed) {
  const { p0, c0, c1, p1 } = observed ?? {}
  const shared = [p0, c0, c1, p1].every(Number.isFinite) && p0 > 0 && c0 === p0 && c1 > c0 && p1 >= c1
  return result(shared, observed, 'budget meter did not advance across the parent and child')
}

export function judgeEnvelope(observed) {
  return result(observed.bytes === 40 * 1024 && Number.isInteger(observed.hash) &&
    observed.hash === observed.childHash && observed.echoEqual === true, observed, '40 KiB envelope did not round trip')
}

export function judgeBootThrow(observed, nonce, agentCount, journalStarts) {
  return result(observed.message === 'df-probe boot ' + nonce && agentCount === 0 && journalStarts === 0,
    { ...observed, agentCount, journalStarts }, 'child rejection or zero agent starts could not be established')
}

export function cancelLabels(nonce) {
  return { parent: `DFPROBE:${nonce}:P1`, child: `DFPROBE:${nonce}:C1` }
}

function journalEntry(file, index, line) {
  const row = json(line)
  if (!isObject(row)) throw new Error(`Invalid journal entry in ${file} at line ${index + 1}`)
  return row
}

export function workflowJournal(sessionDir, runId, live = false) {
  if (!RUN_ID.test(runId)) throw new Error('Invalid workflow run ID')
  const file = join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl')
  const lines = readFileSync(file, 'utf8').split('\n')
  if (live) lines.pop()
  return lines.flatMap((line, index) => {
    if (line.trim() === '') return []
    const row = journalEntry(file, index, line)
    if (row.type !== 'started' || row.label || !/^[A-Za-z0-9_-]+$/.test(row.agentId ?? '')) return row
    const meta = join(dirname(file), `agent-${row.agentId}.meta.json`)
    try {
      const { description } = JSON.parse(readFileSync(meta, 'utf8'))
      return { ...row, label: description }
    } catch (error) {
      if (error.code === 'ENOENT') return row
      throw error
    }
  })
}

export function workflowState(sessionDir, runId) {
  if (!RUN_ID.test(runId)) throw new Error('Invalid workflow run ID')
  const state = JSON.parse(readFileSync(join(sessionDir, 'workflows', `${runId}.json`), 'utf8'))
  if (!isObject(state)) throw new Error('Invalid workflow state')
  return state
}

function sameAttempt(a, b) {
  return a.key === b.key && a.agentId === b.agentId && a.directory === b.directory
}

function settled(row, attempt) {
  return sameAttempt(row, attempt) && (row.type === 'result' || row.type === 'failed')
}

const completed = row => row.type === 'result' && row.result != null
const stopped = status => status === 'killed' || status === 'stopped'
const startsFor = (rows, label) => rows.filter(row => row.type === 'started' && row.label === label &&
  typeof row.key === 'string' && row.key !== '' && typeof row.agentId === 'string' && row.agentId !== '')

const journalDirectory = runId => join('subagents', 'workflows', runId)

// The original and resumed run's journals, plus each directory in which this probe's own
// attempts start: a runtime may journal a child run on its own, and a resumed child may get
// a new directory. The nonce is unique to this launch, so other runs stay out.
function cancelScope(before, after, runIds, nonce) {
  const own = new Set(runIds.map(journalDirectory))
  const prefix = `DFPROBE:${nonce}:`
  for (const row of [...before, ...after]) if (row.type === 'started' && row.label?.startsWith(prefix)) own.add(row.directory)
  const keep = rows => rows.filter(row => own.has(row.directory))
  return { before: keep(before), after: keep(after) }
}

// The rows each directory gained after the stopped snapshot, or null when one no longer
// begins with its snapshot rows.
// before is the stopped session's journals. after is the same session's journals once the resume completes.
export function judgeCancel({ original, resumed, stop, before, after }) {
  const fail = reason => ({ status: 'fail', reason })
  if (!launched(original) || !launched(resumed) || !original.session ||
    original.input?.name !== CANCEL_WORKFLOW || resumed.input?.name !== CANCEL_WORKFLOW ||
    original.input.resumeFromRunId !== undefined || resumed.input.resumeFromRunId !== original.output.runId ||
    resumed.session !== original.session || original.output.taskId === resumed.output.taskId ||
    original.resultLine >= resumed.line || !isDeepStrictEqual(resumed.input.args, original.input.args)) {
    return fail('original workflow was not resumed with the same args in the same session')
  }
  if (!stop || !stopped(stop.status) || stop.taskId !== original.output.taskId ||
    stop.session !== original.session || stop.line <= original.line || stop.line >= resumed.line) {
    return fail('no correlated workflow stop before resume')
  }
  if (!Array.isArray(before) || !Array.isArray(after)) return fail('missing attempt journals')
  const nonce = original.input.args?.nonce
  if (typeof nonce !== 'string' || nonce === '') return fail('missing cancellation probe nonce')
  const scoped = cancelScope(before, after, [original.output.runId, resumed.output.runId], nonce)
  before = scoped.before
  after = scoped.after
  const labels = cancelLabels(nonce)
  const [parent] = startsFor(before, labels.parent)
  const children = startsFor(before, labels.child)
  const child = children.at(-1)
  if (!parent || !child || !before.slice(before.indexOf(parent) + 1).some((row, index) =>
    sameAttempt(row, parent) && completed(row) &&
    (parent.directory !== child.directory || before.indexOf(parent) + index + 1 < before.indexOf(child)))) {
    return fail('no completed parent call followed by an active first child call')
  }
  if (children.some(attempt => before.slice(before.indexOf(attempt) + 1).some(row => settled(row, attempt)))) {
    return fail('first child call had already ended at the stop boundary')
  }

  const fresh = journalGrowth(before, after)
  if (!fresh) return fail('resumed journal does not follow the stopped snapshot')
  if (fresh.some(row => children.some(attempt => settled(row, attempt)))) {
    return fail('original child attempt settled after the stopped snapshot')
  }
  const restart = startsFor(fresh, labels.child).find(row => row.key === child.key &&
    !children.some(attempt => attempt.agentId === row.agentId))
  if (!restart || !fresh.slice(fresh.indexOf(restart) + 1).some(row => sameAttempt(row, restart) && completed(row))) {
    return fail('interrupted child call did not restart and complete')
  }
  const replayed = startsFor(fresh, labels.parent).length === 0 ? ['P1'] : []
  return { status: 'pass', observed: {
    session: original.session, runId: original.output.runId, resumedRunId: resumed.output.runId,
    interruptedAgentId: child.agentId, restartedAgentId: restart.agentId, replayed,
    childJournal: child.directory, restartJournal: restart.directory,
  } }
}

export const beforeCancelDir = transcript => `${transcript}.l1-j-before`

export function parseManualTranscript(transcript) {
  try {
    const capture = beforeCancelDir(transcript)
    const text = readFileSync(transcript, 'utf8')
    const prefix = readFileSync(join(capture, 'session.jsonl'), 'utf8')
    if (!prefix.trim() || !text.startsWith(prefix) || !prefix.endsWith('\n')) {
      throw new Error('stopped snapshot must contain the transcript prefix before resume')
    }
    const live = parseStream(text)
    const stopLine = prefix.split('\n').length - 1
    const cancelCalls = live.calls.filter(call => call.input?.name === CANCEL_WORKFLOW)
    const [original, resumed] = cancelCalls
    const sessionId = basename(transcript, extname(transcript))
    if (cancelCalls.length !== 2 || !launched(original) || !launched(resumed) ||
      original.session !== sessionId || original.resultLine > stopLine || resumed.line <= stopLine) {
      throw new Error('expected one launch and one resume around the stopped snapshot')
    }
    const runId = original.output.runId
    const state = workflowState(capture, runId)
    if (state.taskId !== original.output.taskId || !stopped(state.status)) {
      throw new Error('no stopped state for the original workflow task')
    }
    const terminal = terminalFor(original, live.terminals)
    if (terminal && (!stopped(terminal.status) || terminal.line >= resumed.line)) {
      throw new Error('workflow terminal event contradicts the stopped snapshot')
    }
    const sessionDir = join(dirname(transcript), sessionId)
    return { ...judgeCancel({
      original, resumed,
      stop: { session: sessionId, taskId: state.taskId, status: state.status, line: stopLine },
      before: sessionJournal(capture),
      after: sessionJournal(sessionDir),
    }), mode: 'manual' }
  } catch (error) {
    return { status: 'fail', mode: 'manual', reason: error.message }
  }
}

export function writeVerdict(file, l1) {
  return updateVerdict(file, previous => {
    const oldCancel = previous.l1?.checks?.[CANCEL]
    const checks = { ...l1.checks }
    if (checks[CANCEL]?.status === 'pending' && oldCancel?.mode === 'manual') checks[CANCEL] = oldCancel
    return { ...previous, l1: { cli: l1.cli, nameForm: l1.nameForm, checks } }
  })
}

export function writeManualVerdict(file, check) {
  return updateVerdict(file, previous => {
    if (!isObject(previous.l1) || !isObject(previous.l1.checks)) throw new Error('Run the live probes before recording manual L1-j')
    const { l1 } = previous
    return { ...previous, l1: { ...l1, checks: { ...l1.checks, [CANCEL]: { ...check, mode: 'manual' } } } }
  })
}

function updateVerdict(file, update) {
  let previous = {}
  try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!isObject(previous)) throw new Error('Verdict must be a JSON object')
  const next = update(previous)
  const scratch = mkdtempSync(join(dirname(file), '.native-verdict-'))
  try {
    const temp = join(scratch, 'verdict.json')
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
    renameSync(temp, file)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return next
}

export async function writeFactoryVerdict(file, { cli, checks, sha256, inlineSha256 }, { root = REPO } = {}) {
  const { protocol, nameForm } = await handoffProtocol(root)
  if (!Number.isSafeInteger(protocol) || !nameForm) throw new Error('Invalid Factory handoff protocol or child name form')
  if (typeof cli !== 'string' || !cli.trim()) throw new Error('Missing Claude CLI version')
  const hashes = Object.fromEntries(['factory.js', 'council.js', 'pair.js'].map(name => {
    const hash = sha256?.[name]
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Missing or invalid candidate SHA-256 for ${name}`)
    return [name, hash]
  }))
  const outcomes = Object.fromEntries(L2_REQUIRED.map(id => [id, checks?.[id] ?? { status: 'pending' }]))
  return updateVerdict(file, previous => {
    if (previous.l1?.nameForm !== nameForm) throw new Error('Factory child workflow name form differs from the L1 verdict')
    if (inlineSha256) {
      const provenance = { cli, protocol, nameForm, sha256: { inline: inlineSha256, candidate: hashes } }
      const cancel = outcomes['L2-iv']
      const old = previous.l2?.checks?.['L2-iv']
      outcomes['L2-iv'] = cancel.status === 'pending' && old?.mode === 'manual' &&
        old.status === 'pass' && isDeepStrictEqual(old.provenance, provenance) ? old : { ...cancel, provenance }
    }
    return { ...previous, l2: { cli, protocol, nameForm, checks: outcomes, sha256: hashes } }
  })
}

export function factoryExitCode(checks) {
  return L2_REQUIRED.every(id => checks?.[id]?.status === 'pass') ? 0 : 1
}

export function probeExitCode(checks, { claudeRan = true } = {}) {
  if (!claudeRan || L1_REQUIRED.some(id => id !== CANCEL && checks?.[id]?.status !== 'pass')) return 1
  const cancel = checks?.[CANCEL]
  return cancel?.mode === 'auto' && !['pass', 'pending'].includes(cancel.status) ? 1 : 0
}

// The script functions below are serialized by probeScripts. Their runtime globals
// (args, agent, workflow, budget and log) are supplied by Claude Code.
async function probeChild() {
  switch (args.operation) {
    case 'ping': return { nonce: args.nonce }
    case 'echo': return { hash: hashEnvelope(args.envelope), echo: args.envelope }
    case 'mutate':
      args.nested.x = 'child'
      return { value: args.nested.x }
    case 'budget': {
      const c0 = budget.spent()
      await token('C1', args.nonce)
      return { c0, c1: budget.spent() }
    }
    case 'throw': throw new Error('df-probe boot ' + args.nonce)
    case 'replay': return {
      tokens: [await token('C1', args.nonce), await token('C2', args.nonce, args.answer)],
      unused: args.unused,
    }
    case 'sibling': return token('S', args.nonce)
    case 'upgrade': return { marker: 'upgrade-child-v2', tokens: [await token('Y', args.nonce), await token('Z', args.nonce)] }
    case 'cancel': return token('C1', args.nonce, undefined, args.words)
    default: throw new Error('unknown child probe')
  }
}

function hashEnvelope(value) {
  const encoded = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < encoded.length; index++) hash = Math.imul(hash ^ encoded.charCodeAt(index), 16777619)
  return hash >>> 0
}

function equalJson(first, second) {
  if (first === second) return true
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object' ||
      Array.isArray(first) !== Array.isArray(second)) return false
  const keys = Object.keys(first)
  return keys.length === Object.keys(second).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(second, key) && equalJson(first[key], second[key]))
}

async function token(position, nonce, answer, words) {
  const suffix = answer === undefined ? '' : ' Use this answer as inspiration: ' + answer
  const prompt = words ? 'Return a short token followed by a space and a story of about ' + words +
    ' words, all inside the token JSON field. Do not use tools.' :
    'Return an arbitrary 16-character alphanumeric token. Do not use tools.' + suffix
  const response = await agent(prompt, {
    label: 'DFPROBE:' + nonce + ':' + position, model: 'haiku',
    schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
  })
  return response?.token ?? null
}

function observation(probe, nonce, observed) {
  const record = { probe, nonce, observed }
  log('DFPROBE ' + JSON.stringify(record))
  return record
}

async function probeParent() {
  const { probe, nonce, child, answer, resume, unused } = args
  const report = observed => observation(probe, nonce, observed)
  const call = (operation, extra) => workflow(child, { nonce, operation, ...extra })
  switch (probe) {
    case 'L1-a': {
      const names = {}
      for (const [form, name] of [['qualified', 'df-probe:child'], ['bare', 'child']]) {
        try { names[form] = { resolved: (await workflow(name, { operation: 'ping', nonce }))?.nonce === nonce } }
        catch (error) { names[form] = { resolved: false, error: error.message } }
      }
      return report(names)
    }
    case 'L1-b1': {
      const envelope = { handoff: { nested: { text: '', list: [null, false, 7, { some: ['data'] }] } } }
      envelope.handoff.nested.text = 'x'.repeat(40 * 1024 - JSON.stringify(envelope).length)
      const hash = hashEnvelope(envelope)
      const response = await call('echo', { envelope })
      return report({ bytes: JSON.stringify(envelope).length, hash, childHash: response?.hash, echoEqual: equalJson(envelope, response?.echo) })
    }
    case 'L1-b2': {
      const nested = { x: 'parent' }
      try {
        const response = await call('mutate', { nested })
        const mutation = response?.value !== 'child' ? 'unproven' : nested.x === 'child' ? 'reference' : 'copy'
        return report({ mutation, parentValue: nested.x, childValue: response?.value })
      } catch (error) { return report({ error: error.message }) }
    }
    case 'L1-b3': {
      await token('P1', nonce)
      const p0 = budget.spent()
      const childSpend = await call('budget')
      return report({ p0, ...childSpend, p1: budget.spent() })
    }
    case 'L1-c': {
      try { await call('throw') }
      catch (error) { return report({ message: error.message }) }
      return report({ message: null })
    }
    case 'L1-d':
    case 'L1-d2':
    case 'L1-f': {
      const parent = await token('P1', nonce)
      const received = await call('replay', { unused, answer })
      const tokens = [parent, ...received.tokens]
      if (resume && probe !== 'L1-f') tokens.push(await token('P2', nonce))
      return report({ tokens, unused: received.unused })
    }
    case 'L1-g':
      return report({ tokens: [await call('sibling'), await call('sibling')] })
    default: throw new Error('unknown parent probe')
  }
}

async function upgradeParent(version) {
  const { probe, nonce, child, answer } = args
  const x = await token('X', nonce)
  if (version === 1) {
    return observation(probe, nonce, { version, stop: 'answer', tokens: [x, await token('Y', nonce), await token('Z', nonce)] })
  }
  const delegated = await workflow(child, { nonce, operation: 'upgrade' })
  const continuation = await token('NEXT', nonce, answer)
  return observation(probe, nonce, { version, marker: delegated.marker, tokens: [x, ...delegated.tokens, continuation] })
}

async function cancelParent() {
  const { probe, nonce, child, words } = args
  const parent = await token('P1', nonce)
  const first = await workflow(child, { nonce, operation: 'cancel', words })
  return observation(probe, nonce, { tokens: [parent, first] })
}

function workflowScript(name, body) {
  const meta = { name, description: 'Native workflow probe: ' + name, whenToUse: 'Only during the native workflow check',
    phases: [{ title: 'Probe', detail: 'Collect native workflow evidence', model: 'haiku' }] }
  return `export const meta = ${JSON.stringify(meta)}\n\n${body}\n`
}

export function probeScripts(version = 1) {
  const helpers = [hashEnvelope, equalJson, token, observation].map(fn => fn.toString()).join('\n\n')
  const script = (name, fn, arg = '') => workflowScript(name, `${helpers}\n\nreturn await (${fn})(${arg})`)
  const scripts = {
    parent: script('parent', probeParent),
    child: script('child', probeChild),
    upgrade: script('upgrade', upgradeParent, version),
    cancel: script('cancel', cancelParent),
  }
  if (version === 2) scripts[UPGRADE_MARKER] = workflowScript(UPGRADE_MARKER, 'return "upgrade-v2"')
  return scripts
}

function writeProbePlugin(path, scripts) {
  mkdirSync(join(path, '.claude-plugin'), { recursive: true })
  mkdirSync(join(path, 'workflows'), { recursive: true })
  writeFileSync(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0' }))
  for (const [name, source] of Object.entries(scripts)) writeFileSync(join(path, 'workflows', name + '.js'), source)
}

function inside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

export function scratchEnv(config, dedicated, env = process.env) {
  const isolated = { ...env, CLAUDE_CONFIG_DIR: config }
  if (dedicated) delete isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR
  else isolated.CLAUDE_SECURESTORAGE_CONFIG_DIR = ''
  return isolated
}

function claudeCommand(args, options) {
  const run = spawnSync('claude', args, { ...options, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`claude ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`)
  return run.stdout.trim()
}

function installedPlugins(options) {
  const installed = json(claudeCommand(['plugin', 'list', '--json'], options))
  if (!Array.isArray(installed) || installed.some(plugin =>
    typeof plugin?.id !== 'string' || typeof plugin.enabled !== 'boolean')) {
    throw new Error('Cannot verify isolated Claude plugin inventory')
  }
  return installed
}

function pluginInventory(options, allowed) {
  const enabled = installedPlugins(options).filter(plugin => plugin.enabled)
  if (enabled.some(plugin => plugin.id !== allowed)) throw new Error('Probe configuration contains a foreign enabled plugin')
  return enabled
}

function sessionDirectory(config, session) {
  if (!/^[A-Za-z0-9_-]+$/.test(session ?? '')) return null
  const projects = join(config, 'projects')
  if (!existsSync(projects)) return null
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project, session)
    if (existsSync(dir)) return dir
  }
  return null
}

function startSession({ cwd, env, plugin, artifacts, guard }) {
  const path = join(artifacts, randomUUID())
  const stream = createStreamParser()
  const permissions = guard?.args ?? ['--allowedTools', 'Workflow', '--tools', 'Workflow']
  const child = spawn('claude', ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', ...permissions, '--plugin-dir', plugin], { cwd, env, stdio: 'pipe' })
  let stderr = '', failure, exited = false
  const done = new Promise(resolve => child.once('close', () => { exited = true; stream.finish(); resolve() }))
  child.on('error', error => { failure = error })
  child.stdin.on('error', error => { failure = error })
  child.stdout.setEncoding('utf8').on('data', chunk => {
    appendFileSync(path + '.jsonl', chunk)
    stream.push(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', chunk => {
    appendFileSync(path + '.stderr', chunk)
    stderr = (stderr + chunk).slice(-2000)
  })
  function send(frame) {
    child.stdin.write(JSON.stringify(frame) + '\n')
  }
  function sendUser(content) {
    send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
  }
  async function waitFor(read, description, timeout = DEADLINE_MS) {
    const end = Date.now() + timeout
    while (true) {
      if (failure) throw failure
      const found = read()
      if (found) return found
      if (exited || Date.now() >= end) throw new Error(`${description}: ${stderr.trim() || 'no correlated Claude response'}`)
      await delay(25)
    }
  }
  async function invoke(input, timeout) {
    const firstCall = stream.calls.length, firstResult = stream.results.length
    // Claude Code rejects an unknown workflow name before PreToolUse hooks run, so a listing
    // probe never reaches the guard; it cannot launch anything, and its listing is checked.
    const guarded = guard && !isListingProbe(input) ? guard : null
    guarded?.permit(input)
    try {
      sendUser(inputPrompt(input))
      const call = await waitFor(() => {
        const matched = stream.calls.slice(firstCall).find(row => isDeepStrictEqual(row.input, input))
        if (matched) return matched
        const driver = stream.results.slice(firstResult).find(row => row.event.is_error)
        if (driver) throw new Error(`Claude did not make the requested Workflow call: ${textOf(driver.event.errors ?? driver.event.result) || stderr.trim()}`)
        return null
      }, `could not invoke ${input.name}`, timeout)
      guarded?.verify(call)
      return call
    } finally {
      guarded?.clear()
    }
  }
  async function control(request) {
    const request_id = randomUUID()
    send({ type: 'control_request', request_id, request })
    return waitFor(() => stream.controls.find(row => row.response?.request_id === request_id)?.response, request.subtype, 30_000)
  }
  async function close() {
    child.stdin.end()
    if (!exited) child.kill('SIGTERM')
    const fallback = setTimeout(() => child.kill('SIGKILL'), 1000)
    try { await done } finally { clearTimeout(fallback) }
  }
  return { stream, invoke, sendUser, control, waitFor, close, config: env.CLAUDE_CONFIG_DIR }
}

async function inSession(options, callback) {
  const session = startSession(options)
  try { return await callback(session) } finally { await session.close() }
}

function stateFor(dir, { runId, taskId }) {
  if (!dir) return null
  try {
    const state = workflowState(dir, runId)
    return state.taskId === taskId ? state : null
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    return null
  }
}

async function observe(session, input, call) {
  call ??= await session.invoke(input)
  if (!launched(call)) throw new Error(call.text || 'Workflow did not launch')
  return session.waitFor(() => {
    const dir = sessionDirectory(session.config, call.session)
    const terminal = terminalFor(call, session.stream.terminals)
    if (terminal && terminal.status !== 'completed') throw new Error(`Workflow ended with status ${terminal.status}`)
    if (!dir) return null
    const state = stateFor(dir, call.output) ?? terminal
    if (state && state.status !== 'completed') throw new Error(state.error || `Workflow ended with status ${state.status}`)
    const observed = probeObservation(state, input.args.probe, input.args.nonce)
    return observed && { call, dir, state, observed }
  }, `no completed evidence for ${input.args.probe}`)
}

function runJournal(dir, id, live = false) {
  const directory = journalDirectory(id)
  if (!existsSync(join(dir, directory, 'journal.jsonl'))) return []
  return workflowJournal(dir, id, live).map(row => ({ ...row, directory }))
}

function sessionJournal(dir, live = false) {
  const base = join(dir, 'subagents', 'workflows')
  if (!existsSync(base)) return []
  return readdirSync(base).sort().filter(id => RUN_ID.test(id)).flatMap(id => runJournal(dir, id, live))
}

function attemptLabel(nonce, position) {
  return `DFPROBE:${nonce}:${position}`
}

function newAttempts(before, after) {
  return after.filter(row => row.type === 'started' && !before.some(old => old.type === 'started' && sameAttempt(row, old)))
}

function hasToken(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function judgeReplay(probe, nonce, initial, resumed, before, after) {
  const positionsToCheck = probe === 'L1-i' ? ['X', 'Y', 'Z'] : probe === 'L1-g' ? ['S', 'S'] : ['P1', 'C1', 'C2']
  const labels = positionsToCheck.map(position => attemptLabel(nonce, position))
  const fresh = newAttempts(before, after)
  const original = initial.tokens, replay = resumed.tokens
  const append = ['L1-d', 'L1-d2', 'L1-i'].includes(probe)
  if (!Array.isArray(original) || !Array.isArray(replay) || original.length !== labels.length ||
      replay.length !== labels.length + Number(append) || ![...original, ...replay].every(hasToken)) {
    return result(false, null, 'missing agent results')
  }
  const attempts = [...new Set(labels)].flatMap(label => startsFor(before, label))
  if (attempts.length !== labels.length || !attempts.every(attempt =>
    before.some(row => sameAttempt(row, attempt) && completed(row)))) {
    return result(false, null, 'initial agent attempts or results are missing')
  }
  const positions = labels.map((label, index) => {
    const changes = startsFor(fresh, label)
    const reran = probe === 'L1-g' ? changes.some(row => row.key === attempts[index].key ||
      !attempts.some(attempt => attempt.key === row.key)) : changes.length > 0
    return original[index] === replay[index] && !reran
  })
  const doneFresh = position => startsFor(fresh, attemptLabel(nonce, position)).some(attempt =>
    after.some(row => sameAttempt(row, attempt) && completed(row)))
  const observed = { original, resumed: replay, newStarts: fresh.map(row => row.label ?? row.agentId) }
  if (probe === 'L1-g') {
    observed.ambiguous = original[0] === original[1]
    observed.ordinals = positions.map((replayed, index) => ({ ordinal: index + 1, replayed: !observed.ambiguous && replayed }))
    if (observed.ambiguous) return result(false, observed, 'positional replay is inconclusive with identical sibling results')
    return result(positions.every(Boolean) && fresh.length === 0, observed, 'sibling calls did not replay positionally')
  }
  observed.positions = positions.map((replayed, index) => ({ position: positionsToCheck[index], replayed }))
  if (probe === 'L1-f') return result(positions[0] && positions[1] && doneFresh('C2'), observed, 'changed child suffix did not rerun after replay')
  const unusedChanged = probe !== 'L1-d2' || (initial.unused === 'initial' && resumed.unused === 'changed')
  if (probe === 'L1-d2') observed.unused = { before: initial.unused, after: resumed.unused }
  return result(positions.every(Boolean) && doneFresh(probe === 'L1-i' ? 'NEXT' : 'P2') && fresh.length === 1 && unusedChanged, observed,
    'the original calls did not all replay before the continuation')
}

function locations(config, sessionDir, rows, nonce) {
  const find = position => startsFor(rows, attemptLabel(nonce, position)).find(row =>
    existsSync(join(sessionDir, row.directory, `agent-${row.agentId}.jsonl`)))?.directory
  const parent = find('P1'), child = find('C1')
  return result(Boolean(parent && child), { parent: parent && relative(config, join(sessionDir, parent)),
    child: child && relative(config, join(sessionDir, child)) },
    'could not locate both parent and child agent transcripts')
}

async function shadowing(root, options) {
  const marketplace = join(root, 'marketplace'), plugin = join(root, 'shadow-sideload')
  const config = join(root, 'shadow-config')
  mkdirSync(config)
  const marker = name => ({ [name]: workflowScript(name, 'return ' + JSON.stringify(name)) })
  writeProbePlugin(join(marketplace, PLUGIN), marker('installed-marker'))
  writeProbePlugin(plugin, marker('sideload-marker'))
  mkdirSync(join(marketplace, '.claude-plugin'))
  writeFileSync(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: MARKET, owner: { name: 'Native workflow check' }, plugins: [{ name: PLUGIN, source: './df-probe' }],
  }))
  const shadow = { ...options, plugin, env: scratchEnv(config, false, options.env) }
  pluginInventory(shadow)
  claudeCommand(['plugin', 'marketplace', 'add', marketplace], shadow)
  const id = `${PLUGIN}@${MARKET}`
  claudeCommand(['plugin', 'install', id], shadow)
  const [installed] = pluginInventory(shadow, id)
  const readFrom = installed?.readFromFolder ?? installed?.installPath
  if (!readFrom || !inside(realpathSync(readFrom), root) || !existsSync(join(readFrom, 'workflows', 'installed-marker.js'))) {
    throw new Error('Scratch plugin inventory did not confirm the installed marker')
  }
  return inSession(shadow, async session => {
    const { names } = await loadedWorkflows(session)
    const observed = { installed: names.includes(`${PLUGIN}:installed-marker`), sideload: names.includes(`${PLUGIN}:sideload-marker`) }
    return result(observed.sideload && !observed.installed, observed, 'the sideloaded copy did not exclusively shadow the installed copy')
  })
}

async function loadedWorkflows(session, plugin = PLUGIN) {
  const call = await session.invoke({ name: `${plugin}:missing-${randomUUID()}` })
  const available = /not found\. Available: ([^<\n]*)/.exec(call.text)?.[1]
  if (!call.error || !available) throw new Error('No native loaded-workflow listing')
  return { sessionId: call.session, names: available.split(',').map(name => name.trim()) }
}

async function upgrade(options, child) {
  options = { ...options, plugin: join(dirname(options.plugin), 'upgrade-plugin') }
  writeProbePlugin(options.plugin, probeScripts())
  return inSession(options, async session => {
    const args = { probe: 'L1-i', nonce: randomUUID(), child }
    const original = await observe(session, { name: UPGRADE_WORKFLOW, args })
    if (original.observed.version !== 1 || original.observed.stop !== 'answer') throw new Error('v1 did not reach the answer stop')
    const before = sessionJournal(original.dir)
    writeProbePlugin(options.plugin, probeScripts(2))
    session.sendUser('/reload-plugins')
    const listing = await loadedWorkflows(session)
    if (listing.sessionId !== original.call.session || !listing.names.includes(`${PLUGIN}:${UPGRADE_MARKER}`)) {
      throw new Error('v2 marker was absent after the same-session plugin reload')
    }
    const resumed = await observe(session, { name: UPGRADE_WORKFLOW, args: { ...args, answer: 'continue after reload' },
      resumeFromRunId: original.call.output.runId })
    if (resumed.call.session !== original.call.session || resumed.observed.version !== 2 ||
        resumed.observed.marker !== 'upgrade-child-v2') throw new Error('resume did not return the v2 child marker in the original session')
    return judgeReplay('L1-i', args.nonce, original.observed, resumed.observed, before, sessionJournal(resumed.dir))
  })
}

function cancelInput(child, words) {
  return { name: CANCEL_WORKFLOW, args: { probe: CANCEL, nonce: randomUUID(), child, words } }
}

// A stop notification can precede the old runner's exit. Each request keeps the normal
// invocation deadline; only that refusal is retried, for retryMs after the first one.
export async function resumeAfterStop(session, input, original, retryMs = 30_000, observeResume = observe) {
  const { runId, taskId } = original.output
  const resume = { ...input, resumeFromRunId: runId }
  let end
  while (true) {
    const call = await session.invoke(resume)
    if (call.session !== original.session) throw new Error('Cancellation resumed in a different session')
    if (!call.error || !call.text.includes(`Workflow ${runId} `) ||
        !call.text.includes(`run has not exited yet (task ${taskId})`)) return observeResume(session, resume, call)
    end ??= Date.now() + retryMs
    if (Date.now() >= end) throw new Error('Original workflow did not exit in time to resume')
    await delay(250)
  }
}

async function cancelAttempt(options, input) {
  return inSession(options, async session => {
    const original = await session.invoke(input)
    if (!launched(original)) throw new Error(original.text || 'Cancellation workflow did not launch')
    const label = cancelLabels(input.args.nonce).child
    const inspect = () => {
      const dir = sessionDirectory(session.config, original.session)
      return { dir, terminal: terminalFor(original, session.stream.terminals), state: stateFor(dir, original.output) }
    }
    const started = await session.waitFor(() => {
      const { dir, terminal, state } = inspect()
      const status = (state ?? terminal)?.status
      if (status === 'completed') return { missed: true }
      if (status) throw new Error(`Workflow ended before cancellation: ${status}`)
      if (!dir) return null
      // The label carries this attempt's nonce, so any run directory of the session may hold it.
      const rows = sessionJournal(dir, true)
      const active = startsFor(rows, label).at(-1)
      return active && (rows.some(row => settled(row, active)) ? { missed: true } : { active })
    }, 'waiting for the first child agent to start')
    if (started.missed) return { missed: true }
    const response = await session.control({ subtype: 'stop_task', task_id: original.output.taskId })
    if (response.subtype === 'error' && /stop_task is not supported in this context/i.test(response.error ?? '')) {
      return { status: 'pending', reason: response.error }
    }
    if (response.subtype !== 'success') {
      const { state, terminal } = inspect()
      if ((state ?? terminal)?.status === 'completed') return { missed: true }
      throw new Error(response.error || 'Claude refused stop_task')
    }
    const boundary = await session.waitFor(() => {
      const { dir, terminal, state } = inspect()
      if ([state?.status, terminal?.status].includes('completed')) return { missed: true }
      if ([state?.status, terminal?.status].includes('failed')) throw new Error('Workflow failed around the stop request')
      if (!dir || !stopped(state?.status)) return null
      return { dir, stop: terminal ?? { session: original.session, taskId: original.output.taskId,
        status: state.status, line: original.resultLine } }
    }, 'waiting for the stopped workflow', 30_000)
    if (boundary.missed) return { missed: true }
    const before = sessionJournal(boundary.dir)
    if (before.some(row => settled(row, started.active))) return { missed: true }
    const resumed = await resumeAfterStop(session, input, original)
    return judgeCancel({ original, resumed: resumed.call, stop: boundary.stop,
      before, after: sessionJournal(resumed.dir) })
  })
}

async function cancel(options, child) {
  for (const words of [250, 500, 1000]) {
    const check = await cancelAttempt(options, cancelInput(child, words))
    if (!check.missed) return { ...check, mode: 'auto' }
  }
  return { status: 'fail', mode: 'auto', reason: 'missed the active child cancellation window in all three attempts' }
}

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

function manualInstructions(options, child, file) {
  const { cwd, env, plugin } = options
  const config = env.CLAUDE_CONFIG_DIR, session = randomUUID()
  const input = cancelInput(child, 1000)
  const auth = env.CLAUDE_SECURESTORAGE_CONFIG_DIR === '' ? 'CLAUDE_SECURESTORAGE_CONFIG_DIR=' :
    '-u CLAUDE_SECURESTORAGE_CONFIG_DIR'
  const command = `cd ${quote(cwd)} && env ${auth} CLAUDE_CONFIG_DIR=${quote(config)} claude --model haiku --plugin-dir ${quote(plugin)} --session-id ${quote(session)}`
  const resume = JSON.stringify({ ...input, resumeFromRunId: 'REPLACE_WITH_ORIGINAL_WF_RUN_ID' })
  console.log(`
Manual L1-j
1. In a terminal, launch this isolated Claude session:
   ${command}
2. Ask Claude to call Workflow exactly once with this input:
   ${JSON.stringify(input)}
3. In /workflows, open the run and wait for the DFPROBE:${input.args.nonce}:C1 agent to show as running. Return to the run list and press x on the whole workflow. Wait until it is stopped.
4. Before resuming, run these commands in another shell. Keep the capture next to the transcript:
   transcript=$(find ${quote(join(config, 'projects'))} -type f -name ${quote(session + '.jsonl')} -print)
   snapshot="$transcript.l1-j-before"
   side="${'${transcript%.jsonl}'}"
   test -f "$transcript" && mkdir "$snapshot" && cp "$transcript" "$snapshot/session.jsonl" && cp -R "$side/workflows" "$side/subagents" "$snapshot/"
5. In the original session ask Claude to call Workflow with this input, replacing REPLACE_WITH_ORIGINAL_WF_RUN_ID with the original run's exact ID:
   ${resume}
6. Wait for the restarted run to finish, then run in the shell from step 4:
   node ${quote(fileURLToPath(import.meta.url))} --manual L1-j --transcript "$transcript" --verdict ${quote(resolve(file))}
`)
}

const skips = ids => Object.fromEntries(ids.map(id => [id, { status: 'skipped' }]))

async function runProbes(options, root, checks, file) {
  const input = { name: `${PLUGIN}:parent`, args: { probe: 'L1-a', nonce: randomUUID() } }
  let discovery
  try { discovery = await inSession(options, session => observe(session, input)) }
  catch (error) { throw new Error(`${error.message}. For login, use a supported credential environment or --config-dir <isolated authenticated directory>. Generated configs reuse the default macOS Keychain login.`) }
  const names = discovery.observed
  const nameForm = names.qualified?.resolved === true ? 'qualified' : names.bare?.resolved === true ? 'bare' : null
  checks['L1-a'] = result(Boolean(nameForm), names, 'neither child name resolved')
  const child = nameForm === 'qualified' ? `${PLUGIN}:child` : 'child'
  const measure = async (probe, run) => {
    try { checks[probe] = await run() }
    catch (error) { checks[probe] = result(false, null, error.message) }
  }
  if (nameForm) {
    for (const probe of ['L1-b1', 'L1-b2', 'L1-b3', 'L1-c']) {
      await measure(probe, () => inSession(options, async session => {
        const nonce = randomUUID()
        const { observed, dir, state } = await observe(session, { name: input.name, args: { probe, nonce, child } })
        if (probe === 'L1-b1') return judgeEnvelope(observed)
        if (probe === 'L1-b2') return result(['copy', 'reference'].includes(observed.mutation), observed, 'child mutation could not be observed')
        if (probe === 'L1-b3') return judgeMeter(observed)
        const starts = sessionJournal(dir).filter(row => row.type === 'started').length
        return judgeBootThrow(observed, nonce, state.agentCount, starts)
      }))
    }
    for (const probe of ['L1-d', 'L1-d2', 'L1-f', 'L1-g']) {
      await measure(probe, () => inSession(options, async session => {
        const nonce = randomUUID()
        const args = { probe, nonce, child, ...(probe === 'L1-d2' ? { unused: 'initial' } : {}) }
        const initial = await observe(session, { name: input.name, args })
        const before = sessionJournal(initial.dir)
        if (probe === 'L1-d') checks['L1-e'] = locations(session.config, initial.dir, before, nonce)
        const changed = probe === 'L1-d2' ? { unused: 'changed' } : probe === 'L1-f' ? { answer: 'append an answer' } : {}
        const resumed = await observe(session, { name: input.name, args: { ...args, resume: true, ...changed },
          resumeFromRunId: initial.call.output.runId })
        if (resumed.call.session !== initial.call.session) throw new Error('Workflow resumed in a different Claude session')
        return judgeReplay(probe, nonce, initial.observed, resumed.observed, before, sessionJournal(resumed.dir))
      }))
    }
  }
  await measure('L1-h', () => shadowing(root, options))
  if (nameForm) {
    await measure('L1-i', () => upgrade(options, child))
    await measure(CANCEL, () => cancel(options, child))
    checks[CANCEL].mode = 'auto'
    if (checks[CANCEL].status === 'pending') manualInstructions(options, child, file)
  }
  return nameForm
}

function scratchConfig(configDir, root) {
  const config = realpathSync(configDir)
  const defaultConfig = join(homedir(), '.claude')
  const normal = existsSync(defaultConfig) ? realpathSync(defaultConfig) : defaultConfig
  const repo = realpathSync(REPO)
  if (!statSync(config).isDirectory() || inside(root, config) || inside(config, normal) || inside(config, repo) || inside(repo, config)) {
    throw new Error('--config-dir must be a dedicated Claude configuration outside the default config, checkout and probe directories')
  }
  return config
}

async function live(configDir, file) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'df-workflow-check-')))
  const cwd = join(root, 'cwd'), plugin = join(root, PLUGIN), artifacts = join(root, 'artifacts')
  const checks = skips([...L1_REQUIRED, ...L1_RECORDED, ...L1_INFORMATIONAL].sort())
  let cli = null, nameForm = null
  try {
    let config = join(root, 'config')
    if (configDir) config = scratchConfig(configDir, root)
    else mkdirSync(config)
    mkdirSync(cwd)
    mkdirSync(artifacts)
    const options = { cwd, plugin, artifacts, env: scratchEnv(config, Boolean(configDir)) }
    cli = claudeCommand(['--version'], options)
    pluginInventory(options)
    writeProbePlugin(plugin, probeScripts())
    nameForm = await runProbes(options, root, checks, file)
  } catch (error) {
    checks['L1-a'] = result(false, null, error.message)
  }
  writeVerdict(file, { cli, nameForm, checks })
  for (const [id, check] of Object.entries(checks)) console.log(`${id}: ${check.status}${check.reason ? ` (${check.reason})` : ''}`)
  console.log(`Probe artifacts: ${root}`)
  return probeExitCode(checks, { claudeRan: Boolean(cli) })
}

// Every model that would default to Codex Astra is pinned to Sol (Simple review, Pair reviewer,
// Fix seats, panel and spec coverage); candidate and control get the same args, so parity holds.
const FACTORY_ARGS = {
  'L2-i': {
    tier: 'simple', strategy: 'independent', maxTurns: 2, simple: { reviewer: 'sol' },
    task: 'Fix the off-by-one in math.cjs count: it should return the input. Add a focused test.',
  },
  'L2-ii': {
    tier: 'simple', strategy: 'pair', mode: 'implement', pair: { reviewer: 'sol', spec: false, maxDesignReviews: 1, maxReviews: 3 },
    task: 'Change the increment implementation in math.cjs to advance by two. Decide how to preserve the public caller behavior, check downstream callers, and add a focused test.',
  },
  'L2-iii': {
    tier: 'fix', strategy: 'independent', mode: 'implement', spec: { coverage: 'sol', ask: true }, audit: false,
    seats: ['opus', 'sol'], panel: ['opus', 'sol'],
    task: 'Fix retry.cjs to retry transient failures and add a focused test. The retry policy for HTTP 5xx versus timeouts is a product decision reserved for the maintainer. The repository cannot settle that choice. Ask before implementing.',
  },
}
const FACTORY_ANSWERS = {
  'L2-ii': { answer: 'Preserve caller.cjs next as advancing by one. Update and test the increment implementation and its caller.', implement: true },
  'L2-iii': { answer: 'Retry both timeouts and HTTP 5xx, but do not retry other HTTP responses.' },
}

export function factoryArgs(id, verify) {
  const scenario = id === 'L3' ? 'L2-ii' : id === 'L2-iv' ? 'L2-i' : id
  const args = { brief: false, tierConfirmed: true, noSplit: true, retro: false, verify, ...FACTORY_ARGS[scenario] }
  if (id === 'L2-iv') delete args.maxTurns
  return args
}

function factoryConfig(configDir, root) {
  if (!configDir) throw new Error('Pass --config-dir with a dedicated Claude configuration and authenticate it first')
  const config = scratchConfig(configDir, root)
  for (let path = dirname(realpathSync(REPO)); path !== dirname(path); path = dirname(path)) {
    if (existsSync(join(path, '.git')) && inside(config, path)) {
      throw new Error('--config-dir must be outside the main checkout')
    }
  }
  const file = join(config, 'settings.json')
  const settings = existsSync(file) && json(readFileSync(file, 'utf8'))
  const allow = settings?.permissions?.allow
  if (!Array.isArray(allow) || !allow.includes('Bash(dark-factory:*)')) {
    throw new Error(`Add "Bash(dark-factory:*)" to permissions.allow in scratch ${file}`)
  }
  validateFactoryGuardSettings(settings, file)
  // Managed settings still apply when project and local settings are omitted.
  for (const dir of ['/etc/claude-code', '/Library/Application Support/ClaudeCode']) {
    const fragments = join(dir, 'managed-settings.d')
    const files = [join(dir, 'managed-settings.json')]
    if (existsSync(fragments)) files.push(...readdirSync(fragments).filter(name => name.endsWith('.json')).map(name => join(fragments, name)))
    for (const path of files.filter(existsSync)) validateFactoryGuardSettings(json(readFileSync(path, 'utf8')), path)
  }
  return config
}

const isListingProbe = input => /:missing-[0-9a-f-]{36}$/.test(input?.name ?? '')

// A missing matcher, "*" (every tool) or one that does not compile may still match Workflow.
const matchesWorkflow = matcher => {
  if (!matcher || matcher === '*') return true
  try { return new RegExp(matcher).test('Workflow') } catch { return true }
}

function validateFactoryGuardSettings(settings, file) {
  const allow = settings?.permissions?.allow ?? []
  const hooks = settings?.hooks?.PreToolUse ?? []
  if (!isObject(settings) || !Array.isArray(allow) || !Array.isArray(hooks) ||
      settings.disableAllHooks === true || settings.allowManagedHooksOnly === true ||
      settings.allowManagedPermissionRulesOnly === true || settings.permissions?.defaultMode === 'bypassPermissions' ||
      allow.some(rule => typeof rule === 'string' && /^(?:\*|Workflow(?:\s*\(.*\))?)$/.test(rule.trim())) ||
      hooks.some(hook => matchesWorkflow(hook?.matcher))) {
    throw new Error(`Settings in ${file} conflict with guarded Workflow requests. Use a dedicated configuration that allows the checker hook.`)
  }
}

function factoryPreflight(copy, { cwd, env }) {
  const helper = join(copy.path, 'bin', 'dark-factory')
  const run = spawnSync(helper, ['preflight', '--vendors', 'codex', '--claude-settings'], {
    cwd, env, timeout: 90_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error) throw run.error
  const report = json(run.stdout.trim())
  const checks = ['codex', 'claude-settings'].map(name => [name, report?.vendors?.[name]])
  if (run.status !== 0 || report?.status !== 'ok' || checks.some(([, check]) => check?.ok !== true)) {
    const failures = checks.filter(([, check]) => check?.ok !== true)
      .map(([name, check]) => `${name}: ${check?.error ?? 'no passing preflight result'}`)
    throw new Error(`Factory setup preflight failed: ${failures.join('; ') || run.stderr.trim() || report?.status}`)
  }
}

function verifyFactoryListing(loaded, copy, baselineSession, expected) {
  const marker = `${FACTORY_PLUGIN}:${copy.marker}`
  const names = loaded.names.filter(name => name.startsWith(FACTORY_PLUGIN + ':'))
  if (!loaded.sessionId || (baselineSession && loaded.sessionId !== baselineSession) ||
      !isDeepStrictEqual(names.sort(), [...expected, marker].sort())) {
    throw new Error(`Expected one dark-factory workflow set and marker ${marker}; loaded ${names.join(', ') || 'none'}. Check the scratch plugin and reload.`)
  }
}

function verifyFactoryCopy(copy, workflowHashes) {
  const onDisk = Object.fromEntries(Object.keys(copy.sha256).map(name => [name, readFileSync(join(copy.path, 'workflows', name))]))
  if (!isDeepStrictEqual(workflowHashes(onDisk), copy.sha256)) {
    throw new Error(`Workflow bytes differ from the expected hashes in ${copy.path}. Recreate the scratch plugin.`)
  }
  if (!existsSync(join(copy.path, 'workflows', copy.marker + '.js'))) {
    throw new Error(`Expected marker ${copy.marker} is missing on disk in ${copy.path}`)
  }
}

async function checkFactoryLoad(session, copy, baselineSession, expected, workflowHashes) {
  const loaded = await loadedWorkflows(session, FACTORY_PLUGIN)
  verifyFactoryListing(loaded, copy, baselineSession, expected)
  verifyFactoryCopy(copy, workflowHashes)
  return loaded
}

function inspectFactory(session, call, listing) {
  const dir = sessionDirectory(session.config, call.session)
  return { call, dir, state: stateFor(dir, call.output), terminal: terminalFor(call, session.stream.terminals), listing }
}

const endedFactory = status => status === 'completed' || status === 'failed' || stopped(status)

const factoryCaptureDir = transcript => transcript + '.l2-iv-before'
const readJsonFile = path => JSON.parse(readFileSync(path, 'utf8'))
const writeCapture = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const inputPrompt = input => 'Call Workflow exactly once with this input: ' + JSON.stringify(input) +
  '. Use no other tools. After invoking it, reply "done".'

function manualFactoryInstructions({ options, guard, copy, dir, provenance, root, head, input, gitVariables }) {
  const sessionId = randomUUID()
  const config = options.env.CLAUDE_CONFIG_DIR
  const file = join(dir, 'capture.json')
  writeCapture(file, { config, sessionId, cwd: options.cwd, root, head, copy, provenance, input, guardDir: join(dir, 'guard') })
  const unset = ['CLAUDE_SECURESTORAGE_CONFIG_DIR', ...gitVariables].flatMap(name => ['-u', name])
  const launch = ['env', ...unset, `CLAUDE_CONFIG_DIR=${config}`,
    `PATH=${options.env.PATH}`, 'claude', '--model', 'haiku', ...guard.args.filter((_, index, args) =>
      args[index] !== '--permission-prompts' && args[index - 1] !== '--permission-prompts'),
    '--plugin-dir', copy.path, '--session-id', sessionId].map(quote).join(' ')
  const command = [process.execPath, fileURLToPath(import.meta.url), '--factory', '--capture', file].map(quote).join(' ')
  console.log(`\nManual L2-iv (${copy.mode})
1. Open this isolated interactive session:
   cd ${quote(options.cwd)} && ${launch}
2. In a separate shell run ${command} list. Paste the printed listing prompt into Claude.
3. After the listing, run ${command} start and paste the printed Factory prompt.
4. While the first solve agent is running, run ${command} active. Continue only after it records the transcript.
5. In /workflows, select the whole Factory run and press x. Wait until stopped, then run
   ${command} stopped
   Paste the printed listing prompt into the same Claude session.
6. Run ${command} resume after that listing, paste its printed resume prompt and wait for completion.
7. Use the judging command below after both sessions finish.`)
  return `"$(${command} path)"`
}

function manualTranscriptPath({ config, sessionId }) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid manual session ID')
  const projects = join(config, 'projects')
  const paths = readdirSync(projects).map(project => join(projects, project, sessionId + '.jsonl')).filter(existsSync)
  if (paths.length !== 1) throw new Error('Cannot locate the unique interactive Factory transcript')
  return paths[0]
}

function manualListing(stream, copy, sessionId, expected, after, before) {
  const calls = stream.calls.filter(call => call.session === sessionId && call.line > after && call.resultLine < before &&
    call.input?.name?.startsWith(FACTORY_PLUGIN + ':missing-') && call.error)
  const call = calls.at(-1)
  const names = /not found\. Available: ([^<\n]*)/.exec(call?.text ?? '')?.[1]?.split(',').map(name => name.trim()) ?? []
  verifyFactoryListing({ sessionId: call?.session, names }, copy, sessionId, expected)
  return call
}

const factoryCalls = stream => stream.calls.filter(call => call.input?.name === FACTORY_WORKFLOW && launched(call))

async function captureManualFactory(file, phase) {
  const meta = readJsonFile(file)
  if (phase === 'path') {
    console.log(manualTranscriptPath(meta))
    return 0
  }
  const [{ factoryWorkflowGuard }, { factoryCancelBoundary, judgeFirstLeg, snapshotRunDirectory },
    { fixtureEnvironment, fixtureVerify }, { workflowHashes }, { EXPECTED }] = await Promise.all([
    import('./factory-workflow-guard.mjs'), import('./factory-evidence.mjs'), import('./factory-fixture.mjs'),
    import('./candidate.mjs'), import('./loader-check.mjs'),
  ])
  const { config, root, cwd, head, copy, input, sessionId } = meta
  if (!isDeepStrictEqual(input, { name: FACTORY_WORKFLOW, args: factoryArgs('L2-iv', fixtureVerify) })) {
    throw new Error('Manual capture has unexpected Factory arguments')
  }
  const env = fixtureEnvironment(scratchEnv(factoryConfig(config, root), true))
  env.PATH = join(copy.path, 'bin') + delimiter + env.PATH
  verifyFactoryCopy(copy, workflowHashes)
  if (['list', 'start', 'resume'].includes(phase)) {
    if (installedPlugins({ cwd, env }).length) throw new Error('Manual Factory needs an empty scratch plugin inventory')
    factoryPreflight(copy, { cwd, env })
    if (claudeCommand(['--version'], { cwd, env }) !== meta.provenance.cli) throw new Error('Claude CLI changed since manual setup')
  }
  const guard = factoryWorkflowGuard(join(dirname(file), 'guard'), { existing: true })
  const permit = request => { guard.permit(request); console.log(inputPrompt(request)) }
  // A listing probe never reaches the guard (see isListingProbe), so it needs no permit.
  const newListing = () => console.log(inputPrompt({ name: `${FACTORY_PLUGIN}:missing-${randomUUID()}` }))
  if (phase === 'list') {
    newListing()
    return 0
  }
  const transcript = manualTranscriptPath(meta)
  const text = readFileSync(transcript, 'utf8')
  const stream = parseStream(text)
  const [original, extra] = factoryCalls(stream)
  const capture = factoryCaptureDir(transcript)
  const dir = transcript.slice(0, -extname(transcript).length)
  switch (phase) {
    case 'start':
      if (original) throw new Error('The interactive Factory leg has already started')
      manualListing(stream, copy, sessionId, EXPECTED, 0, Infinity)
      guard.clear()
      permit(input)
      break
    case 'active': {
      if (!original || extra || !isDeepStrictEqual(original.input, input) || original.session !== sessionId ||
          terminalFor(original, stream.terminals) || endedFactory(stateFor(dir, original.output)?.status)) {
        throw new Error('The original Factory invocation is not running')
      }
      guard.verify(original)
      const rows = sessionJournal(dir, true)
      const active = activeFactoryAgent(dir, rows, factoryCancelBoundary)
      if (!active) throw new Error('First post-setup agent transcript is not active. Retry before canceling.')
      mkdirSync(capture, { mode: 0o700 })
      writeFileSync(join(capture, 'active-agent.jsonl'), active.transcript, { flag: 'wx', mode: 0o600 })
      writeCapture(join(capture, 'active.json'), { rows, taskId: original.output.taskId })
      console.log('Captured the active Factory agent. Cancel the parent now.')
      break
    }
    case 'stopped': {
      if (!original || extra || !text.endsWith('\n')) throw new Error('Wait for the stopped session transcript before resuming')
      const state = stateFor(dir, original.output)
      const terminal = terminalFor(original, stream.terminals)
      const rows = sessionJournal(dir)
      const active = readJsonFile(join(capture, 'active.json'))
      const boundary = factoryCancelBoundary(active.rows)
      if (!boundary || active.taskId !== original.output.taskId || !journalGrowth(active.rows, rows) ||
          !statSync(join(capture, 'active-agent.jsonl')).size) throw new Error('Missing active Factory attempt evidence')
      const directory = snapshotRunDirectory(boundary.runDir, { repo: cwd, head })
      const first = judgeFirstLeg('L2-iv', { call: original, state, terminal, rows, directory,
        active: { start: boundary.start, transcript: true } })
      if (first.status !== 'pass') throw new Error(first.reason)
      writeFileSync(join(capture, 'session.jsonl'), text, { flag: 'wx', mode: 0o600 })
      writeCapture(join(capture, 'stopped.json'), { meta, state, rows, directory })
      guard.clear()
      newListing()
      break
    }
    case 'resume': {
      const prefix = readFileSync(join(capture, 'session.jsonl'), 'utf8')
      if (!original || extra || !text.startsWith(prefix)) throw new Error('Missing original stopped Factory transcript')
      manualListing(stream, copy, sessionId, EXPECTED, prefix.split('\n').length - 1, Infinity)
      guard.clear()
      permit({ ...input, resumeFromRunId: original.output.runId })
      break
    }
    default:
      throw new Error('Factory capture phase must be list, start, active, stopped, resume or path')
  }
  return 0
}

async function judgeManualFactory(transcript, mode, provenance) {
  const [{ factoryCancelBoundary, judgeFirstLeg, judgeResume, snapshotRunDirectory },
    { fixtureVerify }, { workflowHashes }, { EXPECTED }, { factoryWorkflowGuard }] = await Promise.all([
    import('./factory-evidence.mjs'), import('./factory-fixture.mjs'), import('./candidate.mjs'),
    import('./loader-check.mjs'), import('./factory-workflow-guard.mjs'),
  ])
  const capture = factoryCaptureDir(transcript)
  const { meta, state, rows, directory } = readJsonFile(join(capture, 'stopped.json'))
  const { copy, input, sessionId, cwd, head, guardDir } = meta
  const args = factoryArgs('L2-iv', fixtureVerify)
  if (!isDeepStrictEqual(meta.provenance, provenance) || copy.mode !== mode ||
      !isDeepStrictEqual(copy.sha256, provenance.sha256[mode]) ||
      copy.marker !== `candidate-${copy.sha256['factory.js'].slice(0, 12)}`) {
    throw new Error(`Stale ${mode} cancellation provenance; use captures from this live verdict`)
  }
  verifyFactoryCopy(copy, workflowHashes)
  if (realpathSync(transcript) !== realpathSync(manualTranscriptPath(meta))) throw new Error('Transcript is outside its recorded scratch session')
  const text = readFileSync(transcript, 'utf8')
  const prefix = readFileSync(join(capture, 'session.jsonl'), 'utf8')
  if (!prefix.trim() || !prefix.endsWith('\n') || !text.startsWith(prefix)) {
    throw new Error('Stopped capture does not match the transcript prefix')
  }
  const stream = parseStream(text)
  const [original, resumed, extra] = factoryCalls(stream)
  const stopLine = prefix.split('\n').length - 1
  if (extra || !original || !resumed || original.session !== sessionId || original.resultLine > stopLine ||
      resumed.line <= stopLine || !isDeepStrictEqual(input, { name: FACTORY_WORKFLOW, args }) ||
      !isDeepStrictEqual(original.input, input)) throw new Error('Expected one pinned Factory launch and resume around the stopped capture')
  manualListing(stream, copy, sessionId, EXPECTED, 0, original.line)
  manualListing(stream, copy, sessionId, EXPECTED, stopLine, resumed.line)
  factoryWorkflowGuard(guardDir, { existing: true }).verify(resumed)
  const active = readJsonFile(join(capture, 'active.json'))
  const boundary = factoryCancelBoundary(active.rows)
  if (!boundary || active.taskId !== original.output.taskId || !journalGrowth(active.rows, rows) ||
      !lstatSync(join(capture, 'active-agent.jsonl')).isFile() || !statSync(join(capture, 'active-agent.jsonl')).size) {
    throw new Error('Missing active agent capture before the parent stopped')
  }
  const terminal = terminalFor(original, stream.terminals)
  if (terminal && terminal.line > stopLine) throw new Error('Factory stopped after the saved boundary')
  const first = { call: original, terminal, state, rows, directory, active: { start: boundary.start, transcript: true } }
  const firstCheck = judgeFirstLeg('L2-iv', first)
  if (firstCheck.status !== 'pass') return { first: firstCheck }
  const dir = transcript.slice(0, -extname(transcript).length)
  const afterState = stateFor(dir, resumed.output)
  const afterTerminal = terminalFor(resumed, stream.terminals)
  const result = factoryResultFor(resumed, afterState, afterTerminal)
  if (!result) throw new Error('Missing completed Factory resume result')
  const after = { call: resumed, state: afterState, terminal: afterTerminal, rows: sessionJournal(dir),
    directory: snapshotRunDirectory(result.runDir, { repo: cwd, head }) }
  return { first: firstCheck, resume: judgeResume('L2-iv', first, after), repo: directory.repo, head: directory.head,
    session: sessionId }
}

async function manualFactory(argv) {
  const options = {}
  if (argv[0] !== 'L2-iv') throw new Error('Specify --manual L2-iv for Factory cancellation')
  for (let index = 1; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2)
    if (!['--control', '--candidate', '--verdict'].includes(flag) || Object.hasOwn(options, flag)) throw new Error(`Unexpected option ${flag}`)
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    options[flag] = value
  }
  if (!options['--control'] || !options['--candidate']) throw new Error('Manual L2-iv requires both --control and --candidate transcripts')
  const file = options['--verdict'] ?? VERDICT
  const { l2 } = readJsonFile(file)
  const provenance = l2?.checks?.['L2-iv']?.provenance
  const { workflowBytes, workflowHashes } = await import('./candidate.mjs')
  const current = await handoffProtocol(REPO)
  const currentHashes = { inline: workflowHashes(workflowBytes('inline')), candidate: workflowHashes(workflowBytes()) }
  if (!provenance || l2.cli !== provenance.cli || current.protocol !== l2.protocol || current.nameForm !== l2.nameForm ||
      l2.protocol !== provenance.protocol || l2.nameForm !== provenance.nameForm ||
      !isDeepStrictEqual(provenance.sha256, currentHashes) || !isDeepStrictEqual(l2.sha256, currentHashes.candidate)) {
    throw new Error('Run the live Factory checker on the current builds before recording manual L2-iv')
  }
  let check
  try {
    const control = await judgeManualFactory(options['--control'], 'inline', provenance)
    const candidate = await judgeManualFactory(options['--candidate'], 'candidate', provenance)
    const { compareLegs } = await import('./factory-evidence.mjs')
    if (control.resume?.status === 'pass' && candidate.resume?.status === 'pass' &&
        (control.repo === candidate.repo || control.session === candidate.session || control.head !== candidate.head)) {
      throw new Error('Manual Factory legs must use distinct fixtures and sessions at the same seed HEAD')
    }
    check = compareLegs(control, candidate)
  } catch (error) {
    check = { status: 'fail', reason: error.message }
  }
  updateVerdict(file, previous => {
    if (!isDeepStrictEqual(previous.l2, l2) || previous.l1?.nameForm !== current.nameForm) {
      throw new Error('Factory verdict changed during manual verification; rerun the command')
    }
    return { ...previous, l2: { ...l2, checks: { ...l2.checks, 'L2-iv': { ...check, mode: 'manual', provenance } } } }
  })
  console.log(`L2-iv: ${check.status}${check.reason ? ` (${check.reason})` : ''}`)
  if (check.differences) console.log(JSON.stringify(check.differences))
  if (check.status !== 'pass') return 1
  // A passing L2-iv does not complete an l2 whose other checks have not passed.
  const checks = { ...l2.checks, 'L2-iv': check }
  const incomplete = L2_REQUIRED.filter(id => checks[id]?.status !== 'pass').map(id => `${id} ${checks[id]?.status ?? 'missing'}`)
  if (incomplete.length) {
    console.error(`l2 is not complete: ${incomplete.join(', ')}`)
    return 1
  }
  return 0
}

// A Workflow refusal or a failed request after the preconditions pass is evidence for the judge,
// not a fatal error: it leaves the scenario without its stop. A guard failure stays fatal.
async function launchFactory(session, input, listing) {
  try {
    const call = await session.invoke(input)
    if (launched(call) && call.session === listing.sessionId) return { call }
    return { call, observationError: `Factory did not launch in the checked session: ${call.text || 'no task'}` }
  } catch (error) {
    if (/guard receipt/.test(error.message)) throw error
    return { call: null, observationError: `Factory did not launch: ${error.message}` }
  }
}

async function observeFactory(session, input, listing, call) {
  if (!call) {
    const launch = await launchFactory(session, input, listing)
    if (launch.observationError) return launch
    call = launch.call
  } else if (!launched(call) || call.session !== listing.sessionId) {
    return { call, observationError: `Factory did not launch in the checked session: ${call.text || 'no task'}` }
  }
  try {
    return await session.waitFor(() => {
      const snapshot = inspectFactory(session, call, listing)
      const { dir, state, terminal } = snapshot
      if ((terminal && terminal.status !== 'completed') || (endedFactory(state?.status) && state.status !== 'completed')) {
        return { ...snapshot, observationError: state?.error ?? `Native Factory task ended with status ${terminal?.status ?? state.status}` }
      }
      if (state?.status !== 'completed') return null
      const result = factoryResultFor(call, state, terminal)
      return result && { ...snapshot, result, rows: sessionJournal(dir) }
    }, 'waiting for the native Factory result', FACTORY_DEADLINE_MS)
  } catch (error) {
    return { ...inspectFactory(session, call, listing), observationError: error.message }
  }
}

function activeFactoryAgent(dir, rows, factoryCancelBoundary) {
  const active = factoryCancelBoundary(rows)
  if (!active || !/^[A-Za-z0-9_-]+$/.test(active.start.agentId)) return null
  const file = join(dir, active.start.directory, `agent-${active.start.agentId}.jsonl`)
  if (!existsSync(file) || !lstatSync(file).isFile()) return null
  const transcript = readFileSync(file)
  return transcript.length ? { ...active, transcript } : null
}

async function stopFactory(session, call, listing, factoryCancelBoundary, saveActive, captureDirectory) {
  const active = await session.waitFor(() => {
    const snapshot = inspectFactory(session, call, listing)
    if (endedFactory(snapshot.state?.status) || snapshot.terminal) return { missed: true }
    if (!snapshot.dir) return null
    const rows = sessionJournal(snapshot.dir, true)
    const active = activeFactoryAgent(snapshot.dir, rows, factoryCancelBoundary)
    if (!active) return null
    saveActive(active)
    return active
  }, 'waiting for the first post-setup Factory agent', FACTORY_DEADLINE_MS)
  if (active.missed) return { observationError: 'Factory ended before the first post-setup agent could be canceled', call }
  const response = await session.control({ subtype: 'stop_task', task_id: call.output.taskId })
  if (response.subtype === 'error' && /stop_task.*(?:not supported|unavailable)/i.test(response.error ?? '')) {
    return { unsupported: true, observationError: response.error, call }
  }
  if (response.subtype !== 'success') {
    const snapshot = inspectFactory(session, call, listing)
    return { ...snapshot, observationError: response.error || 'Claude refused stop_task' }
  }
  return session.waitFor(() => {
    const snapshot = inspectFactory(session, call, listing)
    if ([snapshot.state?.status, snapshot.terminal?.status].some(status => status === 'completed' || status === 'failed')) {
      return { ...snapshot, observationError: 'Factory ended before cancellation took effect' }
    }
    if (!stopped(snapshot.state?.status)) return null
    return captureDirectory({
      ...snapshot, active: { start: active.start, transcript: true }, rows: sessionJournal(snapshot.dir),
    }, active.runDir)
  }, 'waiting for the stopped Factory task', 30_000)
}

async function liveFactory(configDir, file) {
  const [{ createPluginCopy, replacePluginWorkflows, scratchBase, workflowBytes, workflowHashes },
    { compareLegs, factoryCancelBoundary, judgeFirstLeg, judgeResume, snapshotRunDirectory },
    { fixtureEnvironment, fixtureSeed, fixtureVerify, GIT_REPO_ENV }, { factoryWorkflowGuard }, { EXPECTED }] = await Promise.all([
    import('./candidate.mjs'), import('./factory-evidence.mjs'), import('./factory-fixture.mjs'),
    import('./factory-workflow-guard.mjs'), import('./loader-check.mjs'),
  ])
  const root = mkdtempSync(join(scratchBase(), 'df-factory-check-'))
  console.log(`Factory artifacts: ${root}`)
  const config = factoryConfig(configDir, root)
  const env = fixtureEnvironment(scratchEnv(config, true))
  const options = { cwd: root, env }
  if (installedPlugins(options).length) throw new Error('Factory needs an empty scratch plugin inventory. Use a configuration without installed plugins.')
  const cli = claudeCommand(['--version'], options)
  const { protocol, nameForm } = await handoffProtocol(REPO)
  if (!nameForm || json(readFileSync(file, 'utf8'))?.l1?.nameForm !== nameForm) {
    throw new Error('Use an L1 verdict whose child workflow name form matches the candidate')
  }
  const bytes = { inline: workflowBytes('inline'), candidate: workflowBytes() }
  const fixture = fixtureSeed(root, env)
  const checks = {}
  let started = false
  const provenance = { cli, protocol, nameForm, sha256: {
    inline: workflowHashes(bytes.inline), candidate: workflowHashes(bytes.candidate),
  } }

  function prepare(id, mode, tag = id) {
    const dir = join(root, `${tag}-${mode}`)
    mkdirSync(dir)
    const cwd = fixture.clone(join(dir, 'repo'))
    const copy = createPluginCopy(mode, bytes[mode])
    const legEnv = { ...env, PATH: join(copy.path, 'bin') + delimiter + env.PATH }
    const options = { cwd, env: legEnv, plugin: copy.path, artifacts: dir }
    const guard = factoryWorkflowGuard(join(dir, 'guard'))
    return { options, guard, copy, dir }
  }

  async function leg(id, mode) {
    const { options, guard, dir, copy: initialCopy } = prepare(id, mode)
    const { cwd } = options
    let copy = initialCopy
    const scenario = id === 'L3' ? 'L2-ii' : id
    const args = factoryArgs(id, fixtureVerify)
    const input = { name: FACTORY_WORKFLOW, args }
    return inSession({ ...options, guard }, async session => {
      const precondition = async expectedSession => {
        factoryConfig(configDir, root)
        if (installedPlugins(options).length) throw new Error('Factory needs an empty scratch plugin inventory. Remove installed scratch plugins.')
        factoryPreflight(copy, options)
        return checkFactoryLoad(session, copy, expectedSession, EXPECTED, workflowHashes)
      }
      const captureDirectory = (snapshot, runDir = snapshot.result?.runDir) => {
        if (runDir) {
          try {
            snapshot.directory = snapshotRunDirectory(runDir, { repo: cwd, head: fixture.head })
          } catch (error) {
            snapshot.directoryError = error.message
          }
        }
        return snapshot
      }
      const save = (phase, snapshot) => {
        writeFileSync(join(dir, `${phase}.json`), JSON.stringify({ ...snapshot, copy }, null, 2) + '\n')
        return snapshot
      }
      const listing = await precondition()
      started = true
      let initial
      if (id === 'L2-iv') {
        const launch = await launchFactory(session, input, listing)
        const { call } = launch
        if (launch.observationError) initial = launch
        else {
          try {
            initial = await stopFactory(session, call, listing, factoryCancelBoundary,
              active => writeFileSync(join(dir, 'active-agent.jsonl'), active.transcript), captureDirectory)
          } catch (error) {
            initial = { ...inspectFactory(session, call, listing), observationError: error.message }
          }
        }
        save('first', initial)
        if (initial.unsupported) return { unsupported: true, reason: initial.observationError }
      } else {
        initial = save('first', captureDirectory(await observeFactory(session, input, listing)))
      }
      const first = judgeFirstLeg(id, initial)
      if (first.status !== 'pass') return { first }
      if (id === 'L2-iv') {
        let resumeListing
        let resumed
        try {
          resumed = await resumeAfterStop({
            invoke: async request => {
              resumeListing = await precondition(initial.call.session)
              return session.invoke(request)
            },
          }, input, initial.call, 30_000, (_, request, call) => observeFactory(session, request, resumeListing, call))
        } catch (error) {
          resumed = { observationError: error.message }
        }
        save('resume', captureDirectory(resumed))
        return { first, resume: judgeResume(id, initial, resumed) }
      }
      if (id === 'L3') {
        copy = replacePluginWorkflows(copy, bytes.candidate)
        session.sendUser('/reload-plugins')
      }
      const answer = FACTORY_ANSWERS[scenario]
      const resumedArgs = answer ? {
        ...args, clarifications: initial.result.questions.map(({ id }) => ({ id, ...answer })),
      } : args
      const resumeListing = await precondition(initial.call.session)
      const resumed = save('resume', captureDirectory(await observeFactory(session, {
        name: FACTORY_WORKFLOW, args: resumedArgs, resumeFromRunId: initial.call.output.runId,
      }, resumeListing)))
      return { first, resume: judgeResume(id, initial, resumed) }
    })
  }

  // A failure before any Factory launch leaves no verdict. One at a resume or a later leg (a
  // precondition that no longer holds) writes the checks finished so far, fails the check in
  // progress, leaves the rest pending and exits nonzero.
  const inline = {}
  let current, halted = null
  try {
    for (const id of Object.keys(FACTORY_ARGS)) {
      current = id
      inline[id] = await leg(id, 'inline')
      checks[id] = compareLegs(inline[id], await leg(id, 'candidate'))
    }
    // L3's first stop and L2-ii's are independent inline runs: each is judged on its own, and only
    // the upgraded resume's protocol is compared with the control's.
    current = 'L3'
    checks.L3 = compareLegs(inline['L2-ii'], await leg('L3', 'inline'), { phases: ['resume'] })
    current = 'L2-iv'
    const control = await leg('L2-iv', 'inline')
    const candidate = control.unsupported ? null : await leg('L2-iv', 'candidate')
    const unsupported = control.unsupported ? control : candidate?.unsupported ? candidate : null
    checks['L2-iv'] = unsupported && (control.unsupported || (control.first?.status === 'pass' && control.resume?.status === 'pass'))
      ? { status: 'pending', reason: unsupported.reason }
      : compareLegs(control, candidate)
  } catch (error) {
    if (!started) throw error
    halted = error
    checks[current] = { status: 'fail', reason: `Stopped: ${error.message}` }
    for (const id of L2_REQUIRED) checks[id] ??= { status: 'pending', reason: `Not run: the live check stopped at ${current}` }
  }
  const { l2 } = await writeFactoryVerdict(file, { cli, checks, sha256: provenance.sha256.candidate, inlineSha256: provenance.sha256.inline })
  if (!halted && l2.checks['L2-iv'].status === 'pending') {
    const captures = ['inline', 'candidate'].map(mode => {
      const { options, guard, copy, dir } = prepare('L2-iv', mode, 'manual')
      return manualFactoryInstructions({ options, guard, copy, dir, provenance, root, head: fixture.head, gitVariables: GIT_REPO_ENV, input: {
        name: FACTORY_WORKFLOW, args: factoryArgs('L2-iv', fixtureVerify),
      } })
    })
    const judge = [process.execPath, fileURLToPath(import.meta.url), '--factory', '--manual', 'L2-iv'].map(quote).join(' ')
    console.log(`${judge} --control ${captures[0]} --candidate ${captures[1]} --verdict ${quote(resolve(file))}`)
  }
  for (const id of L2_REQUIRED) {
    const { status, reason, differences } = l2.checks[id]
    console.log(`${id}: ${status}${reason ? ` (${reason})` : ''}`)
    if (differences) console.log(JSON.stringify(differences))
  }
  if (halted) {
    console.error(halted.message)
    return 1
  }
  return factoryExitCode(l2.checks)
}

async function main(argv) {
  const factory = argv[0] === '--factory'
  if (factory) argv = argv.slice(1)
  if (factory && argv[0] === '--manual') return manualFactory(argv.slice(1))
  if (factory && argv[0] === '--capture') {
    if (argv.length !== 3) throw new Error('Usage: --factory --capture FILE PHASE')
    return captureManualFactory(argv[1], argv[2])
  }
  if (argv[0] !== '--manual') {
    let config, file = VERDICT
    for (let index = 0; index < argv.length; index += 2) {
      const [flag, value] = argv.slice(index, index + 2)
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      if (flag === '--config-dir') config = value
      else if (flag === '--verdict') file = value
      else throw new Error(`Unknown option: ${flag}`)
    }
    return factory ? liveFactory(config, file) : live(config, file)
  }
  const [mode, checkId, flag, transcript, verdictFlag, file, ...rest] = argv
  if (mode !== '--manual' || checkId !== CANCEL || flag !== '--transcript' || !transcript ||
    (argv.length !== 4 && (verdictFlag !== '--verdict' || !file || rest.length > 0))) {
    throw new Error('Usage: node tools/workflow-check.mjs --manual L1-j --transcript <file> [--verdict <path>]')
  }
  const check = parseManualTranscript(transcript)
  writeManualVerdict(file ?? VERDICT, check)
  console.log(`L1-j: ${check.status}${check.reason ? ` (${check.reason})` : ''}`)
  return check.status === 'pass' ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
