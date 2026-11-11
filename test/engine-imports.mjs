import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { api, fixture } from './fixtures/engine-package.mjs'
test('syntax-aware executable imports ignore prose and reject unsupported dependencies', async t => {
  const E=await api(),f=fixture(t), cases=JSON.parse(readFileSync(new URL('./fixtures/engine-imports.json',import.meta.url)))
  const root=join(f.dir,'grammar');mkdirSync(root);writeFileSync(join(root,'local.mjs'),'export const value=1\n')
  const check=(source,name='entry.mjs')=>{writeFileSync(join(root,name),source);return E.validateImports(root,[[Buffer.from('local.mjs').toString('base64')],[Buffer.from(name).toString('base64')]])}
  for(const source of cases.valid) assert.doesNotThrow(()=>check(source),source)
  for(const source of cases.invalid) assert.throws(()=>check(source),undefined,source)
  for(const source of cases.cjs) assert.doesNotThrow(()=>check(source,'entry.cjs'))
  assert.throws(()=>check('await Promise.resolve()','ordinary.js'),/syntax/)
  mkdirSync(join(root,'workflows'));assert.doesNotThrow(()=>check('return await Promise.resolve(1)','workflows/native.js'))
  const pin=E.exportEngine(f.source,f.output,f.target)
  const parser=join(pin.root,'lib/vendor/acorn.cjs');writeFileSync(parser,'throw new Error("untrusted parser executed")')
  assert.throws(()=>E.validateExport(f.output),/content or mode changed/)
})

test('real loaders distinguish ESM URLs from literal CJS percent paths', async t => {
  const E = await api(), f = fixture(t), root = join(f.dir, 'modules'), marker = join(f.dir, 'outside-ran')
  mkdirSync(join(root, '%2e%2e'), { recursive: true })
  writeFileSync(join(root, '%2e%2e/outside.mjs'), 'export const origin="inventoried"\n')
  writeFileSync(join(f.dir, 'outside.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');export const origin='outside'\n`)
  const run = program => spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
  const entry = join(root, 'entry.mjs'), url = pathToFileURL(entry).href
  writeFileSync(entry, 'import {origin} from "./%2e%2e/outside.mjs"; console.log(origin)\n')
  const raw = run(`await import(${JSON.stringify(url)})`)
  assert.equal(raw.status, 0, raw.stderr); assert.equal(raw.stdout.trim(), 'outside'); assert.ok(existsSync(marker))
  unlinkSync(marker)
  for (const source of [
    'import "./%2e%2e/outside.mjs"', 'export * from "./%2e%2e/outside.mjs"',
    'await import("./%2e%2e/outside.mjs")',
  ]) {
    writeFileSync(entry, source)
    const guarded = run(`import * as E from ${JSON.stringify(pathToFileURL(join(f.plugin, 'lib/engine.mjs')).href)};E.validateImports(${JSON.stringify(root)},E.packageInventory(${JSON.stringify(root)}));await import(${JSON.stringify(url)})`)
    assert.notEqual(guarded.status, 0); assert.match(guarded.stderr, /external engine import/); assert.equal(existsSync(marker), false)
  }
  writeFileSync(entry, '')
  writeFileSync(join(root, '%2e%2e/literal.cjs'), "module.exports='literal-percent-directory'\n")
  const cjs = join(root, 'entry.cjs')
  writeFileSync(cjs, 'console.log(require("./%2e%2e/literal.cjs"))\n')
  assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
  assert.equal(run(`await import(${JSON.stringify(pathToFileURL(cjs).href)})`).stdout.trim(), 'literal-percent-directory')
  writeFileSync(entry, 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url); console.log(require("./%2e%2e/literal.cjs"))')
  assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
  assert.equal(run(`await import(${JSON.stringify(url)})`).stdout.trim(), 'literal-percent-directory')
  writeFileSync(entry, '')
  writeFileSync(cjs, 'import("./%2e%2e/outside.mjs")')
  assert.throws(() => E.validateImports(root, E.packageInventory(root)), /external engine import/)
  writeFileSync(cjs, '')
  writeFileSync(join(root, 'space #?.mjs'), "export const value='local-encoded'\n")
  writeFileSync(entry, 'import {value} from "./space%20%23%3F.mjs"; console.log(value)')
  assert.doesNotThrow(() => E.validateImports(root, E.packageInventory(root)))
  assert.equal(run(`await import(${JSON.stringify(url)})`).stdout.trim(), 'local-encoded')
  for (const source of ['import "./space%20%23%3F.mjs?q"', 'import "./space%20%23%3F.mjs#h"', 'import "./%2foutside.mjs"', 'import "./bad%xx.mjs"', 'import "./space%20%23%3F.mjs" with {type:"json"}', 'import("./space%20%23%3F.mjs", {with:{type:"json"}})']) {
    writeFileSync(entry, source); assert.throws(() => E.validateImports(root, E.packageInventory(root)))
  }
})
