import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, fixture, subjectEnv } from './fixtures/engine-package.mjs'

const cases = JSON.parse(readFileSync(new URL('./fixtures/engine-loader-cases.json', import.meta.url)))
test('supported loaders and genuine local scopes retain real file loading and shipped closure', async t => {
  const E = await api(), f = fixture(t)
  for (const row of cases.controls) await t.test(row.name, () => {
    const root = mkdtempSync(join(f.dir, 'positive-')), entry = join(root, `entry.${row.ext}`)
    mkdirSync(join(root, '%2e%2e')); writeFileSync(join(root, '%2e%2e/inside.cjs'), "module.exports='inside-inventory'\n")
    writeFileSync(join(root, 'inside.cjs'), "module.exports='inside-inventory'\n"); writeFileSync(entry, row.source)
    assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
    if (row.execute !== false) {
      const actual = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000, env: subjectEnv(process.env) })
      assert.equal(actual.status, 0, actual.stderr); assert.equal(actual.stdout.trim(), 'inside-inventory')
    }
  })
  const root = mkdtempSync(join(f.dir, 'members-'))
  writeFileSync(join(root, 'entry.mjs'), ['argv', 'env', 'exitCode', 'execPath', 'on', 'once', 'removeListener', 'kill', 'pid', 'stdout', 'stderr', 'version', 'geteuid', 'cwd'].map(name => `void process.${name};void globalThis.process[${JSON.stringify(name)}]`).join('\n'))
  assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
  assert.doesNotThrow(() => E.validateImports(f.plugin, E.packageInventory(f.plugin)))
  assert.ok(E.exportEngine(f.source, f.output, f.target).packageDigest)
})
