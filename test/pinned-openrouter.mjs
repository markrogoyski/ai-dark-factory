// An OpenRouter seat under a pinned engine: observed as the Claude CLI plus its endpoint, with its
// run-owned configuration directory as its only user layer. Host observations come from the pinned
// harness; the Claude CLI is a stub (fixtures/openrouter-claude.cjs). No model or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync, cpSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, jsonResult, readJson, root } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

const ENDPOINT = 'https://openrouter.ai/api'
const policy = () => import('../plugins/dark-factory/lib/policy.mjs')

// The pinned engine's guard, as the helper calls it: {executor, settings} or {status: 'error'}.
function guard(f, pin, spec) {
  const r = spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), 'guard'], { env: f.env, input: JSON.stringify({ pin, spec }), encoding: 'utf8' })
  return JSON.parse(r.stdout.trim().split('\n').at(-1))
}

test('observation', async t => {
  const P = await policy()
  const observed = { vendor: 'claude', facts: { deliveryKnown: true, hooks: true }, layers: [] }
  const plain = P.providerConfiguration({}, observed), routed = P.providerConfiguration({}, { ...observed, endpoint: ENDPOINT })
  assert.equal(routed.security.endpoint, ENDPOINT)
  assert.deepEqual({ ...routed, security: { ...routed.security, endpoint: undefined } }, { ...plain, security: { ...plain.security, endpoint: undefined } })
  assert.equal('endpoint' in plain.security, false)

  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const home = join(f.env.HOME, 'claude')
  f.update({ sources: { [join(home, 'settings.json')]: { status: 'file', text: '{"disableAllHooks":true}' } } })
  const route = guard(f, pin, { kind: 'openrouter', cwd: f.target, repoRoot: f.target, writable: [] })
  assert.ok(route.settings, JSON.stringify(route))
  assert.ok(route.settings.sources.every(([path]) => !path.startsWith(home + '/') && path !== join(f.env.HOME, '.claude.json')), JSON.stringify(route.settings.sources))
  const claude = guard(f, pin, { kind: 'claude', cwd: f.target, repoRoot: f.target, writable: [] })
  assert.equal(claude.status, 'error', 'the Claude seat reads the global settings and is refused, as before')
  f.update({ sources: {} })

  const config = join(f.dir, 'run', 'openrouter', 'A', 'config')
  mkdirSync(config, { recursive: true })
  const spec = { kind: 'openrouter', cwd: f.target, repoRoot: f.target, writable: [], claudeConfigDir: config, endpoint: ENDPOINT }
  const hashFor = (file, kind, entry) => {
    rmSync(file, { force: true })
    if (entry !== undefined) writeFileSync(file, JSON.stringify({ projects: { [f.target]: entry } }))
    const r = guard(f, pin, kind === 'openrouter' ? spec : { kind: 'claude', cwd: f.target, repoRoot: f.target, writable: [] })
    assert.ok(r.settings, JSON.stringify(r))
    return r.settings.settingsHash
  }
  const stateFile = join(config, '.claude.json')
  const absent = hashFor(stateFile, 'openrouter'), empty = hashFor(stateFile, 'openrouter', { allowedTools: [], mcpServers: {} })
  assert.equal(empty, absent, 'an empty tool list grants nothing')
  // A non-empty allowedTools adds a layer; Bash rules are bounded by the hook, so it is admitted with another hash.
  assert.notEqual(hashFor(stateFile, 'openrouter', { allowedTools: ['Bash(curl:*)'] }), absent)
  rmSync(stateFile, { force: true })
  const userState = join(f.env.HOME, '.claude.json')
  const cAbsent = hashFor(userState, 'claude'), cEmpty = hashFor(userState, 'claude', { allowedTools: [], mcpServers: {} })
  assert.notEqual(cEmpty, cAbsent, 'for a Claude seat an empty entry is still a layer, as before')
  rmSync(userState, { force: true })
  assert.notEqual(absent, cAbsent, 'the endpoint is part of what is pinned')
})

test('pinned seat-run', async t => {
  const E = await api()
  for (const variant of ['fresh', 'empty', 'curl', 'global']) {
    const f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
    const helper = join(pin.root, 'bin/dark-factory'), trace = join(f.dir, 'or-trace.jsonl')
    cpSync(join(root, 'test/fixtures/openrouter-claude.cjs'), join(f.dir, 'bin', 'claude')); chmodSync(join(f.dir, 'bin', 'claude'), 0o755)
    const env = { DARK_FACTORY_PIN: JSON.stringify(pin), OPENROUTER_API_KEY: 'sk-or-v1-SENTINEL0123456789abcdef', OR_PIN_TRACE: trace,
      ...(['empty', 'curl'].includes(variant) ? { OR_PIN_VARIANT: variant } : {}) }
    const run = jsonResult(f.run(helper, ['init', '--repo', f.target, '--seats', 'A', '--run-id', 'or', '--factory'], env))
    if (variant === 'global') f.update({ sources: { [join(f.env.HOME, 'claude', 'settings.json')]: { status: 'file', text: '{"disableAllHooks":true}' } } })
    const prompt = join(f.dir, 'tiny.md'); writeFileSync(prompt, 'Check\n<<<OUTPUT_SCHEMA\n{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}\nOUTPUT_SCHEMA>>>\n')
    const turn = (vendor, job) => {
      let r = jsonResult(f.run(helper, ['seat-run', '--run-dir', run.runDir, '--vendor', vendor, '--seat', job, '--job', job, '--model', vendor === 'openrouter' ? 'deepseek/deepseek-v4-pro' : 'sonnet',
        '--effort', 'high', '--sandbox', 'workspace-write', '--cwd', run.worktrees.A, '--writable', run.room, '--prompt-file', prompt, '--fresh', '--no-transcript', '--max-wait', '30',
        ...(vendor === 'openrouter' ? ['--config-key', 'A'] : [])], env))
      while (r.status === 'running') r = jsonResult(f.run(helper, ['wait', '--run-dir', run.runDir, '--job', job, '--max-wait', '30'], env))
      return r
    }
    const result = turn('openrouter', 'r0-A')
    const traces = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : []
    const spec = readJson(join(run.runDir, 'jobs', 'r0-A', 'spec.json'))
    if (variant === 'curl') {
      assert.equal(traces[0].hookStatus, 2, JSON.stringify(traces))
      assert.match(traces[0].hookStderr, /capabilities changed|settings changed/)
      assert.equal(result.status, 'error'); assert.match(result.error, /ENGINE_DRIFT/)
      continue
    }
    assert.equal(result.status, 'done', `${variant}: ${JSON.stringify(result)}`)
    assert.equal(traces[0].hookStatus, 0, JSON.stringify(traces))
    assert.deepEqual([spec.kind, spec.endpoint, spec.claudeConfigDir], ['openrouter', ENDPOINT, join(run.runDir, 'openrouter', 'A', 'config')])
    assert.equal(result.settingsHash, spec.settingsHash, 'the job guard and the early guard agree')
    if (variant === 'global') {
      const refused = turn('claude', 'r0-B')
      assert.equal(refused.status, 'error'); assert.match(refused.error, /ENGINE_DRIFT|unsupported control/)
    }
    if (variant === 'fresh') {
      const host = join(f.dir, 'hostrun'); mkdirSync(host)
      writeFileSync(join(host, 'checkpoint.json'), JSON.stringify({ runs: [run.runDir] }))
      const script = `import(${JSON.stringify(join(pin.root, 'lib/engine.mjs'))}).then(E => E.validateAdmissions(${JSON.stringify(host)}, ${JSON.stringify(pin)})).then(() => console.log('ok'))`
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...f.env, ...env }, encoding: 'utf8' })
      assert.equal(r.stdout.trim(), 'ok', r.stderr)
    }
  }
})
