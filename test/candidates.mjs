// The unshipped candidate builds: what they leave out, that the flows they leave out cannot grow
// them, and that building them writes nothing the plugin ships.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKFLOW_BUDGET, build } from '../tools/build.mjs'
import { EXPECTED } from '../tools/loader-check.mjs'
import { CANDIDATES, PAIR_LIB, TARGETS } from '../tools/sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = file => readFileSync(join(root, file), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const PARAMS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime']
const LINE = /^built factory-split \((\d+) bytes, (\d+) under the 480000-byte budget\)$/

// Every file the plugin ships, by content; Python's caches are not shipped.
function pluginHashes(dir = join(root, 'plugins'), out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) pluginHashes(path, out)
    else out[path.slice(root.length + 1)] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return out
}

test('padding the Pair flow and the debate turns leaves the delegating Factory byte-identical', () => {
  const padding = `\nglobalThis.__growth = "${'x'.repeat(20000)}"\n`
  const read = file => source(file) + (file === 'src/pair.js' || file === 'src/turns.js' ? padding : '')
  assert.equal(build('factory-split', { read }), build('factory-split'))
  // The padding survives pruning where those files are bundled, so the check above is not vacuous.
  for (const name of ['pair', 'council']) {
    const grown = Buffer.byteLength(build(name, { read })) - Buffer.byteLength(build(name))
    assert.ok(grown >= 20000, `${name} grew by ${grown} bytes`)
  }
})

test('the reader supplies the policy inputs, and validation sees what it supplies', () => {
  assert.equal(build('policy', { read: source }), build('policy'))
  const read = file => source(file) + (file === 'src/lib/util.js' ? '\nfunction __probe() { return Date.now() }\n' : '')
  assert.throws(() => build('policy', { read }), /Date/)
})

test('candidates are separate from the shipped targets', () => {
  assert.throws(() => build('nope'), /unknown target nope/)
  assert.throws(() => build('toString'), /unknown target toString/)
  assert.deepEqual(Object.keys(TARGETS), ['policy', 'run-plan', 'ensemble', 'council', 'factory', 'pair'])
  assert.deepEqual(EXPECTED, ['dark-factory:council', 'dark-factory:ensemble', 'dark-factory:factory', 'dark-factory:pair', 'dark-factory:run-plan'])
  assert.deepEqual(Object.keys(CANDIDATES), ['factory-split'])
  assert.equal(Object.hasOwn(CANDIDATES['factory-split'], 'output'), false)
})

test('the delegating Factory bundles brief, intake and routing but none of the flows it hands to', () => {
  const { order } = CANDIDATES['factory-split']
  const flows = ['src/schemas.js', 'src/turns.js', 'src/repair.js', 'src/council.js', 'src/pair-schemas.js', 'src/pair.js',
    'src/simple.js', 'src/feature.js', 'src/architecture.js', ...PAIR_LIB]
  assert.deepEqual(flows.filter(file => order.includes(file)), [])
  for (const file of ['src/lib/handoff.js', 'src/turns-core.js', 'src/brief.js', 'src/route.js']) assert.ok(order.includes(file), file)
  assert.equal(order.at(-1), 'src/main-factory-split.js')
  assert.ok(TARGETS.factory.order.includes('src/route.js'))
  assert.equal(TARGETS.factory.order.at(-1), 'src/main-factory.js')
  // It loads the way the runtime loads a workflow.
  new AsyncFunction(...PARAMS, build('factory-split').replace(/^export const meta\s*=/m, 'const meta ='))
})

// Runs the candidate report in its own process, as the CLI does, with the given budget.
function report(budget) {
  const script = `import { reportCandidates } from ${JSON.stringify(pathToFileURL(join(root, 'tools', 'build.mjs')).href)}; reportCandidates({ budget: ${budget} })`
  const { status, stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' })
  return { status, stdout, stderr }
}

test('--candidates reports each candidate size and writes nothing the plugin ships', () => {
  const before = pluginHashes()
  const { status, stdout, stderr } = spawnSync(process.execPath, [join(root, 'tools', 'build.mjs'), '--candidates'], { cwd: root, encoding: 'utf8' })
  assert.deepEqual([status, stderr], [0, ''], stdout + stderr)
  const lines = stdout.trimEnd().split('\n')
  assert.equal(lines.length, 1, stdout)
  const [, bytes, headroom] = lines[0].match(LINE) || assert.fail(stdout)
  assert.equal(Number(bytes), Buffer.byteLength(build('factory-split')))
  assert.equal(Number(bytes) + Number(headroom), WORKFLOW_BUDGET)
  assert.deepEqual(pluginHashes(), before)
})

test('a candidate over the budget fails the report; one exactly at it passes', () => {
  const size = Buffer.byteLength(build('factory-split'))
  assert.deepEqual(report(size), { status: 0, stdout: `built factory-split (${size} bytes, 0 under the ${size}-byte budget)\n`, stderr: '' })
  assert.deepEqual(report(size - 1), { status: 1, stdout: '', stderr: `build: candidate factory-split is ${size} bytes, over the ${size - 1}-byte budget\n` })
})
