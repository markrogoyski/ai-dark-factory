import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { journalRuntime, loadCheckpoint, readEventLog } from '../plugins/dark-factory/lib/checkpoint.mjs'
import { runWorkflow, parseCLI } from '../plugins/dark-factory/lib/codex-runner.mjs'

// Launch preparation probes the installed provider CLIs; these tests are about the checkpoint, not the host.
const noPrepare = async () => null

function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'factory-checkpoint-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'code'), 'base\n'); git('add', 'code'); git('commit', '-qm', 'Base')
  const hostRunDir = join(repo, '.council/host-test'), runDir = join(repo, '.council/test')
  mkdirSync(hostRunDir, { recursive: true }); mkdirSync(join(runDir, 'room'), { recursive: true }); mkdirSync(join(runDir, 'wt'))
  git('worktree', 'add', '--detach', '-q', join(runDir, 'wt/A'), 'HEAD')
  const run = { runDir, runId: 'test', repoRoot: repo }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run)); writeFileSync(join(runDir, 'room/post'), 'original evidence')
  const opts = { repo, hostRunDir, args: { task: 'Fix code' }, engine: 'engine1', emit: () => {} }
  return { ...opts, opts, run, git }
}

test('checkpoint replays exact completed operations without another model call', async t => {
  const f = fixture(t), request = { run: f.run, prompt: 'Review exact snapshot', label: 'review' }
  const runtime = { agent: async () => ({ summary: 'reviewed' }), turn: async () => {}, measure: async () => {}, checkpointState: () => ({ sequence: 1 }) }
  const first = journalRuntime(runtime, f.opts)
  await first.agent(request)
  const saved = loadCheckpoint(f.hostRunDir, f.opts)
  let invoked = false
  const second = journalRuntime({ ...runtime, agent: async () => { invoked = true; return {} } }, { ...f.opts, saved })
  assert.deepEqual(await second.agent(request), { summary: 'reviewed' }); assert.equal(invoked, false)
  const third = journalRuntime(runtime, { ...f.opts, saved })
  await assert.rejects(() => third.agent({ ...request, prompt: 'Changed task' }), { code: 'CHECKPOINT_MISMATCH' })
  await assert.rejects(() => third.agent(request), { code: 'CHECKPOINT_MISMATCH' }, 'a mismatch poisons later replay too')
})

test('replay requests and raw logs obey existing checkpoint compatibility', async t => {
  const f = fixture(t)
  const log = join(f.run.runDir, 'logs/replay.log')
  mkdirSync(join(f.run.runDir, 'logs'))
  writeFileSync(log, 'fatal before individual tests ran\n')
  const request = { run: f.run, seat: 'A', label: 'pair-code-2', replay: { testRoots: ['tests'],
    mapping: [{ file: 'tests/new.cjs', command: 'node tests/new.cjs', checkIds: ['T1'], fixtures: [] }] } }
  const result = { status: 'done', replay: { records: [{ side: 'base', exitCode: 255, log }] } }
  const runtime = { measure: async () => result, checkpointState: () => ({ sequence: 1 }) }
  await journalRuntime(runtime, f.opts).measure(request)
  const saved = loadCheckpoint(f.hostRunDir, f.opts)
  const resume = () => journalRuntime({ ...runtime, measure: () => { throw new Error('must reuse') } }, { ...f.opts, saved })
  assert.deepEqual(await resume().measure(request), result)
  for (const key of ['testRoots', 'command', 'checkIds', 'fixtures']) {
    const changed = structuredClone(request)
    if (key === 'testRoots') changed.replay.testRoots.push('spec')
    else changed.replay.mapping[0][key] = key === 'command' ? 'true' : ['changed']
    await assert.rejects(() => resume().measure(changed), { code: 'CHECKPOINT_MISMATCH' })
  }
  writeFileSync(log, 'tampered')
  assert.throws(() => loadCheckpoint(f.hostRunDir, f.opts), /evidence changed/)
})

test('checkpoint rejects changed source, inputs, evidence, worktrees and engine before replay', async t => {
  for (const change of ['source', 'evidence', 'worktree', 'engine', 'reference']) {
    const f = fixture(t)
    const ref = join(f.repo, 'PLAN'); writeFileSync(ref, 'original plan'); f.opts.args.plan = [ref]
    const runtime = journalRuntime({ agent: async () => ({ ok: true }), checkpointState: () => ({ sequence: 1 }) }, f.opts)
    await runtime.agent({ run: f.run, prompt: 'Read' })
    if (change === 'source') writeFileSync(join(f.repo, 'code'), 'changed')
    if (change === 'evidence') writeFileSync(join(f.run.runDir, 'room/post'), 'tampered')
    if (change === 'worktree') writeFileSync(join(f.run.runDir, 'wt/A/code'), 'partial interrupted edit')
    if (change === 'reference') writeFileSync(ref, 'different requirements')
    assert.throws(() => loadCheckpoint(f.hostRunDir, { ...f.opts, engine: change === 'engine' ? 'engine2' : 'engine1' }), /changed/)
  }
})

test('parallel operations commit only at a completed barrier; failures keep the prior checkpoint', async t => {
  const f = fixture(t); let release
  const slow = new Promise(r => { release = r })
  const runtime = journalRuntime({ agent: async r => r.label === 'slow' ? slow : { ok: true }, checkpointState: () => ({ sequence: 1 }) }, f.opts)
  await runtime.agent({ run: f.run, label: 'first' })
  const before = readFileSync(join(f.hostRunDir, 'checkpoint.json'), 'utf8')
  const pending = runtime.agent({ run: f.run, label: 'slow' })
  await runtime.agent({ run: f.run, label: 'fast' })
  assert.equal(readFileSync(join(f.hostRunDir, 'checkpoint.json'), 'utf8'), before)
  release(null); await pending
  assert.equal(readFileSync(join(f.hostRunDir, 'checkpoint.json'), 'utf8'), before)
})

const empty = s => s.enum ? s.enum[0] : s.type === 'object' ? Object.fromEntries(Object.entries(s.properties).map(([k,v]) => [k,empty(v)])) : s.type === 'array' ? [] : s.type === 'string' ? '' : s.type === 'boolean' ? false : 0

async function pausedRun(t, flags = []) {
  const f = fixture(t), deadlines = []
  const dependencies = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    assert.equal(argv[0], 'seat-run')
    deadlines.push(argv[argv.indexOf('--timeout-min') + 1])
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const result = empty(schema)
    if ('tier' in result) Object.assign(result, { status: 'ok', tier: 'feature', mode: 'implement', strategy: 'independent' })
    else Object.assign(result, { status: 'error', error: 'Test stops at setup.' })
    return { status: 'done', result }
  } } }
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--tier', 'simple', ...flags, 'Fix code']), dependencies)
  assert.equal(first.status, 'needs-tier')
  const resume = flags => runWorkflow({ ...parseCLI(['--resume', first.hostRunDir, ...(flags || [])]), args: { tierConfirmed: true } }, dependencies)
  const metadata = () => JSON.parse(readFileSync(join(first.hostRunDir, 'host.json'), 'utf8'))
  return { ...f, first, resume, metadata, deadlines }
}

test('checkpoint request mismatch aborts the generated workflow instead of failing an ordinary turn', async t => {
  const f = await pausedRun(t)
  const path = join(f.first.hostRunDir, 'checkpoint.json')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  saved.entries[0].hash = 'changed-request'
  writeFileSync(path, JSON.stringify(saved))
  const before = readFileSync(path, 'utf8')
  const result = await f.resume()
  assert.equal(result.status, 'failed')
  assert.match(result.error, /Checkpoint request changed at operation 1/)
  assert.equal(f.deadlines.length, 1, 'no new turns after mismatch')
  assert.equal(readFileSync(path, 'utf8'), before, 'the checkpoint is preserved')
})

test('resume preserves runtime limits and explicit overrides persist on subsequent resumes', async t => {
  const f = await pausedRun(t, ['--concurrency', '1', '--timeout-min', '2'])
  assert.deepEqual(f.metadata().runtimeOptions, { concurrency: 1, timeoutMin: 2 })
  await f.resume()
  assert.deepEqual(f.metadata().runtimeOptions, { concurrency: 1, timeoutMin: 2 })
  // Explicitly selecting the ordinary defaults must also override saved values.
  await f.resume(['--concurrency', '3'])
  assert.deepEqual(f.metadata().runtimeOptions, { concurrency: 3, timeoutMin: 2 })
  await f.resume(['--timeout-min', '90'])
  await f.resume()
  assert.deepEqual(f.metadata().runtimeOptions, { concurrency: 3, timeoutMin: 90 })
  assert.deepEqual(f.deadlines, ['2', '2', '2', '90', '90'])
})

test('resume falls back to ordinary runtime defaults when no settings were saved', async t => {
  const f = await pausedRun(t)
  const metadata = f.metadata(); delete metadata.runtimeOptions
  writeFileSync(join(f.first.hostRunDir, 'host.json'), JSON.stringify(metadata))
  await f.resume()
  assert.deepEqual(f.metadata().runtimeOptions, { concurrency: 3, timeoutMin: 90 })
})

test('resume recovers a torn event tail without losing prior turns or corrupting later appends', async t => {
  const f = await pausedRun(t)
  const extra = { type: 'turn.started', role: 'setup', job: 'interrupted', note: 'Unicode: é 🧪' }
  appendFileSync(f.first.hostEvents, JSON.stringify(extra) + '\n')
  const valid = readFileSync(f.first.hostEvents)
  const partial = Buffer.from('{"type":"🧪').subarray(0, -1)
  appendFileSync(f.first.hostEvents, partial)
  // Interrupted temporary metadata writes must not replace the last complete documents.
  for (const name of ['host', 'args', 'result', 'metrics']) writeFileSync(join(f.first.hostRunDir, `${name}.json.tmp`), '{"partial":')
  const result = await f.resume()
  assert.equal(result.metrics.turns, 3, 'completed intake, interrupted turn, new setup')
  assert.equal(result.metrics.turnsByRole.setup, 2)
  assert.deepEqual(f.deadlines, ['90', '90'], 'intake replays without a CLI call')
  const bytes = readFileSync(f.first.hostEvents)
  assert.ok(bytes.subarray(0, valid.length).equals(valid))
  const events = bytes.toString('utf8').trim().split('\n').map(JSON.parse)
  assert.ok(events.some(e => e.job === 'interrupted'))
  assert.equal(events.at(-1).type, 'run.completed')
})

test('resume retains a valid final event lacking its newline', async t => {
  const f = await pausedRun(t)
  appendFileSync(f.first.hostEvents, JSON.stringify({ type: 'turn.started', role: 'setup', job: 'last-valid-record' }))
  const result = await f.resume()
  assert.equal(result.metrics.turns, 3)
  assert.equal(readEventLog(f.first.hostEvents).filter(e => e.job === 'last-valid-record').length, 1)
})

test('resume rejects malformed completed event records without changing the log', async t => {
  for (const suffix of ['{"type":\n', '{"type":\n{"type":"later"}']) {
    const f = await pausedRun(t)
    appendFileSync(f.first.hostEvents, suffix)
    const before = readFileSync(f.first.hostEvents)
    await assert.rejects(f.resume, /Invalid event log .* at line/)
    assert.deepEqual(readFileSync(f.first.hostEvents), before)
    assert.equal(f.deadlines.length, 1, 'no new CLI turns on corrupt history')
  }
})

test('a failed metadata write leaves the previous JSON intact', t => {
  const f = fixture(t), file = join(f.hostRunDir, 'host.json')
  writeFileSync(file, '{"saved":true}\n')
  // Inject an interrupted write in a separate process, so no other test's fs changes.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path) => { write(path, '{"partial":'); throw new Error('Interrupted write'); };
    syncBuiltinESMExports();
    const { writeJsonAtomic } = await import(process.argv[1]);
    assert.throws(() => writeJsonAtomic(process.argv[2], {saved:false}), /Interrupted write/);
    assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), {saved:true});
  `, new URL('../plugins/dark-factory/lib/checkpoint.mjs', import.meta.url).href, file])
})

test('runner resumes a tier decision using the saved intake and a new setup operation', async t => {
  const f = fixture(t), calls = []
  const dependencies = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    assert.equal(argv[0], 'seat-run')
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const result = empty(schema)
    if ('tier' in result) { calls.push('intake'); Object.assign(result, { status: 'ok', tier: 'feature', mode: 'implement', strategy: 'independent' }) }
    else { calls.push('setup'); Object.assign(result, { status: 'error', error: 'Test stops at the setup boundary.' }) }
    return { status: 'done', result }
  } } }
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--tier', 'simple', 'Fix code']), dependencies)
  assert.equal(first.status, 'needs-tier')
  const second = await runWorkflow({ ...parseCLI(['--resume', first.hostRunDir]), args: { tierConfirmed: true } }, dependencies)
  assert.equal(second.status, 'failed')
  assert.deepEqual(calls, ['intake', 'setup'])
  assert.equal(second.hostRunDir, first.hostRunDir)
  assert.ok(readFileSync(second.hostEvents, 'utf8').includes('checkpoint.replayed'))
})

test('resume retains turns started after the last checkpoint even without a final result', async t => {
  const f = fixture(t)
  let turns = 0
  const dependencies = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    turns++
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    return { status: 'done', result: { ...empty(schema), status: 'ok', tier: 'feature', mode: 'implement', strategy: 'independent' } }
  } } }
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--tier', 'simple', 'Fix code']), dependencies)
  assert.equal(first.status, 'needs-tier')
  rmSync(join(first.hostRunDir, 'result.json'))
  appendFileSync(first.hostEvents, JSON.stringify({ type: 'turn.started', role: 'setup', job: 'interrupted-before-checkpoint' }) + '\n')
  const result = await runWorkflow({ ...parseCLI(['--resume', first.hostRunDir, '--max-turns', '2']), args: { tierConfirmed: true, maxTurns: 2 } }, dependencies)
  assert.equal(turns, 1)
  assert.equal(result.metrics.turns, 2)
  assert.equal(result.status, 'blocked')
  assert.match(result.stopReason, /turn budget exhausted/)
})

test('resume reuses specification review but amends criteria with the new answer', async t => {
  const f = fixture(t), calls = []
  const helper = new URL('../plugins/dark-factory/bin/dark-factory', import.meta.url)
  const dependencies = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const result = empty(schema)
    if ('runDir' in result) {
      calls.push('setup')
      const runId = prompt.match(/--run-id '([^']+)'/)[1]
      const created = JSON.parse(execFileSync(fileURLToPath(helper), ['init', '--repo', f.repo, '--seats', 'A,B', '--run-id', runId], { encoding: 'utf8' }).trim().split('\n').at(-1))
      writeFileSync(join(created.runDir, 'verify.sh'), 'true\n')
      Object.assign(result, { status: 'ok', mode: 'implement', runId, runDir: created.runDir, repoRoot: f.repo,
        criteria: [{ id: 'C1', text: 'Preserve the selected behavior.' }], verify: 'true', baselinePasses: true })
    } else if ('findings' in result && schema.properties.findings.items.properties.kind?.enum.includes('decision')) {
      calls.push('spec')
      result.findings = prompt.includes('# Your lens: coverage') ? [{ severity: 'major', kind: 'decision', criterion: 'C1', statement: 'Which boundary behavior?', evidence: 'The task permits either behavior.', change: 'Choose a boundary behavior.', readings: ['Keep it', 'Change it'] }] : []
    } else if ('rulings' in result) {
      calls.push('panel'); result.rulings = [{ finding: 'S1', verdict: 'decision', note: 'Requires user intent.' }]
    } else if ('applied' in result) {
      calls.push('amend'); assert.match(prompt, /Keep the existing boundary behavior/)
      Object.assign(result, { criteria: [{ id: 'C1', text: 'Keep the existing boundary behavior.' }], verify: 'true', baselinePasses: true, applied: [{ finding: 'S1', change: 'Use the user answer.' }] })
    } else return { status: 'error', error: 'Fixture stops before implementation.' }
    return { status: 'done', result }
  } } }
  const first = await runWorkflow({ ...parseCLI(['--cwd', f.repo, '--workflow', 'council', '--seats', 'astra,sol', 'Fix code']), args: { task: 'Fix code', seats: ['astra', 'sol'], spec: 'ask', retro: false } }, dependencies)
  assert.equal(first.status, 'needs-user', JSON.stringify(first))
  const original = [...calls]
  const second = await runWorkflow({ ...parseCLI(['--resume', first.hostRunDir]), args: { clarifications: [{ id: 'S1', answer: 'Keep the existing boundary behavior.' }] } }, dependencies)
  assert.equal(second.status, 'failed')
  assert.deepEqual(calls, [...original, 'amend'], 'only the answer-dependent amendment is a new turn')
})
