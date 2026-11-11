import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, jsonResult } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

test('real version observations retain the specific production Claude policy refusal', async t => {
  const E = await api(), f = harness(t), executable = join(f.dir, 'bin/claude'), marker = join(f.dir, 'startup')
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '2.1.99 (Claude Code)'; exit 0; fi\necho forbidden > ${JSON.stringify(marker)}\nexit 97\n`); chmodSync(executable, 0o755)
  // Import the real adapter directly, without the test observation loader.
  const factsResult = spawnSync(process.execPath, ['--input-type=module', '-e', `import{providerFacts}from${JSON.stringify(join(f.plugin, 'lib/engine-observations.mjs'))};console.log(JSON.stringify(providerFacts('claude')))`], {
    env: { ...f.env, NODE_OPTIONS: '' }, encoding: 'utf8',
  })
  assert.equal(factsResult.status, 0, factsResult.stderr)
  const facts = JSON.parse(factsResult.stdout); assert.equal(facts.deliveryKnown, false); assert.equal(facts.hooks, true)
  f.update({ facts: { claude: { ...facts, defaults: f.settings.defaults } } })
  E.exportEngine(f.source, f.output, f.target)
  for (const destination of [f.output, join(f.dir, 'new-export')]) {
    const r = jsonResult(f.launch(['--pin-engine', destination, '--workflow', 'pair', '--author', 'opus', '--reviewer', 'sol', 'Fix sum']))
    assert.match(r.error, /mandatory server\/MDM policy delivery facts unavailable/)
    assert.equal(existsSync(marker), false); assert.equal(existsSync(f.env.FACTORY_TEST_LOG), false)
  }
})

test('ordinary unpinned headless Claude runs with Codex unavailable', async t => {
  await api(); const f = harness(t), codex = join(f.dir, 'bin/codex'), marker = join(f.dir, 'codex-invoked')
  writeFileSync(codex, `#!/bin/sh\necho forbidden > ${JSON.stringify(marker)}\nexit 98\n`)
  const args = join(f.dir, 'claude-only.json')
  writeFileSync(args, JSON.stringify({ task: 'Fix sum', author: 'opus', reviewer: 'sonnet' }))
  const result = jsonResult(f.launch(['--workflow', 'pair', '--args-file', args]))
  assert.equal(result.final?.readiness?.state, 'ready', JSON.stringify(result))
  assert.equal(existsSync(marker), false)
  const calls = readFileSync(f.env.FACTORY_TEST_LOG, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.length); assert.ok(calls.every(call => call.vendor === 'claude'))
  for (const call of calls) {
    assert.equal(call.args.includes('--disable-slash-commands'), false)
    assert.equal(call.args.includes('--strict-mcp-config'), false)
    assert.ok(call.args.includes('--permission-prompts'))
    const tools = call.args[call.args.indexOf('--tools') + 1]
    assert.equal(tools, 'Bash,Read,Glob,Grep,Edit,Write')
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1])
    assert.equal(settings.sandbox.failIfUnavailable, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false)
  }
})
