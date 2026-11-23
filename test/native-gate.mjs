import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { L1_RECORDED, L1_REQUIRED } from '../tools/workflow-check.mjs'

const BUILT = 'plugins/dark-factory/workflows'
const HANDOFF = 'src/lib/handoff.js'
const VERDICT = 'tools/native-verdict.json'
const FREE_CALL = /(^|[^A-Za-z0-9_$.])workflow\(/
const LEAVES = ['council', 'pair', 'ensemble', 'run-plan']
const L2_REQUIRED = ['L2-i', 'L2-ii', 'L2-iii', 'L2-iv', 'L3']
const NAME_FORMS = ['qualified', 'bare']

function readOptional(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

const passing = check => check?.status === 'pass'
const nonemptyString = value => typeof value === 'string' && value.trim() !== ''
const nonemptyArray = (value, predicate) => Array.isArray(value) && value.length > 0 && value.every(predicate)
const observedShape = {
  'L1-e': observed => nonemptyString(observed?.parent) && nonemptyString(observed?.child),
  'L1-f': observed => nonemptyArray(observed?.positions, row => nonemptyString(row?.position) && typeof row.replayed === 'boolean'),
  'L1-g': observed => nonemptyArray(observed?.ordinals, row => Number.isInteger(row?.ordinal) && typeof row.replayed === 'boolean'),
}

function recorded(id, check) {
  return (passing(check) || check?.status === 'fail') && observedShape[id](check.observed)
}

async function handoffLibrary(root) {
  const manifest = join(root, 'tools/sources.mjs')
  const { LIB, PAIR_LIB } = await import(pathToFileURL(manifest).href)
  const source = [...new Set([...LIB, ...PAIR_LIB, HANDOFF])].map(file => readFileSync(join(root, file), 'utf8')).join('\n')
  return new Function(`'use strict';\n${source}\nreturn { HANDOFF_VERSION, childWorkflow }`)()
}

function checkL1(l1, issues) {
  if (!l1) {
    issues.push('G1: src/lib/handoff.js requires an l1 verdict')
    return
  }
  if (!NAME_FORMS.includes(l1.nameForm)) issues.push('G1: l1.nameForm must be qualified or bare')
  for (const id of L1_REQUIRED) {
    if (!passing(l1.checks?.[id])) issues.push(`G1: ${id} is not passing`)
  }
  for (const id of L1_RECORDED) {
    if (!recorded(id, l1.checks?.[id])) issues.push(`G1: ${id} is missing a completed observation`)
  }
}

async function checkL2(root, l2, issues) {
  if (!l2) {
    issues.push('G2: factory.js calls workflow() and requires an l2 verdict')
    return
  }
  for (const id of new Set([...L2_REQUIRED, ...Object.keys(l2.checks ?? {})])) {
    if (!passing(l2.checks?.[id])) issues.push(`G2: ${id} is not passing`)
  }
  try {
    const { HANDOFF_VERSION, childWorkflow } = await handoffLibrary(root)
    if (HANDOFF_VERSION === undefined || l2.protocol !== HANDOFF_VERSION) {
      issues.push('G2: l2.protocol differs from HANDOFF_VERSION')
    }
    const names = ['pair', 'independent'].map(strategy => childWorkflow({ strategy }))
    if (!NAME_FORMS.includes(l2.nameForm) || !names.every(name =>
      nonemptyString(name) && (name.includes(':') ? 'qualified' : 'bare') === l2.nameForm)) {
      issues.push('G2: l2.nameForm differs from childWorkflow')
    }
  } catch (error) {
    issues.push(`G2: could not read handoff protocol and names: ${error.message}`)
  }
}

export async function gateIssues(root) {
  const issues = []
  const hasCall = name => FREE_CALL.test(readOptional(join(root, BUILT, `${name}.js`)) ?? '')
  const needsL1 = readOptional(join(root, HANDOFF)) !== null
  const needsL2 = hasCall('factory')
  if (needsL1 || needsL2) {
    const raw = readOptional(join(root, VERDICT))
    let verdict
    try {
      verdict = JSON.parse(raw)
    } catch {
      issues.push(`${needsL1 ? 'G1' : 'G2'}: ${VERDICT} is not valid JSON`)
    }
    if (needsL1) checkL1(verdict?.l1, issues)
    if (needsL2) await checkL2(root, verdict?.l2, issues)
  }
  for (const name of LEAVES) {
    if (hasCall(name)) issues.push(`G3: ${name}.js calls workflow()`)
  }
  return issues
}

const pass = observed => ({ status: 'pass', observed })

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of [BUILT, 'src/lib', 'tools']) mkdirSync(join(root, dir), { recursive: true })
  const put = (path, data) => writeFileSync(join(root, path), data)
  const workflow = (name, source) => put(`${BUILT}/${name}.js`, source)
  const handoff = (protocol = 1, names = "'df:' + strategy") => put(HANDOFF, `
    const HANDOFF_VERSION = ${protocol}
    function childWorkflow({ strategy }) { return ${names} }
  `)
  const verdict = {
    l1: { cli: 'fixture', nameForm: 'qualified', checks: {
      ...Object.fromEntries(L1_REQUIRED.map(id => [id, pass()])),
      'L1-b2': { status: 'fail', observed: { result: 'unexpected mutation' } },
      'L1-e': pass({ parent: 'projects/test/wf_1', child: 'projects/test/wf_1' }),
      'L1-f': { status: 'fail', observed: { positions: [{ position: 'F1', replayed: false }] } },
      'L1-g': { status: 'fail', observed: { ordinals: [{ ordinal: 1, replayed: false }] } },
      'L1-h': { status: 'fail', observed: { shadowed: false } },
    } },
    l2: { protocol: 1, nameForm: 'qualified', checks: Object.fromEntries(L2_REQUIRED.map(id => [id, pass()])) },
  }
  const save = () => put(VERDICT, JSON.stringify(verdict))
  put('tools/sources.mjs', 'export const LIB = []; export const PAIR_LIB = []')
  workflow('factory', "x = workflow('df:pair', a)")
  for (const name of LEAVES) workflow(name, 'obj.workflow(1); myworkflow(2); $workflow(3)')
  handoff()
  save()
  return { root, put, workflow, handoff, verdict, save }
}

test('native gate passes on the current checkout', async () => {
  const root = dirname(fileURLToPath(new URL('../Makefile', import.meta.url)))
  assert.deepEqual(await gateIssues(root), [])
})

test('G1 accepts complete observations despite failing informational probes', async t => {
  assert.deepEqual(await gateIssues(fixture(t).root), [])
})

test('G1 requires the verdict and l1 only when handoff exists', async t => {
  const { root, put, workflow, verdict, save } = fixture(t)
  workflow('factory', '')
  rmSync(join(root, VERDICT))
  assert.deepEqual(await gateIssues(root), ['G1: src/lib/handoff.js requires an l1 verdict'])
  put(VERDICT, '{')
  assert.match((await gateIssues(root))[0], /G1: .* is not valid JSON/)
  delete verdict.l1
  save()
  assert.deepEqual(await gateIssues(root), ['G1: src/lib/handoff.js requires an l1 verdict'])
  rmSync(join(root, HANDOFF))
  put(VERDICT, '{')
  assert.deepEqual(await gateIssues(root), [])
})

test('G1 requires a resolved name form', async t => {
  const { root, verdict, save } = fixture(t)
  for (const form of [null, 'df-probe:child']) {
    verdict.l1.nameForm = form
    save()
    assert.deepEqual(await gateIssues(root), ['G1: l1.nameForm must be qualified or bare'])
  }
})

test('G1 requires an explicit pass for each prerequisite', async t => {
  const { root, verdict, save } = fixture(t)
  for (const id of ['L1-a', 'L1-b1', 'L1-b3', 'L1-c', 'L1-d', 'L1-d2', 'L1-i', 'L1-j']) {
    delete verdict.l1.checks[id]
    save()
    assert.deepEqual(await gateIssues(root), [`G1: ${id} is not passing`])
    verdict.l1.checks[id] = { status: 'fail' }
    save()
    assert.deepEqual(await gateIssues(root), [`G1: ${id} is not passing`])
    verdict.l1.checks[id] = pass()
  }
})

test('G1 rejects incomplete or ill-typed e, f and g observations', async t => {
  const { root, verdict, save } = fixture(t)
  const invalid = {
    'L1-e': [{ parent: 'p' }, { parent: 'p', child: 1 }, { parent: 'p', child: ' ' }],
    'L1-f': [{ positions: [] }, { positions: [{ position: 'F1', replayed: 'yes' }] }],
    'L1-g': [{ ordinals: [] }, { ordinals: [{ ordinal: 1.5, replayed: false }] }],
  }
  for (const [id, shapes] of Object.entries(invalid)) {
    const original = verdict.l1.checks[id]
    for (const value of [undefined, null, { ...original, status: 'skipped' }, { ...original, status: 'pending' },
      pass(), pass(null), pass({}), ...shapes.map(pass)]) {
      verdict.l1.checks[id] = value
      save()
      assert.deepEqual(await gateIssues(root), [`G1: ${id} is missing a completed observation`])
    }
    verdict.l1.checks[id] = original
  }
})

test('G2 requires l2 with every required and extra check passing', async t => {
  const { root, verdict, save } = fixture(t)
  assert.deepEqual(await gateIssues(root), [])
  const { l2 } = verdict
  delete verdict.l2
  save()
  assert.deepEqual(await gateIssues(root), ['G2: factory.js calls workflow() and requires an l2 verdict'])
  verdict.l2 = { ...l2, checks: {} }
  save()
  const ids = ['L2-i', 'L2-ii', 'L2-iii', 'L2-iv', 'L3']
  assert.deepEqual(await gateIssues(root), ids.map(id => `G2: ${id} is not passing`))
  verdict.l2 = l2
  for (const id of ids) {
    delete l2.checks[id]
    save()
    assert.deepEqual(await gateIssues(root), [`G2: ${id} is not passing`])
    l2.checks[id] = { status: 'fail' }
    save()
    assert.deepEqual(await gateIssues(root), [`G2: ${id} is not passing`])
    l2.checks[id] = pass()
  }
  l2.checks.extra = { status: 'fail' }
  save()
  assert.deepEqual(await gateIssues(root), ['G2: extra is not passing'])
})

test('G2 reads the protocol and both name forms from the target tree', async t => {
  const { root, put, handoff, verdict, save } = fixture(t)
  put('tools/sources.mjs', `
    export const LIB = ['src/lib/z-first.js']
    export const PAIR_LIB = ['src/lib/a-second.js']
  `)
  put('src/lib/z-first.js', 'const base = 1')
  put('src/lib/a-second.js', 'const version = base + 1')
  const { l2 } = verdict
  l2.protocol = 0
  save()
  assert.deepEqual(await gateIssues(root), ['G2: l2.protocol differs from HANDOFF_VERSION'])
  l2.protocol = 1
  l2.nameForm = 'bare'
  save()
  assert.deepEqual(await gateIssues(root), ['G2: l2.nameForm differs from childWorkflow'])

  handoff('version', 'strategy')
  assert.deepEqual(await gateIssues(root), ['G2: l2.protocol differs from HANDOFF_VERSION'])
  l2.protocol = 2
  save()
  assert.deepEqual(await gateIssues(root), [])
  for (const strategy of ['pair', 'independent']) {
    handoff('version', `strategy === '${strategy}' ? 'df:' + strategy : strategy`)
    assert.deepEqual(await gateIssues(root), ['G2: l2.nameForm differs from childWorkflow'])
  }
  handoff('version', "strategy === 'pair' ? '' : strategy")
  assert.deepEqual(await gateIssues(root), ['G2: l2.nameForm differs from childWorkflow'])
})

test('G2 uses the specified free-call pattern', async t => {
  const { root, workflow, verdict, save } = fixture(t)
  delete verdict.l2
  save()
  workflow('factory', 'obj.workflow(1); myworkflow(2); $workflow(3); _workflow(4); a1workflow(5)')
  assert.deepEqual(await gateIssues(root), [])
  workflow('factory', 'workflow(1)')
  assert.deepEqual(await gateIssues(root), ['G2: factory.js calls workflow() and requires an l2 verdict'])
})

test('G3 rejects a free call in each built leaf workflow', async t => {
  const { root, workflow } = fixture(t)
  for (const name of ['council', 'pair', 'ensemble', 'run-plan']) {
    workflow(name, 'x = workflow(1)')
    assert.deepEqual(await gateIssues(root), [`G3: ${name}.js calls workflow()`])
    workflow(name, 'obj.workflow(1)')
  }
})
