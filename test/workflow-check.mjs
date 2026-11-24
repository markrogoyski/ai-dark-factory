import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  L2_REQUIRED, beforeCancelDir, createStreamParser, factoryExitCode, judgeBootThrow, judgeCancel, judgeEnvelope, judgeMeter, judgeReplay,
  parseManualTranscript, parseStream, probeExitCode, probeObservation, resumeAfterStop, scratchEnv, terminalFor, workflowJournal,
  writeVerdict, factoryArgs,
} from '../tools/workflow-check.mjs'
import { factoryResultFor } from '../tools/workflow-evidence.mjs'
import { compareLegs, judgeFirstLeg, judgeResume, snapshotRunDirectory } from '../tools/factory-evidence.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/workflow-check/', import.meta.url))
const tool = fileURLToPath(new URL('../tools/workflow-check.mjs', import.meta.url))
const session = '7f2019be-77a2-4e0e-9a13-5b520bd9293c'
const runId = 'wf_9463a017e43a'
const manualFixture = join(fixtures, 'manual', session + '.jsonl')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const readRows = path => readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
const writeRows = (path, rows) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const passing = { status: 'pass' }

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'workflow-check-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function manualCopy(t) {
  const dir = temporary(t)
  cpSync(join(fixtures, 'manual'), dir, { recursive: true })
  const transcript = join(dir, session + '.jsonl')
  const before = beforeCancelDir(transcript)
  const journal = join('subagents', 'workflows', runId, 'journal.jsonl')
  return {
    transcript, before, stoppedJournal: join(before, journal), resumedJournal: join(dir, session, journal),
    stoppedState: join(before, 'workflows', runId + '.json'),
  }
}

test('stream JSONL correlates Workflow launches and later task completions before judging evidence', () => {
  const text = readFileSync(join(fixtures, 'stream.jsonl'), 'utf8')
  const stream = createStreamParser()
  for (let offset = 0; offset < text.length; offset += 17) stream.push(text.slice(offset, offset + 17))
  stream.push('{"type":')
  stream.finish()
  assert.deepEqual(stream.calls, parseStream(text).calls)
  assert.equal(stream.calls.length, 1)
  const [call] = stream.calls
  assert.equal(call.input.name, 'df-probe:budget')
  assert.equal(call.session, session)
  assert.equal(call.output.runId, 'wf_budget')
  assert.equal(call.output.taskId, 'wf_task3')
  const terminal = terminalFor(call, stream.terminals)
  assert.equal(terminal.status, 'completed')
  assert.ok(terminal.line > stream.results[0].line)
  assert.equal(stream.controls[0].response.request_id, 'stop1')
  const state = readJson(join(fixtures, 'wf_budget.json'))
  const observed = probeObservation(state, 'L1-b3', call.input.args.nonce)
  assert.deepEqual(judgeMeter(observed), { status: 'pass', observed: { p0: 9, c0: 9, c1: 17, p1: 18 } })
  assert.equal(probeObservation(state, 'L1-b3', 'other run'), null)
  assert.deepEqual(probeObservation({
    result: JSON.stringify('DFPROBE ' + JSON.stringify({ probe: 'L1-b3', nonce: 'meter', observed })),
  }, 'L1-b3', 'meter'), observed)
})

test('stream parsing ignores an unpaired result and retains a Workflow error', () => {
  const rows = readRows(join(fixtures, 'stream.jsonl'))
  const use = rows[1]
  const reply = rows[3]
  const unrelated = { ...reply, session_id: 'another-session' }
  unrelated.message = structuredClone(reply.message)
  const errorReply = { type: 'user', session_id: session, message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_budget', is_error: true, content: [{ type: 'text', text: 'unavailable' }] },
  ] } }
  const input = [reply, use, unrelated, errorReply].map(row => JSON.stringify(row)).join('\n')
  const { calls } = parseStream(input)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].error, true)
  assert.equal(calls[0].text, 'unavailable')
  assert.equal(terminalFor(calls[0], []), undefined)
})

test('an event-level result is not attributed to a Workflow among multiple tool results', () => {
  const rows = readRows(join(fixtures, 'stream.jsonl'))
  const reply = rows[3]
  reply.message.content = [
    { type: 'tool_result', tool_use_id: 'another-tool', content: 'unrelated result' },
    { type: 'tool_result', tool_use_id: 'toolu_budget',
      content: 'Workflow launched in background. Task ID: right-task\nRun ID: wf_right' },
  ]
  const { calls } = parseStream([rows[1], reply].map(row => JSON.stringify(row)).join('\n'))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].output, { status: 'async_launched', taskId: 'right-task', runId: 'wf_right' })
})

test('a meter observation needs nonzero parent spend and shared advancing finite counts', () => {
  const valid = { p0: 4, c0: 4, c1: 9, p1: 9 }
  assert.equal(judgeMeter(valid).status, 'pass')
  for (const update of [{ p0: 0, c0: 0 }, { c0: 2 }, { c1: 4 }, { p1: 7 }, { p1: '9' }, { c1: Infinity }]) {
    assert.equal(judgeMeter({ ...valid, ...update }).status, 'fail')
  }
})

test('the envelope needs the expected size, matching hashes and a deep-equal echo', () => {
  const observed = { bytes: 40 * 1024, hash: 42, childHash: 42, echoEqual: true }
  assert.equal(judgeEnvelope(observed).status, 'pass')
  for (const change of [{ bytes: 40000 }, { childHash: 43 }, { echoEqual: false }, { hash: null, childHash: null }]) {
    assert.equal(judgeEnvelope({ ...observed, ...change }).status, 'fail')
  }
})

test('the boot rejection needs the exact error and independent zero-agent evidence', () => {
  const nonce = 'boot'
  const observed = { message: 'df-probe boot ' + nonce }
  assert.equal(judgeBootThrow(observed, nonce, 0, 0).status, 'pass')
  for (const [message, agentCount, journalStarts] of [
    [null, 0, 0], ['wrong reason', 0, 0], [observed.message, 1, 0], [observed.message, 0, 1],
    [observed.message, undefined, 0],
  ]) assert.equal(judgeBootThrow({ message }, nonce, agentCount, journalStarts).status, 'fail')
})

test('d, d2 and i require unchanged cached values and exactly one completed continuation', () => {
  const nonce = 'replay'
  const journal = (position, token) => {
    const attempt = { key: position, agentId: 'agent-' + position, label: 'DFPROBE:' + nonce + ':' + position }
    return [{ ...attempt, type: 'started' }, { ...attempt, type: 'result', result: { token } }]
  }
  for (const [probe, positions, next] of [
    ['L1-d', ['P1', 'C1', 'C2'], 'P2'], ['L1-d2', ['P1', 'C1', 'C2'], 'P2'], ['L1-i', ['X', 'Y', 'Z'], 'NEXT'],
  ]) {
    const original = { tokens: ['one', 'two', 'three'], unused: 'initial' }
    const resumed = { tokens: [...original.tokens, 'four'], unused: 'changed' }
    const before = positions.flatMap((position, index) => journal(position, original.tokens[index]))
    const continuation = journal(next, 'four')
    const check = (observed = resumed, entries = continuation) =>
      judgeReplay(probe, nonce, original, observed, before, [...before, ...entries]).status
    assert.equal(check(), 'pass', probe)
    assert.equal(check({ ...resumed, tokens: ['other', 'two', 'three', 'four'] }), 'fail', probe)
    assert.equal(check({ ...resumed, tokens: [...resumed.tokens, 'unexpected'] }), 'fail', probe)
    assert.equal(check(resumed, []), 'fail', probe)
    assert.equal(check(resumed, continuation.slice(0, 1)), 'fail', probe)
    assert.equal(check(resumed, [...continuation, ...journal('extra', 'irrelevant')]), 'fail', probe)
    if (probe === 'L1-d2') assert.equal(check({ ...resumed, unused: 'initial' }), 'fail')
  }
})

test('distinct sibling results can prove replay in order and expose a swap', () => {
  const nonce = 'siblings'
  const original = { tokens: ['left', 'right'] }
  const before = original.tokens.flatMap((token, index) => {
    const attempt = { key: 'sibling-' + index, agentId: 'agent-' + index, label: 'DFPROBE:' + nonce + ':S' }
    return [{ ...attempt, type: 'started' }, { ...attempt, type: 'result', result: { token } }]
  })
  const same = judgeReplay('L1-g', nonce, original, original, before, before)
  assert.equal(same.status, 'pass')
  assert.deepEqual(same.observed.ordinals, [{ ordinal: 1, replayed: true }, { ordinal: 2, replayed: true }])
  const swapped = judgeReplay('L1-g', nonce, original, { tokens: ['right', 'left'] }, before, before)
  assert.equal(swapped.status, 'fail')
})

test('manual capture proves the active child was stopped and restarted in the original session', () => {
  assert.deepEqual(parseManualTranscript(manualFixture), {
    status: 'pass',
    mode: 'manual',
    observed: {
      session, runId, resumedRunId: runId, interruptedAgentId: 'a-c1-before', restartedAgentId: 'a-c1-after', replayed: ['P1'],
      childJournal: join('subagents', 'workflows', runId), restartJournal: join('subagents', 'workflows', runId),
    },
  })
})

test('manual capture records a completed parent call that ran again', t => {
  const { transcript, resumedJournal } = manualCopy(t)
  const rows = readRows(resumedJournal)
  rows.splice(4, 0, { ...rows[1], agentId: 'a-p1-again' }, { ...rows[2], agentId: 'a-p1-again' })
  writeRows(resumedJournal, rows)
  const check = parseManualTranscript(transcript)
  assert.equal(check.status, 'pass')
  assert.deepEqual(check.observed.replayed, [])
})

test('manual capture uses agent metadata when a journal start lacks its label', t => {
  const { transcript, stoppedJournal, resumedJournal } = manualCopy(t)
  for (const file of [stoppedJournal, resumedJournal]) {
    const rows = readRows(file)
    const child = rows.find(row => row.agentId === 'a-c1-before')
    writeFileSync(join(dirname(file), 'agent-a-c1-before.meta.json'), JSON.stringify({ description: child.label }))
    delete child.label
    writeRows(file, rows)
  }
  assert.equal(parseManualTranscript(transcript).status, 'pass')
})

// Moves the C1 rows of a journal into a sibling child run directory.
function moveChildRows(file, child = 'wf_child') {
  const rows = readRows(file)
  const dir = join(dirname(dirname(file)), child)
  mkdirSync(dir, { recursive: true })
  writeRows(join(dir, 'journal.jsonl'), rows.filter(row => row.key === rows[3].key))
  writeRows(file, rows.filter(row => row.key !== rows[3].key))
}

test('manual capture follows a child journaled under its own run directory', t => {
  const { transcript, stoppedJournal, resumedJournal } = manualCopy(t)
  moveChildRows(stoppedJournal)
  moveChildRows(resumedJournal)
  const check = parseManualTranscript(transcript)
  assert.equal(check.status, 'pass', check.reason)
  assert.equal(check.observed.childJournal, join('subagents', 'workflows', 'wf_child'))
  assert.equal(check.observed.restartJournal, check.observed.childJournal)
})

test('manual capture follows a resumed child into a new run directory', t => {
  const { transcript, resumedJournal } = manualCopy(t)
  const rows = readRows(resumedJournal)
  const later = join(dirname(dirname(resumedJournal)), 'wf_resumed_child')
  mkdirSync(later)
  writeRows(join(later, 'journal.jsonl'), rows.slice(4))
  writeRows(resumedJournal, rows.slice(0, 4))
  const check = parseManualTranscript(transcript)
  assert.equal(check.status, 'pass', check.reason)
  assert.equal(check.observed.restartJournal, join('subagents', 'workflows', 'wf_resumed_child'))
})

function settleOriginalChild(file, status = 'result') {
  const rows = readRows(file)
  const attempt = rows.find(row => row.agentId === 'a-c1-before')
  rows.splice(rows.indexOf(attempt) + 1, 0, { type: status, key: attempt.key, agentId: attempt.agentId, result: 'ended' })
  writeRows(file, rows)
}

const invalidManual = [
  ['C1 completed before the stop', ({ stoppedJournal, resumedJournal }) => {
    settleOriginalChild(stoppedJournal)
    settleOriginalChild(resumedJournal)
  }, /already ended/],
  ['C1 failed before the stop', ({ stoppedJournal }) => settleOriginalChild(stoppedJournal, 'failed'), /already ended/],
  ['no stopped state', ({ stoppedState }) => {
    writeFileSync(stoppedState, JSON.stringify({ ...readJson(stoppedState), status: 'completed' }))
  }, /no stopped state/],
  ['stopped state belongs to another task', ({ stoppedState }) => {
    writeFileSync(stoppedState, JSON.stringify({ ...readJson(stoppedState), taskId: 'wf_other_task' }))
  }, /no stopped state/],
  ['snapshot ends mid-line', ({ before }) => {
    const path = join(before, 'session.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8').slice(0, -2))
  }, /transcript prefix/],
  ['snapshot differs from the transcript', ({ before }) => {
    const path = join(before, 'session.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8').replace('sample', 'edited'))
  }, /transcript prefix/],
  ['no pre-resume snapshot', ({ before }) => rmSync(before, { recursive: true }), /ENOENT/],
  ['no C1 restart', ({ resumedJournal }) => writeRows(resumedJournal, readRows(resumedJournal).slice(0, 4)), /did not restart/],
  ['C1 restarts only in an unrelated workflow', ({ resumedJournal }) => {
    const rows = readRows(resumedJournal)
    const unrelated = join(dirname(dirname(resumedJournal)), 'wf_unrelated')
    mkdirSync(unrelated)
    writeRows(join(unrelated, 'journal.jsonl'), rows.slice(4).map(row =>
      row.label ? { ...row, label: row.label.replace('j-capture', 'other-nonce') } : row))
    writeRows(resumedJournal, rows.slice(0, 4))
  }, /did not restart/],
  ['the resumed journal does not extend the snapshot', ({ resumedJournal }) => {
    const rows = readRows(resumedJournal)
    rows[2].result = 'changed result'
    writeRows(resumedJournal, rows)
  }, /does not follow/],
  ['stopped notification arrives after the resume', ({ transcript }) => {
    writeRows(transcript, [...readRows(transcript), { type: 'system', subtype: 'task_notification',
      session_id: session, task_id: 'wf_task1', status: 'stopped' }])
  }, /terminal event contradicts/],
  ['resume reuses the original task ID', ({ transcript }) => {
    const rows = readRows(transcript)
    rows[3].message.content[0].content = rows[3].message.content[0].content.replace('wf_task2', 'wf_task1')
    writeRows(transcript, rows)
  }, /same args in the same session/],
  ['C1 settled between the snapshot and resume', ({ resumedJournal }) => settleOriginalChild(resumedJournal), /settled after/],
  ['wrong original run ID', ({ transcript }) => {
    const rows = readRows(transcript)
    rows[2].message.content[0].input.resumeFromRunId = 'wf_wrong'
    writeRows(transcript, rows)
  }, /same args in the same session/],
  ['different args', ({ transcript }) => {
    const rows = readRows(transcript)
    rows[2].message.content[0].input.args.options.mode = 'changed'
    writeRows(transcript, rows)
  }, /same args in the same session/],
  ['different session', ({ transcript }) => {
    const rows = readRows(transcript)
    rows[2].sessionId = rows[3].sessionId = 'another-session'
    writeRows(transcript, rows)
  }, /same args in the same session/],
]

for (const [name, change, diagnostic] of invalidManual) {
  test(`manual cancellation fails with ${name}`, t => {
    const fixture = manualCopy(t)
    change(fixture)
    const check = parseManualTranscript(fixture.transcript)
    assert.equal(check.status, 'fail')
    assert.equal(check.mode, 'manual')
    assert.match(check.reason, diagnostic)
  })
}

test('cancellation chronology rejects a stop outside the original invocation and resume', () => {
  const [original, resumed] = parseStream(readFileSync(manualFixture, 'utf8')).calls
  const directory = join('subagents', 'workflows', runId)
  const evidence = {
    original, resumed,
    stop: { status: 'stopped', session, taskId: original.output.taskId, line: original.resultLine },
    before: workflowJournal(beforeCancelDir(manualFixture), runId).map(row => ({ ...row, directory })),
    after: workflowJournal(join(dirname(manualFixture), session), runId).map(row => ({ ...row, directory })),
  }
  assert.equal(judgeCancel(evidence).status, 'pass')
  for (const line of [original.line, resumed.line + 1]) {
    assert.match(judgeCancel({ ...evidence, stop: { ...evidence.stop, line } }).reason, /no correlated workflow stop/)
  }
  assert.match(judgeCancel({ ...evidence, original: { ...original, resultLine: resumed.line } }).reason, /same args in the same session/)
})

const l1 = () => ({
  cli: '2.1.330 (fixture)',
  nameForm: 'qualified',
  checks: Object.fromEntries(['L1-a', 'L1-b1', 'L1-b3', 'L1-c', 'L1-d', 'L1-d2', 'L1-i', 'L1-j'].map(id => [id, passing])),
})

test('verdict writer produces l1 and retains a manual j during an automatic pending result', t => {
  const file = join(temporary(t), 'native-verdict.json')
  const section = l1()
  writeVerdict(file, section)
  assert.deepEqual(readJson(file), { l1: section })

  const manual = parseManualTranscript(manualFixture)
  const l2 = { protocol: 12, checks: { 'L2-i': passing } }
  writeFileSync(file, JSON.stringify({ l1: { ...section, checks: { ...section.checks, 'L1-j': manual } }, l2, note: 'retain' }))
  const pending = { status: 'pending', mode: 'auto' }
  const incoming = { cli: 'new fixture', nameForm: 'bare', checks: { ...section.checks, 'L1-j': pending } }
  writeVerdict(file, incoming)
  assert.deepEqual(readJson(file), { l1: { ...incoming, checks: { ...incoming.checks, 'L1-j': manual } }, l2, note: 'retain' })
  const completed = { status: 'fail', mode: 'auto', reason: 'missed cancellation window' }
  incoming.checks['L1-j'] = completed
  writeVerdict(file, incoming)
  assert.deepEqual(readJson(file), { l1: incoming, l2, note: 'retain' })
  incoming.checks['L1-j'] = pending
  writeVerdict(file, incoming)
  assert.deepEqual(readJson(file).l1.checks['L1-j'], pending)
})

test('manual CLI changes only L1-j in an existing verdict', t => {
  const file = join(temporary(t), 'native-verdict.json')
  const original = { l1: { ...l1(), more: 'retain' }, l2: { protocol: 12 }, note: 'retain' }
  writeFileSync(file, JSON.stringify(original))
  const run = spawnSync(process.execPath, [tool, '--manual', 'L1-j', '--transcript', manualFixture, '--verdict', file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout.trim(), 'L1-j: pass')
  original.l1.checks['L1-j'] = parseManualTranscript(manualFixture)
  assert.deepEqual(readJson(file), original)
})

test('manual CLI requires an existing l1 verdict', t => {
  const file = join(temporary(t), 'native-verdict.json')
  const argv = [tool, '--manual', 'L1-j', '--transcript', manualFixture, '--verdict', file]
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /Run the live probes before recording manual L1-j/)
  assert.equal(existsSync(file), false)
})

test('a nonpassing manual transcript replaces only j and exits nonzero', t => {
  const { transcript, stoppedJournal } = manualCopy(t)
  settleOriginalChild(stoppedJournal)
  const file = join(temporary(t), 'native-verdict.json')
  const original = { l1: l1(), l2: { protocol: 12 } }
  writeFileSync(file, JSON.stringify(original))
  const run = spawnSync(process.execPath, [tool, '--manual', 'L1-j', '--transcript', transcript, '--verdict', file], { encoding: 'utf8' })
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stdout, /L1-j: fail/)
  original.l1.checks['L1-j'] = parseManualTranscript(transcript)
  assert.deepEqual(readJson(file), original)
})

test('live exit uses the current required results and preserves informational status', () => {
  const { checks } = l1()
  assert.equal(probeExitCode(checks), 0)
  assert.equal(probeExitCode(checks, { claudeRan: false }), 1)
  for (const id of ['L1-a', 'L1-b1', 'L1-b3', 'L1-c', 'L1-d', 'L1-d2', 'L1-i']) {
    assert.equal(probeExitCode({ ...checks, [id]: undefined }), 1, id)
    assert.equal(probeExitCode({ ...checks, [id]: { status: 'fail' } }), 1, id)
  }
  for (const id of ['L1-b2', 'L1-e', 'L1-f', 'L1-g', 'L1-h']) {
    assert.equal(probeExitCode({ ...checks, [id]: { status: 'fail' } }), 0, id)
  }
  for (const [status, mode, code] of [['pending', 'auto', 0], ['fail', 'auto', 1], ['pass', 'auto', 0], ['fail', 'manual', 0]]) {
    assert.equal(probeExitCode({ ...checks, 'L1-j': { status, mode } }), code)
  }
})

function stubClaude(t, scenario, { dedicated = false } = {}) {
  const root = realpathSync(temporary(t)), bin = join(root, 'bin')
  const trace = join(root, 'trace.jsonl'), verdict = join(root, 'verdict.json')
  const stub = join(bin, 'claude')
  mkdirSync(bin)
  cpSync(join(fixtures, 'claude-stub.mjs'), stub)
  chmodSync(stub, 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, DF_PROBE_TRACE: trace,
    DF_PROBE_SCENARIO: scenario, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/inherited-identity' }
  const config = join(root, 'dedicated')
  const args = ['--verdict', verdict]
  if (dedicated) {
    mkdirSync(config)
    args.push('--config-dir', config)
  }
  return { root, trace, verdict, env, config, args }
}

function runStub(t, scenario, options = {}) {
  const fixture = stubClaude(t, scenario, options)
  const run = spawnSync(process.execPath, [tool, ...fixture.args], { env: fixture.env, encoding: 'utf8', timeout: 20_000 })
  assert.equal(run.error, undefined)
  assert.equal(run.status, options.exitCode ?? 0, run.stdout + run.stderr)
  return { ...fixture, run, rows: readRows(fixture.trace), l1: readJson(fixture.verdict).l1 }
}

test('scratch auth preserves credentials while keeping generated and dedicated identities separate', () => {
  const env = { ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/old', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/old-login' }
  assert.deepEqual(scratchEnv('/scratch', false, env), {
    ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/scratch', CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
  })
  assert.deepEqual(scratchEnv('/dedicated', true, env), {
    ANTHROPIC_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: '/dedicated',
  })
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/old-login')
})

test('importing the workflow tool does not launch Claude', t => {
  const { trace, env } = stubClaude(t, '')
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify(new URL('../tools/workflow-check.mjs', import.meta.url).href)}`],
    { env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(trace), false)
})

test('isolated L1-a through h exercise generated scripts and judge native-shaped artifacts', t => {
  const { root, rows, l1: section } = runStub(t, '')
  assert.equal(section.cli, '2.1.330 (Claude fixture)')
  assert.equal(section.nameForm, 'qualified')
  const { checks } = section
  for (const id of ['a', 'b1', 'b2', 'b3', 'c', 'd', 'd2', 'e', 'f', 'h']) {
    assert.equal(checks['L1-' + id].status, 'pass', JSON.stringify(checks['L1-' + id]))
  }
  assert.deepEqual(checks['L1-b3'].observed, { p0: 10, c0: 10, c1: 20, p1: 20 })
  assert.equal(checks['L1-b1'].observed.bytes, 40960)
  assert.equal(checks['L1-b2'].observed.mutation, 'copy')
  assert.equal(checks['L1-c'].observed.agentCount, 0)
  assert.equal(checks['L1-c'].observed.journalStarts, 0)
  assert.match(checks['L1-e'].observed.child, /^projects\/scratch\//)
  assert.equal(checks['L1-e'].observed.parent, checks['L1-e'].observed.child)
  assert.equal(checks['L1-g'].observed.ambiguous, true)
  assert.equal(checks['L1-g'].status, 'fail')
  assert.match(checks['L1-g'].reason, /inconclusive/)
  assert.deepEqual(checks['L1-g'].observed.ordinals, [{ ordinal: 1, replayed: false }, { ordinal: 2, replayed: false }])
  assert.deepEqual(checks['L1-h'].observed, { installed: false, sideload: true })

  const headless = rows.filter(row => row.argv?.[0] === '-p')
  for (const row of headless) {
    assert.ok(row.config.startsWith(root + '/df-workflow-check-'))
    assert.ok(row.cwd.startsWith(root + '/df-workflow-check-'))
    assert.equal(row.secure, '')
    const plugin = row.argv[row.argv.indexOf('--plugin-dir') + 1]
    assert.ok(plugin.startsWith(root + '/df-workflow-check-'))
    assert.equal(readJson(join(plugin, '.claude-plugin/plugin.json')).name, 'df-probe')
  }
  const install = rows.find(row => row.argv?.[1] === 'install')
  const shadow = headless.find(row => row.config === install.config)
  assert.deepEqual(install.argv, ['plugin', 'install', 'df-probe@df-probe-local'])
  assert.equal(install.config, shadow.config)
  assert.notEqual(install.config, headless[0].config)

  for (const id of ['L1-d', 'L1-d2', 'L1-f', 'L1-g']) {
    const [first, second] = rows.filter(row => row.input?.args?.probe === id)
    assert.equal(first.session, second.session)
    assert.match(second.input.resumeFromRunId, /^wf_/)
    const requests = rows.filter(row => row.agent?.probe === id).map(row => row.agent.request)
    const copies = id === 'L1-g' ? 2 : 3
    const stable = id === 'L1-f' ? 2 : copies
    assert.deepEqual(requests.slice(0, stable), requests.slice(copies, copies + stable))
    if (id === 'L1-f') assert.notEqual(requests[2], requests[5])
    if (id === 'L1-g') assert.equal(requests[0], requests[1])
    if (id === 'L1-d2') assert.deepEqual([first.input.args.unused, second.input.args.unused], ['initial', 'changed'])
  }
})

test('replay judges reject fresh attempts even when agent tokens match', t => {
  const { l1: section } = runStub(t, 'same-token-rerun', { exitCode: 1 })
  for (const id of ['L1-d', 'L1-d2', 'L1-f', 'L1-g']) {
    const check = section.checks[id]
    assert.equal(check.status, 'fail', id)
    assert.ok(check.observed.newStarts.length > 0)
  }
})

test('a dedicated configuration uses its own login and bare child names when required', t => {
  const { config, rows, l1: section } = runStub(t, 'bare', { dedicated: true })
  assert.equal(section.nameForm, 'bare')
  assert.equal(section.checks['L1-d2'].status, 'pass')
  assert.notEqual(section.checks['L1-e'].observed.parent, section.checks['L1-e'].observed.child)
  const cancel = section.checks['L1-j']
  assert.equal(cancel.status, 'pass', cancel.reason)
  assert.equal(cancel.observed.childJournal, join('subagents', 'workflows', 'wf_child'))
  assert.equal(cancel.observed.restartJournal, cancel.observed.childJournal)
  for (const row of rows.filter(row => row.config === config)) assert.equal(row.secure, undefined)
  for (const row of rows.filter(row => row.input?.args?.child)) assert.equal(row.input.args.child, 'child')
})

test('qualified wins when both forms resolve and incomplete transcript locations fail L1-e', t => {
  const { l1: section } = runStub(t, 'both-names-no-child-transcript')
  assert.equal(section.nameForm, 'qualified')
  assert.deepEqual(section.checks['L1-a'].observed, { qualified: { resolved: true }, bare: { resolved: true } })
  assert.equal(section.checks['L1-e'].status, 'fail')
  assert.match(section.checks['L1-e'].observed.parent, /^projects\//)
  assert.equal(section.checks['L1-e'].observed.child, undefined)
})

test('the dedicated config cannot be the default config, checkout, or parent of the probe root', t => {
  const { env, trace, root, args, verdict } = stubClaude(t, '')
  const defaultConfig = join(homedir(), '.claude')
  const checkout = fileURLToPath(new URL('../', import.meta.url))
  for (const config of [defaultConfig, checkout, join(checkout, 'tools'), dirname(realpathSync(checkout)), root]) {
    const run = spawnSync(process.execPath, [tool, ...args, '--config-dir', config], { env, encoding: 'utf8' })
    assert.equal(run.status, 1, run.stdout + run.stderr)
    assert.equal(existsSync(trace), false, config)
    if (existsSync(config)) assert.match(readJson(verdict).l1.checks['L1-a'].reason, /must be a dedicated Claude configuration/)
  }
})

test('shadow probe records when both plugin copies appear', t => {
  const { l1: section } = runStub(t, 'coexist')
  assert.equal(section.checks['L1-h'].status, 'fail')
  assert.deepEqual(section.checks['L1-h'].observed, { installed: true, sideload: true })
})

test('failed name discovery records null and skips dependent probes', t => {
  const { l1: section } = runStub(t, 'unresolved', { exitCode: 1 })
  assert.equal(section.nameForm, null)
  assert.equal(section.checks['L1-a'].status, 'fail')
  assert.equal(section.checks['L1-d'].status, 'skipped')
  assert.equal(section.checks['L1-h'].status, 'pass')
})

test('foreign plugin preflight avoids all headless launches', t => {
  const { rows, l1: section } = runStub(t, 'foreign', { exitCode: 1 })
  assert.equal(rows.some(row => row.argv?.includes('--plugin-dir')), false)
  assert.match(section.checks['L1-a'].reason, /foreign enabled plugin/)
})

test('an authentication failure points to credential and isolated config remedies', t => {
  const { l1: section, rows } = runStub(t, 'auth', { exitCode: 1 })
  assert.equal(rows.filter(row => row.input).length, 1)
  assert.match(section.checks['L1-a'].reason, /Not logged in.*credential environment.*--config-dir.*default macOS Keychain/)
})

test('upgrade verifies the v2 marker after reload and replays the original inline requests', t => {
  const { rows, l1: section } = runStub(t, '')
  assert.deepEqual(section.checks['L1-i'].observed.positions, ['X', 'Y', 'Z'].map(position => ({ position, replayed: true })))
  const original = rows.findIndex(row => row.input?.args?.probe === 'L1-i')
  const { session } = rows[original]
  const reload = rows.findIndex(row => row.session === session && row.command === '/reload-plugins')
  const marker = rows.findIndex(row => row.session === session && row.input?.name.startsWith('df-probe:missing-'))
  const resumed = rows.findIndex(row => row.session === session && row.input?.resumeFromRunId)
  assert.ok(original < reload && reload < marker && marker < resumed)
  const requests = rows.filter(row => row.agent?.probe === 'L1-i').map(row => row.agent.request)
  assert.deepEqual(requests.slice(0, 3), requests.slice(3, 6))
  assert.equal(requests.length, 7)
})

test('automatic cancellation retries a missed window and resumes with the original args', t => {
  const { rows, l1: section } = runStub(t, 'retry')
  const check = section.checks['L1-j']
  assert.equal(check.status, 'pass')
  assert.equal(check.mode, 'auto')
  assert.deepEqual(check.observed.replayed, ['P1'])
  assert.notEqual(check.observed.interruptedAgentId, check.observed.restartedAgentId)
  const launches = rows.filter(row => row.input?.args?.probe === 'L1-j' && !row.input.resumeFromRunId)
  assert.deepEqual(launches.map(row => row.input.args.words), [250, 500])
  assert.notEqual(launches[0].session, launches[1].session)
  const stop = rows.findIndex(row => row.request?.subtype === 'stop_task')
  const resumed = rows.findIndex(row => row.input?.args?.probe === 'L1-j' && row.input.resumeFromRunId)
  assert.ok(rows.indexOf(launches[1]) < stop && stop < resumed)
  assert.equal(rows[stop].request.task_id, 'task-1')
  assert.equal(rows[stop].session, rows[resumed].session)
  assert.deepEqual(rows[resumed].input.args, launches[1].input.args)
})

test('a teardown refusal retries the same cancel resume without starting a new attempt', t => {
  const { rows, l1: section } = runStub(t, 'early-refusal')
  assert.equal(section.checks['L1-j'].status, 'pass')
  const refused = rows.filter(row => row.resumeRefused)
  assert.ok(refused.length > 0)
  const requests = rows.filter(row => !row.resumeRefused && row.input?.args?.probe === 'L1-j')
  assert.equal(requests.filter(row => !row.input.resumeFromRunId).length, 1)
  for (const row of refused) {
    assert.equal(row.session, requests[0].session)
    assert.deepEqual(row.input, requests.at(-1).input)
    assert.deepEqual(row.input.args, requests[0].input.args)
  }
})

const cancelResume = { name: 'df-probe:cancel', args: { probe: 'L1-j', nonce: 'n' } }

// A session double whose resume requests answer from replies, each after its delay.
function resumeSession(replies) {
  const original = { session: 's1', output: { status: 'async_launched', taskId: 'task-1', runId: 'wf_original' } }
  const refusal = { session: 's1', error: true, text: 'Workflow wf_original is paused but its run has not exited yet (task task-1).' }
  const launch = { session: 's1', error: false, text: '', output: { status: 'async_launched', taskId: 'task-2', runId: 'wf_original' } }
  const timeouts = []
  const session = {
    async invoke(input, timeout) {
      timeouts.push(timeout)
      const { refused, ms } = replies.shift()
      await new Promise(resolve => setTimeout(resolve, ms))
      return refused ? refusal : launch
    },
    waitFor: async () => 'observed',
  }
  return { session, original, timeouts }
}

test('a slow first resume keeps the normal deadline; the retry budget starts at the first refusal', async () => {
  const slow = resumeSession([{ refused: false, ms: 120 }])
  assert.equal(await resumeAfterStop(slow.session, cancelResume, slow.original, 50), 'observed')
  assert.deepEqual(slow.timeouts, [undefined])

  const refusedFirst = resumeSession([{ refused: true, ms: 120 }, { refused: true, ms: 0 }, { refused: false, ms: 0 }])
  assert.equal(await resumeAfterStop(refusedFirst.session, cancelResume, refusedFirst.original, 1000), 'observed')
  assert.deepEqual(refusedFirst.timeouts, [undefined, undefined, undefined])

  const slowRefusal = resumeSession([{ refused: true, ms: 120 }, { refused: false, ms: 0 }])
  assert.equal(await resumeAfterStop(slowRefusal.session, cancelResume, slowRefusal.original, 50), 'observed')

  const stuck = resumeSession(Array.from({ length: 20 }, () => ({ refused: true, ms: 0 })))
  await assert.rejects(resumeAfterStop(stuck.session, cancelResume, stuck.original, 300), /did not exit in time/)
})

test('three timing misses exhaust the cancellation attempts and fail live verification', t => {
  const { rows, l1: section } = runStub(t, 'always-miss', { exitCode: 1 })
  assert.equal(section.checks['L1-j'].status, 'fail')
  assert.match(section.checks['L1-j'].reason, /all three attempts/)
  assert.deepEqual(rows.filter(row => row.input?.args?.probe === 'L1-j').map(row => row.input.args.words), [250, 500, 1000])
})

test('unsupported stop records pending and prints commands for an isolated manual capture', t => {
  const { rows, run, l1: section } = runStub(t, 'unsupported')
  assert.equal(section.checks['L1-j'].status, 'pending')
  assert.equal(rows.filter(row => row.input?.args?.probe === 'L1-j').length, 1)
  assert.match(run.stdout, /CLAUDE_CONFIG_DIR=.* claude --model haiku --plugin-dir .* --session-id /)
  assert.match(run.stdout, /in another shell[\s\S]*cp "\$transcript" "\$snapshot\/session\.jsonl"/)
  assert.match(run.stdout, /side="\$\{transcript%\.jsonl\}"/)
  assert.match(run.stdout, /"resumeFromRunId":"REPLACE_WITH_ORIGINAL_WF_RUN_ID"/)
  assert.match(run.stdout, /--manual L1-j --transcript "\$transcript"/)
})

test('make installed propagates a failed reload probe after the loader passes', t => {
  const { env, root } = stubClaude(t, 'reload-missing')
  const checkout = join(root, 'installed-fixture'), tools = join(checkout, 'tools')
  mkdirSync(tools, { recursive: true })
  for (const file of ['workflow-check.mjs', 'workflow-evidence.mjs', 'handoff-protocol.mjs', 'loader-check.mjs', 'sources.mjs']) {
    cpSync(fileURLToPath(new URL('../tools/' + file, import.meta.url)), join(tools, file))
  }
  cpSync(fileURLToPath(new URL('../Makefile', import.meta.url)), join(checkout, 'Makefile'))
  const run = spawnSync('make', ['installed', 'NODE=' + process.execPath, 'HOME=' + root], {
    env, cwd: checkout, encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(run.error, undefined)
  assert.equal(run.status, 2, run.stdout + run.stderr)
  assert.match(run.stdout, /loader: Claude Code loads all 5 workflows/)
  assert.match(run.stdout, /L1-i: fail \(v2 marker was absent/)
  assert.equal(readJson(join(tools, 'native-verdict.json')).l1.checks['L1-j'].status, 'pass')
})

function factoryEvidence(t, id, variant = 1) {
  const repo = realpathSync(temporary(t))
  const head = 'a'.repeat(40)
  const setupId = `2026112${variant}-123456`
  const runDir = join(repo, '.council', setupId)
  const room = join(runDir, 'room')
  const parent = `wf_${variant}abc1234`
  const workflowDir = join('subagents', 'workflows', parent)
  const isPair = id === 'L2-ii' || id === 'L3'
  const isFix = id === 'L2-iii'
  const isCancel = id === 'L2-iv'
  const route = { tier: isFix ? 'fix' : 'simple', strategy: isPair ? 'pair' : 'independent' }
  const args = { task: 'Fixture task', brief: false, tierConfirmed: true, noSplit: true, ...route }
  const metrics = { workflow: 'factory', ...route, turns: 2 }
  if (id === 'L2-i') args.maxTurns = 2
  if (isFix) args.spec = 'ask'
  mkdirSync(join(room, 'empty'), { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ head, runId: setupId, repoRoot: repo, runDir, room }))
  for (const time of [`2026-11-2${variant}T12:34:56Z`, `2026-11-2${variant}T13:34:56Z`]) {
    writeFileSync(join(room, `task-${parent}-${time}.log`), '')
  }
  const call = {
    session: `session-${variant}`, toolUseId: 'tool-first', input: { name: 'dark-factory:factory', args },
    line: 1, resultLine: 2, output: { taskId: 'initial-task', runId: parent, status: 'async_launched' },
  }
  const started = (label, key, agentId) => ({ type: 'started', label, key, agentId, directory: workflowDir })
  const end = ({ key, agentId, directory }, result) => ({ type: 'result', key, agentId, directory, result })
  const intake = started('intake', 'intake-key', `agent${variant}1`)
  const setup = started('setup', 'setup-key', `agent${variant}2`)
  const rows = [
    intake, end(intake, { status: 'ok' }), setup, end(setup, { status: 'ok', runDir, runId: setupId, repoRoot: repo }),
  ]
  const resumeText = `Call Workflow({name: "dark-factory:factory", resumeFromRunId: <this run's id>}). Read ${room}/A.md.`
  const questionId = isFix ? 'S1' : 'Q1'
  const questions = [{ id: questionId, question: 'Which option?', ...(isPair ? { kind: 'design' } : {}) }]
  const answer = { id: questionId, answer: 'Keep the fixture scope.', ...(isPair ? { implement: true } : {}) }
  let result = { status: 'blocked', stopReason: 'Run turn budget exhausted (2).', runDir, metrics }
  if (isPair) result = { status: 'needs-user', workflow: 'factory', ...route, stage: 'design', resumable: true, questions, resumeSteps: resumeText, runDir, metrics: { ...metrics, turns: 7 } }
  if (isFix) result = { status: 'needs-user', round: 'spec', questions, forTheOrchestrator: resumeText, runDir, metrics: { ...metrics, turns: 9 } }
  const status = isCancel ? 'killed' : 'completed'
  const solve = started('r0:A sonnet', 'solve-key', `agent${variant}3`)
  if (isCancel) rows.push(solve)
  const first = {
    call, rows, directory: snapshotRunDirectory(runDir, { repo, head }),
    state: { runId: parent, taskId: 'initial-task', status, result: isCancel ? undefined : result },
    terminal: { line: 3, session: call.session, taskId: 'initial-task', status: isCancel ? 'stopped' : status },
    ...(isCancel ? { active: { start: solve, transcript: true } } : {}),
  }

  let nextResult = result
  const resumedRows = [...rows]
  const workflowProgress = [intake, setup].map(({ label, agentId }, index) =>
    ({ type: 'workflow_agent', index: index + 1, label, agentId, state: 'done', cached: true }))
  if (isPair || isFix || isCancel) {
    const next = started(isPair ? 'resume-check Q1' : isFix ? 'spec amend' : solve.label,
      isCancel ? solve.key : 'continuation-key', `agent${variant}4`)
    resumedRows.push(next, end(next, isFix ? { criteria: [{ id: 'C1' }] } : { status: 'ok' }))
    workflowProgress.push({ type: 'workflow_agent', index: 3, label: next.label, agentId: next.agentId, state: 'done' })
    nextResult = { status: 'done', runDir, metrics: { ...metrics, turns: 12 } }
    if (isPair) nextResult.decisions = [answer]
    if (isFix) nextResult.spec = { answered: [questionId] }
  }
  const resumedCall = {
    ...call, line: 4, resultLine: 5, toolUseId: 'tool-resumed',
    input: { ...call.input, args: isPair || isFix ? { ...args, clarifications: [answer] } : args, resumeFromRunId: parent },
    output: { ...call.output, taskId: 'resume-task' },
  }
  const resumed = {
    call: resumedCall, rows: resumedRows, directory: snapshotRunDirectory(runDir, { repo, head }),
    state: { runId: parent, taskId: 'resume-task', status: 'completed', result: nextResult, workflowProgress },
    terminal: { line: 6, session: call.session, taskId: 'resume-task', status: 'completed' },
  }
  return { first, resumed, repo, runDir, head }
}

for (const id of ['L2-i', 'L2-ii', 'L2-iii', 'L2-iv', 'L3']) {
  test(`${id} judges the intended stop and resume and marks a wrong boundary inconclusive`, t => {
    const { first, resumed } = factoryEvidence(t, id)
    const original = judgeFirstLeg(id, first)
    const continued = judgeResume(id, first, resumed)
    assert.equal(original.status, 'pass', original.reason)
    assert.equal(continued.status, 'pass', continued.reason)
    assert.deepEqual(continued.observed.replayed.map(agent => agent.label), ['intake', 'setup'])
    assert.equal(continued.observed.newStarts.length, id === 'L2-i' ? 0 : 1)
    const wrong = structuredClone(first)
    if (id === 'L2-i') wrong.state.result.stopReason = 'another budget'
    else if (id === 'L2-iii') wrong.state.result.round = 'design'
    else if (id === 'L2-iv') {
      wrong.rows.pop()
      delete wrong.active
    } else wrong.state.result.questions[0].kind = id === 'L3' ? 'spec' : 'setup'
    const missed = judgeFirstLeg(id, wrong)
    assert.equal(missed.status, 'inconclusive')
    assert.equal(compareLegs({ first: original, resume: continued }, { first: missed }).status, 'inconclusive')
    assert.equal(factoryExitCode({ [id]: missed }), 1)
  })
}

test('Factory result extraction requires the current native task and detects contradictory output', t => {
  const { resumed } = factoryEvidence(t, 'L2-i')
  const { call, terminal, state } = resumed
  assert.equal(factoryResultFor(call, { ...state, taskId: 'initial-task' }, terminal), null)
  assert.equal(factoryResultFor(call, { ...state, result: undefined }, { ...terminal, session: 'elsewhere', result: state.result }), null)
  assert.deepEqual(factoryResultFor(call, { ...state, result: undefined }, { ...terminal, result: JSON.stringify(state.result) }), state.result)
  assert.throws(() => factoryResultFor(call, state, { ...terminal, result: { ...state.result, status: 'done' } }), /Conflicting Factory results/)
  assert.throws(() => factoryResultFor(call, state, { ...terminal, status: 'failed' }), /Conflicting native Factory task state/)
})

test('Factory stops require successful setup and the on-disk run record under the fixture', t => {
  const { first, repo, runDir, head } = factoryEvidence(t, 'L2-i')
  assert.throws(() => snapshotRunDirectory(runDir, { repo, head: 'different' }), /seed HEAD/)
  assert.throws(() => snapshotRunDirectory(join(repo, 'missing'), { repo, head }), /ENOENT/)
  assert.throws(() => snapshotRunDirectory(repo, { repo, head }), /outside its fixture/)
  first.rows[3].result.status = 'preflight'
  assert.equal(judgeFirstLeg('L2-i', first).status, 'inconclusive')
})

test('a Factory resume must keep its own directory before comparing across fixtures', t => {
  const own = factoryEvidence(t, 'L2-ii', 1)
  const other = factoryEvidence(t, 'L2-ii', 2)
  const resumed = {
    ...own.resumed, directory: other.resumed.directory,
    state: { ...own.resumed.state, result: { ...own.resumed.state.result, runDir: other.runDir } },
  }
  assert.match(judgeResume('L2-ii', own.first, resumed).reason, /reuse its original setup directory/)
})

test('Factory parity normalizes IDs, timestamps and content hashes, ignores wt/, and compares L2-i layouts in full', t => {
  const control = factoryEvidence(t, 'L2-i', 1)
  const candidate = factoryEvidence(t, 'L2-i', 2)
  const leg = data => ({ first: judgeFirstLeg('L2-i', data.first), resume: judgeResume('L2-i', data.first, data.resumed) })
  const resnap = data => {
    data.first.directory = snapshotRunDirectory(data.runDir, { repo: data.repo, head: data.head })
    data.resumed.directory = snapshotRunDirectory(data.runDir, { repo: data.repo, head: data.head })
  }
  for (const [data, sha, edit] of [[control, 'a'.repeat(64), 'one'], [candidate, 'b'.repeat(64), 'other']]) {
    mkdirSync(join(data.runDir, 'wt', 'A', edit), { recursive: true })
    mkdirSync(join(data.runDir, 'evidence', `A-base-${sha}`), { recursive: true })
    resnap(data)
  }
  assert.deepEqual(compareLegs(leg(control), leg(candidate)), { status: 'pass' })
  rmSync(join(candidate.runDir, 'room', 'empty'), { recursive: true })
  resnap(candidate)
  const layout = compareLegs(leg(control), leg(candidate))
  assert.deepEqual(layout.differences.map(item => item.field), ['first.runDirectory', 'resume.runDirectory'])
  const entries = layout.differences[0].inline
  assert.equal(entries.filter(entry => entry.path.includes('<timestamp>')).length, 2)
  assert.ok(entries.some(entry => entry.path === join('evidence', 'A-base-<sha>')))
  assert.ok(!entries.some(entry => entry.path.split('/')[0] === 'wt'))
  assert.ok(entries.some(entry => entry.type === 'directory' && entry.path === join('room', 'empty')))
  const turns = leg(control)
  turns.resume.observed.metrics.turns = 3
  assert.deepEqual(compareLegs(leg(control), turns).differences.map(item => item.field), ['resume.turns'])
})

test('Factory parity ignores model-dependent stop counts, turns, later agents and worktree files', t => {
  const control = factoryEvidence(t, 'L2-ii', 1)
  const candidate = factoryEvidence(t, 'L3', 2)
  control.first.state.result.stopReason = 'The design used its review allowance, with 1 design finding open (1 major).'
  candidate.first.state.result.stopReason = 'The design used its review allowance, with 3 design findings open (2 major).'
  mkdirSync(join(candidate.runDir, 'wt', 'A', 'src'), { recursive: true })
  mkdirSync(join(candidate.runDir, 'room', 'pair-code-2'), { recursive: true })
  candidate.resumed.directory = snapshotRunDirectory(candidate.runDir, { repo: candidate.repo, head: candidate.head })
  const leg = (id, data) => ({ first: judgeFirstLeg(id, data.first), resume: judgeResume(id, data.first, data.resumed) })
  const inline = leg('L2-ii', control), split = leg('L3', candidate)
  split.resume.observed.metrics.turns += 9
  split.resume.observed.newStarts.push({ position: 4, label: 'review pair-code-2 (relay)' })
  assert.deepEqual(compareLegs(inline, split), { status: 'pass' })
})

test('Factory parity fails on status, stop kind, resume target, replayed prefix and first fresh agent', t => {
  const { first, resumed } = factoryEvidence(t, 'L2-ii')
  const control = { first: judgeFirstLeg('L2-ii', first), resume: judgeResume('L2-ii', first, resumed) }
  const changes = [
    ['resume.status', leg => { leg.resume.observed.status = 'blocked' }],
    ['first.stop', leg => { leg.first.observed.stop.stage = 'implement' }],
    ['first.stop', leg => { leg.first.observed.stop.questionKinds = ['criterion'] }],
    ['first.resumeNamesFactory', leg => { leg.first.observed.resumeText = 'Call Workflow({name: "dark-factory:pair"}).' }],
    ['resume.replayed', leg => { leg.resume.observed.replayed = leg.resume.observed.replayed.slice(0, 1) }],
    ['resume.firstFresh', leg => { leg.resume.observed.newStarts[0].label = 'pair-code-1' }],
    ['resume.route', leg => { leg.resume.observed.route.limits = { maxTurns: 5, maxRunMin: null } }],
    ['resume.plan', leg => { leg.resume.observed.plan = { reviewers: [], limits: { maxReviews: null } } }],
  ]
  for (const [field, change] of changes) {
    const candidate = structuredClone(control)
    change(candidate)
    const compared = compareLegs(control, candidate)
    assert.equal(compared.status, 'fail', field)
    assert.deepEqual(compared.differences.map(item => item.field), [field])
  }
  // A first leg always starts with intake, so its first fresh label is not compared.
  const relabelled = structuredClone(control)
  relabelled.first.observed.newStarts[0].label = 'other'
  assert.deepEqual(compareLegs(control, relabelled), { status: 'pass' })
})

test('Factory parity compares the resume target of native instructions from a later council round', t => {
  const { first, resumed } = factoryEvidence(t, 'L2-iii')
  const result = resumed.state.result
  result.status = 'needs-user'
  result.round = 1
  result.forTheOrchestrator = 'Resume with Workflow({name: "dark-factory:factory", resumeFromRunId: <id>}) and the answer.'
  const initial = judgeFirstLeg('L2-iii', first)
  const control = judgeResume('L2-iii', first, resumed)
  result.forTheOrchestrator = 'Resume with the answer to the follow-up question.'
  const candidate = judgeResume('L2-iii', first, resumed)
  assert.deepEqual(compareLegs({ first: initial, resume: control }, { first: initial, resume: candidate })
    .differences.map(item => item.field), ['resume.resumeNamesFactory'])
})

test('Factory replay rejects a restarted prefix, an incomplete continuation and a canceled resume', t => {
  const { first, resumed } = factoryEvidence(t, 'L2-ii')
  const [intake] = first.rows
  const reran = structuredClone(resumed)
  reran.rows.push({ ...intake, agentId: 'reran' })
  assert.match(judgeResume('L2-ii', first, reran).reason, /restarted a prior position/)
  const missing = structuredClone(resumed)
  missing.rows.pop()
  assert.match(judgeResume('L2-ii', first, missing).reason, /incomplete/)
  const canceled = structuredClone(resumed)
  canceled.state.status = 'killed'
  canceled.terminal.status = 'stopped'
  assert.equal(judgeResume('L2-ii', first, canceled).status, 'fail')
  const rewritten = structuredClone(resumed)
  rewritten.rows[1].result.status = 'error'
  assert.match(judgeResume('L2-ii', first, rewritten).reason, /does not extend/)
})

test('Factory cancellation requires the captured attempt and a completed restart of that position', t => {
  const { first, resumed } = factoryEvidence(t, 'L2-iv')
  const noTranscript = { ...first, active: { ...first.active, transcript: false } }
  assert.equal(judgeFirstLeg('L2-iv', noTranscript).status, 'inconclusive')
  const wrong = structuredClone(resumed)
  wrong.rows.at(-2).key = wrong.rows.at(-1).key = 'other-key'
  assert.match(judgeResume('L2-iv', first, wrong).reason, /did not restart and complete/)
  assert.equal(judgeResume('L2-iv', first, resumed).status, 'pass')
})

function runFactoryStub(t, scenario) {
  const root = realpathSync(temporary(t))
  const config = join(root, 'scratch-config')
  const bin = join(root, 'bin')
  const trace = join(root, 'trace.jsonl')
  const verdict = join(root, 'verdict.json')
  const cli = join(bin, 'claude')
  mkdirSync(config)
  mkdirSync(bin)
  cpSync(join(fixtures, 'factory-claude-stub.mjs'), cli)
  chmodSync(cli, 0o755)
  for (const executable of ['node', 'git', 'python3', 'sh', 'env']) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'which', executable], { encoding: 'utf8' })
    assert.equal(found.status, 0, found.stderr)
    symlinkSync(found.stdout.trim(), join(bin, executable))
  }
  if (scenario !== 'missing-provider') {
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex-fixture\n', { mode: 0o755 })
  }
  const l1 = { nameForm: 'qualified', checks: {} }
  writeFileSync(verdict, JSON.stringify({ l1 }))
  const settings = join(config, 'settings.json')
  const allow = scenario === 'missing-permission' ? [] : ['Bash(dark-factory:*)']
  if (scenario === 'independent-workflow') allow.push('Workflow')
  const hooks = { 'star-hook': '*', 'invalid-hook': '[', 'unmatched-hook': undefined }
  const initialSettings = JSON.stringify({ permissions: { allow }, ...(Object.hasOwn(hooks, scenario)
    ? { hooks: { PreToolUse: [{ matcher: hooks[scenario], hooks: [{ type: 'command', command: 'true' }] }] } } : {}) })
  writeFileSync(settings, initialSettings)
  const env = { ...process.env, PATH: bin, TMPDIR: root, CODEX_HOME: join(root, 'codex'), GIT_DIR: '/wrong-git',
    DF_PROBE_TRACE: trace, DF_PROBE_SCENARIO: scenario }
  const run = spawnSync(process.execPath, [tool, '--factory', '--config-dir', config, '--verdict', verdict],
    { env, cwd: root, encoding: 'utf8', timeout: 45_000 })
  assert.ifError(run.error)
  assert.equal(run.status, ['guard', 'model-variance'].includes(scenario) ? 0 : 1, run.stdout + run.stderr)
  assert.equal(readFileSync(settings, 'utf8'), initialSettings)
  assert.deepEqual(readJson(verdict).l1, l1)
  return { run, config, env, verdict, l2: readJson(verdict).l2, rows: existsSync(trace) ? readRows(trace) : [] }
}

for (const [scenario, diagnostic] of [
  ['duplicate', /Expected one dark-factory workflow set/],
  ['missing-marker', /Expected one dark-factory workflow set and marker/],
  ['wrong-marker', /loaded .*candidate-ffffffffffff/],
  ['missing-permission', /Add "Bash\(dark-factory:\*\)" to permissions.allow/],
  ['missing-provider', /codex: codex is not on PATH/],
  ['installed', /empty scratch plugin inventory/],
  ['independent-workflow', /conflict with guarded Workflow requests/],
  // A matcher of "*", one that does not compile, or none at all may match Workflow.
  ['star-hook', /conflict with guarded Workflow requests/],
  ['invalid-hook', /conflict with guarded Workflow requests/],
  ['unmatched-hook', /conflict with guarded Workflow requests/],
  // The scratch copy's bytes are checked again at the precondition, after createPluginCopy.
  ['altered-copy', /Workflow bytes differ from the expected hashes/],
]) {
  test(`Factory CLI rejects ${scenario} before launching Factory`, t => {
    const { run, rows, l2 } = runFactoryStub(t, scenario)
    assert.match(run.stderr, diagnostic)
    assert.ok(!rows.some(row => row.launch), JSON.stringify(rows))
    assert.equal(l2, undefined)
  })
}

// A listing probe never reaches the hook natively, so disabled hooks show first at the guarded
// Factory call: it stops there, unlaunched, and the partial verdict fails L2-i.
test('Factory CLI stops at the first Factory call that has no guard receipt', t => {
  const { run, rows, l2 } = runFactoryStub(t, 'no-receipt')
  assert.match(run.stderr, /Missing correlated Factory Workflow guard receipt/)
  assert.ok(rows.some(row => row.unguarded), JSON.stringify(rows))
  assert.ok(!rows.some(row => row.launch), JSON.stringify(rows))
  assert.equal(l2.checks['L2-i'].status, 'fail')
  assert.match(l2.checks['L2-i'].reason, /guard receipt/)
})

test('Factory CLI guards and proves paired native resumes and the same-session L3 reload', t => {
  const { run, config, l2, rows } = runFactoryStub(t, 'guard')
  assert.equal(run.stderr, '')
  const launches = rows.filter(row => row.launch)
  assert.equal(launches.length, 18)
  assert.deepEqual(Object.fromEntries(Object.entries(l2.checks).map(([id, check]) => [id, check.status])),
    { 'L2-i': 'pass', 'L2-ii': 'pass', 'L2-iii': 'pass', 'L2-iv': 'pass', L3: 'pass' })
  assert.ok(rows.filter(row => row.argv).every(row => row.config === config))
  assert.equal(rows.filter(row => row.guard === 2 && row.toolUseId === 'unsolicited').length, 20)
  // Listing probes never reach the guard; every Factory call is claimed once and refused a second time.
  assert.ok(!rows.some(row => 'guard' in row && row.input.name.includes(':missing-')))
  assert.equal(rows.filter(row => row.guard === 2 && row.toolUseId === 'duplicate').length,
    rows.filter(row => row.guard === 0).length)

  const fresh = launches.filter(row => !row.launch.resumeFromRunId)
  assert.equal(new Set(fresh.map(row => row.cwd)).size, 9)
  assert.equal(new Set(fresh.map(row => row.session)).size, 9)
  const heads = new Set(fresh.map(row => execGitHead(row.cwd)))
  assert.equal(heads.size, 1)
  for (const [index, row] of launches.entries()) {
    const { args, resumeFromRunId } = row.launch
    assert.deepEqual([args.brief, args.tierConfirmed, args.noSplit, args.retro], [false, true, true, false])
    const preceding = rows.slice(0, rows.indexOf(row)).findLast(item => 'guard' in item && item.toolUseId !== 'duplicate')
    assert.equal(preceding.guard, 0)
    assert.equal(preceding.session, row.session)
    assert.deepEqual(preceding.input, row.launch)
    const listing = rows.slice(0, rows.indexOf(row)).findLast(item => item.listing && item.session === row.session)
    assert.ok(listing.listing.includes('dark-factory:' + row.marker))
    if (resumeFromRunId) assert.equal(resumeFromRunId, launches[index - 1].runId)
  }
  const [budget, budgetResume] = launches.map(row => row.launch)
  assert.equal(budget.args.maxTurns, 2)
  assert.deepEqual(budget.args, budgetResume.args)
  const [pair, pairResume, fix, fixResume] = [launches[4], launches[5], launches[8], launches[9]].map(row => row.launch)
  assert.equal(pair.args.strategy, 'pair')
  assert.deepEqual(pair.args.pair, { reviewer: 'sol', spec: false, maxDesignReviews: 1, maxReviews: 3 })
  assert.deepEqual(pairResume.args.clarifications.map(({ id, implement }) => [id, implement]), [['Q1', true]])
  assert.deepEqual([fix.args.tier, fix.args.strategy, fix.args.spec, fix.args.audit], ['fix', 'independent', { coverage: 'sol', ask: true }, false])
  assert.deepEqual(fixResume.args.clarifications.map(({ id }) => id), ['S1'])
  const [startUpgrade, resumeUpgrade] = launches.slice(12, 14)
  assert.deepEqual(startUpgrade.launch.args, pair.args)
  assert.deepEqual(resumeUpgrade.launch.args, pairResume.args)
  assert.equal(startUpgrade.session, resumeUpgrade.session)
  assert.equal(startUpgrade.mode, 'inline')
  assert.equal(resumeUpgrade.mode, 'candidate')
  const reload = rows.find(row => row.command === '/reload-plugins')
  assert.equal(reload.session, startUpgrade.session)
  assert.equal(reload.previous, startUpgrade.marker)
  assert.equal(reload.marker, resumeUpgrade.marker)
  assert.ok(rows.indexOf(startUpgrade) < rows.indexOf(reload) && rows.indexOf(reload) < rows.indexOf(resumeUpgrade))
  assert.deepEqual(l2.sha256, resumeUpgrade.sha256)
  assert.equal(rows.filter(row => row.edit).length, 5)
  for (const [start, resume] of [launches.slice(14, 16), launches.slice(16, 18)]) {
    const active = rows.find(row => row.session === start.session && row.active)
    const stop = rows.find(row => row.session === start.session && row.request?.subtype === 'stop_task')
    const refused = rows.find(row => row.session === start.session && row.resumeRefused)
    const restart = rows.find(row => row.session === start.session && row.restarted)
    assert.ok(rows.indexOf(start) < rows.indexOf(active) && rows.indexOf(active) < rows.indexOf(stop))
    assert.ok(rows.indexOf(stop) < rows.indexOf(refused) && rows.indexOf(refused) < rows.indexOf(resume))
    assert.ok(rows.indexOf(resume) < rows.indexOf(restart))
    assert.deepEqual(refused.resumeRefused, resume.launch)
    const { maxTurns, ...uncapped } = budget.args
    assert.deepEqual(start.launch.args, uncapped)
    assert.deepEqual(resume.launch.args, uncapped)
  }
})

function execGitHead(cwd) {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}

test('Factory CLI refuses the L3 resume when reload still lists the inline build', t => {
  const { run, rows, l2 } = runFactoryStub(t, 'stale-reload')
  const reload = rows.find(row => row.command === '/reload-plugins')
  assert.ok(reload)
  assert.match(run.stderr, /Expected one dark-factory workflow set and marker/)
  assert.equal(rows.filter(row => row.session === reload.session && row.launch).length, 1)
  assert.deepEqual(Object.fromEntries(Object.entries(l2.checks).map(([id, check]) => [id, check.status])),
    { 'L2-i': 'pass', 'L2-ii': 'pass', 'L2-iii': 'pass', L3: 'fail', 'L2-iv': 'pending' })
  assert.match(l2.checks.L3.reason, /^Stopped: Expected one dark-factory workflow set/)
})

test('a precondition failure at a later leg writes the finished checks and exits nonzero', t => {
  const { run, rows, l2 } = runFactoryStub(t, 'late-precondition')
  assert.match(run.stderr, /Expected one dark-factory workflow set and marker/)
  assert.ok(!rows.some(row => row.launch && row.cwd.split('/').includes('L2-ii-inline')))
  assert.equal(l2.checks['L2-i'].status, 'pass')
  assert.equal(l2.checks['L2-ii'].status, 'fail')
  for (const id of ['L2-iii', 'L2-iv', 'L3']) assert.equal(l2.checks[id].status, 'pending', id)
  assert.match(run.stdout, /L2-i: pass/)
})

test('Factory CLI records inconclusive stops and retains evidence for a parity mismatch', t => {
  const first = runFactoryStub(t, 'wrong-boundary')
  assert.equal(first.l2.checks['L2-ii'].status, 'inconclusive')
  assert.equal(first.l2.checks.L3.status, 'inconclusive')
  assert.match(first.run.stdout, /L2-ii: inconclusive/)
  const changed = runFactoryStub(t, 'parity')
  assert.equal(changed.l2.checks['L2-ii'].status, 'fail')
  assert.match(changed.l2.checks['L2-ii'].reason, /Parity differs in resume\.status$/)
  const [, artifacts] = /Factory artifacts: ([^\n]+)/.exec(changed.run.stdout)
  for (const mode of ['inline', 'candidate']) {
    assert.ok(existsSync(join(artifacts, `L2-ii-${mode}`, 'resume.json')))
  }
})

test('Factory CLI records a first launch refusal after the preconditions as an inconclusive check', t => {
  const { run, rows, l2 } = runFactoryStub(t, 'launch-refusal')
  assert.ok(rows.some(row => row.refused), 'the checker must reach a guarded Factory invocation after the listing')
  assert.equal(l2.checks['L2-i'].status, 'inconclusive', run.stdout + run.stderr)
  assert.match(l2.checks['L2-i'].reason, /native Workflow refused to launch/)
  assert.equal(l2.checks['L2-ii'].status, 'pass')
})

// L3's inline first stop reports more findings than the control's; the candidate's resumes take
// more turns and rounds, with other later agents, worktree files and evidence hashes.
test('Factory CLI passes legs that differ only in model-dependent stop counts, turns, later agents and files', t => {
  const { run, rows, l2 } = runFactoryStub(t, 'model-variance')
  assert.ok(rows.some(row => row.mode === 'candidate' && row.launch?.resumeFromRunId &&
    row.cwd.split('/').includes('L3-inline')), 'the upgraded candidate must actually resume')
  for (const id of L2_REQUIRED) assert.equal(l2.checks[id].status, 'pass', `${id}: ${run.stdout}`)
})

test('Factory CLI fails parity when the candidate resume lost a configured arg but still ends done', t => {
  const { l2 } = runFactoryStub(t, 'dropped-arg')
  for (const id of ['L2-ii', 'L2-iii', 'L3']) {
    assert.equal(l2.checks[id].status, 'fail', id)
    assert.match(l2.checks[id].reason, /Parity differs in resume\.plan$/, id)
  }
  for (const id of ['L2-i', 'L2-iv']) assert.equal(l2.checks[id].status, 'pass', id)
})

test('the Factory run exits 0 only when every required check passes', () => {
  const allPass = () => Object.fromEntries(L2_REQUIRED.map(id => [id, { status: 'pass' }]))
  assert.equal(factoryExitCode(allPass()), 0)
  for (const id of L2_REQUIRED) {
    for (const status of ['fail', 'inconclusive', 'pending', 'skipped']) {
      assert.equal(factoryExitCode({ ...allPass(), [id]: { status } }), 1, `${id} ${status}`)
    }
    const checks = allPass()
    delete checks[id]
    assert.equal(factoryExitCode(checks), 1, `missing ${id}`)
  }
})

test('Factory CLI reports a missed cancellation window and a failed restart', t => {
  const early = runFactoryStub(t, 'early-cancel')
  assert.equal(early.l2.checks['L2-iv'].status, 'inconclusive')
  assert.match(early.run.stdout, /ended before the first post-setup agent/)
  assert.ok(!early.rows.some(row => row.request?.subtype === 'stop_task'))
  const restart = runFactoryStub(t, 'failed-restart')
  assert.equal(restart.l2.checks['L2-iv'].status, 'fail')
  assert.match(restart.run.stdout, /Interrupted agent did not restart and complete/)
})

async function manualFactorySession(t, harness, metaFile) {
  const meta = readJson(metaFile)
  const env = { ...harness.env, CLAUDE_CONFIG_DIR: meta.config, PATH: join(meta.copy.path, 'bin') + ':' + harness.env.PATH }
  delete env.GIT_DIR
  const runCommand = phase => spawnSync(process.execPath, [tool, '--factory', '--capture', metaFile, phase],
    { env, cwd: meta.cwd, encoding: 'utf8', timeout: 15_000 })
  const capture = phase => {
    const run = runCommand(phase)
    assert.equal(run.status, 0, run.stdout + run.stderr)
    return run.stdout.trim()
  }
  // Start the stub with the same invocation settings printed for the maintainer.
  const launch = harness.run.stdout.split('\n').find(line => line.includes('--session-id') && line.includes(meta.sessionId))
  assert.ok(launch)
  const child = spawn('/bin/sh', ['-c', launch.trim()], { env, stdio: 'pipe' })
  t.after(() => child.kill())
  const stream = createStreamParser()
  let stderr = ''
  child.stdin.on('error', error => { stderr += error.message })
  child.stdout.setEncoding('utf8').on('data', chunk => stream.push(chunk))
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const waitFor = async check => {
    for (let tries = 0; tries < 250; tries++) {
      const observation = check()
      if (observation) return observation
      if (child.exitCode !== null) break
      await delay(20)
    }
    assert.fail('Interactive stub did not produce expected evidence: ' + stderr)
  }
  const send = frame => child.stdin.write(JSON.stringify(frame) + '\n')
  const prompt = phase => send({ type: 'user', message: { role: 'user', content: capture(phase) } })
  prompt('list')
  await waitFor(() => stream.calls.some(call => call.input.name.includes(':missing-')))
  prompt('start')
  const original = await waitFor(() => stream.calls.find(call => call.input.name === 'dark-factory:factory'))
  await waitFor(() => readRows(harness.env.DF_PROBE_TRACE).some(row => row.active && row.session === meta.sessionId))
  capture('active')
  send({ type: 'control_request', request_id: 'manual-ui', request: { subtype: 'stop_task', task_id: original.output.taskId } })
  await waitFor(() => terminalFor(original, stream.terminals))
  prompt('stopped')
  await waitFor(() => stream.calls.filter(call => call.input.name.includes(':missing-')).length === 2)
  prompt('resume')
  const resumed = await waitFor(() => stream.calls.find(call => call.input.resumeFromRunId))
  await waitFor(() => terminalFor(resumed, stream.terminals))
  child.stdin.end()
  return capture('path')
}

test('Manual Factory CLI judges two interactive captures and rejects stale or incomplete evidence', async t => {
  const live = runFactoryStub(t, 'unsupported-factory')
  assert.equal(live.l2.checks['L2-iv'].status, 'pending')
  assert.match(live.run.stdout, /Manual L2-iv \(inline\)/)
  assert.match(live.run.stdout, /--control "\$\(/)
  const [, root] = /Factory artifacts: ([^\n]+)/.exec(live.run.stdout)
  const [control, candidate] = await Promise.all(['inline', 'candidate'].map(mode =>
    manualFactorySession(t, live, join(root, 'manual-' + mode, 'capture.json'))))
  const run = (...args) => spawnSync(process.execPath, [tool, '--factory', '--manual', 'L2-iv', ...args,
    '--verdict', live.verdict], { env: live.env, encoding: 'utf8' })
  const options = ['--control', control, '--candidate', candidate]
  const saved = readFileSync(live.verdict, 'utf8')
  for (const partial of [['--control', control], ['--candidate', candidate]]) {
    const missing = run(...partial)
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /requires both --control and --candidate/)
    assert.equal(readFileSync(live.verdict, 'utf8'), saved, 'a usage error leaves the verdict untouched')
  }
  const passed = run(...options)
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /L2-iv: pass/)
  const got = readJson(live.verdict)
  assert.equal(got.l2.checks['L2-iv'].mode, 'manual')
  for (const id of ['L2-i', 'L2-ii', 'L2-iii', 'L3']) assert.deepEqual(got.l2.checks[id], live.l2.checks[id])

  // A passing manual L2-iv still exits nonzero while another l2 check has not passed.
  const complete = readFileSync(live.verdict, 'utf8')
  writeFileSync(live.verdict, JSON.stringify({ ...got, l2: { ...got.l2, checks: { ...got.l2.checks, L3: { status: 'fail' } } } }))
  const partial = run(...options)
  assert.equal(partial.status, 1, partial.stdout + partial.stderr)
  assert.match(partial.stdout, /L2-iv: pass/)
  assert.match(partial.stderr, /l2 is not complete: L3 fail/)
  writeFileSync(live.verdict, complete)

  const sidecar = join(candidate + '.l2-iv-before', 'stopped.json')
  const save = readFileSync(sidecar, 'utf8')
  const stale = JSON.parse(save)
  stale.meta.provenance.sha256.inline['factory.js'] = '0'.repeat(64)
  writeFileSync(sidecar, JSON.stringify(stale))
  const refused = run(...options)
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stdout, /Stale candidate cancellation provenance/)
  assert.equal(readJson(live.verdict).l2.checks['L2-iv'].status, 'fail')

  writeFileSync(sidecar, save)
  rmSync(join(candidate + '.l2-iv-before', 'active-agent.jsonl'))
  const incomplete = run(...options)
  assert.equal(incomplete.status, 1, incomplete.stdout + incomplete.stderr)
  assert.equal(readJson(live.verdict).l2.checks['L2-iv'].status, 'fail')
})

test('no Factory scenario runs Codex Astra: every default Astra model is pinned to Sol', async () => {
  const { loadLib } = await import('./lib.mjs')
  const L = loadLib()
  for (const id of [...L2_REQUIRED]) {
    const args = { task: 'x', ...factoryArgs(id, 'true') }
    assert.doesNotMatch(JSON.stringify(args), /astra/, id)
    let models
    if (args.strategy === 'pair') {
      const config = L.factoryPairConfig({ raw: args, retro: false, roles: {} })
      models = [config.pairOptions.author, config.pairOptions.reviewer, ...config.specReviewers]
    } else {
      // The Simple tier has no panel; every other tier rules with one.
      const config = L.parseConfig(L.tierArgs(args, args.tier), { workflow: 'factory', tier: args.tier })
      models = [...config.lineup, ...(args.tier === 'simple' ? [] : config.panel), ...config.auditors, ...config.specReviewers]
    }
    const keys = models.map(m => m.key)
    assert.ok(keys.length > 1, id)
    assert.ok(!keys.includes('astra'), `${id}: ${keys.join(', ')}`)
  }
})
