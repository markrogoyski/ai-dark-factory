import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync,readFileSync,mkdirSync,chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { api,jsonResult,readJson } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'
import { engineIdentityIssues } from '../plugins/dark-factory/lib/policy.mjs'
test('real charged live resume tolerates incidental Git and Python version output',async t=>{
  await api();const f=harness(t),wrappers=join(f.dir,'version-bin');mkdirSync(wrappers)
  const label=join(f.dir,'version-label');writeFileSync(label,'one')
  for(const tool of ['python3','git']) {
    const real=execFileSync('/bin/sh',['-c',`command -v ${tool}`],{encoding:'utf8'}).trim()
    const path=join(wrappers,tool)
    writeFileSync(path,`#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = --version ]; then printf '%s offline-version-' '${tool}'; cat '${label}'; printf '\\n'; else exec '${real}' "$@"; fi\n`);chmodSync(path,0o755)
  }
  f.env.PATH=wrappers+':'+f.env.PATH
  const first=jsonResult(f.launch(['--tier','simple','Fix sum'],{PINNED_INTAKE_FEATURE:'1'}))
  assert.equal(first.status,'needs-tier',JSON.stringify(first));assert.ok(first.metrics.turns>0)
  const before=readJson(first.checkpoint),answers=join(f.dir,'answers.json');writeFileSync(answers,JSON.stringify({tierConfirmed:true}))
  writeFileSync(label,'two')
  const resumed=jsonResult(f.launch(['--resume',first.hostRunDir,'--args-file',answers],{PINNED_INTAKE_FEATURE:'1'}))
  assert.equal(resumed.final?.readiness?.state,'ready',JSON.stringify(resumed));assert.ok(resumed.metrics.turns>first.metrics.turns)
  assert.equal(readJson(resumed.checkpoint).executor.packageDigest,before.executor.packageDigest)
  const calls=readFileSync(f.env.FACTORY_TEST_LOG,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(x=>x.kind==='intake').length,1)
  const checkpoint=readFileSync(resumed.checkpoint);writeFileSync(join(f.plugin,'lib/evaluate.mjs'),readFileSync(join(f.plugin,'lib/evaluate.mjs'),'utf8')+'\n// package drift\n')
  const refused=jsonResult(f.launch(['--resume',resumed.hostRunDir]));assert.match(refused.error,/changed|engine/i);assert.deepEqual(readFileSync(resumed.checkpoint),checkpoint)
})
test('runtime tolerance is live-only and never tolerates package, mode or pinned revision drift',()=>{
  const identity={version:1,algorithm:'sha256-path-content-mode-v1',mode:'live',packageDigest:'a'.repeat(64),sourceRevision:'b'.repeat(40),root:'/tmp/example',runtimeVersions:{node:'one',python:'one',git:'one'}}
  const changed={...identity,runtimeVersions:{node:'two',python:'two',git:'two'}}
  assert.deepEqual(engineIdentityIssues({},identity,changed),[])
  assert.match(engineIdentityIssues({},{...identity,mode:'pinned'},{...changed,mode:'pinned'}).join(';'),/runtime changed/)
  for(const mode of ['live','pinned']) assert.match(engineIdentityIssues({},{...identity,mode},{...identity,mode,packageDigest:'c'.repeat(64)}).join(';'),/packageDigest changed/)
  assert.match(engineIdentityIssues({},{...identity,mode:'pinned'},{...identity,mode:'pinned',sourceRevision:'c'.repeat(40)}).join(';'),/sourceRevision changed/)
})

test('real pinned resume refuses runtime wrapper drift without rewriting checkpoint evidence',async t=>{
  await api();const {paused}=await import('./fixtures/pinned-harness.mjs'),f=harness(t),wrappers=join(f.dir,'pinned-versions');mkdirSync(wrappers)
  const label=join(f.dir,'pinned-version-label');writeFileSync(label,'one')
  for(const tool of ['git','python3']) {
    const real=execFileSync('/bin/sh',['-c',`command -v ${tool}`],{encoding:'utf8'}).trim(),path=join(wrappers,tool)
    writeFileSync(path,`#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = --version ]; then printf '%s offline-version-' '${tool}'; cat '${label}'; printf '\\n'; else exec '${real}' "$@"; fi\n`);chmodSync(path,0o755)
  }
  f.env.PATH=wrappers+':'+f.env.PATH
  const p=paused(f),checkpoint=readFileSync(p.first.checkpoint),host=readFileSync(join(p.first.hostRunDir,'host.json'))
  writeFileSync(label,'two');const refused=p.resume();assert.match(refused.error,/runtime changed/)
  assert.deepEqual(readFileSync(p.first.checkpoint),checkpoint);assert.deepEqual(readFileSync(join(p.first.hostRunDir,'host.json')),host)
})
