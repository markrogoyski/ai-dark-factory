import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { journalRuntime, loadCheckpoint } from '../plugins/dark-factory/lib/checkpoint.mjs'
import { runWorkflow, parseCLI } from '../plugins/dark-factory/lib/codex-runner.mjs'

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
  await assert.rejects(() => third.agent({ ...request, prompt: 'Changed task' }), /request changed/)
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

test('runner resumes a tier decision using the saved intake and a new setup operation', async t => {
  const f = fixture(t), calls = []
  const dependencies = { progress: () => {}, runtime: { execute: async argv => {
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
  const dependencies = { progress: () => {}, runtime: { execute: async argv => {
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
  const dependencies = { progress: () => {}, runtime: { execute: async argv => {
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
