// Guards the delegating Factory's layout: it bundles goal shaping, intake and routing, and runs Pair
// and the council-based tiers as child workflows, so none of their code may reach factory.js. Each
// check is a pure helper, tested on the shipped tree and on an input it must reject.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, prunedBody } from '../tools/build.mjs'
import { EXPECTED } from '../tools/loader-check.mjs'
import { PAIR_LIB, TARGETS } from '../tools/sources.mjs'
import { candidateScript } from './fixtures/workflow-host.mjs'
import { loadLib } from './lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = file => readFileSync(join(root, file), 'utf8')
const { parse } = createRequire(import.meta.url)('../plugins/dark-factory/lib/vendor/acorn.cjs')

// The flows Factory hands to, and the sources only they need.
const FLOW_SOURCES = ['src/schemas.js', 'src/turns.js', 'src/repair.js', 'src/council.js', 'src/pair-schemas.js', 'src/pair.js',
  'src/simple.js', 'src/feature.js', 'src/architecture.js', ...PAIR_LIB]
const FLOW_ENTRIES = ['councilRun', 'pairRun', 'debateStage', 'simpleRun', 'featureRun', 'architectureRun', 'councilSetup']
const FACTORY_LIMIT = 120000

function forbiddenSources(order) {
  return FLOW_SOURCES.filter(file => order.includes(file))
}

// The names a binding pattern declares, destructuring included.
function bound(pattern, out = []) {
  if (!pattern) return out
  if (pattern.type === 'Identifier') out.push(pattern.name)
  else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) bound(p.type === 'RestElement' ? p.argument : p.value, out)
  else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) bound(e, out)
  else if (pattern.type === 'RestElement') bound(pattern.argument, out)
  else if (pattern.type === 'AssignmentPattern') bound(pattern.left, out)
  return out
}

// The flow entry points the target keeps at the top level of its pruned body, before minification
// renames them: the body build() minifies, parsed as prune.mjs parses it.
function keptDeclarations(target, options = {}) {
  const ast = parse(prunedBody(target, options).code,
    { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  const names = new Set()
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') names.add(node.id.name)
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) for (const name of bound(d.id)) names.add(name)
  }
  return FLOW_ENTRIES.filter(name => names.has(name))
}

function sizeIssue(bytes, limit = FACTORY_LIMIT) {
  return bytes >= limit ? `factory.js is ${bytes} bytes, at or over ${limit}` : null
}

// The workflows Factory starts as children that the loader check does not expect to load.
function missingChildren(names, expected = EXPECTED) {
  return names.filter(name => !expected.includes(name))
}

test('the Factory order bundles brief, intake and routing but no source of the flows it hands to', () => {
  const { order } = TARGETS.factory
  assert.deepEqual(forbiddenSources(order), [])
  for (const file of ['src/lib/handoff.js', 'src/turns-core.js', 'src/brief.js', 'src/route.js']) assert.ok(order.includes(file), file)
  assert.equal(order.at(-1), 'src/main-factory.js')
  assert.deepEqual(forbiddenSources([...order, 'src/pair.js']), ['src/pair.js'])
  assert.deepEqual(forbiddenSources([...order, PAIR_LIB[0]]), [PAIR_LIB[0]])
  // It loads the way the runtime loads a workflow.
  candidateScript()
})

test('the pruned Factory body declares none of the flow entry points; the council and Pair bodies keep theirs', () => {
  assert.deepEqual(keptDeclarations('factory'), [])
  assert.deepEqual(keptDeclarations('council'), ['councilRun', 'debateStage', 'simpleRun', 'featureRun', 'architectureRun', 'councilSetup'])
  assert.deepEqual(keptDeclarations('pair'), ['pairRun'])
})

test('a destructured top-level binding counts as a declaration', () => {
  const read = file => source(file) + (file === 'src/main-factory.js' ? '\nconst { a: [pairRun] } = { a: [1] }\n' : '')
  assert.deepEqual(keptDeclarations('factory', { read }), ['pairRun'])
})

test('factory.js stays under its size limit', () => {
  assert.equal(sizeIssue(Buffer.byteLength(source(TARGETS.factory.output))), null)
  assert.equal(sizeIssue(FACTORY_LIMIT - 1), null)
  assert.match(sizeIssue(FACTORY_LIMIT), /at or over 120000/)
})

test('every workflow Factory starts as a child is one the loader check expects', () => {
  const { HANDOFF_CHILD, childWorkflow } = loadLib()
  const names = Object.keys(HANDOFF_CHILD).map(strategy => childWorkflow({ strategy }))
  assert.deepEqual(names, ['dark-factory:pair', 'dark-factory:council'])
  assert.deepEqual(missingChildren(names), [])
  assert.deepEqual(missingChildren(names, EXPECTED.filter(name => name !== 'dark-factory:pair')), ['dark-factory:pair'])
})

test('padding the Pair flow and the debate turns leaves factory.js byte-identical', () => {
  const padding = `\nglobalThis.__growth = "${'x'.repeat(20000)}"\n`
  const read = file => source(file) + (file === 'src/pair.js' || file === 'src/turns.js' ? padding : '')
  assert.equal(build('factory', { read }), build('factory'))
  // The padding survives pruning where those files are bundled, so the check above is not vacuous.
  for (const name of ['pair', 'council']) {
    const grown = Buffer.byteLength(build(name, { read })) - Buffer.byteLength(build(name))
    assert.ok(grown >= 20000, `${name} grew by ${grown} bytes`)
  }
})
