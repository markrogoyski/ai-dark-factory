import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { launchRequirements, launchReport } from '../plugins/dark-factory/lib/policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'plugins/dark-factory/bin/dark-factory-codex')

// A repository and stub CLIs that record any call other than --version.
function fixture(t, vendors) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-prepare-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'), bin = join(dir, 'bin'), log = join(dir, 'calls.log')
  for (const path of [repo, bin, join(dir, 'home'), join(dir, 'codex-home'), join(dir, 'claude-home')]) mkdirSync(path)
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, 'sum.cjs'), 'module.exports = (a, b) => a - b\n')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'Add sum'])
  for (const vendor of vendors) {
    writeFileSync(join(bin, vendor), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${vendor} stub 1.0"; exit 0; fi\necho "$@" >> ${JSON.stringify(log)}\nexit 1\n`)
    chmodSync(join(bin, vendor), 0o755)
  }
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, 'home'),
    CODEX_HOME: join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude-home') }
  delete env.CLAUDECODE
  const run = (...args) => spawnSync(process.execPath, [cli, '--cwd', repo, ...args], { env, encoding: 'utf8' })
  return { dir, repo, log, run }
}

test('launch requirements name reachable vendors with roles and absolute plan documents', () => {
  const pair = launchRequirements({}, { workflow: 'pair', args: { task: 'x', plan: ['/abs/plan.md', 'inline note'] } })
  assert.deepEqual(Object.keys(pair.vendors).sort(), ['claude', 'codex'])
  assert.ok(pair.vendors.claude.includes('review'))
  assert.deepEqual(pair.references, ['/abs/plan.md'])
  assert.equal(launchRequirements({}, { workflow: 'factory', args: { task: 'x' } }).vendors.codex.includes('intake'), true)
  assert.deepEqual(launchRequirements({}, { workflow: 'pair', args: { task: 'x', explain: true } }).vendors, {})
  assert.throws(() => launchRequirements({}, { workflow: 'run-plan', args: {} }), /does not support run-plan/)
})

test('launch report blocks on missing CLIs or documents and only warns about tracked changes', () => {
  const requirements = launchRequirements({}, { workflow: 'pair', args: { task: 'x' } })
  const ready = launchReport({}, requirements, { vendors: { codex: { ok: true, version: 'v' }, claude: { ok: true } }, missing: [], dirty: ['a.js'] })
  assert.equal(ready.status, 'ready'); assert.match(ready.warnings[0], /a\.js/); assert.equal(ready.authentication, 'unknown')
  const blocked = launchReport({}, requirements, { vendors: { codex: { ok: true } }, missing: ['/abs/plan.md'], dirty: [] })
  assert.equal(blocked.status, 'blocked')
  assert.ok(blocked.blocking.some(line => /^claude CLI \(review\)/.test(line)))
  assert.ok(blocked.blocking.some(line => line.includes('/abs/plan.md')))
  const allowed = launchRequirements({}, { workflow: 'pair', args: { task: 'x', allowDirty: true } })
  assert.deepEqual(launchReport({}, allowed, { vendors: { codex: { ok: true }, claude: { ok: true } }, dirty: ['a.js'] }).warnings, [])
})

test('--prepare reports readiness without a run directory or any model call', t => {
  const f = fixture(t, ['codex', 'claude'])
  const r = f.run('--prepare', '--workflow', 'pair', 'Fix sum')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.status, 'prepared')
  assert.equal(result.prepared.vendors.codex.version, 'codex stub 1.0')
  assert.equal(existsSync(join(f.repo, '.council')), false)
  assert.equal(existsSync(f.log), false)
})

test('a new run stops before intake when a reachable CLI or plan document is missing', t => {
  const f = fixture(t, ['codex'])
  const r = f.run('--workflow', 'factory', '--args-file', writeArgs(f.dir, { task: 'Fix sum', plan: [join(f.dir, 'missing.md')] }))
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.status, 'preflight')
  assert.ok(result.prepared.blocking.some(line => line.startsWith('claude CLI')))
  assert.ok(result.prepared.blocking.some(line => line.includes('missing.md')))
  assert.match(result.error, /no model turn ran/)
  assert.equal(existsSync(join(f.repo, '.council')), false)
  assert.equal(existsSync(f.log), false)
})

test('--prepare refuses resume and run-plan instead of falling through to execution', t => {
  const f = fixture(t, ['codex', 'claude'])
  writeFileSync(join(f.dir, 'host.json'), JSON.stringify({ repo: f.repo, workflow: 'pair' }))
  for (const args of [['--prepare', '--resume', f.dir], ['--prepare', '--workflow', 'run-plan', '--plan-file', join(f.dir, 'plan.json')]]) {
    const r = f.run(...args)
    assert.equal(r.status, 1)
    assert.match(JSON.parse(r.stdout).error, /--prepare checks a new single run/)
  }
  assert.equal(existsSync(join(f.repo, '.council')), false)
  assert.equal(existsSync(f.log), false)
})

function writeArgs(dir, value) {
  const path = join(dir, 'args.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

test('evaluate --collect counts every host run and lists the ones without a usable result', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-collect-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const metrics = readiness => ({ version: 1, host: 'codex', workflow: 'pair', tier: null, strategy: 'pair', readiness, turns: 3 })
  const runs = { 'host-a': { status: 'ready', metrics: metrics('ready') }, 'host-b': { status: 'failed', metrics: metrics('incomplete') }, 'host-c': null, 'host-d': { status: 'old' } }
  for (const [name, result] of Object.entries(runs)) {
    mkdirSync(join(dir, '.council', name), { recursive: true })
    writeFileSync(join(dir, '.council', name, 'host.json'), '{}')
    if (result) writeFileSync(join(dir, '.council', name, 'result.json'), JSON.stringify({ ...result, hostRunDir: join(dir, '.council', name) }))
  }
  mkdirSync(join(dir, '.council', 'run-plan-x'))
  const r = spawnSync(process.execPath, [join(root, 'plugins/dark-factory/bin/dark-factory-evaluate'), '--collect', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const summary = JSON.parse(r.stdout), group = summary.groups['codex/pair/-/pair/default/complete']
  assert.equal(summary.runs, 2); assert.equal(group.runs, 2); assert.equal(group.ready, 1)
  assert.deepEqual(summary.collected[0].incomplete.map(x => [x.hostRunDir.split('/').at(-1), x.reason]),
    [['host-c', 'no result recorded'], ['host-d', 'result has no supported metrics']])
})
