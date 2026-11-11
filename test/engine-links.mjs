import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, readdirSync, linkSync, unlinkSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, root, jsonResult } from './fixtures/engine-package.mjs'
import { harness, paused } from './fixtures/pinned-harness.mjs'

test('exports are independently owned single-link files, including the sidecar', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const walk = path => { for (const name of readdirSync(path)) {
    const file = join(path, name), stat = lstatSync(file)
    if (stat.isDirectory()) walk(file)
    else if (stat.isFile()) {
      assert.equal(stat.uid, process.geteuid()); assert.equal(stat.nlink, 1)
      if (file.startsWith(pin.root + '/')) {
        const source = lstatSync(join(f.plugin, relative(pin.root, file)))
        assert.ok(stat.dev !== source.dev || stat.ino !== source.ino)
      }
    }
  } }
  walk(f.output)
  for (const file of [join(pin.root, 'lib/evaluate.mjs'), join(f.output, 'manifest.json')]) {
    const alias = join(f.dir, 'alias'), before = readFileSync(file)
    linkSync(file, alias)
    assert.throws(() => E.validateExport(f.output), /single-link/)
    assert.throws(() => E.exportEngine(f.source, f.output, f.target), /single-link/)
    const result = spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), 'guard'], { env: f.env, input: JSON.stringify({ pin }), encoding: 'utf8' })
    assert.notEqual(result.status, 0); assert.match(result.stdout, /single-link/)
    assert.deepEqual(readFileSync(file), before); assert.deepEqual(readFileSync(alias), before)
    unlinkSync(alias); assert.ok(E.validateExport(f.output))
    for (const fault of ['uid', 'fstat-uid']) {
      const r = f.run(process.execPath, ['--import', join(root, 'test/fixtures/ownership-preload.mjs'), '--input-type=module', '-e', `import{validateExport}from${JSON.stringify(join(f.plugin, 'lib/engine.mjs'))};validateExport(${JSON.stringify(f.output)})`], { OWNERSHIP_TARGET: file, OWNERSHIP_FAULT: fault })
      assert.notEqual(r.status, 0); assert.match(r.stderr, /ownership/)
    }
  }
})

test('hardlinks refuse guarded helper, hook, relocation and real resume without deleting evidence', async t => {
  const E = await api(), f = harness(t), p = paused(f), pin = p.first.provenance.executor
  const checkpoint = readFileSync(p.first.checkpoint), host = readFileSync(join(p.first.hostRunDir, 'host.json'))
  const file = join(f.output, 'manifest.json'), before = readFileSync(file), alias = join(f.dir, 'manifest-alias')
  linkSync(file, alias)
  const helper = f.run(join(pin.root, 'bin/dark-factory'), ['hash', '--file', f.descriptor], { DARK_FACTORY_PIN: JSON.stringify(pin) })
  assert.notEqual(helper.status, 0); assert.match(helper.stdout, /single-link/)
  const spec = join(f.dir, 'seat.json'); writeFileSync(spec, JSON.stringify({ kind: 'codex', pin, cwd: f.target, writable: [] }))
  const hook = spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), 'hook', spec], { env: f.env, input: JSON.stringify({ tool_name: 'Write', tool_input: {} }), encoding: 'utf8' })
  assert.equal(hook.status, 2); assert.match(hook.stderr, /single-link/)
  const refused = jsonResult(f.launch(['--resume', p.first.hostRunDir])); assert.match(refused.error, /single-link/)
  assert.deepEqual(readFileSync(p.first.checkpoint), checkpoint); assert.deepEqual(readFileSync(join(p.first.hostRunDir, 'host.json')), host)
  assert.deepEqual(readFileSync(file), before); assert.deepEqual(readFileSync(alias), before)
  const relocated = join(f.dir, 'relocated'); cpSync(f.output, relocated, { recursive: true })
  const movedFile = join(relocated, 'manifest.json'); linkSync(movedFile, join(f.dir, 'relocated-alias'))
  assert.throws(() => E.validateExport(relocated, pin), /single-link/)
})
