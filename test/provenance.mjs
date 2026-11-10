import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validate } from './fixtures/provenance-schema.mjs'

test('pure implemented provenance compares identity without confusing candidate and executor', async () => {
  const P = await import('../plugins/dark-factory/lib/policy.mjs')
  const executor = { version: 1, algorithm: 'sha256-path-content-mode-v1', mode: 'pinned', packageDigest: 'a'.repeat(64), sourceRevision: 'b'.repeat(40), root: '/frozen/plugin', runtimeVersions: { node: 'v20', python: 'Python 3.12', git: 'git 2' } }
  assert.deepEqual(P.engineIdentityIssues({}, executor, { ...executor, root: '/relocated/plugin' }), [])
  for (const key of ['version', 'algorithm', 'packageDigest', 'sourceRevision', 'runtimeVersions']) assert.ok(P.engineIdentityIssues({}, executor, { ...executor, [key]: 'changed' }).length)
  assert.deepEqual(P.engineIdentityIssues({}, executor, { ...executor, sourceRevision: 'c'.repeat(40) }), ['Executor sourceRevision changed'])
  const live = { ...executor, mode: 'live' }
  for (const sourceRevision of ['c'.repeat(40), null]) assert.deepEqual(P.engineIdentityIssues({}, live, { ...live, sourceRevision }), [])
  assert.ok(P.engineIdentityIssues({}, live, { ...live, packageDigest: 'd'.repeat(64) }).length)
  assert.ok(P.engineIdentityIssues({}, live, executor).length)
  assert.ok(P.engineIdentityIssues({}, null, { ...executor, runtimeVersions: null }).length)
  const record = P.provenanceFacts({}, { executor, candidate: { packageDigest: executor.packageDigest } })
  const before = JSON.stringify(record)
  assert.deepEqual(P.pinnedOperationIssues({}, executor, { executor, unknown: [], overlaps: [] }), [])
  assert.ok(P.pinnedOperationIssues({}, executor, { executor, overlaps: ['/'] }).length)
  assert.equal(JSON.stringify(record), before)
  const schema = JSON.parse(readFileSync(new URL('../plugins/dark-factory/schemas/provenance.schema.json', import.meta.url)))
  validate(record, schema); validate(P.provenanceFacts({}, {}), schema)
  assert.throws(() => validate({ ...record, version: 2 }, schema))
  assert.throws(() => validate(record, { ...schema, unimplemented: true }), /Unsupported schema keyword/)
})
