import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, api, commit, jsonResult } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

test('exports refuse overlapping roots, unsafe entries and incomplete destinations', async t => {
  const E = await api(), f = fixture(t)
  for (const path of [join(f.target, 'export'), join(f.source, 'export'), f.dir]) assert.throws(() => E.exportEngine(f.source, path, f.target), /overlaps/)
  const alias = join(f.dir, 'alias'); symlinkSync(f.target, alias)
  assert.throws(() => E.exportEngine(f.source, join(alias, 'export'), f.target), /overlaps/)
  mkdirSync(f.output); writeFileSync(join(f.output, 'evidence'), 'keep')
  assert.throws(() => E.exportEngine(f.source, f.output, f.target), /manifest/)
  assert.equal(readFileSync(join(f.output, 'evidence'), 'utf8'), 'keep')
  for (const [name, target] of [['escape', '../../outside'], ['absolute', '/etc/passwd'], ['dangling', 'missing'], ['cycle', 'cycle']]) {
    const g = fixture(t); symlinkSync(target, join(g.plugin, name)); commit(g.source)
    assert.throws(() => E.exportEngine(g.source, g.output, g.target), /symlink/)
  }
})

test('merged settings and implicit grants cannot be narrowed by application profile claims', async t => {
  await api(); const f = harness(t)
  const E = await api(), pin = E.exportEngine(f.source, f.output, f.target)
  const request = { pin, executable: join(pin.root, 'bin/dark-factory'), spec: { kind: 'codex', cwd: f.target, writable: [] } }
  const { spawnSync } = await import('node:child_process')
  const call = extra => {
    const r = spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), 'guard'], { input: JSON.stringify(request), env: { ...f.env, ...extra }, encoding: 'utf8' })
    return { ...r, json: JSON.parse(r.stdout) }
  }
  assert.equal(call().status, 0)
  f.update({ sources: { [join(f.env.CODEX_HOME, 'config.toml')]: { status: 'file', text: `model = \"ordinary-model\"\n[profiles.inactive.sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(f.output)}]` } } })
  assert.equal(call().status, 0, 'inactive profiles do not grant write access')
  f.update({ sources: {} })
  for (const [path, text] of [
    [join(f.env.CODEX_HOME, 'config.toml'), `sandbox_workspace_write = { writable_roots = [${JSON.stringify(f.output)}] }`],
    [join(f.env.CODEX_HOME, 'config.toml'), `profile = "wide"\n[profiles.wide.sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(f.output)}]`],
    [join(f.target, '.codex/config.toml'), `[profiles.wide.sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(f.output)}]`],
    ['/etc/codex/managed_config.toml', `sandbox_workspace_write = { writable_roots = [${JSON.stringify(f.dir)}] }`]
  ]) {
    const sources = { [path]: { status: 'file', text } }
    if (path === join(f.target, '.codex/config.toml')) sources[join(f.env.CODEX_HOME, 'config.toml')] = { status: 'file', text: `[projects.${JSON.stringify(f.target)}]\ntrust_level="trusted"` }
    f.update({ sources })
    assert.match(call({ DARK_FACTORY_TEST_PROFILE: 'bounded' }).json.error, /overlaps/)
  }
  request.spec.kind = 'claude'
  for (const path of [join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), join(f.target, '.claude/settings.json'), join(f.target, '.claude/settings.local.json'), '/Library/Application Support/ClaudeCode/managed-settings.json']) {
    f.update({ sources: { [path]: { status: 'file', text: JSON.stringify({ sandbox: { filesystem: { allowWrite: [f.output] } } }) } } })
    assert.match(call().json.error, /overlaps/)
  }
  f.update({ sources: { [join(f.env.CLAUDE_CONFIG_DIR, 'settings.json')]: { status: 'unknown' } } })
  assert.match(call().json.error, /Unknown write bounds/)
  for (const path of ['/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.d']) {
    f.update({ sources: { [path]: { status: 'directory', entries: ['wide-grants.json'] } } })
    assert.match(call().json.error, /unsupported managed settings directory/)
  }
  f.update({ sources: { [join(f.target, '.claude/settings.local.json')]: { status: 'file', text: '{"disableAllHooks":true}' } } })
  assert.match(call().json.error, /unsupported control/)
  request.spec.kind = 'gemini'
  f.update({ sources: { [join(f.env.HOME, '.gemini/antigravity-cli/settings.json')]: { status: 'file', text: JSON.stringify({ toolPermission: 'proceed-in-sandbox', permissions: { allow: [`write_file(${f.output})`] } }) } } })
  assert.match(call().json.error, /overlaps/)
  f.update({ sources: {}, defaults: ['/tmp', f.dir] }); assert.match(call().json.error, /overlaps/)
  f.update({ defaults: [join(f.dir, 'bounded-temp')] }); assert.equal(call().status, 0)
  const lost = f.run(process.execPath, ['--input-type=module', '-e', "import {spawnSync} from 'node:child_process';spawnSync(process.execPath,['-e','throw 1'],{env:{}})"])
  assert.notEqual(lost.status, 0); assert.match(lost.stderr, /lost observation preload/)
  assert.ok(f.traces().some(x => x.path === '/Library/Application Support/ClaudeCode/managed-settings.json'))
})
