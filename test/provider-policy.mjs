import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { providerConfiguration } from '../plugins/dark-factory/lib/policy.mjs'
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/provider-settings.json', import.meta.url)))
const facts = vendor => ({ unknown: [], deliveryKnown: true, catalogsBounded: true, immutable: vendor !== 'claude', hooks: vendor === 'claude' })
const observations = (vendor, data) => ({ vendor, facts: facts(vendor), permissionMode: 'acceptEdits', shellBounded: true, statusLineOverride: true, layers: [{ source: '/example/settings', base: '/example', data }], plugins: vendor === 'claude' ? [{ source: 'dark-factory@example', inspected: true, executable: [['bin/dark-factory','abc']], activation: { slashCommands: false } }] : [] })
test('typed effective provider configurations admit realistic bounded settings', () => {
  for (const vendor of Object.keys(fixtures)) {
    const input = observations(vendor, fixtures[vendor]), original = JSON.stringify(input), result = providerConfiguration({}, input)
    assert.deepEqual(result.unknown, [], vendor); assert.equal(JSON.stringify(input), original)
    const presentation = structuredClone(input); presentation.layers[0].data.model = 'other-model'
    assert.deepEqual(providerConfiguration({}, presentation).security, result.security)
  }
})
test('unknown executable surfaces and unbounded permissions refuse specifically', () => {
  for (const [vendor, data] of [['claude',{hooks:{SessionStart:[]}}], ['claude',{mcpServers:{local:{command:'node'}}}], ['claude',{permissions:{allow:['Write(/**)']}}], ['codex',{features:{arbitrary_executor:true}}], ['codex',{unexpected_command:'anything'}], ['codex',{model:false}], ['codex',{approval_policy:{execute:'something'}}]]) {
    const result = providerConfiguration({}, observations(vendor,data))
    assert.ok(result.unknown.length, JSON.stringify(data)); assert.ok(result.unknown.every(x=>x.includes(vendor)))
  }
  for (const key of ['hooks','mcp','lsp','startup']) {
    const input = observations('claude', fixtures.claude); input.plugins[0][key]=true
    assert.match(providerConfiguration({},input).unknown.join(';'), /unsupported executable/)
  }
  const inherited=JSON.parse('{"__proto__":{"command":"bad"}}')
  assert.match(providerConfiguration({},observations('claude',inherited)).unknown.join(';'),/unsupported settings key/)
  const opaque=observations('claude',fixtures.claude);opaque.facts.deliveryKnown=false
  assert.match(providerConfiguration({},opaque).unknown.join(';'),/delivery facts unavailable/)
  const input=observations('gemini',fixtures.gemini); input.facts.unknown=['unsupported provider configuration version']
  assert.match(providerConfiguration({},input).unknown.join(';'), /unsupported provider/)
})
test('only selected profiles and applicable trusted layers grant roots', () => {
  const input=observations('codex',{profiles:{wide:{sandbox_workspace_write:{writable_roots:['/wide']}}}})
  assert.deepEqual(providerConfiguration({},input).grants,[])
  input.profile='wide'; assert.equal(providerConfiguration({},input).grants[0].value,'/wide')
  input.layers[0].applicable=false; assert.deepEqual(providerConfiguration({},input).grants,[])
})

test('typed nested presentation and activation boundaries are explicit', () => {
  const codex = observations('codex', fixtures.codex), before = providerConfiguration({}, codex)
  assert.deepEqual(before.unknown, [])
  codex.layers[0].data.notice.hide_full_access_warning = false
  codex.layers[0].data.notice.model_migrations.other = 'model'
  assert.deepEqual(providerConfiguration({}, codex).security, before.security)
  const claude = observations('claude', fixtures.claude), original = providerConfiguration({}, claude)
  claude.layers[0].data.tui = 'default'
  assert.deepEqual(providerConfiguration({}, claude).security, original.security)
  for (const [vendor, data] of [
    ['codex', { notice: { run: 'secret-command' } }], ['codex', { notice: { hide_full_access_warning: 'yes' } }],
    ['codex', { plugins: { 'active@example': { enabled: true } } }], ['codex', { plugins: { 'inactive@example': { enabled: false, mcp_servers: {} } } }],
    ['codex', { marketplaces: { example: { source: 'x', source_type: 'command' } } }],
    ['claude', { tui: {} }], ['claude', { autoMode: { hard_deny: false } }],
    ['claude', { extraKnownMarketplaces: { example: { source: { source: 'url', url: 'https://example.invalid', headersHelper: 'secret-command' } } } }],
  ]) assert.ok(providerConfiguration({}, observations(vendor, data)).unknown.length, JSON.stringify(data))
  for (const input of [observations('codex', fixtures.codex), observations('claude', fixtures.claude)]) {
    input.facts.catalogsBounded = false
    assert.match(providerConfiguration({}, input).unknown.join(';'), /marketplace refresh/)
  }
  claude.permissionMode = 'auto'
  assert.match(providerConfiguration({}, claude).unknown.join(';'), /auto mode enforcement/)
  const passive = observations('codex', { plugins: { 'local@example': { enabled: true } } })
  passive.plugins = [{ source: 'local@example', inspected: true, executable: [['script', 'digest']], activation: { hooks: false } }]
  assert.deepEqual(providerConfiguration({}, passive).unknown, [])
  passive.plugins[0].hooks = true
  assert.match(providerConfiguration({}, passive).unknown.join(';'), /unsupported executable/)
})

test('applicable project profile definitions conservatively contribute roots and executable facts', () => {
  const input = observations('codex', {})
  input.layers = [
    { source: '/user/config', scope: 'user', data: { profile: 'wide', profiles: { wide: { sandbox_workspace_write: { writable_roots: ['/user-root'] } } } } },
    { source: '/project/config', scope: 'project', data: { profile: 'narrow', profiles: { wide: { sandbox_workspace_write: { writable_roots: ['/export-dir'] } }, narrow: { sandbox_workspace_write: { writable_roots: ['/another-root'] } } } } },
  ]
  const before = JSON.stringify(input), result = providerConfiguration({}, input)
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.grants.map(g => g.value).sort(), ['/another-root', '/export-dir', '/user-root'])
  assert.equal(JSON.stringify(input), before)
  for (const profiles of [
    { wide: { mcp_servers: { local: { command: 'secret-command' } } } },
    { narrow: { hooks: { start: 'secret-command' } } },
    { wide: { unsupported_command: 'secret-command' } },
    { wide: null }, null, [],
  ]) {
    input.layers[1].data = { profiles }
    const refused = providerConfiguration({}, input)
    assert.ok(refused.unknown.length, JSON.stringify(profiles))
    assert.equal(refused.unknown.join(';').includes('secret-command'), false)
  }
  input.layers[1].applicable = false
  assert.deepEqual(providerConfiguration({}, input).grants.map(g => g.value), ['/user-root'])
  input.layers[1].applicable = true
  input.layers[1].data = { profiles: { extra: { sandbox_workspace_write: { writable_roots: ['/project-only'] } } } }
  input.layers[0].data = {}
  assert.deepEqual(providerConfiguration({}, input).grants.map(g => g.value), ['/project-only'])
})
