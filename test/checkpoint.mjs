import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs'
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
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--no-brief', '--tier', 'simple', ...flags, 'Fix code']), dependencies)
  assert.equal(first.status, 'needs-tier')
  const resume = flags => runWorkflow({ ...parseCLI(['--resume', first.hostRunDir, ...(flags || [])]), args: { tierConfirmed: true } }, dependencies)
  const metadata = () => JSON.parse(readFileSync(join(first.hostRunDir, 'host.json'), 'utf8'))
  return { ...f, first, resume, metadata, deadlines }
}

test('a failure the workflow carries on past is recorded and replays, so later operations stay reusable', async t => {
  const f = fixture(t), state = { checkpointState: () => ({ sequence: 1 }) }
  const base = { run: f.run, seat: 'A', label: 'base' }, review = { run: f.run, prompt: 'Spec review', label: 'spec' }
  const first = journalRuntime({ ...state, measure: async () => { throw new Error('helper crashed') }, agent: async () => ({ findings: [] }) }, f.opts)
  await assert.rejects(() => first.measure(base), /helper crashed/)
  assert.equal(existsSync(join(f.hostRunDir, 'checkpoint.json')), false, 'a failure alone is not committed')
  await first.agent(review)
  const saved = loadCheckpoint(f.hostRunDir, f.opts)
  assert.deepEqual(saved.entries.map(e => [e.method, e.label, e.error?.message || null]), [['measure', 'base', 'helper crashed'], ['agent', 'spec', null]])
  const live = () => { throw new Error('must reuse') }
  const resumed = journalRuntime({ ...state, measure: live, agent: live }, { ...f.opts, saved })
  await assert.rejects(() => resumed.measure(base), /helper crashed/, 'the recorded failure replays')
  assert.deepEqual(await resumed.agent(review), { findings: [] })
})

test('a failure the run stops at is not committed, so a resume retries it', async t => {
  const f = fixture(t), state = { checkpointState: () => ({ sequence: 1 }) }
  const request = { run: f.run, prompt: 'Author', label: 'author' }
  const first = journalRuntime({ ...state, agent: async r => r.label === 'setup' ? { ok: true } : null, measure: async () => ({ status: 'error' }) }, f.opts)
  await first.agent({ run: f.run, prompt: 'Setup', label: 'setup' })
  assert.equal(await first.agent(request), null)
  await first.measure({ run: f.run, seat: 'A', label: 'base' })
  first.finishCheckpoint()
  const saved = loadCheckpoint(f.hostRunDir, f.opts)
  assert.deepEqual(saved.entries.map(e => e.label), ['setup'])
  let retried = false
  const resumed = journalRuntime({ ...state, agent: async r => { if (r.label === 'author') retried = true; return { ok: true } } }, { ...f.opts, saved })
  await resumed.agent({ run: f.run, prompt: 'Setup', label: 'setup' })
  assert.deepEqual(await resumed.agent(request), { ok: true }); assert.equal(retried, true)
})

test('a recovered error status is committed, and an error that ends the run stops recording', async t => {
  const f = fixture(t), state = { checkpointState: () => ({ sequence: 1 }) }
  const runtime = journalRuntime({ ...state, measure: async () => ({ status: 'error', error: 'suite timed out' }), agent: async r => {
    if (r.label === 'limit') throw Object.assign(new Error('Run turn budget exhausted (3).'), { code: 'RUN_LIMIT' })
    return { ok: r.label }
  } }, f.opts)
  await runtime.measure({ run: f.run, seat: 'A', label: 'base' })
  await runtime.agent({ run: f.run, prompt: 'Review', label: 'review' })
  assert.deepEqual(loadCheckpoint(f.hostRunDir, f.opts).entries.map(e => [e.label, e.result]), [['base', { status: 'error', error: 'suite timed out' }], ['review', { ok: 'review' }]])
  const before = readFileSync(join(f.hostRunDir, 'checkpoint.json'), 'utf8')
  await assert.rejects(() => runtime.agent({ run: f.run, prompt: 'Over budget', label: 'limit' }), { code: 'RUN_LIMIT' })
  await runtime.agent({ run: f.run, prompt: 'After', label: 'after' })
  runtime.finishCheckpoint()
  assert.equal(readFileSync(join(f.hostRunDir, 'checkpoint.json'), 'utf8'), before)
})

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
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--no-brief', '--tier', 'simple', 'Fix code']), dependencies)
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
  const first = await runWorkflow(parseCLI(['--cwd', f.repo, '--no-brief', '--tier', 'simple', 'Fix code']), dependencies)
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

test('pair resume replays the spec review and sends a reworded repeat of the answered question to the author', async t => {
  const f = fixture(t), calls = []
  const helper = new URL('../plugins/dark-factory/bin/dark-factory', import.meta.url)
  const asked = 'C1 fixes tests/AlgebraTest.php, but tests of new code need their own files. Should the new tests go in tests/AlgebraTest.php, or in a separate file?'
  const reworded = 'Must the new tests be added to AlgebraTest.php or put in a separate test file?'
  const conflict = question => ({ criteria: ['C1'], statement: 'C1 fixes the test file.', quoted: [], evidence: 'tests/AlgebraTest.php:1', settle: 'user', reading: '', question, revisits: '', leftOpen: '' })
  const dependencies = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    // The runner measures the baseline itself, with the real helper.
    if (['measure', 'wait'].includes(argv[0])) return JSON.parse(execFileSync(fileURLToPath(helper), argv, { cwd: f.repo, encoding: 'utf8', env: { ...process.env, COUNCIL_JOB_POLL: '0.01' } }).trim().split('\n').at(-1))
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const result = empty(schema)
    if ('runDir' in result) {
      calls.push('setup')
      const runId = prompt.match(/--run-id '([^']+)'/)[1]
      const created = JSON.parse(execFileSync(fileURLToPath(helper), ['init', '--repo', f.repo, '--seats', 'A', '--run-id', runId], { encoding: 'utf8' }).trim().split('\n').at(-1))
      writeFileSync(join(created.runDir, 'verify.sh'), 'true\n')
      Object.assign(result, { status: 'ok', mode: 'implement', runId, runDir: created.runDir, repoRoot: f.repo, head: f.git('rev-parse', 'HEAD').trim(),
        criteria: [{ id: 'C1', text: 'The new tests cover the change.' }], verify: 'true', baselinePasses: true })
    } else if ('findings' in result) {
      calls.push('spec')
      result.findings = [conflict(prompt.includes('# Explicit user decisions') ? reworded : asked)]
    } else return { status: 'error', error: 'Fixture stops before the author.' }
    return { status: 'done', result }
  } } }
  const first = await runWorkflow({ ...parseCLI(['--cwd', f.repo, '--workflow', 'pair', 'Fix code']), args: { task: 'Fix code', retro: false } }, dependencies)
  assert.equal(first.status, 'needs-user', JSON.stringify(first))
  assert.deepEqual(first.questions.map(q => [q.id, q.kind]), [['Q1', 'spec']])
  const original = [...calls]
  const second = await runWorkflow({ ...parseCLI(['--resume', first.hostRunDir]), args: { clarifications: [{ id: 'Q1', answer: 'Put them in AlgebraTest.php.' }] } }, dependencies)
  assert.deepEqual(calls, [...original, 'setup', 'spec'], 'the first setup and spec review replay; only the answer-dependent turns are new')
  assert.equal(second.status, 'failed', 'the fixture stops at the author, which the repeat went to')
  assert.deepEqual(second.spec.findings.map(x => [x.id, x.pass, x.to, x.repeats]), [['S1', 'spec', 'user', ''], ['S2', 'spec-2', 'author', 'Q1']])
})

const goalTask = 'Look into missing pages.'
const goal = { outcome: 'Explain the “missing pages” report.', purpose: "Help the user's support team.",
  scope: 'Page listings.', nonGoals: 'Rebuilding the index.', acceptanceExamples: ['An archived page is accounted for.'],
  verification: 'Observe the reported page count.', delegated: ['testing', 'implementation', 'internal design'] }

function briefRunner(f, ambiguous = false) {
  const helper = fileURLToPath(new URL('../plugins/dark-factory/bin/dark-factory', import.meta.url))
  const labels = [], prompts = []
  const deps = { progress: () => {}, prepare: noPrepare, runtime: { execute: async argv => {
    if (argv[0] === 'preflight') return { status: 'ok' }
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    const v = empty(schema)
    prompts.push(prompt)
    if ('brief' in v) {
      v.brief = { ...goal }
      if ('questions' in v) {
        labels.push('challenge')
        if (ambiguous) v.questions = ['Deliverable?', 'Include archives?'].map((question, i) => ({
          question, wording: goalTask, evidence: 'Callers and documentation permit either.',
          outcomeA: i ? 'Live pages only' : 'Diagnosis', outcomeB: i ? 'All pages' : 'Fix',
          recommendation: i ? 'All pages' : 'Fix', changes: i ? 'Acceptance coverage' : 'Delivered artifact',
        }))
      } else if ('planMissing' in v) labels.push('shape')
      else {
        labels.push('answered')
        assert.ok(prompt.includes('Ship a fix') && prompt.includes('Include archives'))
        Object.assign(v.brief, { outcome: 'Restore missing pages.', acceptanceExamples: ['Archived pages appear again.'] })
      }
    } else if ('signals' in v) {
      labels.push('intake')
      Object.assign(v, { status: 'ok', tier: 'simple', mode: 'implement', strategy: ambiguous ? 'pair' : 'independent' })
    } else if ('runId' in v) {
      labels.push('setup')
      if (ambiguous) {
        if (prompt.includes('Keep the flags')) Object.assign(v, { status: 'error', error: 'End of fixture after answered Pair setup.' })
        else Object.assign(v, { status: 'needs-user', questions: ['Keep the existing flags?'] })
      } else {
        const runId = prompt.match(/--run-id '([^']+)'/)[1]
        const ref = prompt.match(/--ref '([^']+)'/)[1]
        const created = JSON.parse(execFileSync(helper, ['init', '--repo', f.repo, '--seats', 'A', '--run-id', runId, '--ref', ref], { encoding: 'utf8' }).trim().split('\n').at(-1))
        Object.assign(v, { status: 'ok', runId, runDir: created.runDir, repoRoot: f.repo, mode: 'implement',
          refs: created.refs.map(({ source, path, inWorktrees }) => ({ source, path, inWorktrees })),
          verify: 'true', criteria: [{ id: 'C1', text: 'Restore pages.' }], baselinePasses: true })
      }
    } else {
      labels.push('seat')
      return { status: 'error', error: 'Fixture ends at the first implementation turn.' }
    }
    return { status: 'done', result: v }
  } } }
  const launch = args => runWorkflow({ ...parseCLI(['--cwd', f.repo, goalTask]), args: { task: goalTask, retro: false, ...args } }, deps)
  const resume = (run, answers) => runWorkflow({ ...parseCLI(['--resume', run.hostRunDir]), args: { clarifications: answers } }, deps)
  return { labels, prompts, launch, resume, helper }
}

test('brief resume applies a batch and preserves subsequent routed Pair answers', async t => {
  const f = fixture(t), h = briefRunner(f, true)
  const first = await h.launch({})
  assert.equal(first.status, 'needs-user')
  assert.deepEqual(first.questions.map(q => q.id), ['B1', 'B2'])
  const firstAnswer = [{ id: 'B1', answer: 'Ship a fix' }]
  const partial = await h.resume(first, firstAnswer)
  assert.deepEqual(partial.questions.map(q => q.id), ['B2'])
  assert.deepEqual(h.labels, ['shape', 'challenge'])
  await assert.rejects(h.resume(first, [{ id: 'B1', answer: 'Change it' }]), /Existing clarification answers cannot change/)
  await assert.rejects(h.resume(first, [...firstAnswer, { id: 'B9', answer: 'Unknown' }]), /question from this paused run/)
  const answers = [...firstAnswer, { id: 'B2', answer: 'Include archives' }]
  const routed = await h.resume(first, answers)
  assert.deepEqual(h.labels, ['shape', 'challenge', 'answered', 'intake', 'setup'])
  assert.equal(routed.status, 'needs-user')
  assert.deepEqual(routed.questions.map(q => q.id), ['Q1'])
  const doc = JSON.parse(readFileSync(routed.briefFile, 'utf8'))
  assert.deepEqual(doc, routed.brief)
  assert.equal(doc.brief.outcome, 'Restore missing pages.')
  assert.deepEqual(doc.brief.acceptanceExamples, ['Archived pages appear again.'])
  assert.deepEqual(doc.decisions.map(({ id, answer }) => ({ id, answer })), answers)
  for (const value of [doc.brief.outcome, ...doc.brief.acceptanceExamples, ...answers.map(d => d.answer)]) {
    assert.ok(h.prompts[3].includes(value) && routed.report.markdown.includes(value), value)
  }
  const after = await h.resume(first, [...answers, { id: 'Q1', answer: 'Keep the flags' }])
  assert.deepEqual(h.labels, ['shape', 'challenge', 'answered', 'intake', 'setup', 'setup'])
  assert.ok(h.prompts.at(-1).includes('Keep the flags'))
  assert.deepEqual(after.decisions.map(d => d.id), ['Q1'])
})

function nativeFactory() {
  const source = readFileSync(new URL('../plugins/dark-factory/workflows/factory.js', import.meta.url), 'utf8').replace(/^export const meta\s*=/m, 'void')
  return new (Object.getPrototypeOf(async function () {}).constructor)('args', 'agent', 'phase', 'log', source)
}

function runNativeBriefCommand(repo, command) {
  const bin = fileURLToPath(new URL('../plugins/dark-factory/bin', import.meta.url))
  return JSON.parse(execFileSync('/bin/sh', ['-c', command], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH } }))
}

test('brief reuse requires a native saved artifact with the state selected by the challenge', async t => {
  const { repo } = fixture(t)
  const execute = nativeFactory()
  writeFileSync(join(repo, 'draft brief.json'), JSON.stringify(goal))
  const question = { question: 'What should ship?', wording: goalTask, outcomeA: 'Diagnosis', outcomeB: 'Fix',
    evidence: 'Both outcomes fit the existing docs.', recommendation: 'Fix', changes: 'Delivered artifact' }
  for (const questions of [[], [question]]) {
    const expected = questions.length ? 'provisional' : 'settled'
    for (const state of ['settled', 'provisional']) {
      const calls = []
      let saved
      const result = await execute({ task: goalTask, repo, explain: true }, (prompt, opts) => {
        calls.push(opts.label)
        const fields = empty(opts.schema)
        if (opts.label === 'brief shape') return { ...fields, brief: goal }
        if (opts.label === 'intake') return { ...fields, status: 'ok', tier: 'simple', mode: 'implement' }
        assert.equal(opts.label, 'brief challenge')
        const command = prompt.split('\n').find(line => line.startsWith('dark-factory brief '))
        saved = runNativeBriefCommand(repo, command.replace(' FILE ', " 'draft brief.json' ").replace(' STATE ', ' ' + state + ' '))
        return { ...fields, brief: saved.document.brief, briefFile: saved.briefFile, questions }
      }, () => {}, () => {})
      const disk = JSON.parse(readFileSync(saved.briefFile, 'utf8'))
      assert.deepEqual(disk, { version: 1, state, decisions: [], brief: goal })
      if (state !== expected) {
        assert.equal(result.status, 'failed')
        assert.equal(result.briefFile, undefined)
      } else {
        assert.equal(result.status, questions.length ? 'needs-user' : 'explained')
        assert.equal(result.briefFile, saved.briefFile)
        assert.deepEqual(result.brief, disk)
      }
      const reachesIntake = state === 'settled' && !questions.length
      assert.deepEqual(calls, ['brief shape', 'brief challenge', ...(reachesIntake ? ['intake'] : [])])
    }
  }
})

test('brief reuse reads the explained artifact and snapshots it into a separate tier run', async t => {
  const f = fixture(t), h = briefRunner(f)
  const first = await h.launch({ explain: true })
  assert.equal(first.status, 'explained')
  assert.deepEqual(h.labels, ['shape', 'challenge', 'intake'])
  const doc = JSON.parse(readFileSync(first.briefFile, 'utf8'))
  assert.deepEqual(doc.brief, goal)
  assert.deepEqual(doc, first.brief)
  assert.ok(first.report.markdown.includes(goal.purpose))
  const file = join(f.repo, "saved 'résumé' brief.json")
  writeFileSync(file, JSON.stringify(doc))
  const second = await h.launch({ brief: file })
  assert.deepEqual(h.labels.slice(3), ['intake', 'setup', 'seat'])
  assert.ok(h.prompts.slice(3).every(p => p.includes(goal.outcome) && p.includes(goal.purpose)))
  assert.ok(second.briefFile.startsWith(second.runDir + '/refs/'))
  assert.deepEqual(JSON.parse(readFileSync(second.briefFile)), doc)
  assert.deepEqual(second.brief, doc)
  // Execute the native intake's literal helper command as a transport would. The native
  // runtime has no direct filesystem binding and must use the helper within this one turn.
  const execute = nativeFactory()
  const nativeCalls = []
  const native = await execute({ task: goalTask, brief: file, explain: true, repo: f.repo }, (prompt, opts) => {
    nativeCalls.push(opts.label)
    const command = prompt.split('\n').find(line => line.startsWith('dark-factory brief '))
    const copy = runNativeBriefCommand(f.repo, command)
    return { ...empty(opts.schema), ...copy, status: 'ok', tier: 'simple', mode: 'implement' }
  }, () => {}, () => {})
  assert.deepEqual(nativeCalls, ['intake'])
  assert.deepEqual(native.brief, doc)
  assert.deepEqual(JSON.parse(readFileSync(native.briefFile)), doc)
  for (const [name, content] of [['missing', null], ['malformed', '{}'], ['provisional', JSON.stringify({ ...doc, state: 'provisional' })]]) {
    const badFile = join(f.repo, name)
    if (content) writeFileSync(badFile, content)
    const before = h.labels.length
    const bad = await h.launch({ brief: badFile, explain: true })
    assert.equal(bad.status, 'failed', name)
    assert.equal(h.labels.length, before)
  }
  writeFileSync(file, JSON.stringify(doc) + '\n')
  await assert.rejects(h.resume(second, []), /Checkpoint goal brief changed/)
  writeFileSync(first.briefFile, '{}')
  await assert.rejects(h.resume(first, []), /Checkpoint goal brief changed/)
})
