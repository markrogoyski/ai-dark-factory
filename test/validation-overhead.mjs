import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { api, root, git } from './fixtures/engine-package.mjs'
import { harness, paused } from './fixtures/pinned-harness.mjs'

test('offline validation measurements retain mutation detection', async t => {
  const E = await api(), f = harness(t), timings = {}, trace = join(f.dir, 'validation.jsonl')
  const measure = (name, fn, count = 3) => {
    const samples = []
    for (let i = 0; i < count; i++) { const start = performance.now(); fn(i); samples.push(performance.now() - start) }
    const ordered = [...samples].sort((a,b) => a-b)
    timings[name] = { samples, medianMs: ordered[Math.floor(ordered.length / 2)], tailMs: ordered.at(-1) }
  }
  measure('export', i => E.exportEngine(f.source, join(f.dir, `export-${i}`), f.target))
  const pin = E.exportEngine(f.source, f.output, f.target)
  const spec = { kind: 'codex', cwd: f.target, writable: [], pin }
  const input = JSON.stringify({ pin, spec })
  // Timings exclude count instrumentation; raw host observations remain hermetic.
  writeFileSync(join(f.dir, 'request.json'), input)
  const call = (command, extra = {}) => {
    const request = command === 'hook' ? { tool_name: 'Bash', tool_input: { command: ':' } } : { pin, spec }
    const program = `import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,${JSON.stringify([join(pin.root, 'lib/engine.mjs'), command, ...(command === 'hook' ? [join(f.dir, 'spec.json')] : [])])},{env:process.env,input:${JSON.stringify(JSON.stringify(request))},encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1)`
    return f.run(process.execPath, ['--input-type=module', '-e', program], extra)
  }
  writeFileSync(join(f.dir, 'spec.json'), JSON.stringify(spec))
  for (const command of ['guard', 'hook']) measure(command, () => { const r = call(command); assert.equal(r.status, 0, r.stdout + r.stderr) })
  const helper = join(pin.root, 'bin/dark-factory')
  measure('helper', () => assert.equal(f.run(helper, ['hash', '--file', f.descriptor], { DARK_FACTORY_PIN: JSON.stringify(pin) }).status, 0))
  measure('pauseAndResume', () => { const p = paused(f); assert.equal(p.resume().final?.readiness?.state, 'ready') })
  const instrumentation = { NODE_OPTIONS: f.env.NODE_OPTIONS + ` --import=${join(root, 'test/fixtures/validation-probe.mjs')}`, VALIDATION_TRACE: trace }
  const observations = {}
  for (const operation of ['export', 'guard', 'hook', 'helper', 'resume']) {
    const start = f.traces().length, extra = { ...instrumentation, VALIDATION_OPERATION: operation }
    if (operation === 'export') {
      const program = `import {exportEngine} from ${JSON.stringify(join(f.plugin, 'lib/engine.mjs'))};exportEngine(${JSON.stringify(f.source)},${JSON.stringify(join(f.dir, 'counted-export'))},${JSON.stringify(f.target)})`
      const result = f.run(process.execPath, ['--input-type=module', '-e', program], extra)
      assert.equal(result.status, 0, result.stdout + result.stderr)
    } else if (operation === 'helper') assert.equal(f.run(helper, ['hash', '--file', f.descriptor], { ...extra, DARK_FACTORY_PIN: JSON.stringify(pin) }).status, 0)
    else if (operation === 'resume') {
      const previous = { ...f.env }
      Object.assign(f.env, extra)
      try { const p = paused(f); assert.equal(p.resume().final?.readiness?.state, 'ready') }
      finally { for (const key of Object.keys(f.env)) delete f.env[key]; Object.assign(f.env, previous) }
    } else { const counted = call(operation, extra); assert.equal(counted.status, 0, counted.stdout + counted.stderr) }
    const seen = f.traces().slice(start)
    observations[operation] = { sourceReads: seen.filter(x => x.operation === 'source').length, providerFacts: seen.filter(x => x.operation === 'facts').length }
  }
  const counts = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  for (const operation of ['export', 'guard', 'hook', 'helper', 'resume']) assert.ok(counts.some(c => c.operation === operation && c.hashes > 0 && c.readBytes > 0), operation)
  const path = join(pin.root, 'lib/evaluate.mjs'), original = readFileSync(path)
  writeFileSync(path, Buffer.concat([original, Buffer.from('\n// changed')]))
  assert.notEqual(call('guard').status, 0)
  writeFileSync(path, original)
  const indexEnv = { ...process.env, GIT_INDEX_FILE: join(f.dir, 'measurement-index') }
  const treeGit = (...args) => execFileSync('git', ['-C', root, ...args], { env: indexEnv, encoding: 'utf8' }).trim()
  treeGit('read-tree', 'HEAD'); treeGit('add', '-A')
  console.log(JSON.stringify({ measurement: 'offline-validation', revision: git(root, 'rev-parse', 'HEAD'), tree: treeGit('write-tree'), node: process.version, counts, observations, timings, scope: 'temporary repositories and stub CLIs; Node validation counts only; timing excludes count instrumentation; pauseAndResume includes the charged pause; no live inference' }))
})
