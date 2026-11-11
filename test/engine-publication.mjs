import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawn,spawnSync } from 'node:child_process'
import { api,fixture,root,subjectEnv } from './fixtures/engine-package.mjs'
const worker=join(root,'test/fixtures/publication-worker.mjs'),preload=join(root,'test/fixtures/publication-preload.mjs')
function command(f,destination=f.output){return [worker,f.plugin,f.source,destination,f.target]}
function env(f,mode){return {...subjectEnv(process.env),NODE_OPTIONS:`--import=${preload}`,PUBLICATION_FAULT:mode,PUBLICATION_DESTINATION:f.output,PUBLICATION_SENTINEL:join(f.dir,'sentinel')}}
test('exclusive publication preserves preexisting data, faults and retry evidence',async t=>{
  const E=await api()
  for(const mode of ['write','manifest','validation','unsupported','before-kill','after-kill','directory-race','symlink-race','stage-link']) {
    const f=fixture(t),sentinel=join(f.dir,'sentinel');mkdirSync(sentinel);writeFileSync(join(sentinel,'keep'),'keep')
    const foreign=join(f.dir,'.engine-stage-user-owned');mkdirSync(foreign);writeFileSync(join(foreign,'keep'),'keep')
    const r=spawnSync(process.execPath,command(f),{env:env(f,mode),encoding:'utf8'})
    assert.notEqual(r.status,0,mode)
    if(mode==='after-kill') assert.ok(E.validateExport(f.output))
    else if(mode==='directory-race') assert.equal(readFileSync(join(f.output,'sentinel'),'utf8'),'keep')
    else if(mode==='symlink-race') assert.equal(readFileSync(join(f.output,'keep'),'utf8'),'keep')
    else assert.equal(existsSync(f.output),false,mode)
    assert.equal(readFileSync(join(foreign,'keep'),'utf8'),'keep');assert.equal(readFileSync(join(sentinel,'keep'),'utf8'),'keep')
    if(!['directory-race','symlink-race'].includes(mode)) assert.ok(E.exportEngine(f.source,f.output,f.target))
    else assert.throws(()=>E.exportEngine(f.source,f.output,f.target))
    if(mode==='before-kill') assert.ok(readdirSync(f.dir).some(x=>x.startsWith('.engine-stage-')&&x!=='.engine-stage-user-owned'),'crash orphan remains inspectable')
  }
  for(const type of ['file','empty','nonempty','symlink']) {
    const f=fixture(t)
    if(type==='file')writeFileSync(f.output,'keep')
    else if(type==='symlink')symlinkSync(join(f.dir,'missing'),f.output)
    else {mkdirSync(f.output);if(type==='nonempty')writeFileSync(join(f.output,'keep'),'keep')}
    assert.throws(()=>E.exportEngine(f.source,f.output,f.target))
    if(type==='file')assert.equal(readFileSync(f.output,'utf8'),'keep')
    if(type==='nonempty')assert.equal(readFileSync(join(f.output,'keep'),'utf8'),'keep')
  }
})
test('actual local exclusive rename handles concurrent compatible publishers and missing parents',async t=>{
  const E=await api(),f=fixture(t),destination=join(f.dir,'missing','parents','export')
  const launch=()=>new Promise(resolve=>{const child=spawn(process.execPath,command(f,destination),{env:subjectEnv(process.env)});let stderr='';child.stderr.on('data',x=>stderr+=x);child.on('exit',(status,signal)=>resolve({status,signal,stderr}))})
  const results=await Promise.all([launch(),launch()]);for(const r of results)assert.equal(r.status,0,JSON.stringify(r))
  const pin=E.validateExport(destination);assert.equal(pin.packageDigest,E.exportEngine(f.source,destination,f.target).packageDigest)
  assert.equal(readdirSync(join(f.dir,'missing','parents')).filter(x=>x.startsWith('.engine-stage-')).length,0)
})
