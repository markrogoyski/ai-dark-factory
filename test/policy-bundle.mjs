import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fixture, root, api } from './fixtures/engine-package.mjs'

// Keep this allowlist independent of the generator's export list.
const exports = ['engineIdentityIssues', 'pinnedOperationIssues', 'provenanceFacts', 'providerConfiguration', 'reachableProviders']
test('policy closure, deterministic intrinsics and native target boundaries', async t => {
  await api(); const f = fixture(t)
  const policy = await import(pathToFileURL(join(f.plugin, 'lib/policy.mjs')))
  assert.deepEqual(Object.keys(policy).sort(), exports.sort())
  const { TARGETS, POLICY_LIB } = await import('../tools/sources.mjs')
  const { assertPolicy } = await import('../tools/policy-static.mjs')
  const sources = POLICY_LIB.map(file => ({ file, text: readFileSync(join(root, file), 'utf8') }))
  assertPolicy(sources, exports, TARGETS.policy.trailer)
  assert.throws(() => assertPolicy(sources, exports, TARGETS.policy.trailer + 'console.log(1)'), /export trailer/)
  const scope = JSON.parse(readFileSync(join(root, 'test/fixtures/policy-scope.json')))
  for (const text of scope.valid) assert.doesNotThrow(() => assertPolicy([{ file: 'positive.js', text }]))
  for (const text of scope.invalid) assert.throws(() => assertPolicy([{ file: 'negative.js', text }]), undefined, text)
  for (const source of sources) {
    for (const body of ['return missingPureDependency(S)', 'return process.env', "return require('node:fs')", 'return agent(S)', 'return console.log(S)', 'return Math.random()', 'return `${performance.now()}`']) {
      const changed = sources.map(s => s === source ? { ...s, text: s.text + `\nfunction injectedViolation(S) { ${body} }\n` } : s)
      assert.throws(() => assertPolicy(changed), undefined, `${source.file}: ${body}`)
    }
  }
  for (const removed of ['src/lib/ledger.js', 'src/lib/prompts.js']) assert.throws(() => assertPolicy(sources.filter(s => s.file !== removed)), /Unresolved/)
  for (const [name, target] of Object.entries(TARGETS)) {
    if (name === 'policy') continue
    const text = readFileSync(join(root, target.output), 'utf8')
    assert.match(text, /^export const meta = \{/m); assert.doesNotMatch(text, /^export \{/m)
  }
  cpSync(join(root, 'src'), join(f.source, 'src'), { recursive: true })
  cpSync(join(root, 'tools'), join(f.source, 'tools'), { recursive: true })
  mkdirSync(join(f.source, 'test'), { recursive: true })
  cpSync(join(root, 'test/static.mjs'), join(f.source, 'test/static.mjs'))
  const listPath = join(f.source, 'tools/sources.mjs'), originalList = readFileSync(listPath, 'utf8')
  for (const removed of ['src/lib/ledger.js', 'src/lib/prompts.js']) {
    writeFileSync(listPath, originalList.replace('...LIB, ...PAIR_LIB', `...LIB.filter(file => file !== '${removed}'), ...PAIR_LIB`))
    for (const command of [['tools/build.mjs', '--check'], ['test/static.mjs']]) {
      const r = spawnSync(process.execPath, [join(f.source, command[0]), ...command.slice(1)], { encoding: 'utf8' })
      assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /Unresolved or ambient policy identifier/)
    }
  }
  writeFileSync(listPath, originalList)
  const build = flags => spawnSync(process.execPath, [join(f.source, 'tools/build.mjs'), ...flags], { encoding: 'utf8' })
  const path = join(f.source, 'src/lib/provenance.js'), original = readFileSync(path, 'utf8')
  writeFileSync(path, original + '\nfunction missing(S) { return absentFromPolicy(S) }\n')
  for (const flags of [[], ['--check']]) { const r = build(flags); assert.notEqual(r.status, 0); assert.match(r.stderr, /Unresolved.*absentFromPolicy/) }
  writeFileSync(path, original + '\n// stale generated output\n')
  assert.match(build(['--check']).stderr, /policy.mjs is out of date/)
})
