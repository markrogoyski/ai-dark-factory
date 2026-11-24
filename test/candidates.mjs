// The unshipped candidate builds: what they leave out, that the flows they leave out cannot grow
// them, and that building them writes nothing the plugin ships.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKFLOW_BUDGET, build } from '../tools/build.mjs'
import { createPluginCopy, replacePluginWorkflows, workflowBytes } from '../tools/candidate.mjs'
import { EXPECTED } from '../tools/loader-check.mjs'
import { CANDIDATES, PAIR_LIB, TARGETS } from '../tools/sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = file => readFileSync(join(root, file), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const PARAMS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime']
const LINE = /^built factory-split \((\d+) bytes, (\d+) under the 480000-byte budget\)$/
const plugin = join(root, 'plugins', 'dark-factory')
const workflows = join(plugin, 'workflows')
const candidateTool = join(root, 'tools', 'candidate.mjs')
const candidatePreload = new URL('./fixtures/candidate-preload.mjs', import.meta.url).href
const trio = { 'factory.js': 'factory-split', 'council.js': 'council', 'pair.js': 'pair' }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Every file the plugin ships, by content; Python's caches are not shipped.
function pluginHashes(dir = join(root, 'plugins'), out = {}, base = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) pluginHashes(path, out, base)
    else out[relative(base, path)] = sha256(readFileSync(path))
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

function scratch(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-test-')))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function runCandidate(path, args = [], nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, candidateTool, ...args], {
    cwd: root, env: { ...process.env, TMPDIR: path }, encoding: 'utf8',
  })
  assert.ifError(result.error)
  return result
}

function workflowSnapshot() {
  return ['.', ...readdirSync(workflows, { recursive: true }).sort()].map(name => {
    const file = join(workflows, name)
    const stat = lstatSync(file, { bigint: true })
    return [name, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs, stat.isFile() ? sha256(readFileSync(file)) : null]
  })
}

async function assertPluginCopy(path, mode) {
  const dir = join(path, 'workflows')
  const digests = {}
  for (const [name, target] of Object.entries(trio)) {
    const original = readFileSync(join(workflows, name))
    const expected = mode === 'inline' ? original : Buffer.from(build(target))
    const actual = readFileSync(join(dir, name))
    assert.deepEqual(actual, expected, name)
    if (name === 'factory.js' && mode === 'candidate') assert.notDeepEqual(actual, original)
    digests[name] = sha256(expected)
  }
  const marker = `candidate-${digests['factory.js'].slice(0, 12)}`
  assert.deepEqual(readdirSync(dir).sort(), [...readdirSync(workflows), marker + '.js'].sort())
  const code = readFileSync(join(dir, marker + '.js'), 'utf8')
  const meta = JSON.parse(/^export const meta = (.+)$/m.exec(code)?.[1])
  assert.equal(meta.name, marker)
  assert.ok(meta.description && meta.whenToUse && meta.phases.length)
  const runMarker = new AsyncFunction(code.replace(/^export const meta = .+$/m, ''))
  assert.equal(await runMarker(), marker)
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'candidate.json'), 'utf8')), { mode, marker, sha256: digests })

  const expectedHashes = pluginHashes(plugin, {}, plugin)
  for (const [name, hash] of Object.entries(digests)) expectedHashes[join('workflows', name)] = hash
  expectedHashes[join('workflows', marker + '.js')] = sha256(code)
  expectedHashes['candidate.json'] = sha256(readFileSync(join(path, 'candidate.json')))
  assert.deepEqual(pluginHashes(path, {}, path), expectedHashes)
  const helperMode = lstatSync(join(path, 'bin', 'dark-factory')).mode & 0o777
  assert.ok(helperMode & 0o111)
  assert.equal(helperMode, lstatSync(join(plugin, 'bin', 'dark-factory')).mode & 0o777)
}

test('candidate CLI stages exact plugin copies and hash markers in both modes', async t => {
  const path = scratch(t)
  const before = workflowSnapshot()
  for (const mode of ['candidate', 'inline']) {
    const run = runCandidate(path, mode === 'inline' ? ['--inline'] : [])
    assert.deepEqual([run.status, run.stderr], [0, ''], run.stdout + run.stderr)
    const copy = run.stdout.trim()
    assert.equal(dirname(copy), path)
    assert.equal(realpathSync(copy), copy)
    assert.equal(lstatSync(copy).mode & 0o077, 0)
    await assertPluginCopy(copy, mode)
    assert.deepEqual(workflowSnapshot(), before)
  }
})

test('candidate CLI cleans up a partial copy without touching the source workflows', t => {
  const path = scratch(t)
  const before = workflowSnapshot()
  const run = runCandidate(path, [], ['--import', candidatePreload])
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stderr, /injected marker write failure after copying workflows/)
  assert.equal(run.stdout, '')
  assert.deepEqual(readdirSync(path), [])
  assert.deepEqual(workflowSnapshot(), before)
})

test('workflow swap keeps the owned plugin path and publishes the captured candidate bytes', async t => {
  const before = workflowSnapshot()
  const inline = createPluginCopy('inline')
  t.after(() => rmSync(inline.path, { recursive: true, force: true }))
  const bytes = workflowBytes()
  const candidate = replacePluginWorkflows(inline, bytes)
  assert.equal(candidate.path, inline.path)
  assert.notEqual(candidate.marker, inline.marker)
  for (const [name, buffer] of Object.entries(bytes)) {
    assert.deepEqual(readFileSync(join(candidate.path, 'workflows', name)), buffer)
  }
  await assertPluginCopy(candidate.path, 'candidate')
  assert.throws(() => replacePluginWorkflows({ path: plugin }, bytes), /owned scratch plugin/)
  assert.deepEqual(workflowSnapshot(), before)
})

test('a failed swap publication restores the inline workflows and record', async t => {
  const path = scratch(t)
  const before = workflowSnapshot()
  const script = `
    import { createPluginCopy, replacePluginWorkflows, workflowBytes } from ${JSON.stringify(pathToFileURL(candidateTool).href)}
    const copy = createPluginCopy('inline')
    console.log(copy.path)
    replacePluginWorkflows(copy, workflowBytes())
  `
  const run = spawnSync(process.execPath, ['--import', candidatePreload, '--input-type=module', '-e', script], {
    cwd: root, env: { ...process.env, TMPDIR: path, DF_CANDIDATE_TEST_SWAP: '1' }, encoding: 'utf8',
  })
  assert.ifError(run.error)
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stderr, /injected record publication failure after swapping workflows/)
  await assertPluginCopy(run.stdout.trim(), 'inline')
  assert.deepEqual(workflowSnapshot(), before)
})

test('candidate CLI checks all three built hashes against a fixture verdict', t => {
  const path = scratch(t)
  const verdict = join(path, 'verdict.json')
  const hashes = Object.fromEntries(Object.keys(trio).map(name => [name, sha256(readFileSync(join(workflows, name)))]))
  const args = ['--verify-verdict', '--verdict', verdict]
  const passed = Object.fromEntries(['L2-i', 'L2-ii', 'L2-iii', 'L2-iv', 'L3'].map(id => [id, { status: 'pass' }]))
  writeFileSync(verdict, JSON.stringify({ l2: { sha256: hashes, checks: passed } }))
  const match = runCandidate(path, args)
  assert.deepEqual([match.status, match.stderr], [0, ''], match.stdout + match.stderr)
  assert.match(match.stdout, /hashes match the verdict, and every l2 check passes/)

  // Matching hashes do not make a partial or failing l2 complete.
  const { L3, ...partial } = passed
  writeFileSync(verdict, JSON.stringify({ l2: { sha256: hashes, checks: { ...partial, 'L2-ii': { status: 'fail' } } } }))
  const incomplete = runCandidate(path, args)
  assert.equal(incomplete.status, 1, incomplete.stdout + incomplete.stderr)
  assert.match(incomplete.stderr, /hashes match the verdict; l2 is not complete: L2-ii fail, L3 missing$/m)

  const incorrect = { 'factory.js': '0'.repeat(64), 'council.js': '1'.repeat(64) }
  writeFileSync(verdict, JSON.stringify({ l2: { sha256: incorrect } }))
  const mismatch = runCandidate(path, args)
  assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr)
  for (const name of Object.keys(trio)) {
    assert.ok(mismatch.stderr.includes(`${name} sha256 mismatch: built ${hashes[name]}, verdict ${incorrect[name] ?? '(missing)'}`))
  }
  assert.deepEqual(readdirSync(path), ['verdict.json'])
})
