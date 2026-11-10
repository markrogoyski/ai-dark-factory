import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, chmodSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, api, commit } from './fixtures/engine-package.mjs'

test('every shipped dependency and unexpected path participates in executor identity', async t => {
  const E = await api(), f = fixture(t), pin = E.exportEngine(f.source, f.output, f.target)
  for (const file of ['workflows/pair.js', 'bin/dark-factory', 'bin/dark-factory-codex', 'lib/codex-runner.mjs', 'lib/checkpoint.mjs', 'lib/evaluate.mjs', 'lib/policy.mjs', 'lib/engine.mjs', 'lib/engine-observations.mjs', 'schemas/provenance.schema.json', 'skills/dark-factory/scripts/run.mjs']) {
    const path = join(pin.root, file), original = readFileSync(path), mode = statSync(path).mode
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n// drift')]))
    assert.throws(() => E.validateExport(f.output, pin), /changed/, file); writeFileSync(path, original)
    chmodSync(path, mode & 0o100 ? 0o644 : 0o755)
    assert.throws(() => E.validateExport(f.output, pin), /changed/, file); chmodSync(path, mode)
  }
  writeFileSync(join(pin.root, 'unexpected'), 'x'); assert.throws(() => E.validateExport(f.output), /changed/); unlinkSync(join(pin.root, 'unexpected'))
  assert.equal(E.validateExport(f.output).packageDigest, pin.packageDigest)
  writeFileSync(join(f.plugin, 'lib/outside.mjs'), "import '../../outside.mjs'\n"); commit(f.source)
  assert.throws(() => E.exportEngine(f.source, join(f.dir, 'outside-export'), f.target), /external engine import/)
})
