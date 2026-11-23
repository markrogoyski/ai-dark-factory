import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  beforeCancelDir, createStreamParser, judgeBootThrow, judgeCancel, judgeEnvelope, judgeMeter, judgeReplay,
  parseManualTranscript, parseStream, probeExitCode, probeObservation, resumeAfterStop, scratchEnv, terminalFor, workflowJournal,
  writeVerdict,
} from '../tools/workflow-check.mjs'

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
  for (const file of ['workflow-check.mjs', 'loader-check.mjs', 'sources.mjs']) {
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
