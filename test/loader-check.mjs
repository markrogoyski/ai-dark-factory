import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPECTED, loaderVerdict } from '../tools/loader-check.mjs'

const stream = content => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content }] } }),
  JSON.stringify({ type: 'result', result: 'done' }),
].join('\n')
const listing = names => `<tool_use_error>Workflow "dark-factory:does-not-exist" not found. Available: ${names.join(', ')}</tool_use_error>`

test('every built workflow is expected', () => {
  assert.deepEqual(EXPECTED, ['dark-factory:brief', 'dark-factory:council', 'dark-factory:ensemble', 'dark-factory:factory', 'dark-factory:pair', 'dark-factory:run-plan'])
})

test('a listing with every workflow passes, whatever else it lists', () => {
  assert.equal(loaderVerdict(stream(listing(['deep-research', ...EXPECTED.slice().reverse()]))).ok, true)
})

test('a workflow missing from the listing fails and is named', () => {
  const v = loaderVerdict(stream(listing(EXPECTED.filter(n => n !== 'dark-factory:pair'))))
  assert.equal(v.ok, false)
  assert.match(v.message, /did not load dark-factory:pair \(/)
})

test('a listing in a text block is read, and no listing at all fails', () => {
  assert.equal(loaderVerdict(stream([{ type: 'text', text: listing(EXPECTED) }])).ok, true)
  assert.equal(loaderVerdict(stream('some other error')).ok, false)
  assert.equal(loaderVerdict('').ok, false)
})
