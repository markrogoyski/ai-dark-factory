import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, jsonResult } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'
import { providerPlugin } from './fixtures/provider-plugins.mjs'
const settings=JSON.parse(readFileSync(new URL('./fixtures/provider-settings.json',import.meta.url)))
function guard(f,pin,spec,event=null) {
  return spawnSync(process.execPath,[join(pin.root,'lib/engine.mjs'),event?'hook':'guard',...(event?[join(f.dir,'seat.json')]:[])],{env:f.env,encoding:'utf8',input:JSON.stringify(event || {pin,spec})})
}
test('realistic enabled plugin admits; semantic settings drift blocks tools and reloads',async t=>{
  const E=await api(),f=harness(t),plugin=providerPlugin(f.env.CLAUDE_CONFIG_DIR),path=join(f.env.CLAUDE_CONFIG_DIR,'settings.json')
  writeFileSync(path,JSON.stringify(settings.claude));const pin=E.exportEngine(f.source,f.output,f.target),spec={kind:'claude',pin,cwd:f.target,writable:[]}
  const admitted=guard(f,pin,spec);assert.equal(admitted.status,0,admitted.stdout+admitted.stderr)
  spec.settingsHash=jsonResult(admitted).settings.settingsHash;writeFileSync(join(f.dir,'seat.json'),JSON.stringify(spec))
  writeFileSync(path,JSON.stringify({...settings.claude,theme:'light'},null,4))
  writeFileSync(join(plugin.root,'output-styles/concise.md'),'Use short sentences.\n')
  assert.equal(guard(f,pin,spec).status,0)
  assert.equal(guard(f,pin,spec,{hook_event_name:'ConfigChange'}).status,0)
  const tool=guard(f,pin,spec,{tool_name:'Bash',tool_input:{command:'dark-factory hash --file value',timeout:12}})
  assert.equal(tool.status,0,tool.stderr);const updated=jsonResult(tool).hookSpecificOutput.updatedInput
  assert.match(updated.command,/export PATH=/);assert.ok(updated.command.includes(join(pin.root,'bin')));assert.equal(updated.timeout,12)
  writeFileSync(join(plugin.root,'bin/dark-factory'),'#!/bin/sh\nexit 98\n')
  for(const event of [null,{tool_name:'Write',tool_input:{file_path:'value'}},{hook_event_name:'ConfigChange'}]) {
    const result=guard(f,pin,spec,event);assert.notEqual(result.status,0);assert.match(result.stderr+result.stdout,/settings changed/)
  }
  assert.equal(existsSync(join(f.target,'forbidden-startup')),false)
})
test('plugin startup surfaces and forged invocation guards refuse before execution',async t=>{
  const E=await api()
  for(const variant of ['hook','mcp']) {
    const f=harness(t);providerPlugin(f.env.CLAUDE_CONFIG_DIR,variant);writeFileSync(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify(settings.claude))
    const pin=E.exportEngine(f.source,f.output,f.target),spec={kind:'claude',pin,cwd:f.target,writable:[]},r=guard(f,pin,spec)
    assert.notEqual(r.status,0);assert.match(r.stdout,/unsupported executable/);assert.equal(existsSync(join(f.target,'forbidden-startup')),false)
  }
  const f=harness(t),pin=E.exportEngine(f.source,f.output,f.target),spec={kind:'claude',pin,cwd:f.target,writable:[]}
  for(const data of [{hooks:{PreToolUse:[{origin:'invocation',hooks:[{type:'command',command:`node ${pin.root}/lib/engine.mjs hook fake || exit 2`}]}]}},{disableAllHooks:true},{sandbox:{allowUnsandboxedCommands:true}}]) {
    writeFileSync(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify(data));assert.notEqual(guard(f,pin,spec).status,0)
  }
})
test('Codex trust, profiles and source statuses determine actual applicable grants',async t=>{
  const E=await api(),f=harness(t),pin=E.exportEngine(f.source,f.output,f.target),spec={kind:'codex',pin,cwd:f.target,writable:[]},user=join(f.env.CODEX_HOME,'config.toml')
  mkdirSync(join(f.target,'.codex'));writeFileSync(join(f.target,'.codex/config.toml'),`[sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(f.output)}]\n`)
  writeFileSync(user,'model="gpt-6.1-sol"\npersonality="pragmatic"\n');const first=guard(f,pin,spec);assert.equal(first.status,0,first.stdout)
  spec.settingsHash=jsonResult(first).settings.settingsHash
  writeFileSync(user,'# presentation only\npersonality = "friendly"\nmodel = "gpt-6-astra"\n');assert.equal(guard(f,pin,spec).status,0)
  writeFileSync(user,`[projects.${JSON.stringify(f.target)}]\ntrust_level="trusted"\n`);const wide=guard(f,pin,spec);assert.notEqual(wide.status,0);assert.match(wide.stdout,/overlaps/)
  for(const status of ['directory','unknown']) {
    f.update({sources:{'/etc/claude-code/managed-settings.d':{status,entries:[]}}});spec.kind='claude';delete spec.settingsHash
    assert.match(guard(f,pin,spec).stdout,/managed settings directory/)
  }
})

test('trusted project profile cannot replace or redefine a selected user profile', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const user = join(f.env.CODEX_HOME, 'config.toml'), project = join(f.target, '.codex/config.toml')
  mkdirSync(join(f.target, '.codex'))
  writeFileSync(user, `profile="wide"\n[projects.${JSON.stringify(f.target)}]\ntrust_level="trusted"\n[profiles.wide.sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(f.output)}]\n`)
  for (const selection of ['narrow', 'wide']) {
    writeFileSync(project, `profile=${JSON.stringify(selection)}\n[profiles.wide.sandbox_workspace_write]\nwritable_roots=[]\n[profiles.narrow.sandbox_workspace_write]\nwritable_roots=[]\n`)
    const result = guard(f, pin, { kind: 'codex', pin, cwd: f.target, writable: [] })
    assert.notEqual(result.status, 0); assert.match(result.stdout, /overlaps/)
  }
})

test('actual typed TOML presentation preserves identity and activation drift refuses', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const path = join(f.env.CODEX_HOME, 'config.toml'), spec = { kind: 'codex', pin, cwd: f.target, writable: [] }
  const text = '[plugins."inactive@example"]\nenabled=false\n[marketplaces.example]\nsource="https://example.invalid/catalog.git"\nsource_type="git"\n[notice]\nhide_full_access_warning=true\n'
  writeFileSync(path, text)
  const first = guard(f, pin, spec); assert.equal(first.status, 0, first.stdout)
  spec.settingsHash = jsonResult(first).settings.settingsHash
  writeFileSync(path, text.replace('warning=true', 'warning=false') + '\n# format only\n')
  assert.equal(guard(f, pin, spec).status, 0)
  writeFileSync(path, text.replace('enabled=false', 'enabled=true'))
  assert.match(guard(f, pin, spec).stdout, /active plugin|settings changed/)
})
test('pinned helper constructs strict provider controls without changing native defaults',()=>{
  const text=readFileSync(new URL('../plugins/dark-factory/bin/dark-factory',import.meta.url),'utf8')
  assert.match(text,/--disable-slash-commands/);assert.match(text,/--strict-mcp-config/);assert.match(text,/'--mcp-config', '\{"mcpServers":\{\}\}'/)
  assert.match(text,/'ConfigChange'/);assert.match(text,/approval_policy="never"/)
})

test('semantic settings edits preserve cached helper jobs; capability drift refuses reuse',async t=>{
  const E=await api(),f=harness(t),pin=E.exportEngine(f.source,f.output,f.target),helper=join(pin.root,'bin/dark-factory')
  const env={DARK_FACTORY_PIN:JSON.stringify(pin),PINNED_TINY:'1'},config=join(f.env.CODEX_HOME,'config.toml')
  const run=jsonResult(f.run(helper,['init','--repo',f.target,'--seats','A','--run-id','semantic-cache','--factory'],env))
  const prompt=join(f.dir,'prompt.md');writeFileSync(prompt,'Check fixture\n<<<OUTPUT_SCHEMA\n{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}\nOUTPUT_SCHEMA>>>\n')
  const args=['seat-run','--run-dir',run.runDir,'--vendor','codex','--seat','A','--job','cached','--model','fixture','--effort','high','--sandbox','workspace-write','--cwd',run.worktrees.A,'--prompt-file',prompt,'--fresh','--max-wait','5']
  const first=jsonResult(f.run(helper,args,env));assert.equal(first.status,'done',JSON.stringify(first))
  const specPath=join(run.runDir,'jobs/cached/spec.json'),before=readFileSync(specPath),usage=readFileSync(join(run.runDir,'usage.jsonl'))
  writeFileSync(config,'model = "presentation-change"\n');assert.equal(jsonResult(f.run(helper,args,env)).status,'done')
  assert.deepEqual(readFileSync(join(run.runDir,'usage.jsonl')),usage)
  writeFileSync(config,'approvals_reviewer = "guardian_subagent"\n');const refused=jsonResult(f.run(helper,args,env))
  assert.match(refused.error,/settings changed/);assert.deepEqual(readFileSync(specPath),before);assert.deepEqual(readFileSync(join(run.runDir,'usage.jsonl')),usage)
})

test('real resume admits presentation edits and preserves checkpoint on bounded capability drift',async t=>{
  await api();const {paused}=await import('./fixtures/pinned-harness.mjs'),f=harness(t),p=paused(f),config=join(f.env.CODEX_HOME,'config.toml')
  writeFileSync(config,'# harmless formatting\nmodel = "other-model"\n')
  const resumed=p.resume();assert.equal(resumed.final?.readiness?.state,'ready',JSON.stringify(resumed))
  const checkpoint=readFileSync(resumed.checkpoint),host=readFileSync(join(resumed.hostRunDir,'host.json'))
  writeFileSync(config,'approvals_reviewer = "guardian_subagent"\n')
  const failed=jsonResult(f.launch(['--resume',resumed.hostRunDir]));assert.match(failed.error,/settings changed/)
  assert.deepEqual(readFileSync(resumed.checkpoint),checkpoint);assert.deepEqual(readFileSync(join(resumed.hostRunDir,'host.json')),host)
})

test('default rule/hook and user/project MCP sources cannot hide executable policy',async t=>{
  const E=await api(),f=harness(t),pin=E.exportEngine(f.source,f.output,f.target),spec={kind:'codex',pin,cwd:f.target,writable:[]}
  for(const path of [join(f.env.CODEX_HOME,'rules'),join(f.env.CODEX_HOME,'hooks.json'),join(f.env.CODEX_HOME,'plugins')]) {
    f.update({sources:{[path]:{status:'directory',entries:['policy']}}})
    assert.match(guard(f,pin,spec).stdout,/executable capability source/)
  }
  f.update({sources:{}});spec.kind='claude'
  for(const path of [join(f.target,'.mcp.json'),join(f.env.HOME,'.claude.json')]) {
    writeFileSync(path,JSON.stringify({mcpServers:{external:{command:'touch',args:['forbidden-startup']}}}))
    assert.match(guard(f,pin,spec).stdout,/MCP capability source/)
    writeFileSync(path,JSON.stringify({mcpServers:{}}));assert.equal(guard(f,pin,spec).status,0)
  }
  assert.equal(existsSync(join(f.target,'forbidden-startup')),false)
})

test('trusted project profile definitions cannot hide roots or executable changes', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const user = join(f.env.CODEX_HOME, 'config.toml'), project = join(f.target, '.codex/config.toml')
  const trust = `[projects.${JSON.stringify(f.target)}]\ntrust_level="trusted"\n`
  mkdirSync(join(f.target, '.codex'))
  writeFileSync(user, `profile="wide"\n${trust}[profiles.wide.sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(f.target)}]\n`)
  const spec = { kind: 'codex', pin, cwd: f.target, writable: [] }
  const manifest = readFileSync(join(f.output, 'manifest.json'))
  writeFileSync(project, '[profiles.wide.sandbox_workspace_write]\nwritable_roots=[]\n')
  const first = guard(f, pin, spec); assert.equal(first.status, 0, first.stdout + first.stderr)
  spec.settingsHash = jsonResult(first).settings.settingsHash
  writeFileSync(join(f.dir, 'seat.json'), JSON.stringify(spec))
  for (const text of [
    `[profiles.wide.sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(f.output)}]\n`,
    '[profiles.wide.mcp_servers.local]\ncommand="secret-command"\n',
    '[profiles.other.hooks]\nstart="secret-command"\n',
    '[profiles.wide]\nunknown_command="secret-command"\n',
  ]) {
    writeFileSync(project, text)
    for (const event of [null, { tool_name: 'Bash', tool_input: { command: 'touch forbidden-startup' } }, { hook_event_name: 'ConfigChange' }]) {
      const result = guard(f, pin, spec, event)
      assert.notEqual(result.status, 0, text)
      assert.match(result.stdout + result.stderr, /overlaps|unsupported|settings changed/)
      assert.equal((result.stdout + result.stderr).includes('secret-command'), false)
      assert.equal(existsSync(join(f.target, 'forbidden-startup')), false)
      assert.deepEqual(readFileSync(join(f.output, 'manifest.json')), manifest)
    }
  }
  delete spec.settingsHash
  writeFileSync(project, `[profiles.wide.sandbox_workspace_write]\nwritable_roots=[${JSON.stringify(f.output)}]\n`)
  const fresh = guard(f, pin, spec); assert.notEqual(fresh.status, 0); assert.match(fresh.stdout, /overlaps/)
  writeFileSync(user, trust)
  const noSelection = guard(f, pin, spec); assert.notEqual(noSelection.status, 0); assert.match(noSelection.stdout, /overlaps/)
  writeFileSync(user, '')
  assert.equal(guard(f, pin, spec).status, 0, 'untrusted project sources remain inapplicable')
})
