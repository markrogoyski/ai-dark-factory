import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, symlinkSync, chmodSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fixture, api, commit, git } from './fixtures/engine-package.mjs'
import { validate } from './fixtures/provenance-schema.mjs'

test('committed path/content/mode identity survives relocation and explicit reuse', async t => {
  const configKeys = Object.keys(process.env).filter(k => /^GIT_CONFIG/.test(k) || k === 'GIT_ATTR_NOSYSTEM')
  const inherited = Object.fromEntries(configKeys.map(k => [k, process.env[k]]))
  configKeys.forEach(k => delete process.env[k])
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1' })
  t.after(() => {
    Object.keys(process.env).filter(k => /^GIT_CONFIG/.test(k) || k === 'GIT_ATTR_NOSYSTEM').forEach(k => delete process.env[k])
    Object.assign(process.env, inherited)
  })
  const E = await api(), f = fixture(t)
  git(f.source, 'config', 'core.attributesFile', '/dev/null')
  git(f.source, 'config', 'core.autocrlf', 'false')
  git(f.source, 'config', 'core.safecrlf', 'false')
  const payload = Buffer.from('$Format:%H$\n$Id$\n')
  writeFileSync(join(f.plugin, '.gitattributes'), 'attribute.txt export-subst ident text eol=crlf\n')
  writeFileSync(join(f.plugin, 'attribute.txt'), payload)
  writeFileSync(join(f.plugin, 'literal 🎲 $ space'), Buffer.from([0, 255, 13, 10])); chmodSync(join(f.plugin, 'literal 🎲 $ space'), 0o755)
  symlinkSync('literal 🎲 $ space', join(f.plugin, 'internal-link')); commit(f.source)
  const attrs = git(f.source, 'check-attr', 'export-subst', 'ident', 'text', 'eol', '--', 'plugins/dark-factory/attribute.txt')
  for (const value of ['export-subst: set', 'ident: set', 'text: set', 'eol: crlf']) assert.ok(attrs.includes(value))
  const raw = (...args) => execFileSync('git', ['-C', f.source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  assert.deepEqual(raw('cat-file', 'blob', 'HEAD:plugins/dark-factory/attribute.txt'), payload)
  assert.notDeepEqual(raw('cat-file', '--filters', 'HEAD:plugins/dark-factory/attribute.txt'), payload)
  // An independent raw-object oracle must disagree with filtered/archive exports.
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const rows = raw('ls-tree', '-rz', 'HEAD:plugins/dark-factory'), expected = []
  let start = 0
  for (let i = 0; i < rows.length; i++) if (rows[i] === 0) {
    const record = rows.subarray(start, i), tab = record.indexOf(9)
    const [mode, type, object] = record.subarray(0, tab).toString().split(' ')
    assert.equal(type, 'blob')
    expected.push([record.subarray(tab + 1).toString('base64'), mode, hash(raw('cat-file', 'blob', object))])
    start = i + 1
  }
  expected.sort((a, b) => Buffer.compare(Buffer.from(a[0], 'base64'), Buffer.from(b[0], 'base64')))
  const expectedDigest = hash(JSON.stringify([1, 'sha256-path-content-mode-v1', expected]))
  const pin = E.exportEngine(f.source, f.output, f.target)
  assert.deepEqual(readFileSync(join(pin.root, 'attribute.txt')), payload)
  assert.equal(pin.packageDigest, expectedDigest)
  const schema = JSON.parse(readFileSync(join(f.plugin, 'schemas/provenance.schema.json')))
  validate(JSON.parse(readFileSync(join(f.output, 'manifest.json'))), schema.definitions.manifest)
  assert.equal(pin.packageDigest, E.inventoryDigest(E.committedInventory(f.source).entries))
  assert.equal(pin.packageDigest, E.inventoryDigest(E.packageInventory(join(f.output, 'plugin'))))
  cpSync(f.output, join(f.dir, 'relocated'), { recursive: true, verbatimSymlinks: true })
  assert.equal(E.validateExport(join(f.dir, 'relocated'), pin).packageDigest, pin.packageDigest)
  writeFileSync(join(f.plugin, 'new'), 'candidate'); commit(f.source)
  writeFileSync(join(f.plugin, 'new'), 'dirty')
  assert.deepEqual(E.exportEngine(f.source, f.output, f.target), pin)
  assert.throws(() => E.exportEngine(f.source, join(f.dir, 'new-export'), f.target), /clean shipped/)
  const path = join(f.output, 'manifest.json'), manifest = JSON.parse(readFileSync(path))
  manifest.version = 99; writeFileSync(path, JSON.stringify(manifest))
  assert.equal(E.inventoryDigest(E.packageInventory(pin.root)), pin.packageDigest)
  assert.throws(() => E.validateExport(f.output), /manifest/)
})
