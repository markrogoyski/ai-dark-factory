import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fixture, root, api } from './fixtures/engine-package.mjs'

test('policy target exports only implemented pure APIs and native metadata remains literal', async t => {
  await api(); const f = fixture(t)
  const policy = await import(pathToFileURL(join(f.plugin, 'lib/policy.mjs')))
  assert.deepEqual(Object.keys(policy).sort(), ['engineIdentityIssues', 'pinnedOperationIssues', 'provenanceFacts'].sort())
  const { TARGETS, POLICY_LIB } = await import('../tools/sources.mjs')
  assert.ok(POLICY_LIB.includes('src/lib/provenance.js'))
  for (const [name, target] of Object.entries(TARGETS)) {
    if (name === 'policy') continue
    const text = readFileSync(join(root, target.output), 'utf8')
    assert.match(text, /^export const meta = \{/m)
    assert.doesNotMatch(text, /^export \{/m)
  }
  cpSync(join(root, 'test'), join(f.source, 'test'), { recursive: true })
  cpSync(join(root, 'src'), join(f.source, 'src'), { recursive: true })
  cpSync(join(root, 'tools'), join(f.source, 'tools'), { recursive: true })
  for (const violation of ['function bad(S) { return process.env }', "function bad(S) { return require('node:fs') }", 'function bad(S) { return agent() }']) {
    writeFileSync(join(f.source, 'src/lib/provenance.js'), violation + '\n')
    const r = spawnSync(process.execPath, [join(f.source, 'test/static.mjs')], { encoding: 'utf8' })
    assert.notEqual(r.status, 0); assert.match(r.stdout, /FAIL src\/lib\/provenance/)
  }
  const stale = spawnSync(process.execPath, [join(f.source, 'tools/build.mjs'), '--check'], { encoding: 'utf8' })
  assert.notEqual(stale.status, 0); assert.match(stale.stderr, /policy.mjs is out of date/)
})
