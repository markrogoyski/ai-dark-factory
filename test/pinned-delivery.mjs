import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { api, jsonResult, readJson, git } from './fixtures/engine-package.mjs'
import { harness, paused } from './fixtures/pinned-harness.mjs'

test('real resumed snapshot delivers and evaluator identity remains frozen', async t => {
  await api(); const f = harness(t), p = paused(f), result = p.resume()
  assert.equal(result.final?.readiness.state, 'ready', JSON.stringify(result))
  const pin = result.provenance.executor, helper = join(pin.root, 'bin/dark-factory'), env = { DARK_FACTORY_PIN: JSON.stringify(pin) }
  const measurements = readdirSync(join(result.runDir, 'jobs')).filter(name => name.startsWith('measure-')).map(name => {
    try { return readJson(join(result.runDir, 'jobs', name, 'status.json')) } catch { return null }
  })
  const measured = measurements.find(m => m?.snapshot?.ref === result.final.snapshotRef)
  assert.ok(measured, 'final snapshot has an actual measurement record')
  assert.equal(result.final.snapshotTree, measured.snapshot.tree)
  const report = join(result.hostRunDir, 'result.json')
  const applied = jsonResult(f.run(helper, ['apply', '--run-dir', result.runDir, '--result', report], env))
  assert.equal(applied.status, 'applied', JSON.stringify(applied))
  let delivery = jsonResult(f.run(helper, ['verify-delivery', '--run-dir', result.runDir, '--result', report, '--max-wait', '5'], env))
  while (delivery.status === 'running') delivery = jsonResult(f.run(helper, ['wait', '--run-dir', result.runDir, '--job', delivery.job, '--max-wait', '5'], env))
  const recorded = readJson(join(result.runDir, 'delivery.json'))
  assert.equal(recorded.status, 'delivered', JSON.stringify(recorded))
  assert.equal(recorded.provenance.executor.packageDigest, pin.packageDigest)
  assert.equal(recorded.provenance.candidate.deliveredTree, measured.snapshot.tree)
  assert.equal(recorded.provenance.candidate.deliveredTree, git(f.target, 'write-tree'))
  assert.equal(recorded.provenance.candidate.deliveredCommit, null)
  const evaluator = join(pin.root, 'bin/dark-factory-evaluate')
  const evaluated = jsonResult(f.run(process.execPath, [evaluator, report], env))
  assert.equal(evaluated.evaluator.packageDigest, pin.packageDigest)
  assert.ok(f.traces().some(x => x.argv[1] === evaluator))
  const legacyFile = join(f.dir, 'legacy.json'), legacy = { ...result }; delete legacy.provenance
  writeFileSync(legacyFile, JSON.stringify(legacy))
  assert.equal(jsonResult(f.run(process.execPath, [evaluator, legacyFile])).runs, 1)
  // The candidate gate is unchanged; an external fixture marker triggers a new dependency drift.
  writeFileSync(join(f.dir, 'gate-switch.json'), JSON.stringify({ path: join(pin.root, 'lib/checkpoint.mjs') }))
  let drifted = jsonResult(f.run(helper, ['verify-delivery', '--run-dir', result.runDir, '--result', report, '--max-wait', '5'], env))
  while (drifted.status === 'running') drifted = jsonResult(f.run(helper, ['wait', '--run-dir', result.runDir, '--job', drifted.job, '--max-wait', '5'], env))
  assert.notEqual(drifted.status, 'delivered')
  assert.notEqual(readJson(join(result.runDir, 'delivery.json')).status, 'delivered')
  const before = readFileSync(join(result.runDir, 'delivery.json'))
  const failed = f.run(helper, ['apply', '--run-dir', result.runDir, '--result', report], env)
  assert.notEqual(failed.status, 0); assert.match(failed.stdout, /changed/)
  assert.deepEqual(readFileSync(join(result.runDir, 'delivery.json')), before)
  assert.notEqual(f.run(process.execPath, [evaluator, report], env).status, 0)
  const jobs = join(result.runDir, 'jobs')
  const existing = readdirSync(jobs).find(name => { try { return readJson(join(jobs, name, 'spec.json')).pin?.mode === 'pinned' } catch { return false } })
  const jd = join(jobs, 'dependency-drift-job'); mkdirSync(jd)
  writeFileSync(join(jd, 'spec.json'), JSON.stringify(readJson(join(jobs, existing, 'spec.json'))))
  f.run(helper, ['_job', jd], { DARK_FACTORY_PIN: '' })
  assert.equal(readJson(join(jd, 'status.json')).code, 'ENGINE_DRIFT')
  const oldStatus = readFileSync(join(jobs, existing, 'status.json'))
  const cache = f.run(helper, ['seat-run', '--run-dir', result.runDir, '--seat', 'A', '--job', existing, '--model', 'fixture', '--effort', 'high', '--cwd', f.target, '--prompt-file', join(f.dir, 'missing')], env)
  assert.notEqual(cache.status, 0)
  assert.deepEqual(readFileSync(join(jobs, existing, 'status.json')), oldStatus)
})
