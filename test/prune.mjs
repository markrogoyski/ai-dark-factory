import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prune } from '../tools/prune.mjs'
import { WORKFLOW_BUDGET } from '../tools/build.mjs'
import { TARGETS } from '../tools/sources.mjs'
import { readFileSync } from 'node:fs'

const run = async code => new (Object.getPrototypeOf(async function () {}).constructor)('agent', code)(x => x)

test('a declaration nothing reaches is dropped, and one a kept statement names is kept', () => {
  const { code, dropped } = prune('function used() { return helper() }\nfunction helper() { return 1 }\nfunction unused() { return 2 }\nreturn used()\n')
  assert.deepEqual(dropped, ['unused'])
  assert.match(code, /function helper/)
})

test('a function the main body defines stays reachable from a shared file that calls it', async () => {
  // feature.js calls escalate(), which main-factory.js defines at the top level.
  const body = 'function feature(h) { return escalate(h) }\nconst result = await feature(3)\nreturn result\nfunction escalate(h) { return h * 2 }\n'
  const { code, dropped } = prune(body)
  assert.deepEqual(dropped, [])
  assert.equal(await run(code), 6)
})

test('a declaration whose initialiser runs something is kept even if unnamed elsewhere', () => {
  const { dropped } = prune('const A = agent(1)\nlet B = [1, () => agent(2)]\nconst C = { x: 1 }\nlet D\nreturn 0\n')
  assert.deepEqual(dropped, ['B', 'C', 'D'])
})

test('property names and labels are not references, but shorthand properties are', () => {
  const { dropped } = prune('function a() {}\nfunction b() {}\nfunction c() {}\nfunction d() {}\nouter: for (;;) break outer\nreturn [x.a, { b: 1 }, { c }, { [d]: 1 }]\n')
  assert.deepEqual(dropped, ['a', 'b'])
})

test('a name referenced only by a dropped declaration is dropped with it', () => {
  const { dropped } = prune('function a() { return b() }\nfunction b() { return 1 }\nreturn 0\n')
  assert.deepEqual(dropped.sort(), ['a', 'b'])
})

test('the build still fits each workflow within the budget', () => {
  for (const [name, { output }] of Object.entries(TARGETS)) {
    if (name === 'policy') continue
    assert.ok(Buffer.byteLength(readFileSync(new URL(`../${output}`, import.meta.url))) <= WORKFLOW_BUDGET, output)
  }
})
