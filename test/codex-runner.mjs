import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, utimesSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { parseCLI, resultExitCode, validateResult, createLimiter, createRuntime, runWorkflow } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { LIB } from '../tools/sources.mjs'

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
  const source = [...LIB, 'src/boot.js', 'src/schemas.js', 'src/turns.js'].map(f => readFileSync(join(root, f), 'utf8')).join('\n')
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
  await runtime.agent({ prompt: 'amend', schema: object, vendor: 'codex', model: 'test', role: 'spec', label: 'spec amend' })
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
  const result = await runWorkflow(parseCLI(['--cwd', repo, 'Implement the missing plan']), { progress: () => {}, runtime: {
    execute: async argv => {
      count++
      const payload = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
      const schema = JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])
      return { status: 'done', result: { ...empty(schema), status: 'needs-plan', planMissing: 'PLAN.md' } }
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
  writeFileSync(join(bin, 'codex'), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
  const result = JSON.parse(execFileSync(process.execPath, [cli, '--cwd', repo, '--tier', 'simple', 'Fix sum to add its operands'], {
    encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home,
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
