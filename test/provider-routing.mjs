import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { api, jsonResult } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'
test('copied generated policy covers strategy, tier, escalation and control routes',async t=>{
  const E=await api(),f=harness(t),pin=E.exportEngine(f.source,f.output,f.target)
  const {reachableProviders}=await import(pathToFileURL(join(pin.root,'lib/policy.mjs')))
  const matrix=JSON.parse(readFileSync(new URL('./fixtures/provider-routing.json',import.meta.url)))
  for(const row of matrix) {
    const input={workflow:row.workflow,args:row.args}
    if(row.error) assert.throws(()=>reachableProviders({},input),undefined,JSON.stringify(input))
    else assert.deepEqual([...new Set(reachableProviders({},input).map(r=>r.vendor))].sort(),row.vendors,JSON.stringify(input))
  }
  for(const workflow of ['pair','ensemble']) assert.deepEqual(reachableProviders({},{workflow,args:{explain:true}}),[])
  assert.deepEqual([...new Set(reachableProviders({},{workflow:'factory',args:{task:'Explain',explain:true,roles:{intake:'opus'}}}).map(r=>r.vendor))],['claude'])
})
test('Codex-only pinned Pair completes despite irrelevant invalid Claude settings',async t=>{
  await api();const f=harness(t)
  f.update({sources:{[join(f.env.CLAUDE_CONFIG_DIR,'settings.json')]:{status:'file',text:'not valid JSON'}}})
  const result=jsonResult(f.launch(['--pin-engine',f.output,'--workflow','pair','--author','sol','--reviewer','astra','Fix sum; the word gemini is task prose']))
  assert.equal(result.final?.readiness?.state,'ready',JSON.stringify(result))
  const observations=f.traces();assert.ok(observations.some(x=>x.operation==='facts'&&x.path==='codex'))
  assert.ok(!observations.some(x=>x.operation==='facts'&&x.path==='claude'))
  assert.ok(!observations.some(x=>x.path?.includes('/claude/')))
  const calls=readFileSync(f.env.FACTORY_TEST_LOG,'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.length>0);assert.ok(calls.every(x=>x.vendor!=='claude'))
})
test('CLI overrides args-file routing and reachable Claude refuses before export',async t=>{
  await api();const f=harness(t),args=join(f.dir,'args.json')
  writeFileSync(args,JSON.stringify({task:'Fix sum',author:'opus',reviewer:'opus'}))
  f.update({sources:{[join(f.env.CLAUDE_CONFIG_DIR,'settings.json')]:{status:'unknown'}}})
  const result=jsonResult(f.launch(['--pin-engine',f.output,'--workflow','pair','--args-file',args,'--author','sol','--reviewer','opus']))
  assert.match(result.error,/unreadable settings/)
  assert.ok(f.traces().some(x=>x.operation==='facts'&&x.path==='claude'))
})

test('reuse validates every reachable provider before the first model call',async t=>{
  const E=await api(),f=harness(t);E.exportEngine(f.source,f.output,f.target)
  f.update({sources:{[join(f.env.CLAUDE_CONFIG_DIR,'settings.json')]:{status:'unknown'}}})
  const result=jsonResult(f.launch(['--pin-engine',f.output,'--workflow','pair','--author','sol','--reviewer','opus','Fix sum']))
  assert.match(result.error,/unreadable settings/)
  const {existsSync}=await import('node:fs');assert.equal(existsSync(f.env.FACTORY_TEST_LOG),false)
})

test('explicit investigate reviewers are checked before any solve is charged', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const { reachableProviders } = await import(pathToFileURL(join(pin.root, 'lib/policy.mjs')))
  const args = { task: 'Inspect sum', mode: 'investigate', seats: 'sol,astra', models: { review: 'opus', compare: 'sol' } }
  assert.ok(reachableProviders({}, { workflow: 'ensemble', args }).some(route => route.vendor === 'claude' && route.role === 'review' && route.reason === 'ensemble'))
  const file = join(f.dir, 'ensemble.json'); writeFileSync(file, JSON.stringify(args))
  f.update({ facts: { claude: { deliveryKnown: false } } })
  const result = jsonResult(f.launch(['--pin-engine', f.output, '--workflow', 'ensemble', '--args-file', file]))
  assert.match(result.error, /delivery facts unavailable/)
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(f.env.FACTORY_TEST_LOG), false)
})
