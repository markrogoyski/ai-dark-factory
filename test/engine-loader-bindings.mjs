import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { api, fixture, subjectEnv } from './fixtures/engine-package.mjs'

const cases = JSON.parse(readFileSync(new URL('./fixtures/engine-loader-cases.json', import.meta.url)))
test('actual loaders refuse unsupported acquisition and wrapper binding forms before execution', async t => {
  const E = await api(), f = fixture(t), marker = join(f.dir, 'outside-ran')
  writeFileSync(join(f.dir, 'outside.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');module.exports='outside-inventory'\n`)
  const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000, env: subjectEnv(process.env) })
  for (const row of cases.escapes) await t.test(row.name, () => {
    const root = mkdtempSync(join(f.dir, 'modules-')), entry = join(root, `entry.${row.ext}`)
    writeFileSync(join(root, 'inside.cjs'), "module.exports='inside-inventory'\n")
    writeFileSync(entry, row.source)
    if (existsSync(marker)) unlinkSync(marker)
    const raw = run([entry]), rawMarker = existsSync(marker)
    if (rawMarker) unlinkSync(marker)
    const guarded = run(['--input-type=module', '-e', `import * as E from ${JSON.stringify(pathToFileURL(join(f.plugin, 'lib/engine.mjs')).href)};E.validateImports(${JSON.stringify(root)},E.packageInventory(${JSON.stringify(root)}));await import(${JSON.stringify(pathToFileURL(entry).href)})`])
    console.log(JSON.stringify({ oracle: 'loader', name: row.name, rawExit: raw.status, rawOutput: raw.stdout.trim(), rawMarker, guardedExit: guarded.status, guardedOutput: guarded.stdout.trim(), guardedMarker: existsSync(marker), refusal: guarded.stderr.split('\n').find(line => /Error:/.test(line)) || '' }))
    assert.equal(raw.status, 0, raw.stderr); assert.equal(raw.stdout.trim(), 'outside-inventory'); assert.equal(rawMarker, true)
    assert.notEqual(guarded.status, 0, guarded.stdout); assert.match(guarded.stderr, /Unsupported|Untracked|Unresolved/)
    assert.equal(guarded.stdout.includes('outside-inventory'), false); assert.equal(existsSync(marker), false)
  })
  for (const row of cases.refusals) await t.test(row.name, () => {
    const root = mkdtempSync(join(f.dir, 'syntax-')), entry = join(root, `entry.${row.ext}`)
    writeFileSync(join(root, 'inside.cjs'), "module.exports='inside-inventory'\n"); writeFileSync(entry, row.source)
    assert.throws(() => E.validateImports(root, E.packageInventory(root)), error => error.code === 'ENGINE_DRIFT' && new RegExp(row.reason || 'Unsupported|Untracked|Unresolved').test(error.message), row.name)
  })
  for (const row of cases.dataControls) await t.test(row.name, () => {
    const root = mkdtempSync(join(f.dir, 'data-')), entry = join(root, `entry.${row.ext}`)
    writeFileSync(entry, row.source)
    assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
    const actual = run([entry]); assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stdout.trim(), 'inside-inventory')
  })
  const allowed = ['child_process', 'crypto', 'fs', 'module', 'os', 'path', 'url']
  const denied = ['process', 'vm', 'inspector', 'inspector/promises', 'repl', 'worker_threads', 'wasi', 'sqlite', 'fs/promises', 'not-a-real-builtin']
  for (const name of [...allowed, ...denied]) for (const prefix of ['', 'node:']) for (const form of ['static', 'side-effect', 're-export', 'dynamic', 'require']) await t.test(`builtin ${prefix}${name} via ${form}`, () => {
    const root = mkdtempSync(join(f.dir, 'builtin-')), spec = JSON.stringify(prefix + name)
    const source = form === 'static' ? name === 'module' ? `import {isBuiltin} from ${spec}` : `import * as data from ${spec}`
      : form === 'side-effect' ? `import ${spec}` : form === 're-export' ? `export * from ${spec}` : form === 'dynamic' ? `import(${spec})` : `require(${spec})`
    writeFileSync(join(root, form === 'require' ? 'entry.cjs' : 'entry.mjs'), source)
    const check = () => E.validateImports(root, E.packageInventory(root))
    const admit = allowed.includes(name) && (name !== 'module' || ['static', 'side-effect'].includes(form))
    if (admit) assert.doesNotThrow(check); else assert.throws(check)
  })
  console.log(JSON.stringify({ oracle: 'native-addon', rawExecution: 'unmeasured', coverage: 'dlopen-shaped validation refusal only; no compiled addon' }))
})
