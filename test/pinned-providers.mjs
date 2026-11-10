import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, jsonResult, readJson } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

test('headless Claude rewrites actual Bash input despite a competing legacy helper', async t => {
  await api(); const f = harness(t), competing = join(f.dir, 'competing')
  mkdirSync(competing)
  writeFileSync(join(competing, 'dark-factory'), '#!/bin/sh\necho COMPETING_HELPER_RAN >&2\nexit 97\n', { mode: 0o755 })
  const r = jsonResult(f.launch(['--pin-engine', f.output, '--workflow', 'pair', '--author', 'opus', '--reviewer', 'sol', 'Fix sum'], { PINNED_COMPETING_BIN: competing }))
  assert.equal(r.final?.readiness.state, 'ready', JSON.stringify(r))
  assert.equal(r.provenance.executor.mode, 'pinned')
  assert.ok(r.provenance.inputs.design)
  const traces = f.traces()
  assert.ok(traces.some(x => x.argv.includes('hook')), 'real hook subprocess performed identity/settings checks')
  const jobs = join(r.runDir, 'jobs')
  const specFile = readdirSync(jobs).map(name => join(jobs, name, 'spec.json')).find(file => { try { return readJson(file).kind === 'claude' } catch { return false } })
  for (const tool_name of ['Edit', 'Write']) {
    const tool_input = { file_path: join(f.target, 'value'), content: 'unchanged input', old_string: 'base', new_string: 'new' }
    const hook = spawnSync(process.execPath, [join(r.provenance.executor.root, 'lib/engine.mjs'), 'hook', specFile], { env: f.env, input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' })
    assert.equal(hook.status, 0, hook.stderr)
    assert.deepEqual(JSON.parse(hook.stdout).hookSpecificOutput.updatedInput, tool_input)
  }
  const wrong = f.run(join(f.plugin, 'bin/dark-factory'), ['hash', '--file', f.descriptor], { DARK_FACTORY_PIN: JSON.stringify(r.provenance.executor) })
  assert.notEqual(wrong.status, 0); assert.match(wrong.stdout, /different executor|Mismatched helper/)
  f.update({ sources: { '/etc/claude-code/managed-settings.json': { status: 'file', text: '{"disableAllHooks":true}' } } })
  const refused = jsonResult(f.launch(['--pin-engine', f.output, '--workflow', 'pair', '--author', 'opus', 'Fix sum']))
  assert.equal(refused.status, 'failed'); assert.match(refused.error || refused.stopReason || '', /unsupported control|Unknown write bounds/)
})

test('Claude settings drift during a turn blocks the original tool input', async t => {
  await api()
  for (const corrupt of [false, true]) {
    const f = harness(t), competing = join(f.dir, 'competing'), marker = join(f.dir, 'tool-ran'), trace = join(f.dir, 'hook-status.jsonl')
    mkdirSync(competing)
    writeFileSync(join(competing, 'dark-factory'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
    const result = jsonResult(f.launch(['--pin-engine', f.output, '--workflow', 'pair', '--author', 'opus', '--reviewer', 'sol', 'Fix sum'], {
      PINNED_COMPETING_BIN: competing, PINNED_HOOK_DRIFT: marker, PINNED_HOOK_TRACE: trace,
      ...(corrupt ? { PINNED_HOOK_CORRUPT: join(f.output, 'plugin/lib/engine.mjs') } : {}) }))
    assert.notEqual(result.final?.readiness?.state, 'ready')
    const statuses = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(statuses.some(s => s.status === 2 && (corrupt ? /SyntaxError/ : /unsupported control|settings changed/).test(s.stderr)))
    assert.equal(existsSync(marker), false, 'the original command must not run after refusal')
  }
})

test('Codex and agy stub jobs invoke bare frozen helper without changing grants', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const helper = join(pin.root, 'bin/dark-factory'), trace = join(f.dir, 'helpers.jsonl'), competing = join(f.dir, 'competing')
  mkdirSync(competing)
  writeFileSync(join(competing, 'dark-factory'), '#!/bin/sh\nexit 97\n', { mode: 0o755 })
  f.env.PATH = competing + ':' + f.env.PATH
  const env = { DARK_FACTORY_PIN: JSON.stringify(pin), DARK_FACTORY_INVOCATION: 'controller-only', DARK_FACTORY_SEAT_SPEC: 'controller-only', PINNED_TINY: '1',
    PINNED_EXPECTED_HELPER: helper, PINNED_HELPER_TRACE: trace, PINNED_CANDIDATE_PROBE: f.plugin }
  const run = jsonResult(f.run(helper, ['init', '--repo', f.target, '--seats', 'A', '--run-id', 'providers', '--factory'], env))
  const agy = join(f.env.HOME, '.gemini/antigravity-cli'); mkdirSync(agy, { recursive: true })
  const settings = join(agy, 'settings.json'); writeFileSync(settings, '{"toolPermission":"proceed-in-sandbox","permissions":{"allow":[]}}')
  const before = readFileSync(settings)
  const prompt = join(f.dir, 'tiny.md'); writeFileSync(prompt, 'Check the fixture\n<<<OUTPUT_SCHEMA\n{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}\nOUTPUT_SCHEMA>>>\n')
  for (const vendor of ['codex', 'gemini']) {
    let result = jsonResult(f.run(helper, ['seat-run', '--run-dir', run.runDir, '--vendor', vendor, '--seat', vendor, '--job', vendor,
      '--model', 'fixture', '--effort', 'high', '--sandbox', 'workspace-write', '--cwd', run.worktrees.A, '--prompt-file', prompt, '--fresh', '--max-wait', '5'], env))
    while (result.status === 'running') result = jsonResult(f.run(helper, ['wait', '--run-dir', run.runDir, '--job', result.job, '--max-wait', '5'], env))
    assert.equal(result.status, 'done', JSON.stringify(result)); assert.deepEqual(result.result, { ok: true })
  }
  const resolutions = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(resolutions.map(r => r.provider).sort(), ['agy', 'codex'])
  assert.ok(resolutions.every(r => r.resolved === realpathSync(helper)))
  assert.deepEqual(readFileSync(settings), before)
})
