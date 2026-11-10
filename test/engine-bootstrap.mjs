import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, cpSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fixture, api, cli, jsonResult, commit, readJson } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

test('CLI pins committed bytes, reuses old N and relocates without installation', async t => {
  const E = await api(), f = fixture(t)
  let result = jsonResult(cli(f, ['--pin-engine', f.output, '--workflow', 'pair', '--explain', 'Fix value']))
  assert.equal(result.status, 'explained')
  assert.equal(result.provenance.executor.mode, 'pinned')
  const digest = result.provenance.executor.packageDigest
  writeFileSync(join(f.plugin, 'lib/codex-runner.mjs'), "throw new Error('candidate takeover')\n"); commit(f.source)
  writeFileSync(join(f.plugin, 'untracked'), 'dirty')
  result = jsonResult(cli(f, ['--pin-engine', f.output, '--workflow', 'pair', '--explain', 'Fix value']))
  assert.equal(result.status, 'explained'); assert.equal(result.provenance.executor.packageDigest, digest)
  const relocated = join(f.dir, 'relocated'); cpSync(f.output, relocated, { recursive: true, verbatimSymlinks: true })
  const launcher = join(relocated, 'plugin/skills/dark-factory/scripts/run.mjs')
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [launcher, '--pin-engine', relocated, '--cwd', f.target, '--workflow', 'pair', '--explain', 'Fix value'], { encoding: 'utf8' })
  assert.equal(jsonResult(r).provenance.executor.packageDigest, digest)
  result = jsonResult(cli(f, ['--pin-engine', f.output, '--workflow', 'run-plan', '--plan-file', 'missing']))
  assert.match(result.error, /Run-plan/)
  assert.equal(E.validateExport(relocated).packageDigest, digest)
})

test('real CLI rejects broad default roots before provider work', async t => {
  await api(); const f = harness(t)
  f.update({ defaults: ['/tmp', f.dir] })
  const r = jsonResult(f.launch(['--pin-engine', f.output, '--workflow', 'pair', 'Fix sum']))
  assert.equal(r.status, 'failed')
  assert.match(r.error || r.stopReason || '', /overlaps/)
  assert.equal(existsSync(f.output), false, 'unsafe new export is refused before writing package bytes')
})

test('uninstrumented defaults refuse before provider probes or export writes', async t => {
  const f = fixture(t), bin = join(f.dir, 'runtime-bin'), home = join(f.dir, 'empty-home'), marker = join(f.dir, 'provider-ran')
  for (const path of [bin, home, join(home, 'codex'), join(home, 'claude'), join(f.dir, 'temp')]) mkdirSync(path, { recursive: true })
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const name of ['python3', 'git']) {
    const path = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim()
    assert.ok(path.startsWith('/'))
    symlinkSync(path, join(bin, name))
  }
  for (const name of ['codex', 'claude', 'agy']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf ran > '${marker}'\nexit 99\n`, { mode: 0o755 })
  const env = { HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
    TMPDIR: join(f.dir, 'temp'), TMP: join(f.dir, 'temp'), TEMP: join(f.dir, 'temp'), PATH: bin,
    DARK_FACTORY_PIN: '', DARK_FACTORY_INVOCATION: '', DARK_FACTORY_SEAT_SPEC: '',
    NODE_OPTIONS: '', PYTHONPATH: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const output = join(env.TMPDIR, 'export')
  const result = cli(f, ['--pin-engine', output, '--workflow', 'pair', 'Fix value'], env)
  const refusal = jsonResult(result)
  assert.notEqual(result.status, 0)
  assert.equal(refusal.status, 'failed')
  assert.match(refusal.error, /Default write-root overlap/)
  assert.equal(existsSync(output), false, 'no export directory, manifest or plugin bytes')
  assert.equal(existsSync(marker), false, 'no provider invocation, including version probes')
})

test('task text cannot select an additional provider during export', async t => {
  await api(); const f = harness(t)
  const result = jsonResult(f.launch(['--pin-engine', f.output, '--tier', 'simple', '--', 'Fix the literal gemini label'], { PINNED_INTAKE_FEATURE: '1' }))
  assert.equal(result.status, 'needs-tier', JSON.stringify(result))
  assert.equal(f.traces().filter(x => x.operation === 'defaults' && x.path === 'gemini').length, 0)
})

test('non-factory gates run candidate entrypoints without inherited executor context', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const helper = join(pin.root, 'bin/dark-factory'), env = { DARK_FACTORY_PIN: JSON.stringify(pin),
    DARK_FACTORY_INVOCATION: 'controller-only', DARK_FACTORY_SEAT_SPEC: 'controller-only' }
  const run = jsonResult(f.run(helper, ['init', '--repo', f.target, '--seats', 'A', '--run-id', 'candidate-env'], env))
  const script = join(f.dir, 'candidate-gate.cjs'), command = join(f.dir, 'candidate-gate.sh')
  writeFileSync(script, `const assert=require('node:assert/strict'),cp=require('node:child_process');
for(const key of ['DARK_FACTORY_PIN','DARK_FACTORY_INVOCATION','DARK_FACTORY_SEAT_SPEC']) assert.equal(Object.hasOwn(process.env,key),false,key);
const r=JSON.parse(cp.execFileSync(process.execPath,${JSON.stringify([join(f.plugin, 'bin/dark-factory-codex'), '--cwd', f.target, '--workflow', 'pair', '--explain', 'Inspect candidate'])},{encoding:'utf8'}));
assert.equal(r.provenance.executor.mode,'live');assert.equal(r.provenance.executor.root,${JSON.stringify(f.plugin)});
cp.execFileSync(${JSON.stringify(join(f.plugin, 'bin/dark-factory'))},['hash','--file',${JSON.stringify(script)}]);\n`)
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
  writeFileSync(command, `${quote(process.execPath)} ${quote(script)}\n`)
  let result = jsonResult(f.run(helper, ['verify', '--run-dir', run.runDir, '--path', f.target, '--label', 'candidate', '--command-file', command, '--max-wait', '5'], env))
  while (result.status === 'running') result = jsonResult(f.run(helper, ['wait', '--run-dir', run.runDir, '--job', result.job, '--max-wait', '5'], env))
  assert.equal(result.suite?.passed, true, JSON.stringify(result))
})
