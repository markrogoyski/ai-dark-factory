import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, jsonResult } from './fixtures/engine-package.mjs'
import { harness, paused } from './fixtures/pinned-harness.mjs'

const diagnostics = r => r.stderr.trim().split('\n').filter(line => line.startsWith('{"type":"pin.admission"')).map(JSON.parse)
function assertRedacted(r, secrets) {
  const rows = diagnostics(r); assert.ok(rows.length, r.stderr)
  for (const row of rows) {
    const text = JSON.stringify(row)
    for (const secret of secrets) assert.equal(text.includes(secret), false)
    assert.ok(row.capabilities.includes('executable-activation'))
    assert.ok(row.roles.length); assert.ok(row.sources.every(source => source.name && source.scope))
    assert.match(row.invalidation, /Persistent approvals.*one-time approvals/)
  }
  for (const secret of secrets) assert.equal((r.stdout + r.stderr).includes(secret), false)
  return rows
}
test('success and refusal diagnostics precede work and redact watched source values', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const config = join(f.env.CODEX_HOME, 'config.toml'), secret = 'PRIVATE_HEADER_COMMAND_TOKEN'
  const spec = { kind: 'codex', pin, cwd: f.target, writable: [] }
  const guard = () => spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), 'guard'], { env: f.env, input: JSON.stringify({ pin, spec }), encoding: 'utf8' })
  writeFileSync(config, 'model="presentation"\n')
  const admitted = guard(), rows = diagnostics(admitted)
  assert.equal(admitted.status, 0, admitted.stdout); assert.equal(rows[0].status, 'watching'); assert.equal(rows.at(-1).status, 'admitted')
  // Raw provenance is private evidence, whereas diagnostic labels contain no absolute paths.
  for (const row of rows) assert.equal(JSON.stringify(row).includes(f.dir), false)
  for (const source of [`unknown_${secret}="${secret}"`, `model="${secret}`, `[plugins."${secret}"]\nenabled=true`]) {
    writeFileSync(config, source)
    const r = guard(), refused = assertRedacted(r, [secret, f.dir])
    assert.notEqual(r.status, 0); assert.equal(refused[0].status, 'watching'); assert.equal(refused.at(-1).status, 'refused')
    assert.ok(refused.at(-1).reasons.includes('unknown-capabilities'))
  }
  f.update({ sources: { [config]: { status: 'unknown', error: secret } } })
  assertRedacted(guard(), [secret, f.dir]); f.update({ sources: {} })
  spec.kind = 'claude'
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: ['\u0000' + secret] } }))
  const badGrant = guard(); assert.notEqual(badGrant.status, 0); assertRedacted(badGrant, [secret, f.dir])
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{}'); spec.kind = 'codex'
  writeFileSync(config, 'model="presentation"\n')
  f.update({ facts: { claude: { deliveryKnown: false } } })
  for (const destination of [f.output, join(f.dir, 'new-export')]) {
    const r = f.launch(['--pin-engine', destination, '--workflow', 'pair', '--author', 'sol', '--reviewer', 'opus', 'Inspect sum'])
    const events = assertRedacted(r, [secret]); assert.equal(events.at(-1).status, 'refused')
    assert.match(jsonResult(r).error, /delivery facts unavailable/); assert.equal(existsSync(f.env.FACTORY_TEST_LOG), false)
  }
})
test('diagnostics survive real cache and resume paths without rewriting refusal evidence', async t => {
  await api(); const f = harness(t), p = paused(f), config = join(f.env.CODEX_HOME, 'config.toml')
  writeFileSync(config, 'model="presentation"\n')
  const answers = join(f.dir, 'diagnostic-answers.json'); writeFileSync(answers, '{"tierConfirmed":true}')
  const r = f.launch(['--resume', p.first.hostRunDir, '--args-file', answers], { PINNED_INTAKE_FEATURE: '1' })
  assert.equal(jsonResult(r).final?.readiness?.state, 'ready', r.stdout)
  assert.ok(diagnostics(r).some(row => row.status === 'admitted'))
  const before = readFileSync(p.first.checkpoint)
  writeFileSync(config, 'approvals_reviewer="guardian_subagent"\n')
  const refused = f.launch(['--resume', p.first.hostRunDir, '--args-file', answers], { PINNED_INTAKE_FEATURE: '1' })
  assert.equal(diagnostics(refused).at(-1).status, 'refused'); assert.ok(diagnostics(refused).at(-1).reasons.includes('capabilities-changed')); assert.match(jsonResult(refused).error, /settings changed/)
  assert.deepEqual(readFileSync(p.first.checkpoint), before)
})
test('overlap refusals withhold configured write roots at guard, hook and launch boundaries', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const secret = 'PRIVATE_CONFIGURATION_PATH_77921', grant = join(f.output, secret)
  writeFileSync(join(f.env.CODEX_HOME, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(grant)}]\n`)
  const input = JSON.stringify({ pin, spec: { kind: 'codex', cwd: f.target, writable: [] } })
  const run = mode => spawnSync(process.execPath, [join(pin.root, 'lib/engine.mjs'), mode], { env: f.env, input, encoding: 'utf8' })
  const launch = f.launch(['--pin-engine', f.output, '--workflow', 'pair', '--author', 'sol', '--reviewer', 'sol', 'Check fixture'])
  for (const r of [run('guard'), launch]) {
    assert.notEqual(r.status, 0); assert.match(jsonResult(r).error, /Export overlaps writable root/)
    assert.ok(diagnostics(r).at(-1).reasons.includes('write-root-overlap'))
    assert.equal((r.stdout + r.stderr).includes(secret), false)
  }
  const hook = run('hook')
  assert.equal(hook.stderr.includes(secret), false); assert.equal(hook.stdout.includes(secret), false)
  assert.equal(existsSync(f.env.FACTORY_TEST_LOG), false)
})
