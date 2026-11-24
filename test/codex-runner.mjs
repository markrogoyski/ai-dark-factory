import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, utimesSync, symlinkSync, chmodSync, cpSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { parseCLI, resultExitCode, validateResult, createLimiter, createRuntime, runWorkflow, keepAwake, briefResult, FACTORY_CHILDREN } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { readEventLog } from '../plugins/dark-factory/lib/checkpoint.mjs'
import { LIB, HANDOFF_LIB } from '../tools/sources.mjs'
import { loadLib } from './lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'plugins/dark-factory/bin/dark-factory-codex')
const object = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }

function temporary(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-codex-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function initRepo(path) {
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Factory test'])
  execFileSync('git', ['-C', path, 'config', 'user.email', 'factory@example.invalid'])
  writeFileSync(join(path, 'sum.cjs'), 'module.exports = (a, b) => a - b\n')
  writeFileSync(join(path, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2, 3), 5)\n")
  execFileSync('git', ['-C', path, 'add', '.'])
  execFileSync('git', ['-C', path, 'commit', '-qm', 'Add failing sum'])
}

function empty(schema) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, empty(value)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'string') return ''
  return 0
}

test('an engine failure still records effort metrics without inventing phase findings', async t => {
  const repo = temporary(t)
  initRepo(repo)
  const options = parseCLI(['--cwd', repo, '--workflow', 'pair', 'Fix sum'])
  options.args.repair = { maxPasses: 0 }
  const result = await runWorkflow(options, { progress: () => {}, runtime: { execute: () => { throw new Error('No CLI should run') } } })
  assert.equal(result.status, 'failed')
  assert.equal(result.metrics.turns, 0)
  assert.equal(result.metrics.readiness, 'incomplete')
  assert.equal(result.metrics.detailIncomplete, true)
  assert.equal(result.metrics.findingsByStage, null)
  assert.ok(existsSync(join(result.hostRunDir, 'metrics.json')))
})

test('CLI merges full arguments and explicit options without parsing task text as code', t => {
  const dir = temporary(t)
  const file = join(dir, 'args.json')
  writeFileSync(file, JSON.stringify({ task: 'old', tier: 'feature', simple: { reviewer: 'opus' }, spec: false }))
  const parsed = parseCLI(['--args-file', file, '--tier=simple', '--concurrency', '2', '--', 'Fix $(touch /tmp/no)'], dir)
  assert.equal(parsed.args.task, 'Fix $(touch /tmp/no)')
  assert.equal(parsed.args.tier, 'simple')
  assert.equal(parsed.args.simple.reviewer, 'opus')
  assert.equal(parsed.args.spec, false)
  assert.equal(parsed.concurrency, 2)
  assert.throws(() => parseCLI(['--concurrency', '0', 'task']), /positive integer/)
  assert.throws(() => parseCLI(['--workflow', '../../bad', 'task']), /factory or council/)
  assert.throws(() => parseCLI(['--unknown', 'task']), /Unknown option/)
  assert.equal(parseCLI(['--help']).help, true)
  const pair = parseCLI(['--workflow', 'pair', '--author', 'opus', '--reviewer', 'astra', '--max-reviews', '6', 'Build it'])
  assert.equal(pair.workflow, 'pair')
  assert.deepEqual(pair.args, { author: 'opus', reviewer: 'astra', maxReviews: 6, task: 'Build it' })
  assert.throws(() => parseCLI(['--author', 'opus', 'Build it']), /require --workflow pair/)
  assert.deepEqual(parseCLI(['--workflow', 'pair', '--max-design-reviews', '2', 'Build it']).args, { maxDesignReviews: 2, task: 'Build it' })
  assert.throws(() => parseCLI(['--max-design-reviews', '2', 'Build it']), /require --workflow pair/)
  const direct = parseCLI(['--workflow', 'pair', '--no-design', 'Write the plan'])
  assert.deepEqual(direct.args, { design: false, task: 'Write the plan' })
  assert.equal(direct.noDesign, undefined)
  assert.throws(() => parseCLI(['--no-design', 'Write the plan']), /--no-design requires --workflow pair/)
  const quiet = parseCLI(['--workflow', 'pair', '--no-retro', '--no-design', 'Write the plan'])
  assert.deepEqual(quiet.args, { retro: false, design: false, task: 'Write the plan' })
  assert.equal(quiet.noRetro, undefined)
  for (const workflow of ['factory', 'council', 'ensemble']) assert.throws(() => parseCLI(['--workflow', workflow, '--no-retro', 'Build it']), /--no-retro requires --workflow pair/)
})

test('schema validation rejects malformed or stale model outputs', () => {
  assert.deepEqual(validateResult({ ok: true }, object), { ok: true })
  assert.throws(() => validateResult({}, object), /missing required/)
  assert.throws(() => validateResult({ ok: 'true' }, object), /expected boolean/)
  assert.throws(() => validateResult({ ok: true, unexpected: 1 }, object), /unexpected field/)
  assert.throws(() => validateResult('old', { type: 'string', enum: ['new'] }), /enum/)
})

test('exit codes distinguish readiness from execution and decision states', () => {
  assert.equal(resultExitCode({ status: 'done', final: { readiness: { state: 'ready' } } }), 0)
  for (const status of ['needs-plan', 'needs-tier', 'needs-split', 'needs-user', 'blocked']) assert.equal(resultExitCode({ status }), 2)
  for (const state of ['blocked', 'incomplete']) assert.equal(resultExitCode({ status: 'done', final: { readiness: { state } } }), 2)
  for (const status of ['failed', 'error', 'preflight']) assert.equal(resultExitCode({ status }), 1)
  assert.equal(resultExitCode({ status: 'blocked', preflight: [{ vendor: 'codex', ok: false }] }), 1)
  assert.equal(resultExitCode({ status: 'done' }), 2, 'no proof of readiness must not report success')
})

test('limiter bounds turns, preserves result order, and releases slots on failure', async () => {
  const limit = createLimiter(2)
  let active = 0, peak = 0
  const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => limit(async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    if (i === 2) throw new Error('expected failure')
    return i
  })))
  assert.equal(peak, 2)
  assert.equal(active, 0)
  assert.equal(results[2].status, 'rejected')
  assert.equal(results[6].value, 6)
})

test('direct turns write exact payloads and preserve session, checkout and writable settings', async t => {
  const dir = temporary(t), seen = []
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, timeoutMin: 7, execute: async argv => {
    seen.push(argv)
    if (argv[0] === 'seat-run') return { status: 'running' }
    return { status: 'done', result: { ok: true } }
  } })
  const payload = 'literal `echo` $(touch nope) 🎲\n'
  const result = await runtime.turn({ prompt: payload, schema: object, vendor: 'codex', model: 'test', effort: 'high',
    key: 'A-r1', threadKey: 'A', fresh: false, cwd: join(dir, 'wt', 'A'), writable: [join(dir, 'room')], checkout: 'A-r0' })
  assert.equal(result.status, 'done')
  assert.equal(readFileSync(join(dir, 'jobs/A-r1.host.prompt.md'), 'utf8'), payload)
  assert.ok(seen[0].includes('--no-transcript'))
  assert.ok(!seen[0].includes('--fresh'))
  assert.equal(seen[0][seen[0].indexOf('--seat') + 1], 'A')
  assert.equal(seen[0][seen[0].indexOf('--checkout') + 1], 'A-r0')
  assert.equal(seen[0][seen[0].indexOf('--timeout-min') + 1], '7')
  assert.equal(seen[1][0], 'wait')
})

test('recovery evidence requires a current nonempty post and a retained session', async t => {
  const dir = temporary(t)
  for (const mode of ['valid', 'schema', 'missing', 'empty', 'stale', 'symlink', 'outside', 'no-session']) {
    const runDir = join(dir, mode)
    mkdirSync(runDir)
    const post = mode === 'outside' ? join(dir, 'outside.md') : join(runDir, 'room', 'r0', 'A.md')
    const runtime = createRuntime({ repo: dir, hostRunDir: runDir, execute: async () => {
      const jd = join(runDir, 'jobs', 'A-r0')
      mkdirSync(jd, { recursive: true })
      writeFileSync(join(jd, 'prompt.md'), 'original prompt')
      if (mode !== 'missing') {
        mkdirSync(join(runDir, 'room', 'r0'), { recursive: true })
        if (mode === 'symlink') symlinkSync(join(jd, 'prompt.md'), post)
        else writeFileSync(post, mode === 'empty' ? ' \n' : 'Completed post')
        if (mode === 'stale') utimesSync(post, 1, 1)
      }
      return { status: mode === 'schema' ? 'done' : 'error', error: 'timed out',
        thread: mode === 'no-session' ? undefined : 'session-A', result: { ok: 'invalid' } }
    } })
    const result = await runtime.turn({ key: 'A-r0', threadKey: 'A', vendor: 'claude', model: 'sonnet',
      role: 'seat', prompt: 'solve', schema: object, recoveryPost: post })
    assert.equal(result.status, 'error')
    assert.equal(result.recoverySession, ['valid', 'schema'].includes(mode) ? 'session-A' : undefined, mode)
  }
})

test('recovery passes the required session to the helper and keeps original job artifacts', async t => {
  const dir = temporary(t), calls = []
  mkdirSync(join(dir, 'jobs', 'A-r0'), { recursive: true })
  writeFileSync(join(dir, 'jobs', 'A-r0', 'out.json'), 'original diagnostic')
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, execute: async argv => {
    calls.push(argv)
    return { status: 'done', result: { ok: true } }
  } })
  await runtime.turn({ key: 'A-r0-recover', threadKey: 'A', vendor: 'claude', model: 'sonnet',
    prompt: 'return structured output', schema: object, resumeSession: 'session-A',
    sandbox: 'read-only', writable: [], effort: 'low', timeoutMin: 3, fresh: false })
  const argv = calls[0]
  assert.equal(argv[argv.indexOf('--resume-session') + 1], 'session-A')
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(argv[argv.indexOf('--timeout-min') + 1], '3')
  assert.ok(!argv.includes('--fresh'))
  assert.equal(readFileSync(join(dir, 'jobs', 'A-r0', 'out.json'), 'utf8'), 'original diagnostic')
})

test('shared seat recovery resumes the real helper job with a stub Claude CLI', async t => {
  const dir = temporary(t)
  initRepo(dir)
  const runDir = join(dir, '.council', 'recover'), bin = join(dir, 'bin')
  const room = join(runDir, 'room'), post = join(room, 'r0', 'A.md'), log = join(dir, 'calls.jsonl')
  mkdirSync(join(room, 'r0'), { recursive: true })
  mkdirSync(bin)
  const run = { runDir, room, repoRoot: dir, runId: 'recover' }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const stub = join(bin, 'claude')
  writeFileSync(stub, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
prompt = sys.stdin.read()
schema = json.loads(args[args.index('--json-schema') + 1])
session_flag = '--resume' if '--resume' in args else '--session-id'
session = args[args.index(session_flag) + 1]
with open(os.environ['RECOVERY_TEST_LOG'], 'a') as f:
    f.write(json.dumps({'args': args, 'prompt': prompt, 'session': session}) + '\\n')
out = {'subtype': 'success', 'session_id': session, 'usage': {'input_tokens': 7}}
if '--resume' in args:
    out['structured_output'] = {'summary': 'recovered', 'process': '', 'turn': schema['properties']['turn']['enum'][0]}
else:
    with open(os.environ['RECOVERY_TEST_POST'], 'w') as f:
        f.write('My completed independent post')
    out['result'] = 'Completed work, missing structured output'
print(json.dumps(out))
`)
  chmodSync(stub, 0o755)
  const runtime = createRuntime({ repo: dir, hostRunDir: runDir, timeoutMin: 1,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
      RECOVERY_TEST_POST: post, RECOVERY_TEST_LOG: log, COUNCIL_JOB_POLL: '0.01' } })
  const source = [...LIB, ...HANDOFF_LIB, 'src/boot.js', 'src/schemas.js', 'src/turns-core.js', 'src/turns.js'].map(f => readFileSync(join(root, f), 'utf8')).join('\n')
  const h = new Function('factoryRuntime', 'args', source + '\nreturn { state: S, seatTurn };')(runtime, { host: 'codex', task: 'Solve independently' })
  h.state.run = run
  const member = { L: 'A', key: 'sonnet', name: 'Claude Sonnet', vendor: 'claude', model: 'sonnet', effort: 'high', wt: dir }
  const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
  const result = await h.seatTurn(member, 0, 'Solve independently and publish your post.', schema)
  assert.equal(result.summary, 'recovered')
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].session, calls[1].session)
  assert.equal(calls[1].args[calls[1].args.indexOf('--tools') + 1], 'Read,Glob,Grep')
  assert.match(calls[1].prompt, /read only your own post/)
  assert.equal(readFileSync(post, 'utf8'), 'My completed independent post')
  assert.match(readFileSync(join(runDir, 'jobs', 'A-r0', 'out.json'), 'utf8'), /missing structured output/)
  const recoverySpec = JSON.parse(readFileSync(join(runDir, 'jobs', 'A-r0-recover', 'spec.json'), 'utf8'))
  assert.equal(recoverySpec.resumeSession, calls[0].session)
  assert.equal(recoverySpec.timeout, 60, 'recovery also respects the runner default deadline')
  assert.equal(readFileSync(join(runDir, 'usage.jsonl'), 'utf8').trim().split('\n').length, 2)
})

test('native agent roles use fresh contexts and reject invalid provider output', async t => {
  const dir = temporary(t), seen = []
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, gitDirs: [join(dir, '.git')], execute: async argv => {
    seen.push(argv)
    const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    return { status: 'done', result: { ok: true, turn: schema.properties.turn.enum[0] } }
  } })
  assert.deepEqual(await runtime.agent({ prompt: 'intake', schema: object, vendor: 'codex', model: 'test', role: 'intake' }), { ok: true })
  await runtime.agent({ prompt: 'setup', schema: object, vendor: 'codex', model: 'test', role: 'setup' })
  await runtime.agent({ prompt: 'amend', schema: object, vendor: 'codex', model: 'test', role: 'spec', label: 'spec amend', measures: true })
  await runtime.agent({ prompt: 'review', schema: object, vendor: 'codex', model: 'test', role: 'spec', label: 'spec coverage' })
  assert.ok(seen.every(argv => argv.includes('--fresh')))
  assert.equal(seen[0][seen[0].indexOf('--sandbox') + 1], 'read-only')
  assert.equal(seen[1][seen[1].indexOf('--cwd') + 1], dir)
  assert.ok(seen[1].includes(join(dir, '.git')))
  assert.ok(seen[2].includes(join(dir, '.git')), 'amendment can remeasure the baseline')
  assert.equal(seen[2][seen[2].indexOf('--sandbox') + 1], 'workspace-write')
  assert.equal(seen[3][seen[3].indexOf('--sandbox') + 1], 'read-only')
  assert.ok(!seen[3].includes(join(dir, '.git')), 'ordinary specification review remains read-only')
  const invalid = createRuntime({ repo: dir, hostRunDir: dir, execute: async () => ({ status: 'done', result: {} }) })
  assert.equal(await invalid.agent({ prompt: 'intake', schema: object, vendor: 'codex', model: 'test', role: 'intake' }), null)
})

test('preflight runs in the host and fails before launching the setup model', async t => {
  const dir = temporary(t), calls = []
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, execute: async argv => {
    calls.push(argv)
    return { status: 'error', vendors: { codex: { ok: false, error: 'Missing CLI' } } }
  } })
  const schema = { type: 'object', properties: { status: { type: 'string' }, preflight: { type: 'array', items: object }, error: { type: 'string' } } }
  const output = await runtime.agent({ prompt: 'setup', schema, vendor: 'codex', model: 'test', role: 'setup', preflightVendors: ['codex'] })
  assert.equal(output.status, 'preflight')
  assert.equal(output.preflight[0].error, 'Missing CLI')
  assert.deepEqual(calls, [['preflight', '--vendors', 'codex']])
})

test('measurement permissions follow the measures flag, not the display label', async t => {
  const dir = temporary(t), seen = []
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, gitDirs: [join(dir, '.git')], execute: async argv => {
    seen.push(argv)
    const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    return { status: 'done', result: { ok: true, turn: schema.properties.turn.enum[0] } }
  } })
  const base = { prompt: 'p', schema: object, vendor: 'codex', model: 'test', role: 'spec' }
  await runtime.agent({ ...base, label: 'renamed amendment', measures: true })
  await runtime.agent({ ...base, label: 'spec amend' })
  assert.ok(seen[0].includes(join(dir, '.git')), 'measures: true grants Git access under any label')
  assert.equal(seen[0][seen[0].indexOf('--sandbox') + 1], 'workspace-write')
  assert.ok(!seen[1].includes(join(dir, '.git')), 'the label alone grants nothing')
  assert.equal(seen[1][seen[1].indexOf('--sandbox') + 1], 'read-only')
})

test('permission diagnostics survive validation, host events and native role unwrapping', async t => {
  const dir = temporary(t), events = [], diagnostics = []
  const permissionDenials = { count: 1, tools: ['Bash'], source: join(dir, 'jobs/check/out.json') }
  let valid = true
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, emit: event => events.push(event), execute: async argv => {
    const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    return { status: 'done', permissionDenials, result: { ok: valid ? true : 'invalid', turn: schema.properties.turn.enum[0] } }
  } })
  const request = { prompt: 'check', schema: object, vendor: 'claude', model: 'sonnet', role: 'checker', onResult: r => diagnostics.push(r) }
  assert.deepEqual(await runtime.agent(request), { ok: true }, 'diagnostics must not alter the model output schema')
  valid = false
  assert.equal(await runtime.agent(request), null)
  assert.deepEqual(diagnostics.map(r => r.status), ['done', 'error'])
  assert.equal(diagnostics[1].errorClass, 'schema')
  for (const record of [...diagnostics, ...events.filter(e => e.type === 'turn.completed')]) {
    assert.deepEqual(record.permissionDenials, permissionDenials)
  }
})

test('custom model slugs get stable distinct filesystem-safe session and job keys', async t => {
  const dir = temporary(t), calls = []
  const runtime = createRuntime({ repo: dir, hostRunDir: dir, execute: async argv => {
    calls.push(argv)
    return { status: 'done', result: { ok: true } }
  } })
  for (const model of ['codex:custom-model', 'codex_custom-model']) {
    await runtime.turn({ prompt: 'review', schema: object, vendor: 'codex', model: 'custom-model',
      key: `panel-${model}-r0`, threadKey: `panel-${model}` })
  }
  const keys = calls.map(argv => argv[argv.indexOf('--job') + 1])
  assert.ok(keys.every(key => /^[\w.-]+$/.test(key)))
  assert.notEqual(keys[0], keys[1])
})

test('untrusted setup paths are rejected before host files can be created', async t => {
  const dir = temporary(t), repo = join(dir, 'repo'), outside = join(dir, 'outside')
  mkdirSync(repo); mkdirSync(outside)
  const runtime = createRuntime({ repo, hostRunDir: repo, execute: async () => { throw new Error('must not launch') } })
  await assert.rejects(runtime.turn({ run: { runDir: outside }, prompt: 'bad', schema: object }), /outside the repository/)
  assert.equal(existsSync(join(outside, 'jobs')), false)
  const invented = join(repo, '.council', 'invented')
  await assert.rejects(runtime.agent({ run: { runDir: invented }, role: 'checker', prompt: 'bad', schema: object }), /run.json/)
  assert.equal(existsSync(invented), false)
})

test('Pair setup base identity must match the helper run metadata', async t => {
  const repo = temporary(t), runDir = join(repo, '.council', 'pair-base')
  const run = { runDir, repoRoot: repo, runId: 'pair-base', head: 'b'.repeat(40) }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  let head = 'c'.repeat(40)
  const schema = { type: 'object', properties: Object.fromEntries(Object.keys(run).map(key => [key, { type: 'string' }])),
    required: Object.keys(run), additionalProperties: false }
  const runtime = createRuntime({ repo, hostRunDir: repo, execute: async argv => {
    const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const outputSchema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
    return { status: 'done', result: { ...run, head, turn: outputSchema.properties.turn.enum[0] } }
  } })
  const request = { prompt: 'setup', schema, role: 'setup', model: 'test', vendor: 'codex' }
  await assert.rejects(runtime.agent(request), /different original base commit/)
  head = run.head
  assert.deepEqual(await runtime.agent(request), run)
})

test('cancellation stops detached measurement commands and prevents queued model launches', async t => {
  const dir = temporary(t), repo = join(dir, 'repo'), runDir = join(repo, '.council', 'run')
  mkdirSync(join(runDir, 'logs'), { recursive: true })
  mkdirSync(join(runDir, 'jobs'))
  const run = { repoRoot: repo, runDir, runId: 'run' }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  writeFileSync(join(runDir, 'logs', 'suite-r0.log.pid'), String(child.pid))
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let finish
  const runtime = createRuntime({ repo, hostRunDir: dir, concurrency: 1, execute: async () => {
    entered()
    await new Promise(resolve => { finish = resolve })
    return { status: 'done', result: { ok: true } }
  } })
  const first = runtime.turn({ run, prompt: 'check', schema: object, key: 'first' })
  await started
  const queued = runtime.turn({ run, prompt: 'check', schema: object, key: 'queued' })
  runtime.cancel()
  finish()
  assert.equal((await first).status, 'error')
  await assert.rejects(queued, /interrupted/)
  const outcome = await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error('measurement survived cancellation')), 3000).unref())])
  assert.equal(outcome.signal, 'SIGTERM')
  assert.equal(existsSync(join(runDir, 'jobs', 'queued.host.prompt.md')), false)
})

test('factory decisions stop before setup while preserving input and machine-readable results', async t => {
  const dir = temporary(t), repo = join(dir, 'repo')
  initRepo(repo)
  let count = 0
  const result = await runWorkflow(parseCLI(['--cwd', repo, 'Implement the missing plan']), { progress: () => {}, prepare: async () => null, runtime: {
    execute: async argv => {
      count++
      const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
      const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
      return { status: 'done', result: { ...empty(schema), planMissing: 'PLAN.md' } }
    },
  } })
  assert.equal(result.status, 'needs-plan')
  assert.equal(resultExitCode(result), 2)
  assert.equal(count, 1)
  assert.equal(JSON.parse(readFileSync(join(result.hostRunDir, 'result.json'))).status, 'needs-plan')
  assert.equal(JSON.parse(readFileSync(join(result.hostRunDir, 'args.json'))).host, 'codex')
  assert.ok(existsSync(result.hostEvents))
})

test('full CLI Simple run uses actual worktrees, helper jobs and verification with a stub Codex', t => {
  const dir = temporary(t), repo = join(dir, 'repo'), bin = join(dir, 'bin'), home = join(dir, 'codex-home')
  initRepo(repo)
  mkdirSync(bin); mkdirSync(home)
  // Every provider the run can reach is the fixture, so preflight never probes an installed CLI.
  for (const cli of ['codex', 'claude']) writeFileSync(join(bin, cli), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
  const result = JSON.parse(execFileSync(process.execPath, [cli, '--cwd', repo, '--tier', 'simple', 'Fix sum to add its operands'], {
    encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
      FACTORY_TEST_REPO: repo, FACTORY_TEST_LOG: join(dir, 'calls.jsonl'), COUNCIL_JOB_POLL: '0.01' },
  }))
  assert.equal(result.status, 'done')
  assert.equal(result.final.readiness.state, 'ready')
  assert.match(readFileSync(join(repo, 'sum.cjs'), 'utf8'), /a - b/, 'main checkout remains untouched')
  assert.match(readFileSync(join(result.final.worktree, 'sum.cjs'), 'utf8'), /a \+ b/)
  execFileSync(process.execPath, ['check.cjs'], { cwd: result.final.worktree })
  assert.match(execFileSync('git', ['-C', repo, 'show', result.final.snapshotRef + ':sum.cjs'], { encoding: 'utf8' }), /a \+ b/)
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.some(call => call.kind === 'checker'))
  assert.ok(calls.some(call => call.kind === 'audit'))
  assert.ok(calls.some(call => call.kind === 'record'))
  assert.equal(new Set(calls.map(call => call.thread)).size, calls.length, 'the Simple clean path uses independent contexts')
  assert.ok(result.retro.saved && existsSync(result.retro.saved), 'facts are recorded without Claude transcripts')
})

test('installed pair workflow runs both author/reviewer directions and repeated reviews with stub CLIs', t => {
  for (const author of ['sol', 'opus']) {
    const dir = temporary(t), repo = join(dir, 'repo'), bin = join(dir, 'bin')
    initRepo(repo); mkdirSync(bin)
    mkdirSync(join(repo, 'tests'))
    writeFileSync(join(repo, 'tests/preserved.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2, 0), 2)\n")
    execFileSync('git', ['-C', repo, 'add', 'tests'])
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'Add preserved test root'])
    for (const cli of ['codex', 'claude']) writeFileSync(join(bin, cli), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
    execFileSync('bash', [join(root, 'install-codex.sh'), '--repo', repo], { encoding: 'utf8' })
    const result = JSON.parse(execFileSync(process.execPath, [join(repo, '.agents/skills/dark-factory/scripts/run.mjs'),
      '--cwd', repo, '--workflow', 'pair', '--author', author, 'Fix sum to add its operands'], {
      encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
        FACTORY_TEST_REPO: repo, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: join(dir, 'calls.jsonl'),
        PAIR_TEST_FIXES: '1', COUNCIL_JOB_POLL: '0.01' },
    }))
    assert.equal(result.status, 'done')
    assert.equal(result.final.readiness.state, 'ready')
    const summary = JSON.parse(readFileSync(result.summaryFile, 'utf8'))
    assert.deepEqual(summary.final.readiness, result.final.readiness)
    assert.equal(summary.final.snapshotTree, result.final.snapshotTree)
    assert.equal(summary.reviews, undefined, 'compact summary omits the full review history')
    assert.equal(JSON.parse(readFileSync(result.hostEvents, 'utf8').trim().split('\n').at(-1)).summary, result.summaryFile)
    const savedResult = JSON.parse(readFileSync(join(result.runDir, 'result.json'), 'utf8'))
    assert.equal(savedResult.artifactType, 'dark-factory-result')
    assert.equal(savedResult.artifactVersion, 1)
    assert.equal(summary.artifactType, 'dark-factory-summary')
    assert.equal(summary.artifactVersion, 1)
    assert.deepEqual(savedResult.reviews, result.reviews)
    assert.deepEqual(result.reviews.map(r => r.stage), ['design', 'code', 'code', 'code'])
    assert.ok(result.findings.every(f => f.status === 'fixed'))
    assert.deepEqual(result.final.replay.records.map(r => [r.side, r.passed]), [['base', false], ['final', true], ['base', true], ['final', true]])
    assert.match(readFileSync(join(repo, 'sum.cjs'), 'utf8'), /a - b/, 'delivery stays separate')
    assert.match(readFileSync(join(result.final.worktree, 'sum.cjs'), 'utf8'), /a \+ b/)
    assert.equal(result.final.snapshotTree, execFileSync('git', ['-C', repo, 'rev-parse', `${result.final.snapshotRef}^{tree}`], { encoding: 'utf8' }).trim())
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const authors = calls.filter(c => ['pair-design', 'pair-implement'].includes(c.kind))
    const reviewers = calls.filter(c => c.kind === 'pair-review')
    assert.equal(new Set(authors.map(c => c.thread)).size, 1, 'author keeps its session')
    assert.equal(new Set(reviewers.map(c => c.thread)).size, 4, 'each review starts fresh')
    assert.ok(reviewers.every(c => c.cwd.includes('/snap/pair-review-')))
    assert.ok(authors.every(c => c.vendor === (author === 'sol' ? 'codex' : 'claude')))
    assert.ok(reviewers.every(c => c.vendor === (author === 'sol' ? 'claude' : 'codex')))
    assert.equal(new Set(calls.map(c => c.vendor)).size, 2)
    assert.equal(calls.filter(c => c.kind === 'retro').length, 1, 'a standalone pair run ends with the model retro')
    assert.ok(result.retro.saved && existsSync(result.retro.saved), 'the retro is saved outside the run')
    // Every model turn's tokens, by role and model, with the per-turn lines beside the result.
    const tokens = result.metrics.tokens
    assert.equal(tokens.version, 2); assert.equal(tokens.complete, true, JSON.stringify(tokens.missing))
    assert.equal(tokens.records, calls.length, 'one counted turn per model CLI call')
    // The stubs report 10 in / 10 out per call; a resumed Codex session reports its running total,
    // so its later turns count the difference, which the stub leaves at 0.
    const lines = JSON.parse(readFileSync(tokens.turnsFile, 'utf8')).turns
    assert.equal(lines.length, calls.length)
    assert.ok(lines.every(l => [0, 10].includes(l.input) && l.source === 'helper-usage'), JSON.stringify(lines))
    assert.deepEqual([tokens.total.input, tokens.total.output], [lines.reduce((n, l) => n + l.input, 0), lines.reduce((n, l) => n + l.output, 0)])
    assert.ok(tokens.byRole.author.turns >= 2 && tokens.byRole.reviewer.turns === 4, JSON.stringify(tokens.byRole))
    // The milestones carry the running total; the report has it per model.
    const logged = readFileSync(result.hostEvents, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'log').map(e => e.message)
    assert.ok(logged.some(m => /^pair: .* · tokens so far: \d+ in \/ \d+ out$/.test(m)), logged.join('\n'))
    assert.match(result.report.markdown, /### Token use\n\n\| Model \| Turns \| Input \| Cached \| Cache writes \| Output \| Turn time \|/)
    // A crash can leave the last valid checkpoint without a final result file.
    rmSync(join(result.hostRunDir, 'result.json'))
    const resumed = JSON.parse(execFileSync(process.execPath, [cli, '--resume', result.hostRunDir], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    assert.equal(resumed.final.snapshotTree, result.final.snapshotTree)
    assert.deepEqual(resumed.findings, result.findings)
    assert.deepEqual(resumed.final.replay, result.final.replay)
    assert.equal(resumed.metrics.turns, result.metrics.turns)
    assert.deepEqual(resumed.metrics.turnsByRole, result.metrics.turnsByRole)
    assert.deepEqual(resumed.metrics.tokens.total, tokens.total, 'a replayed run counts the turns it ran once')
    assert.equal(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, calls.length, 'checkpoint replay launches no model CLI')
    execFileSync('git', ['-C', repo, 'apply', result.final.diff])
    const helper = join(root, 'plugins/dark-factory/bin/dark-factory')
    const invoke = args => JSON.parse(execFileSync(helper, args, { cwd: repo, encoding: 'utf8', timeout: 15_000 }).trim().split('\n').at(-1))
    let delivery = invoke(['verify-delivery', '--run-dir', result.runDir, '--result', join(result.hostRunDir, 'result.json'), '--max-wait', '5'])
    while (delivery.status === 'running') delivery = invoke(['wait', '--run-dir', result.runDir, '--job', delivery.job, '--max-wait', '5'])
    assert.equal(delivery.status, 'delivered', JSON.stringify(delivery))
    assert.equal(delivery.validation.passed, true)
  }
})

test('Ensemble uses real isolated snapshots and fresh reviewers through stub CLIs', t => {
  const dir = temporary(t), repo = join(dir, 'repo'), bin = join(dir, 'bin')
  initRepo(repo); mkdirSync(bin)
  // Every provider the run can reach is the fixture, so preflight never probes an installed CLI.
  for (const cli of ['codex', 'claude']) writeFileSync(join(bin, cli), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
  let stdout
  try {
    execFileSync(process.execPath, [cli, '--cwd', repo, '--workflow', 'ensemble', '--seats', 'sol,astra', 'Fix sum to add its operands'], {
      encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(dir, 'codex-home'),
        FACTORY_TEST_REPO: repo, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: join(dir, 'calls.jsonl'), COUNCIL_JOB_POLL: '0.01' },
    })
    assert.fail('Advisory selection must return exit 2')
  } catch (error) { assert.equal(error.status, 2, String(error.stderr)); stdout = error.stdout }
  const result = JSON.parse(stdout)
  assert.equal(result.status, 'advisory')
  assert.ok(result.candidates.every(c => c.final.readiness.state === 'ready'), JSON.stringify(result))
  assert.equal(new Set(result.candidates.map(c => c.final.worktree)).size, 2)
  assert.match(readFileSync(join(repo, 'sum.cjs'), 'utf8'), /a - b/)
  for (const c of result.candidates) assert.equal(c.final.snapshotTree, execFileSync('git', ['-C', repo, 'rev-parse', `${c.final.snapshotRef}^{tree}`], { encoding: 'utf8' }).trim())
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const reviews = calls.filter(c => c.kind === 'ensemble-review')
  assert.equal(reviews.length, 4)
  assert.equal(new Set(reviews.map(c => c.thread)).size, 4)
  assert.ok(reviews.every(c => c.cwd.includes('/snap/ensemble-')))
})

test('a standalone run keeps the Mac awake with caffeinate unless disabled or off macOS', () => {
  const calls = []
  const start = (cmd, args, opts) => { calls.push([cmd, args, opts]); return { unref() { calls.push('unref') } } }
  keepAwake({ platform: 'darwin', env: {}, pid: 42, start })
  assert.deepEqual(calls, [['caffeinate', ['-i', '-w', '42'], { detached: true, stdio: 'ignore' }], 'unref'])
  calls.length = 0
  assert.equal(keepAwake({ platform: 'darwin', env: { DARK_FACTORY_KEEP_AWAKE: '0' }, pid: 42, start }), null)
  assert.equal(keepAwake({ platform: 'linux', env: {}, pid: 42, start }), null)
  assert.deepEqual(calls, [])
})

test('--brief prints what a transport relays and points at the full result', () => {
  assert.equal(parseCLI(['--workflow', 'pair', '--brief', '--', 'Do it'], '/repo').brief, true)
  const result = { status: 'ready', stage: 'code', design: 'x'.repeat(50000), testContract: { checks: [] }, reviews: [{}], task: 'long', forTheOrchestrator: 'Read final.readiness first.',
    findings: [{ id: 'P1', stage: 'design', severity: 'minor', status: 'fixed', statement: 's'.repeat(400), evidence: 'e', history: [] }],
    final: { worktree: '/wt', post: '/repo/.council/host-a/room/pair-code-2/A.md', snapshotRef: 'r', diff: 'd'.repeat(20000), readiness: { state: 'ready' } }, metrics: { turns: 9 }, hostRunDir: '/repo/.council/host-a' }
  const brief = briefResult(result)
  assert.deepEqual(Object.keys(brief).sort(), ['final', 'findings', 'forTheOrchestrator', 'hostRunDir', 'metrics', 'resultFile', 'stage', 'status'])
  assert.deepEqual(brief.final, { worktree: '/wt', post: '/repo/.council/host-a/room/pair-code-2/A.md', snapshotRef: 'r', readiness: { state: 'ready' } })
  assert.deepEqual(brief.findings, [{ id: 'P1', stage: 'design', severity: 'minor', status: 'fixed', statement: 's'.repeat(300) }])
  assert.equal(brief.resultFile, '/repo/.council/host-a/result.json')
  assert.equal(brief.forTheOrchestrator, 'Read final.readiness first.')
  assert.ok(!('design' in brief) && !('reviews' in brief) && !('task' in brief))
  const capped = briefResult({ ...result, forTheOrchestrator: 'g'.repeat(9000) }).forTheOrchestrator
  assert.ok(capped.length < 4100 && capped.endsWith('resultFile]'))
  assert.ok(JSON.stringify(brief).length < 1000)
  const retro = { worked: [{ what: 'w' }], changes: [{ change: 'c' }], saved: '/r.md', error: '', notes: [{ turn: 't', text: 'n'.repeat(400) }], markdown: '### Process retro' }
  assert.deepEqual(briefResult({ ...result, retro }).retro, { saved: '/r.md', error: '', markdown: '### Process retro' })
})

// A Pair stop for the user continues on the runner with --resume and the answers appended: the
// runner checks every answer against the run's questions before any turn, replays the turns before
// the stop from its checkpoint, and keeps one retro.
function pairAsking(t, ask = '1') {
  const dir = temporary(t), repo = join(dir, 'repo'), bin = join(dir, 'bin'), log = join(dir, 'calls.jsonl')
  initRepo(repo); mkdirSync(bin)
  mkdirSync(join(repo, 'tests'))
  writeFileSync(join(repo, 'tests/preserved.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2, 0), 2)\n")
  execFileSync('git', ['-C', repo, 'add', 'tests'])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'Add preserved test root'])
  for (const name of ['codex', 'claude']) writeFileSync(join(bin, name), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude-home'),
    FACTORY_TEST_REPO: repo, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: log, PAIR_TEST_ASK: ask, COUNCIL_JOB_POLL: '0.01' }
  let files = 0
  const runner = (args, answers) => {
    const extra = answers ? ['--args-file', join(dir, `args-${++files}.json`)] : []
    if (answers) writeFileSync(extra[1], JSON.stringify(answers))
    const r = spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', timeout: 90_000, env })
    return { ...JSON.parse(r.stdout), exitCode: r.status }
  }
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  const first = initial => runner(['--cwd', repo, '--workflow', 'pair', '--author', 'sol', ...(initial ? [] : ['Fix sum to add its operands'])],
    initial && { task: 'Fix sum to add its operands', ...initial })
  return { runner, calls, first }
}
const settle = ' Answer every question at this stop under its ID, and only questions this run asked.'

test('resume: a runner Pair stop continues with the answers, after unknown ones are refused before any turn', t => {
  const { runner, calls, first } = pairAsking(t)
  const stopped = first()
  assert.equal(stopped.status, 'needs-user', JSON.stringify(stopped.error || stopped.stopReason))
  assert.equal(stopped.exitCode, 2)
  assert.deepEqual(stopped.questions, [{ id: 'Q1', about: 'none', kind: 'author', question: 'Keep the old flag?' }])
  assert.equal(stopped.resumable, true)
  assert.match(stopped.resumeSteps, new RegExp(`dark-factory-codex --resume ${stopped.hostRunDir.replace(/[.]/g, '\\.')} --args-file <that file>`))
  assert.equal(calls().filter(c => c.kind === 'retro').length, 1)
  const before = calls().length
  const saved = name => readFileSync(join(stopped.hostRunDir, name), 'utf8')
  const kept = { args: saved('args.json'), result: saved('result.json'), checkpoint: saved('checkpoint.json') }

  // (a) An ID the run never asked: needs-user again, naming it, before anything is written.
  const unknown = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q9', answer: 'x' }] })
  assert.equal(unknown.status, 'needs-user')
  assert.equal(unknown.exitCode, 2)
  assert.equal(unknown.stopReason, `The answers do not settle this stop (Q1). Missing: Q1. Unknown: Q9.${settle}`)
  assert.deepEqual(unknown.answerIssues, { missing: ['Q1'], unknown: ['Q9'], invalid: [] })
  assert.equal(unknown.resumable, true)
  assert.equal(calls().length, before, 'no CLI launched')
  assert.deepEqual({ args: saved('args.json'), result: saved('result.json'), checkpoint: saved('checkpoint.json') }, kept)

  // (b) The answer: no turn before the stop runs again, and the run completes with one retro.
  const done = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q1', answer: 'yes' }] })
  assert.equal(done.status, 'done', JSON.stringify(done.error || done.stopReason))
  assert.equal(done.final.readiness.state, 'ready')
  assert.deepEqual(done.decisions.map(d => [d.id, d.answer, d.label]), [['Q1', 'yes', 'pair-design-1']])
  const fresh = calls().slice(before)
  assert.equal(fresh[0].kind, 'pair-design')
  assert.equal(fresh[0].decisions, true, 'the first new launch is the answered author turn')
  assert.equal(calls().filter(c => c.kind === 'retro').length, 2, 'the stopped run and the continued run each ran one retro')
  const entries = JSON.parse(saved('checkpoint.json')).entries
  assert.deepEqual(entries.filter(e => e.label === 'retro').length, 1, 'the checkpoint keeps one retro')
  assert.equal(entries.at(-1).label, 'retro')
})

test('resume: an answer saved with the first arguments that no stop took is unknown until removed', t => {
  const { runner, calls, first } = pairAsking(t)
  const stopped = first({ clarifications: [{ id: 'Q9', answer: 'x' }] })
  assert.equal(stopped.status, 'needs-user')
  assert.deepEqual(stopped.unusedAnswers, ['Q9'])
  const before = calls().length
  const refused = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q9', answer: 'x' }, { id: 'Q1', answer: 'yes' }] })
  assert.equal(refused.status, 'needs-user')
  assert.equal(refused.stopReason, `The answers do not settle this stop (Q1). Unknown: Q9.${settle}`)
  assert.equal(calls().length, before)
  const done = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q1', answer: 'yes' }] })
  assert.equal(done.status, 'done', JSON.stringify(done.error || done.stopReason))
  assert.deepEqual(done.unusedAnswers, [])
})

test('resume: a runner Pair stop resumed without its answers names the missing ones before any turn', t => {
  const { runner, calls, first } = pairAsking(t)
  const stopped = first()
  assert.equal(stopped.status, 'needs-user')
  const before = calls().length
  const saved = name => readFileSync(join(stopped.hostRunDir, name), 'utf8')
  const kept = { args: saved('args.json'), result: saved('result.json'), checkpoint: saved('checkpoint.json') }
  for (const answers of [undefined, { clarifications: [] }]) {
    const again = runner(['--resume', stopped.hostRunDir], answers)
    assert.equal(again.status, 'needs-user', JSON.stringify(again.error))
    assert.equal(again.exitCode, 2)
    assert.equal(again.stopReason, `The answers do not settle this stop (Q1). Missing: Q1.${settle}`)
    assert.deepEqual(again.answerIssues, { missing: ['Q1'], unknown: [], invalid: [] })
    assert.equal(again.resumable, true)
    assert.ok(!('retro' in again))
    assert.equal(calls().length, before, 'no CLI launched')
    assert.deepEqual({ args: saved('args.json'), result: saved('result.json'), checkpoint: saved('checkpoint.json') }, kept)
  }
})

test('resume: a repeated answer to an earlier stop is named before any turn, and a changed one is still refused', t => {
  const { runner, calls, first } = pairAsking(t, '2')
  const stopped = first()
  assert.deepEqual(stopped.questions.map(q => q.id), ['Q1'])
  const q1 = { id: 'Q1', answer: 'yes' }, q2 = { id: 'Q2', answer: 'no' }
  const second = runner(['--resume', stopped.hostRunDir], { clarifications: [q1] })
  assert.equal(second.status, 'needs-user', JSON.stringify(second.error || second.stopReason))
  assert.deepEqual(second.questions, [{ id: 'Q2', about: 'none', kind: 'author', question: 'Rename the option?' }])
  assert.deepEqual(second.decisions.map(d => d.id), ['Q1'])
  const before = calls().length
  const repeated = runner(['--resume', stopped.hostRunDir], { clarifications: [q1, q1, q2] })
  assert.equal(repeated.status, 'needs-user', JSON.stringify(repeated.error))
  assert.equal(repeated.exitCode, 2)
  assert.equal(repeated.stopReason, `The answers do not settle this stop (Q2). Unknown: Q1 (repeated).${settle}`)
  assert.deepEqual(repeated.answerIssues, { missing: [], unknown: ['Q1 (repeated)'], invalid: [] })
  const missing = runner(['--resume', stopped.hostRunDir], { clarifications: [q1] })
  assert.equal(missing.stopReason, `The answers do not settle this stop (Q2). Missing: Q2.${settle}`)
  const changed = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q1', answer: 'no' }, q2] })
  assert.equal(changed.status, 'failed')
  assert.equal(changed.error, 'Existing clarification answers cannot change on resume.')
  assert.equal(calls().length, before, 'no CLI launched')
  const done = runner(['--resume', stopped.hostRunDir], { clarifications: [q1, q2] })
  assert.equal(done.status, 'done', JSON.stringify(done.error || done.stopReason))
  assert.deepEqual(done.decisions.map(d => d.id), ['Q1', 'Q2'])
})

test('resume: a runner Pair stop whose worktree changed is refused before any turn', t => {
  const { runner, calls, first } = pairAsking(t)
  const stopped = first()
  assert.equal(stopped.status, 'needs-user')
  writeFileSync(join(stopped.final.worktree, 'stray.txt'), 'written after the stop\n')
  const before = calls().length
  const refused = runner(['--resume', stopped.hostRunDir], { clarifications: [{ id: 'Q1', answer: 'yes' }] })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.error, 'Checkpoint worktree or snapshot changed, possibly by an interrupted write. Start a new run; no files were reset.')
  assert.equal(calls().length, before, 'no CLI launched')
})

function copyChildPlugin(t, bodies) {
  const dir = temporary(t), repo = join(dir, 'repo'), plugin = join(dir, 'plugin')
  initRepo(repo)
  cpSync(join(root, 'plugins', 'dark-factory'), plugin, {
    recursive: true, filter: path => !path.endsWith('/__pycache__'),
  })
  for (const [name, body] of Object.entries(bodies)) {
    writeFileSync(join(plugin, 'workflows', `${name}.js`), `export const meta = { name: '${name}', description: 'Fixture workflow' }\n${body}\n`)
  }
  return { dir, repo, plugin, runnerURL: pathToFileURL(join(plugin, 'lib', 'codex-runner.mjs')).href }
}

async function childWorkflowFixture(t, bodies) {
  const { repo, runnerURL } = copyChildPlugin(t, bodies)
  const runner = await import(runnerURL)
  return (workflow = 'factory', args = {}) => runner.runWorkflow(
    { ...runner.parseCLI(['--cwd', repo, '--workflow', workflow, 'Exercise child workflow dispatch']), args },
    { prepare: async () => null, progress: () => {}, runtime: { execute: () => assert.fail('Unexpected CLI launch') } },
  )
}

function workflowEvents(result) {
  return readFileSync(result.hostEvents, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type.startsWith('workflow.') || event.type === 'log')
    .map(event => [event.type, event.name ?? event.message])
}

test('the Factory runner registry matches the handoff child workflows', () => {
  assert.deepEqual(FACTORY_CHILDREN, [...new Set(Object.values(loadLib().HANDOFF_CHILD))].sort())
})

test('Factory runs both children with fresh args and the same host bindings', async t => {
  const run = await childWorkflowFixture(t, {
    factory: `
const input = { tag: 'one', nested: { values: [1] } }
budget.host = { agent, parallel, pipeline, phase, log, factoryRuntime }
budget.error = Object.assign(new Error('Child broke'), { code: 'CHILD_BROKE' })
const first = await workflow('dark-factory:council', input)
const second = await workflow('dark-factory:pair', { tag: 'two' })
const third = await workflow('dark-factory:council', { tag: 'three' })
let caught
try {
  await workflow('dark-factory:council', { reject: true })
} catch (error) {
  caught = { same: error === budget.error, message: error.message, code: error.code }
}
return { status: 'done', first, second, third, input, sameReturn: second === budget.pairResult, caught }
`,
    council: `
if (args.reject) throw budget.error
log(meta.name + ' ' + args.tag)
args.nested?.values.push(2)
const bindings = { agent, parallel, pipeline, phase, log, factoryRuntime }
return { child: meta.name, tag: args.tag, values: args.nested?.values ?? [],
  sharedHost: Object.keys(bindings).every(key => bindings[key] === budget.host[key]) }
`,
    pair: `
log(meta.name + ' ' + args.tag)
return budget.pairResult = { child: meta.name, tag: args.tag }
`,
  })
  const result = await run()
  assert.equal(result.status, 'done', result.error)
  assert.deepEqual(result.first, { child: 'council', tag: 'one', values: [1, 2], sharedHost: true })
  assert.deepEqual(result.second, { child: 'pair', tag: 'two' })
  assert.deepEqual(result.third, { child: 'council', tag: 'three', values: [], sharedHost: true })
  assert.deepEqual(result.input, { tag: 'one', nested: { values: [1] } })
  assert.equal(result.sameReturn, true)
  assert.deepEqual(result.caught, { same: true, message: 'Child broke', code: 'CHILD_BROKE' })
  assert.equal(JSON.parse(readFileSync(join(result.hostRunDir, 'host.json'), 'utf8')).workflow, 'factory')
  const events = workflowEvents(result)
  assert.deepEqual(events.slice(0, 9), [
    ['workflow.started', 'dark-factory:council'], ['log', 'council one'], ['workflow.completed', 'dark-factory:council'],
    ['workflow.started', 'dark-factory:pair'], ['log', 'pair two'], ['workflow.completed', 'dark-factory:pair'],
    ['workflow.started', 'dark-factory:council'], ['log', 'council three'], ['workflow.completed', 'dark-factory:council'],
  ])
  assert.deepEqual(events.slice(9).filter(([type]) => type === 'workflow.started'), [
    ['workflow.started', 'dark-factory:council'],
  ])
})

test('Factory child calls preserve structured values and omitted args', async t => {
  const run = await childWorkflowFixture(t, {
    factory: `
const input = { day: new Date('2025-01-01T00:00:00Z'), counts: new Map([['a', 1]]), missing: undefined }
const copy = await workflow('dark-factory:pair', input)
const omitted = await workflow('dark-factory:pair')
return { status: 'done', copy, omitted, originalCount: input.counts.get('a') }
`,
    pair: `
if (args === undefined) return 'omitted'
args.counts.set('a', 2)
return { day: args.day.getTime(), count: args.counts.get('a'),
  hasUndefined: Object.hasOwn(args, 'missing') && args.missing === undefined }
`,
  })
  const result = await run()
  assert.equal(result.status, 'done', result.error)
  assert.deepEqual(result.copy, { day: Date.UTC(2025, 0, 1), count: 2, hasUndefined: true })
  assert.equal(result.omitted, 'omitted')
  assert.equal(result.originalCount, 1)
})

test('Factory rejects unknown and non-string workflow names before starting a child', async t => {
  const run = await childWorkflowFixture(t, {
    factory: `
const cycle = {}
cycle.self = cycle
const hostile = { toString() { throw new Error('coerced') }, toJSON() { throw new Error('serialized') } }
const names = ['council', 'pair', 'dark-factory:factory', 'dark-factory:ensemble', 'dark-factory:run-plan',
  'dark-factory:missing', 'dark-factory:', 'dark-factory:pair\\n', null, undefined, 1n, Symbol('child'),
  cycle, hostile, ['dark-factory:pair'], () => {}]
const errors = []
for (const name of names) {
  try { await workflow(name, {}) } catch (error) { errors.push(error.message) }
}
return { status: 'done', errors }
`,
    council: 'return {}',
    pair: 'return {}',
  })
  const result = await run()
  assert.equal(result.status, 'done', result.error)
  assert.deepEqual(result.errors, [
    'council', 'pair', 'dark-factory:factory', 'dark-factory:ensemble', 'dark-factory:run-plan',
    'dark-factory:missing', 'dark-factory:', 'dark-factory:pair\n', 'null', 'undefined', '1', 'Symbol(child)',
    'object', 'object', 'object', 'function',
  ].map(name => 'Unknown workflow: ' + name))
  assert.deepEqual(workflowEvents(result), [])
})

test('runner refuses nested calls and direct Council or Pair callers', async t => {
  const run = await childWorkflowFixture(t, {
    factory: "return await workflow('dark-factory:council', {})",
    council: "return await workflow(args.target ?? 'dark-factory:pair', {})",
    pair: "return await workflow(args.target ?? 'dark-factory:council', {})",
  })
  const factory = await run()
  assert.equal(factory.status, 'failed')
  assert.equal(factory.error, 'workflow() cannot be called inside a child workflow')
  assert.deepEqual(workflowEvents(factory).filter(([type]) => type === 'workflow.started'), [
    ['workflow.started', 'dark-factory:council'],
  ])
  for (const [name, child] of [['council', 'dark-factory:pair'], ['pair', 'dark-factory:council']]) {
    for (const target of [child, 'dark-factory:unknown', 'dark-factory:ensemble', 'council']) {
      const result = await run(name, { target })
      assert.equal(result.status, 'failed', name + ' calling ' + target)
      assert.equal(result.error, `workflow() is available on this runner only to dark-factory:factory, not dark-factory:${name}`)
      assert.deepEqual(workflowEvents(result), [])
    }
  }
})

test('an uncaught child error reaches the runner failure handling', async t => {
  const run = await childWorkflowFixture(t, {
    factory: "return await workflow('dark-factory:pair', {})",
    pair: "throw Object.assign(new Error('Pair child failed'), { code: 'CHILD_BROKE' })",
  })
  const result = await run()
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Pair child failed')
})

test('Factory keeps its launch child scripts across a live rebuild', async t => {
  const { plugin, repo, runnerURL } = copyChildPlugin(t, {
    factory: `
log('ready to delegate')
const first = await workflow('dark-factory:pair', {})
log('ready to delegate again')
const second = await workflow('dark-factory:pair', {})
return { status: 'done', first, second, council: await workflow('dark-factory:council', {}) }
`,
    pair: "return 'launch Pair'",
    council: "return 'launch Council'",
  })
  const runner = await import(runnerURL)
  const { liveIdentity } = await import(pathToFileURL(join(plugin, 'lib', 'engine.mjs')).href)
  const launchDigest = liveIdentity().packageDigest
  const replacement = "export const meta = { name: 'pair' }\nlog('replacement ran')\nreturn 'new Pair'\n"
  const pairPath = join(plugin, 'workflows', 'pair.js')
  const result = await runner.runWorkflow(runner.parseCLI(['--cwd', repo, 'Use the launch workflows']), {
    prepare: async () => null,
    progress(line) {
      const { type, message } = JSON.parse(line)
      if (type === 'log' && message === 'ready to delegate') writeFileSync(pairPath, replacement)
      if (type === 'log' && message === 'ready to delegate again') rmSync(pairPath)
    },
  })
  assert.equal(result.status, 'done', result.error)
  assert.deepEqual([result.first, result.second, result.council], ['launch Pair', 'launch Pair', 'launch Council'])
  assert.ok(!existsSync(pairPath), 'the second dispatch used the launch script after the file was removed')
  assert.ok(!workflowEvents(result).some(([, value]) => value === 'replacement ran'))
  assert.equal(result.provenance.executor.packageDigest, launchDigest)
  assert.notEqual(liveIdentity().packageDigest, launchDigest)
})

test('Factory refuses a package change during launch preparation before writing any run state', async t => {
  const { plugin, repo, runnerURL } = copyChildPlugin(t, {
    factory: "log('Factory ran'); return { status: 'done' }",
  })
  const runner = await import(runnerURL)
  const hostBase = join(repo, '.council')
  await assert.rejects(runner.runWorkflow(runner.parseCLI(['--cwd', repo, 'Check startup drift']), {
    prepare: async () => {
      writeFileSync(join(plugin, 'workflows', 'pair.js'), 'return null\n')
      return null
    },
    progress: () => {},
  }), { code: 'ENGINE_DRIFT', message: 'Engine package changed during Factory launch' })
  // The refusal comes before host.json, args.json, events or a result: a paused run that is
  // resumed into it keeps its saved arguments and needs-user result.
  const hosts = readdirSync(hostBase).filter(name => name.startsWith('host-'))
  assert.equal(hosts.length, 1)
  assert.deepEqual(readdirSync(join(hostBase, hosts[0])), [])
})

test('Factory follows a symlinked workflows directory to its inventoried files', async t => {
  const { plugin, repo, runnerURL } = copyChildPlugin(t, {
    factory: "return { status: 'done', child: await workflow('dark-factory:pair', {}) }",
    pair: "return 'Pair through a linked directory'",
  })
  cpSync(join(plugin, 'workflows'), join(plugin, 'workflow-files'), { recursive: true })
  rmSync(join(plugin, 'workflows'), { recursive: true })
  symlinkSync('workflow-files', join(plugin, 'workflows'))
  const runner = await import(runnerURL)
  const result = await runner.runWorkflow(runner.parseCLI(['--cwd', repo, 'Run through a linked directory']), {
    prepare: async () => null, progress: () => {},
  })
  assert.equal(result.status, 'done', result.error)
  assert.equal(result.child, 'Pair through a linked directory')
})

test('a refusal before the run starts reaches --output with its code', async t => {
  const dir = temporary(t), output = join(dir, 'result.json')
  const runner = await import(pathToFileURL(join(root, 'plugins', 'dark-factory', 'lib', 'codex-runner.mjs')).href)
  const write = process.stdout.write
  process.stdout.write = () => true
  try { await runner.main(['--resume', join(dir, 'no-such-run'), '--output', output]) } finally {
    process.stdout.write = write
    process.exitCode = undefined
  }
  const result = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'ENOENT')
  assert.match(result.error, /no-such-run/)
})

test('Factory follows an internal workflow symlink to its inventoried file', async t => {
  const { plugin, repo, runnerURL } = copyChildPlugin(t, {
    factory: "return { status: 'done', child: await workflow('dark-factory:pair', {}) }",
    pair: "return 'linked Pair'",
  })
  const workflows = join(plugin, 'workflows')
  for (const name of ['factory', 'pair']) {
    writeFileSync(join(workflows, `${name}-target.js`), readFileSync(join(workflows, `${name}.js`)))
    rmSync(join(workflows, `${name}.js`))
    symlinkSync(`${name}-target.js`, join(workflows, `${name}.js`))
  }
  const runner = await import(runnerURL)
  const result = await runner.runWorkflow(runner.parseCLI(['--cwd', repo, 'Run linked workflows']), {
    prepare: async () => null, progress: () => {},
  })
  assert.equal(result.status, 'done', result.error)
  assert.equal(result.child, 'linked Pair')
})

test('Factory checks for a complete compilable workflow set before running the parent', async t => {
  const { plugin, repo, runnerURL } = copyChildPlugin(t, {
    factory: "log('Factory ran'); return { status: 'done' }",
    pair: 'return )',
  })
  const runner = await import(runnerURL)
  const run = () => runner.runWorkflow(runner.parseCLI(['--cwd', repo, 'Check Factory workflow files']), {
    prepare: async () => null, progress: () => {},
  })
  const invalid = await run()
  assert.equal(invalid.status, 'failed')
  assert.match(invalid.error, /Unexpected token/)
  assert.deepEqual(workflowEvents(invalid), [])

  rmSync(join(plugin, 'workflows', 'pair.js'))
  await assert.rejects(run(), { code: 'ENGINE_DRIFT', message: 'Factory requires a built workflow file: pair.js' })
})

const fixtureAgent = `
const ask = (label, extra = {}) => factoryRuntime.agent({
  label, role: 'seat', prompt: 'fixture ' + label, vendor: 'codex', model: 'test',
  schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
  ...extra,
})
`

function childProcessFixture(t, bodies) {
  const scripts = { pair: 'return null', ...bodies }
  const { dir, repo, runnerURL } = copyChildPlugin(t,
    Object.fromEntries(Object.entries(scripts).map(([name, body]) => [name, fixtureAgent + body])))
  const trace = join(dir, 'turns.jsonl'), worker = join(dir, 'turn.mjs'), driver = join(dir, 'driver.mjs')
  writeFileSync(worker, String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [trace, hold, ...argv] = process.argv.slice(2)
const option = name => argv[argv.indexOf(name) + 1]
const prompt = readFileSync(option('--prompt-file'), 'utf8')
const label = /^fixture ([\w-]+)$/m.exec(prompt)[1]
const schema = JSON.parse(prompt.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
const job = option('--job'), runDir = option('--run-dir')
const jobDir = join(runDir, 'jobs', job)
const mark = stage => appendFileSync(trace, JSON.stringify({ stage, label, job, jobDir, pid: process.pid }) + '\n')
mkdirSync(jobDir, { recursive: true })
mark('enter')

if (label === hold) {
  const deadline = Date.now() + 15_000
  while (!existsSync(join(runDir, 'release-' + hold))) {
    if (Date.now() >= deadline) throw new Error('Fixture turn was never released: ' + label)
    await delay(10)
  }
}

const result = { turn: schema.properties.turn.enum[0], label }
if (label === 'child-setup') {
  const repoRoot = option('--cwd'), runId = 'child-run'
  const childDir = join(repoRoot, '.council', runId)
  const run = { repoRoot, runDir: childDir, runId }
  mkdirSync(childDir)
  writeFileSync(join(childDir, 'run.json'), JSON.stringify(run))
  Object.assign(result, run)
}
appendFileSync(join(runDir, 'usage.jsonl'), JSON.stringify({
  job, vendor: 'codex', model: 'test', seconds: 1, usage: { input_tokens: 7, output_tokens: 3 },
}) + '\n')
mark('exit')
console.log(JSON.stringify({ status: 'done', result }))
`)
  writeFileSync(driver, String.raw`
import { spawn } from 'node:child_process'

const [runnerURL, worker, trace, hold, repo, ...flags] = process.argv.slice(2)
const { parseCLI, runWorkflow } = await import(runnerURL)
const result = await runWorkflow(parseCLI(['--cwd', repo, ...flags]), {
  progress: () => {}, prepare: async () => null,
  runtime: { execute: (argv, { signal }) => new Promise((resolve, reject) => {
    if (argv[0] !== 'seat-run') throw new Error('Unexpected helper call: ' + argv[0])
    // The test owns the read end of fd 3. The worker keeps it open if the driver dies first.
    const proc = spawn(process.execPath, [worker, trace, hold, ...argv], {
      signal, timeout: 18_000, stdio: ['ignore', 'pipe', 'pipe', 3],
    })
    let stdout = '', stderr = ''
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    proc.once('error', reject)
    proc.once('close', code => {
      if (code !== 0) return reject(new Error('Fixture turn failed: ' + stderr))
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
    })
  }) },
})
console.log(JSON.stringify(result))
`)

  function launch(flags, hold = '') {
    const proc = spawn(process.execPath, [driver, runnerURL, worker, trace, hold, repo, ...flags], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 25_000, killSignal: 'SIGKILL',
    })
    let stdout = '', stderr = ''
    proc.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    proc.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    proc.stdio[3].resume()
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })))
    const closed = new Promise(resolve => {
      proc.on('error', error => { stderr += error.message })
      proc.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    t.after(async () => {
      proc.kill('SIGKILL')
      await closed
    })
    return { proc, exited, closed, async result() {
      const outcome = await closed
      assert.equal(outcome.code, 0, outcome.stderr)
      return JSON.parse(outcome.stdout)
    } }
  }
  const marks = () => readEventLog(trace)
  const hostDir = () => {
    const host = readdirSync(join(repo, '.council')).find(name => name.startsWith('host-'))
    assert.ok(host, 'Expected a host directory')
    return join(repo, '.council', host)
  }
  return { launch, marks, hostDir }
}

async function waitForChildFixture(driver, description, probe) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!driver.proc.pid || driver.proc.exitCode !== null || driver.proc.signalCode !== null) {
      const { stderr } = await driver.closed
      assert.fail('Driver exited before ' + description + '\n' + stderr)
    }
    const value = probe()
    if (value) return value
    await delay(10)
  }
  assert.fail('Timed out waiting for ' + description)
}

function peakFixtureProcesses(marks) {
  const active = new Set()
  let peak = 0
  for (const { stage, pid } of marks) {
    if (stage === 'enter') {
      assert.ok(!active.has(pid), 'Unexpected duplicate process entry')
      active.add(pid)
      peak = Math.max(peak, active.size)
    } else {
      assert.equal(stage, 'exit')
      assert.ok(active.delete(pid), 'Process exited without an entry marker')
    }
  }
  assert.equal(active.size, 0)
  return peak
}

test('child runtime: Factory and Council share a process limiter', async t => {
  for (const concurrency of [1, 2]) {
    await t.test('concurrency ' + concurrency, async t => {
      const fixture = childProcessFixture(t, {
        factory: `
const { existsSync } = await import('node:fs')
const { join } = await import('node:path')
const { setTimeout: delay } = await import('node:timers/promises')
const parent = ask('parent')
const startChild = join(args.repo, '.council', args.hostRunId, 'start-child')
const deadline = Date.now() + 10_000
while (!existsSync(startChild)) {
  if (Date.now() >= deadline) throw new Error('Parent fixture never started')
  await delay(10)
}
const child = workflow('dark-factory:council', {})
return { status: 'done', results: await parallel([() => parent, () => child]) }
`,
        council: `
const turn = ask('child')
log('child agent requested')
return await turn
`,
      })
      const driver = fixture.launch(['--concurrency', String(concurrency), 'Test contention'], 'parent')
      await waitForChildFixture(driver, 'parent CLI entry', () => fixture.marks().find(mark => mark.label === 'parent'))
      const host = fixture.hostDir(), eventLog = join(host, 'events.jsonl')
      writeFileSync(join(host, 'start-child'), '')
      await waitForChildFixture(driver, 'child agent request', () =>
        readEventLog(eventLog).some(event => event.type === 'log' && event.message === 'child agent requested'))
      if (concurrency === 2) {
        await waitForChildFixture(driver, 'child CLI entry', () => fixture.marks().some(mark => mark.label === 'child'))
      } else {
        assert.deepEqual(readEventLog(eventLog).filter(event => event.type === 'turn.started').map(event => event.label), ['parent'])
      }
      assert.ok(!fixture.marks().some(mark => mark.label === 'parent' && mark.stage === 'exit'))
      writeFileSync(join(host, 'release-parent'), '')
      const result = await driver.result()
      assert.equal(result.status, 'done', result.error)
      assert.deepEqual(result.results, [{ label: 'parent' }, { label: 'child' }])
      const marks = fixture.marks()
      assert.deepEqual(marks.filter(mark => mark.stage === 'enter').map(mark => mark.label), ['parent', 'child'])
      assert.equal(peakFixtureProcesses(marks), concurrency)
      if (concurrency === 1) {
        assert.deepEqual(readEventLog(eventLog).filter(event => ['turn.started', 'turn.completed'].includes(event.type))
          .map(event => [event.type, event.label]), [
          ['turn.started', 'parent'], ['turn.completed', 'parent'], ['turn.started', 'child'], ['turn.completed', 'child'],
        ])
      }
    })
  }
})

test('child runtime: a Council agent spends the last turn in the Factory cap', async t => {
  const fixture = childProcessFixture(t, {
    factory: `
const parent = await ask('parent')
const child = await workflow('dark-factory:council', {})
return { status: 'done', parent, child }
`,
    council: `
const allowed = await ask('child-allowed')
try { await ask('child-over-cap') } catch (error) {
  return { allowed, refused: { code: error.code, message: error.message } }
}
throw new Error('The cap should have refused the second child agent')
`,
  })
  const result = await fixture.launch(['--max-turns', '2', 'Test the shared cap']).result()
  const message = 'Run turn budget exhausted (2).'
  assert.equal(result.status, 'blocked', result.error)
  assert.equal(result.stopReason, message)
  assert.deepEqual(result.parent, { label: 'parent' })
  assert.deepEqual(result.child, { allowed: { label: 'child-allowed' }, refused: { code: 'RUN_LIMIT', message } })
  assert.equal(result.metrics.turns, 2)
  assert.equal(JSON.parse(readFileSync(join(result.hostRunDir, 'host.json'), 'utf8')).spentTurns, 2)
  assert.deepEqual(fixture.marks().filter(mark => mark.stage === 'enter').map(mark => mark.label), ['parent', 'child-allowed'])
})

test('child runtime: child directories feed Factory accounting and summary output', async t => {
  const fixture = childProcessFixture(t, {
    factory: `
const child = await workflow('dark-factory:council', {})
return { status: 'done', ...child, directories: factoryRuntime.runDirectories() }
`,
    council: `
const run = await ask('child-setup', {
  role: 'setup', setupRunId: 'child-run',
  schema: { type: 'object', properties: {
    label: { type: 'string' }, repoRoot: { type: 'string' }, runDir: { type: 'string' }, runId: { type: 'string' },
  }, required: ['label', 'repoRoot', 'runDir', 'runId'], additionalProperties: false },
})
await ask('child-seat', { run })
return { runDir: run.runDir, summary: { status: 'done' } }
`,
  })
  const result = await fixture.launch(['Test directory accounting']).result()
  assert.equal(result.status, 'done', result.error)
  const childDir = join(dirname(result.hostRunDir), 'child-run')
  assert.deepEqual(result.directories, [result.hostRunDir, childDir])
  const childJob = fixture.marks().find(mark => mark.stage === 'enter' && mark.label === 'child-seat').job
  const jobsIn = runDir => readEventLog(join(runDir, 'usage.jsonl')).map(row => row.job)
  assert.deepEqual(jobsIn(childDir), [childJob])
  assert.ok(!jobsIn(result.hostRunDir).includes(childJob))
  const tokens = JSON.parse(readFileSync(join(result.hostRunDir, 'tokens.json'), 'utf8'))
  assert.equal(tokens.records, 2)
  const childTurn = tokens.turns.find(turn => turn.job === childJob)
  assert.equal(childTurn.input, 7)
  assert.equal(childTurn.output, 3)
  assert.equal(result.summaryFile, join(childDir, 'summary.json'))
  assert.equal(JSON.parse(readFileSync(result.summaryFile, 'utf8')).status, 'done')
})

test('child runtime: SIGKILL during Council replays completed child calls on resume', async t => {
  const fixture = childProcessFixture(t, {
    factory: `
const parent = await ask('parent')
const pair = await workflow('dark-factory:pair', {})
const council = await workflow('dark-factory:council', {})
return { status: 'done', parent, pair, council }
`,
    pair: "return await ask('pair')",
    council: `
const first = await ask('council-first')
const interrupted = await ask('council-interrupted')
return { first, interrupted }
`,
  })
  const driver = fixture.launch(['Test replay across child workflow calls'], 'council-interrupted')
  const held = await waitForChildFixture(driver, 'interrupted Council CLI entry', () =>
    fixture.marks().find(mark => mark.label === 'council-interrupted' && mark.stage === 'enter'))
  const host = fixture.hostDir()
  const completed = ['parent', 'pair', 'council-first']
  try {
    const checkpoint = JSON.parse(readFileSync(join(host, 'checkpoint.json'), 'utf8'))
    assert.deepEqual(checkpoint.entries.map(entry => [entry.method, entry.label]),
      completed.map(label => ['agent', label]))
    assert.deepEqual(fixture.marks().filter(mark => mark.stage === 'exit').map(mark => mark.label), completed)
    assert.equal(driver.proc.kill('SIGKILL'), true)
    assert.equal((await driver.exited).signal, 'SIGKILL')
  } finally {
    process.kill(held.pid, 'SIGKILL')
    // Close waits for the inherited pipe, so the held worker has stopped by this point.
    await driver.closed
  }

  const resumed = await fixture.launch(['--resume', host]).result()
  assert.equal(resumed.status, 'done', resumed.error)
  assert.equal(resumed.hostRunDir, host)
  assert.deepEqual([resumed.parent, resumed.pair, resumed.council], [
    { label: 'parent' }, { label: 'pair' },
    { first: { label: 'council-first' }, interrupted: { label: 'council-interrupted' } },
  ])
  const marks = fixture.marks()
  const launches = marks.filter(mark => mark.stage === 'enter')
  assert.deepEqual(launches.map(mark => mark.label), [...completed, 'council-interrupted', 'council-interrupted'])
  const resumedKey = held.job + '-resume1'
  const events = readEventLog(join(host, 'events.jsonl'))
  assert.deepEqual(events.filter(event => event.type === 'checkpoint.replayed').map(event => [event.method, event.label]),
    completed.map(label => ['agent', label]))
  assert.deepEqual(launches.filter(mark => mark.job.endsWith('-resume1')).map(mark => mark.jobDir),
    [join(host, 'jobs', resumedKey)])
  assert.deepEqual(readdirSync(join(host, 'jobs'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('-resume1')).map(entry => entry.name), [resumedKey])
  assert.equal(JSON.parse(readFileSync(join(host, 'host.json'), 'utf8')).workflow, 'factory')
  const switched = await fixture.launch(['--resume', host, '--workflow', 'pair']).closed
  assert.equal(switched.code, 1)
  assert.match(switched.stderr, /Cannot change workflow on resume\./)
  assert.deepEqual(fixture.marks(), marks)
})
