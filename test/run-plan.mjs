// Real Git and helper delivery, deterministic model substitutes. No provider/account calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPlan } from '../plugins/dark-factory/lib/run-plan-runner.mjs'
import { parseCLI, resultExitCode, validateResult } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { build } from '../tools/build.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, 'plugins/dark-factory/bin/dark-factory')
const ready = { state: 'ready', blocked: [], incomplete: [] }
const policy = new Function(readFileSync(join(root, 'src/lib/run-plan.js'), 'utf8') + '\nreturn {runPlanDefinition,runPlanNext,runPlanBrief,runPlanAnswer}')()
const task = (id, after = []) => ({ id, task: `Implement ${id}`, criteria: [`${id} works`], after })
// Most tests are about scheduling and delivery: their plans skip the grooming pre-pass.
const plan = tasks => ({ version: 1, id: 'test', tasks, decisions: ['Preserve public behavior.'], acceptance: { verify: 'true', criteria: ['The complete plan works together.'] }, groom: false })
const groomed = tasks => { const p = plan(tasks); delete p.groom; return p }
const read = file => JSON.parse(readFileSync(file, 'utf8'))

function fixture(t, input = plan([task('one'), task('two', ['one'])])) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'factory-run-plan-'))), repo = join(temp, 'repo with spaces')
  mkdirSync(repo)
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  const file = join(repo, 'plan.json')
  writeFileSync(file, JSON.stringify(input, null, 2) + '\n')
  writeFileSync(join(repo, 'base.txt'), 'original\n'); git('add', '.'); git('commit', '-qm', 'Base')
  const stateDir = join(repo, '.council/run-plan-test')
  const calls = []
  const plumbing = (...argv) => {
    const invoke = args => JSON.parse(execFileSync(helper, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, COUNCIL_JOB_POLL: '0.01' } }).trim().split('\n').at(-1))
    let r = invoke(argv)
    while (r.status === 'running') r = invoke(['wait', '--run-dir', argv[argv.indexOf('--run-dir') + 1], '--job', r.job, '--max-wait', '5'])
    assert.notEqual(r.status, 'error', JSON.stringify(r))
    return r
  }
  const runTask = async (S, item, args) => {
    calls.push({ id: item.id, args, head: git('rev-parse', 'HEAD') })
    if (item.id === 'acceptance') return { status: 'converged', mode: 'investigate', final: { readiness: ready,
      criteria: args.criteria.map((_,i) => ({ criterion: `C${i + 1}`, status: 'met' })) }, metrics: { turns: 2 } }
    const run = plumbing('init', '--repo', repo, '--seats', 'A', '--factory', '--run-id', `${item.id}-${S.tasks[item.id].attempts}`)
    writeFileSync(join(run.runDir, 'verify.sh'), 'true\n')
    writeFileSync(join(run.runDir, 'wt/A', `${item.id}.txt`), `implemented ${item.id}  \n`)
    mkdirSync(join(run.runDir, 'room/final'), { recursive: true })
    writeFileSync(join(run.runDir, 'room/final/A.md'), `Implemented ${item.id}. Preserve existing behavior.\n`)
    const m = plumbing('measure', '--run-dir', run.runDir, '--seat', 'A', '--label', 'final', '--max-wait', '5')
    return { status: 'done', mode: 'implement', runDir: run.runDir, final: { readiness: ready, snapshotRef: m.snapshot.ref, snapshotTree: m.snapshot.tree,
      post: join(run.runDir, 'room/final/A.md'), summary: `Implemented ${item.id}` }, delivery: { status: 'pending' }, metrics: { turns: 3 } }
  }
  const options = { cwd: repo, workflow: 'run-plan', args: { planFile: file } }
  const invoke = (deps = {}, args = {}) => runPlan({ ...options, args: { ...options.args, ...args } }, { progress: () => {}, runTask, ...deps })
  return { temp, repo, git, file, stateDir, calls, runTask, invoke, options, plumbing, state: () => read(join(stateDir, 'state.json')) }
}

test('plan validation rejects cycles, lost criteria, and execution overrides', () => {
  for (const p of [plan([task('one', ['missing'])]), plan([task('one', ['two']), task('two', ['one'])]),
    plan([task('one'), task('one')]), plan([{ ...task('one'), criteria: [] }]),
    { ...plan([task('one')]), defaults: { allowDirty: true } },
    { ...plan([task('one')]), acceptance: { verify: 'true', criteria: [] } }]) assert.throws(() => policy.runPlanDefinition(p))
})

test('sequential tasks commit code and progress together; final acceptance is fresh', async t => {
  const f = fixture(t)
  const result = await f.invoke()
  assert.equal(resultExitCode(result), 0, JSON.stringify(result))
  assert.equal(result.workflow, 'run-plan')
  assert.equal(result.planId, 'test')
  assert.equal(result.planFile, f.file)
  assert.equal(result.planRunDir, f.stateDir)
  assert.deepEqual(f.calls.map(c => c.id), ['one', 'two', 'acceptance'])
  assert.notEqual(f.calls[0].head, f.calls[1].head)
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '3')
  const first = f.git('rev-parse', 'HEAD^')
  assert.ok(read(f.file).progress.completed.two)
  assert.ok(JSON.parse(f.git('show', `${first}:plan.json`)).progress.completed.one)
  assert.equal(readFileSync(join(f.repo, 'one.txt'), 'utf8'), 'implemented one  \n')
  assert.equal(result.budget.turns, 8)
  const decisions = read(f.calls[1].args.plan.at(-1))
  assert.deepEqual(decisions.decisions, ['Preserve public behavior.'])
  assert.match(decisions.completed.one.post, /room\/final\/A.md/)
  assert.deepEqual(f.calls.at(-1).args.criteria, ['The complete plan works together.', 'one: one works', 'two: two works'])
  assert.equal(f.calls.at(-1).args.spec, false, 'acceptance verifies the settled plan without reopening its specification')
  const again = await f.invoke({ runTask: () => { throw new Error('Completed run-plan must not rerun') } })
  assert.equal(again.final.readiness.state, 'ready')
})

test('parked tasks block dependents but independent tasks continue; answers retain budgets', async t => {
  const f = fixture(t, plan([task('one'), task('dependent', ['one']), task('independent')]))
  const first = await f.invoke({ runTask: (S, item, args) => item.id === 'one'
    ? Promise.resolve({ status: 'needs-tier', questions: ['Use feature?'], metrics: { turns: 1 } }) : f.runTask(S, item, args) })
  assert.equal(first.status, 'blocked')
  assert.equal(first.tasks.one.status, 'parked')
  assert.equal(first.tasks.dependent.status, 'pending')
  assert.equal(first.tasks.independent.status, 'done')
  const story = first.report.markdown.split('\n')
  assert.equal(story[0], '### How the plan went')
  assert.match(story[2], /^- one \(Implement one\): parked after 1 attempt: Use feature\?\. Report: .*\/one-1\/result\.json$/)
  assert.equal(story[3], '- dependent (Implement dependent): waiting on one')
  assert.match(story[4], /^- independent \(Implement independent\): done after 1 attempt, committed [0-9a-f]{12}\. Report: /)
  assert.equal(story[5], '- acceptance (final acceptance): not started')
  assert.equal(story.at(-1), 'Budget used: 4 of 200 turns, 0 of 120 minutes.')
  const second = await f.invoke({}, { answers: { one: { answer: 'Use feature and preserve the API.', tier: 'feature' } } })
  assert.equal(second.final.readiness.state, 'ready', JSON.stringify(second))
  const resumed = f.calls.find(c => c.id === 'one')
  assert.equal(resumed.args.tierConfirmed, true)
  assert.match(resumed.args.context, /Use feature and preserve the API/)
  assert.equal(second.tasks.one.attempts, 2)
  const repeated = await f.invoke({}, { answers: { one: { answer: 'Use feature and preserve the API.', tier: 'feature' } } })
  assert.equal(repeated.final.readiness.state, 'ready')
  assert.equal(repeated.decisions.length, 1)
})

test('failed attempts and total turns persist without implementation commits', async t => {
  const p = plan([task('one')]); p.limits = { maxTurns: 4, taskMaxTurns: 2, maxAttempts: 2 }
  const f = fixture(t, p)
  let calls = 0
  const deps = { runTask: async () => { calls++; return { status: 'failed', error: 'CLI failed', metrics: { turns: 2 } } } }
  const result = await f.invoke(deps)
  assert.equal(calls, 2); assert.equal(result.tasks.one.status, 'parked')
  assert.equal(result.budget.turns, 4); assert.equal(f.git('rev-list', '--count', 'HEAD'), '1')
  const exhausted = await f.invoke(deps, { answers: { one: 'Retry if budget allows.' } })
  assert.match(exhausted.error, /exhausted its 2 attempts/)
  assert.deepEqual(f.state().decisions, [])
  assert.equal(calls, 2)
})

for (const boundary of ['after-prepare', 'after-apply', 'before-commit', 'after-commit']) {
  test(`interruption ${boundary} resumes without duplicate implementation or commits`, async t => {
    const f = fixture(t, plan([task('one')]))
    const stopped = await f.invoke({ at: name => { if (name === boundary) throw new Error(`interrupt ${name}`) } })
    assert.equal(stopped.status, 'blocked')
    assert.equal(f.state().active.task, 'one')
    const resumed = await f.invoke()
    assert.equal(resumed.final.readiness.state, 'ready', JSON.stringify(resumed))
    assert.equal(f.calls.filter(c => c.id === 'one').length, 1)
    assert.equal(f.git('rev-list', '--count', 'HEAD'), '2')
    assert.equal(f.git('status', '--porcelain'), '')
  })
}

test('a delivery commit that landed before its journal write is adopted without recommitting or reverifying', async t => {
  const f = fixture(t, plan([task('one')]))
  await f.invoke({ at: name => { if (name === 'after-commit') throw new Error('interrupt after-commit') } })
  const landed = f.git('rev-parse', 'HEAD')
  assert.equal(f.state().tasks.one.status, 'running')
  assert.equal(f.state().tasks.one.commit, undefined)
  const resumed = await f.invoke({ verifyDelivery: () => { throw new Error('Must not reverify a landed commit') } })
  assert.equal(resumed.final.readiness.state, 'ready', JSON.stringify(resumed))
  assert.equal(f.git('rev-parse', 'HEAD'), landed)
  assert.equal(f.git('log', '--format=%B').split('\n').filter(line => line === 'Factory-Task: one').length, 1)
  assert.equal(f.state().tasks.one.status, 'done')
  assert.equal(f.state().tasks.one.commit, landed)
})

test('an interrupted delivery whose verification passed commits on resume without reverifying', async t => {
  const f = fixture(t, plan([task('one')]))
  await f.invoke({ at: name => { if (name === 'before-commit') throw new Error('interrupt before-commit') } })
  const d = f.state().active.delivery
  assert.equal(read(join(d.runDir, 'delivery.json')).status, 'delivered')
  const resumed = await f.invoke({ verifyDelivery: () => { throw new Error('Must not reverify a passed delivery') } })
  assert.equal(resumed.final.readiness.state, 'ready', JSON.stringify(resumed))
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '2')
  assert.equal(f.git('rev-parse', 'HEAD^{tree}'), d.tree)
  assert.equal(f.state().tasks.one.commit, f.git('rev-parse', 'HEAD'))
})

test('the journal records its engine and task bases; resume refuses a different engine', async t => {
  const f = fixture(t, plan([task('one')]))
  const [x, y] = ['a'.repeat(64), 'b'.repeat(64)], base = f.git('rev-parse', 'HEAD'), messages = []
  const start = (engine, deps = {}) => runPlan({ ...f.options, engine }, { progress: m => messages.push(m), runTask: f.runTask, ...deps })
  await start(x, { at: name => { if (name === 'after-reserve') throw new Error('crash') } })
  assert.equal(f.state().engine, x)
  assert.equal(f.state().tasks.one.base, base)
  const refused = await start(y)
  assert.equal(refused.error, `Run-plan test started on engine ${x}, but the installed engine is ${y}. Finish it with the original plugin or start a new plan.`)
  assert.equal(f.state().active.task, 'one')
  const old = f.state(); delete old.engine
  writeFileSync(join(f.stateDir, 'state.json'), JSON.stringify(old, null, 2))
  const resumed = await start(y)
  assert.equal(resumed.tasks.one.status, 'parked', JSON.stringify(resumed))
  assert.ok(messages.some(m => /journal predates engine recording/.test(m)))
})

test('an engine inside the target repository does not refuse resume', async t => {
  const f = fixture(t, plan([task('one')]))
  const [x, y] = ['a'.repeat(64), 'b'.repeat(64)], messages = []
  const start = (engine, deps = {}) => runPlan({ ...f.options, engine }, { progress: m => messages.push(m), runTask: f.runTask, engineRoot: join(f.repo, 'plugin'), ...deps })
  await start(x, { at: name => { if (name === 'after-reserve') throw new Error('crash') } })
  const resumed = await start(y)
  assert.equal(resumed.tasks.one.status, 'parked', JSON.stringify(resumed))
  assert.ok(messages.some(m => /engine is part of the target repository/.test(m)))
  assert.equal(f.state().engine, x)
})

test('interrupted attempts retain their reservation and park without resetting checkout', async t => {
  const p = plan([task('one')]); p.limits = { maxTurns: 10, taskMaxTurns: 4 }
  const f = fixture(t, p)
  await f.invoke({ at: name => { if (name === 'after-reserve') throw new Error('crash') } })
  const result = await f.invoke()
  assert.equal(result.tasks.one.status, 'parked'); assert.equal(result.budget.turns, 4)
  assert.equal(f.calls.length, 0)
  const done = await f.invoke({}, { answers: { one: 'Retry the interrupted attempt.' } })
  assert.equal(done.final.readiness.state, 'ready')
  assert.equal(done.budget.turns, 9)
})

test('unexpected dirty delivery stays intact and blocks other tasks', async t => {
  const f = fixture(t)
  await f.invoke({ at: name => { if (name === 'after-apply') throw new Error('crash') } })
  writeFileSync(join(f.repo, 'base.txt'), 'user edit\n')
  const result = await f.invoke()
  assert.match(result.error, /unexpected checkout changes/)
  assert.equal(readFileSync(join(f.repo, 'base.txt'), 'utf8'), 'user edit\n')
  assert.equal(f.calls.length, 1)
})

test('recovery preserves staged-only user changes', async t => {
  const f = fixture(t, plan([task('one')]))
  await f.invoke({ at: name => { if (name === 'after-apply') throw new Error('crash') } })
  writeFileSync(join(f.repo, 'base.txt'), 'staged user edit\n'); f.git('add', 'base.txt')
  writeFileSync(join(f.repo, 'base.txt'), 'original\n')
  assert.match((await f.invoke()).error, /unexpected staged changes/)
  assert.equal(f.git('show', ':base.txt'), 'staged user edit')
})

test('SIGKILL after commit recovers in a new process without duplicating the task', async t => {
  const f = fixture(t, plan([task('one')]))
  const result = await f.runTask({ tasks: { one: { attempts: 1 } } }, task('one'), {})
  const resultFile = join(f.temp, 'prepared-result.json'), worker = join(f.temp, 'interrupt.mjs')
  writeFileSync(resultFile, JSON.stringify(result))
  writeFileSync(worker, `import {runPlan} from ${JSON.stringify(new URL('../plugins/dark-factory/lib/run-plan-runner.mjs', import.meta.url).href)};
    import {readFileSync} from 'node:fs';
    await runPlan(${JSON.stringify(f.options)}, {progress:()=>{},runTask:async()=>JSON.parse(readFileSync(${JSON.stringify(resultFile)},'utf8')),
      at:name=>{if(name==='after-commit')process.kill(process.pid,'SIGKILL')}});`)
  const killed = spawnSync(process.execPath, [worker], { encoding: 'utf8', timeout: 30000 })
  assert.equal(killed.signal, 'SIGKILL', killed.stderr)
  const recovered = await f.invoke()
  assert.equal(recovered.final.readiness.state, 'ready', JSON.stringify(recovered))
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '2')
  assert.deepEqual(f.calls.map(c => c.id), ['one', 'acceptance'])
})

test('interrupted reservations cannot replenish the plan run time cap', async t => {
  const p = plan([task('one'), task('two')]); p.limits = { maxRunMin: 1, taskMaxRunMin: 1 }
  const f = fixture(t, p)
  await f.invoke({ at: name => { if (name === 'after-reservation-journal') throw new Error('crash before attempt directory creation') } })
  const result = await f.invoke({}, { answers: { one: 'Retry if budget remains.' } })
  assert.equal(result.budget.elapsedMs, 60000)
  assert.equal(result.final.readiness.state, 'incomplete')
  assert.equal(f.calls.length, 0)
})

test('changed reference documents invalidate completion and run-plan locks exclude another runner', async t => {
  const f = fixture(t, plan([task('one')]))
  const reference = join(f.temp, 'design.md')
  writeFileSync(reference, 'Original contract')
  const p = read(f.file); p.defaults = { plan: [reference] }
  writeFileSync(f.file, JSON.stringify(p)); f.git('add', 'plan.json'); f.git('commit', '-qm', 'Add design reference')
  const lock = join(f.repo, '.git/dark-factory-run-plan.lock')
  writeFileSync(lock, String(process.pid))
  assert.match((await f.invoke()).error, /already running/)
  writeFileSync(lock, '')
  assert.match((await f.invoke()).error, /lock is incomplete/)
  assert.equal(readFileSync(lock, 'utf8'), '', 'a lock being initialized is never stolen')
  rmSync(lock)
  assert.equal((await f.invoke()).final.readiness.state, 'ready')
  writeFileSync(reference, 'Changed contract')
  assert.match((await f.invoke()).error, /references.*changed/)
})

test('failed delivery rolls back and parks once; reinvocation is idle and an answer can retry', async t => {
  const f = fixture(t)
  let checks = 0
  const deps = { verifyDelivery: async (S,d) => {
    checks++
    writeFileSync(join(d.runDir, 'delivery.json'), JSON.stringify({ status: 'incomplete' })); return { status: 'done' }
  } }
  const result = await f.invoke(deps)
  assert.equal(result.tasks.one.status, 'parked')
  assert.match(result.tasks.one.question, /Delivery verification did not pass/)
  assert.equal(result.tasks.one.attempts, 1)
  assert.equal(f.state().active, null)
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '1')
  assert.equal(f.calls.length, 1)
  assert.equal(f.git('status', '--porcelain'), '')
  assert.ok(!existsSync(join(f.repo, 'one.txt')))
  assert.ok(existsSync(join(f.stateDir, 'one-1/delivery.patch')))
  assert.deepEqual((await f.invoke(deps)).budget, result.budget)
  assert.equal(checks, 1)
  const done = await f.invoke({}, { answers: { one: 'Correct the verification failure and retry.' } })
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(done.tasks.one.attempts, 2)
})

test('rejected commit hooks park and restore both the index and checkout', async t => {
  const f = fixture(t, plan([task('one')]))
  const hook = join(f.repo, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "hook rejects commit" >&2\nexit 1\n'); chmodSync(hook, 0o755)
  const first = await f.invoke({ runTask: async (S, item, args) => {
    const result = await f.runTask(S, item, args)
    if (item.id === 'acceptance') return result
    rmSync(join(result.runDir, 'wt/A/base.txt'))
    const measured = f.plumbing('measure', '--run-dir', result.runDir, '--seat', 'A', '--label', 'deleted', '--max-wait', '5')
    return { ...result, final: { ...result.final, snapshotRef: measured.snapshot.ref, snapshotTree: measured.snapshot.tree } }
  } })
  assert.match(first.tasks.one.question, /Delivery commit failed.*|hook rejects commit/s)
  assert.equal(first.tasks.one.status, 'parked')
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(readFileSync(join(f.repo, 'base.txt'), 'utf8'), 'original\n', 'staged deletions are restored')
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '1')
  assert.deepEqual((await f.invoke()).budget, first.budget)
  rmSync(hook)
  assert.equal((await f.invoke({}, { answers: { one: 'The hook is fixed; retry.' } })).status, 'done')
})

for (const boundary of ['after-delivery-failure', 'after-delivery-rollback']) {
  test(`interruption ${boundary} parks without rechecking or charging extra time`, async t => {
    const f = fixture(t, plan([task('one')]))
    let tick = 1000
    await f.invoke({ now: () => tick, verifyDelivery: async () => { tick = 2000; throw new Error('Delivery failed') },
      at: name => { if (name === boundary) throw new Error('crash') } })
    const recovered = await f.invoke({ now: () => 1000000, verifyDelivery: () => { throw new Error('Must not verify again') } })
    assert.equal(recovered.tasks.one.status, 'parked')
    assert.equal(recovered.tasks.one.question, 'Delivery failed')
    assert.equal(recovered.tasks.one.attempts, 1)
    assert.equal(recovered.budget.elapsedMs, 1000)
    assert.equal(recovered.budget.turns, 3)
    assert.equal(f.git('status', '--porcelain'), '')
  })
}

test('older failed deliveries and exhausted interrupted deliveries can park without another reservation', async t => {
  for (const legacyFailure of [false, true]) {
    const p = plan([task('one')]); p.limits = { maxRunMin: 1, taskMaxRunMin: 1 }
    const f = fixture(t, p)
    await f.invoke({ at: (name, S) => {
      if (name !== 'after-apply') return
      if (legacyFailure) writeFileSync(join(S.active.delivery.runDir, 'delivery.json'), JSON.stringify({ status: 'incomplete' }))
      throw new Error('Old controller stopped')
    } })
    const recovered = await f.invoke({ verifyDelivery: () => { throw new Error('Must not reverify') } })
    assert.equal(recovered.tasks.one.status, 'parked', JSON.stringify(recovered))
    assert.equal(recovered.tasks.one.attempts, 1)
    assert.equal(recovered.budget.elapsedMs, 60000)
    assert.equal(f.git('status', '--porcelain'), '')
    assert.deepEqual((await f.invoke()).budget, recovered.budget)
  }
})

test('delivery failure preserves unexpected verifier changes until the user restores known bytes', async t => {
  const f = fixture(t, plan([task('one')]))
  const failed = await f.invoke({ verifyDelivery: async () => {
    writeFileSync(join(f.repo, 'base.txt'), 'verifier change\n'); throw new Error('Failed check')
  } })
  assert.match(failed.error, /Unexpected delivery changes were preserved/)
  assert.equal(readFileSync(join(f.repo, 'base.txt'), 'utf8'), 'verifier change\n')
  writeFileSync(join(f.repo, 'base.txt'), 'original\n')
  assert.equal((await f.invoke()).tasks.one.status, 'parked')
  assert.equal(f.git('status', '--porcelain'), '')
})

test('symlinked repository paths resolve to the same plan journal; escaping plans are rejected', async t => {
  const f = fixture(t, plan([task('one')]))
  const alias = join(f.temp, 'repo-alias')
  symlinkSync(f.repo, alias)
  assert.equal((await f.invoke({}, { planFile: join(alias, 'plan.json') })).status, 'done')
  assert.equal((await f.invoke()).status, 'done')
  const outside = join(f.temp, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'plan.json'), readFileSync(f.file))
  symlinkSync(outside, join(f.repo, 'outside'))
  assert.match((await f.invoke({}, { planFile: join(f.repo, 'outside/plan.json') })).error, /inside the repository/)
})

test('recovery does not race a detached delivery verification', async t => {
  const f = fixture(t, plan([task('one')]))
  await f.invoke({ at: (name, S) => {
    if (name !== 'before-verify-delivery') return
    const job = join(S.active.delivery.runDir, 'jobs/verify-delivery')
    mkdirSync(job, { recursive: true }); writeFileSync(join(job, 'pid'), String(process.pid))
    throw new Error('Interrupted while verification is running')
  } })
  assert.match((await f.invoke()).error, /verification is still running/)
  assert.equal(f.calls.length, 1)
})

test('a failed delivery waits for its detached verifier before rolling back', async t => {
  const f = fixture(t, plan([task('one')]))
  let job
  const failed = await f.invoke({ verifyDelivery: async (S, d) => {
    job = join(d.runDir, 'jobs/verify-delivery')
    mkdirSync(job, { recursive: true }); writeFileSync(join(job, 'pid'), String(process.pid))
    throw new Error('The wait command timed out')
  } })
  assert.match(failed.error, /verification is still running/)
  assert.ok(existsSync(join(f.repo, 'one.txt')), 'the verifier still owns the applied checkout')
  assert.match(f.state().active.delivery.failure, /wait command timed out/)
  writeFileSync(join(job, 'status.json'), JSON.stringify({ status: 'error' }))
  const resumed = await f.invoke()
  assert.equal(resumed.tasks.one.status, 'parked')
  assert.equal(f.git('status', '--porcelain'), '')
  assert.equal(f.calls.length, 1)
})

test('failed final gate and missing independent review cannot report completion', async t => {
  for (const stage of ['gate', 'review']) {
    const p = plan([task('one')]); if (stage === 'gate') p.acceptance.verify = 'exit 7'
    const f = fixture(t, p)
    const result = await f.invoke({ runTask: (S,item,args) => item.id === 'acceptance'
      ? Promise.resolve({ status: 'done', mode: 'investigate', final: { readiness: { state: 'incomplete', incomplete: ['Missing review'] } }, metrics: { turns: 1 } }) : f.runTask(S,item,args) })
    assert.equal(result.final.readiness.state, 'incomplete')
    assert.equal(result.tasks.one.status, 'done')
    assert.equal(result.tasks.acceptance.status, 'parked')
  }
})

test('final acceptance runs the generated Council and respects its real statuses and unmet criteria', async t => {
  const empty = s => s.enum ? s.enum[0] : s.type === 'object' ? Object.fromEntries(Object.entries(s.properties).map(([k,v]) => [k, empty(v)])) : s.type === 'array' ? [] : s.type === 'string' ? '' : s.type === 'boolean' ? false : 0
  const source = build('council').replace('export const meta', 'const meta')
  const council = new (Object.getPrototypeOf(async function(){}).constructor)('args', 'factoryRuntime', 'parallel', 'phase', 'log', source)
  for (const criterionStatus of ['met', 'unmet', 'partial']) {
    const defect = criterionStatus !== 'met'
    const p = plan([task('one')]); p.acceptance.args = { seats: ['astra', 'sol'], rounds: 1, retro: false }
    const f = fixture(t, p), calls = []
    let acceptance
    const result = await f.invoke({ runTask: async (S, item, args) => {
      if (item.id !== 'acceptance') return f.runTask(S, item, args)
      const respond = async r => {
        calls.push(r)
        const value = empty(r.schema)
        if (r.role === 'setup') Object.assign(value, { status: 'ok', mode: 'investigate', repoRoot: f.repo, runId: 'acceptance', runDir: join(f.repo, '.council/acceptance'),
          criteria: args.criteria.map((text,i) => ({ id: `C${i+1}`, text })), verify: 'true', baselinePasses: true })
        else if (r.role === 'checker') Object.assign(value, { postWords: 20,
          criteria: args.criteria.map((_, i) => ({ criterion: `C${i+1}`, status: criterionStatus, note: defect ? 'Repository still fails the boundary case.' : 'Inspected the implementation.' })) })
        else if (r.role === 'seat') {
          if ('summary' in value) value.summary = defect ? 'The repository still has a boundary defect.' : 'The repository meets every criterion.'
          if ('confidence' in value) value.confidence = 5
          if ('vote' in value) value.vote = { ...value.vote, ship: 'A', reason: 'Verified the same evidence.' }
          if ('endorse' in value) value.endorse = true
        } else throw new Error(`Unexpected acceptance role: ${r.role}`)
        validateResult(value, r.schema)
        return value
      }
      const runtime = { now: () => 1000, agent: respond, turn: async r => ({ status: 'done', result: await respond(r) }) }
      acceptance = await council({ ...args, host: 'codex' }, runtime, jobs => Promise.all(jobs.map(j => j())), () => {}, () => {})
      return acceptance
    } })
    assert.ok(['converged', 'scorecard'].includes(acceptance.status), JSON.stringify(acceptance))
    assert.equal(acceptance.mode, 'investigate')
    assert.equal(result.tasks.acceptance.status, defect ? 'parked' : 'done', JSON.stringify(result))
    assert.equal(result.status, defect ? 'blocked' : 'done')
    assert.ok(calls.some(c => c.role === 'checker'))
    assert.ok(calls.some(c => c.role === 'seat' && c.label.startsWith('ratify')))
    assert.ok(calls.filter(c => c.role === 'checker').every(c => c.prompt.includes('A complete investigation that finds defects is not successful acceptance.')))
  }
})

test('HEAD and plan changes reject stale completion; untracked user files are preserved', async t => {
  const f = fixture(t, plan([task('one')]))
  await f.invoke()
  writeFileSync(join(f.repo, 'personal.txt'), 'keep me')
  assert.match((await f.invoke()).error, /dirty/)
  assert.equal(readFileSync(join(f.repo, 'personal.txt'), 'utf8'), 'keep me')
  f.git('add', 'personal.txt'); f.git('commit', '-qm', 'User work')
  assert.match((await f.invoke()).error, /HEAD changed/)
})

test('shared controller runs through Claude transport and retains a prompt golden', async () => {
  const source = build('run-plan').replace('export const meta', 'const meta')
  const run = new (Object.getPrototypeOf(async function(){}).constructor)('args', 'agent', 'phase', source)
  const input = { planFile: '/repo/plan.json', repo: '/repo' }
  let prompt
  const result = await run(input, async text => { prompt = text; return { result: JSON.stringify({ status: 'blocked' }), error: '' } }, () => {})
  assert.equal(result.status, 'blocked')
  const file = join(root, 'test/golden/run-plan/transport.txt')
  if (process.env.UPDATE_GOLDEN) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, prompt + '\n') }
  assert.equal(prompt + '\n', readFileSync(file, 'utf8'))
})

test('task brief snapshots decisions without inheriting previous agent conversations', () => {
  const S = { plan: policy.runPlanDefinition(plan([task('one'), task('two',['one'])])),
    active: { decisionsFile: '/repo/.council/run-plan-test/two-1/decisions.json', turns: 20, milliseconds: 60000 },
    tasks: { one: { status: 'done', commit: 'abc123', decision: 'private prior author context' } },
    decisions: [{ task: 'two', answer: 'Keep the API.', tier: 'feature' }] }
  const brief = policy.runPlanBrief(S, S.plan.tasks[1])
  const rendered = JSON.stringify(brief, null, 2) + '\n'
  assert.doesNotMatch(rendered, /private prior author context/)
  const file = join(root, 'test/golden/run-plan/brief.txt')
  if (process.env.UPDATE_GOLDEN) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, rendered) }
  assert.equal(rendered, readFileSync(file, 'utf8'))
})

test('a Pair task keeps the plan\'s retro switch and drops council-only options', () => {
  const p = plan([{ ...task('one'), workflow: 'pair', args: { author: 'sol', seats: ['astra', 'sol'], roles: { intake: 'sonnet' } } }])
  p.defaults = { retro: false }
  const S = { plan: policy.runPlanDefinition(p), active: { decisionsFile: '/repo/.council/run-plan-test/one-1/decisions.json', turns: 20, milliseconds: 60000 },
    tasks: {}, decisions: [] }
  const brief = policy.runPlanBrief(S, S.plan.tasks[0])
  assert.equal(brief.retro, false)
  assert.equal(brief.author, 'sol')
  assert.equal('seats' in brief || 'roles' in brief, false)
})

test('CLI routes run-plan inputs without a task and rejects checkpoint resume', () => {
  assert.equal(parseCLI(['--workflow', 'run-plan', '--plan-file', '/repo/plan.json']).args.planFile, '/repo/plan.json')
  assert.throws(() => parseCLI(['--workflow', 'run-plan', '--resume', '/repo/run']), /repeat it to resume/)
})

test('packaged CLI runs a Pair task through stub model CLIs and real delivery', async t => {
  const p = groomed([{ ...task('sum'), workflow: 'pair', args: { author: 'sol', reviewer: 'astra', verify: 'node check.cjs' } }])
  // The grooming pass's shaper and challenger (a brief run), then the Pair task: the re-check of
  // its groomed ticket, setup, the spec review, two author turns and two reviews; the retro would
  // be the tenth.
  p.limits = { maxTurns: 9, taskMaxTurns: 8 }
  const f = fixture(t, p), bin = join(f.temp, 'bin')
  mkdirSync(bin)
  for (const name of ['codex', 'claude']) {
    cpSync(join(root, 'test/fixtures/codex-cli.cjs'), join(bin, name)); chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(f.repo, 'sum.cjs'), 'module.exports = (a,b) => a-b\n')
  writeFileSync(join(f.repo, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)\n")
  mkdirSync(join(f.repo, 'tests'))
  writeFileSync(join(f.repo, 'tests/preserved.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2,0),2)\n")
  f.git('add', '.'); f.git('commit', '-qm', 'Add failing sum')
  const result = spawnSync(process.execPath, [join(root, 'plugins/dark-factory/bin/dark-factory-codex'), '--workflow', 'run-plan', '--cwd', f.repo, '--plan-file', f.file], {
    encoding: 'utf8', timeout: 90000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(f.temp, 'codex-config'), CLAUDE_CONFIG_DIR: join(f.temp, 'claude-config'), FACTORY_TEST_REPO: f.repo,
      FACTORY_TEST_RUN_PATH: join(f.temp, 'run-path'), FACTORY_TEST_LOG: join(f.temp, 'turns.jsonl'), COUNCIL_JOB_POLL: '0.01', COUNCIL_TRANSCRIPT_WAIT: '0' },
  })
  const output = JSON.parse(result.stdout)
  assert.equal(output.tasks?.sum.status, 'done', result.stdout + result.stderr)
  assert.equal(result.status, 2, 'Final acceptance remains pending at the hard turn limit')
  assert.equal(output.groom.tasks.sum.status, 'ready', JSON.stringify(output.groom))
  const kinds = readFileSync(join(f.temp, 'turns.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)
  assert.deepEqual(kinds.slice(0, 3), ['shaper', 'challenger', 'brief-recheck'], 'the pass shapes the task; the Pair run re-checks its ticket')
  assert.match(read(join(f.stateDir, 'sum-1/args.json')).task, /Groomed by dark-factory\s*$/)
  assert.equal(output.budget.turns, 9)
  assert.equal(f.git('status', '--porcelain'), '')
})

// The route Codex reproduced: a Factory task that intake sends to Simple, run through the shipped
// CLI with stub model CLIs, must be committed, not parked for a missing delivery record.
test('packaged CLI commits a Factory Simple task through stub model CLIs and real delivery', async t => {
  const p = plan([task('sum'), task('after', ['sum'])])
  p.tasks[0].args = { verify: 'node check.cjs' }
  p.limits = { maxTurns: 12, taskMaxTurns: 8 }
  const f = fixture(t, p), bin = join(f.temp, 'bin')
  mkdirSync(bin)
  for (const name of ['codex', 'claude']) {
    cpSync(join(root, 'test/fixtures/codex-cli.cjs'), join(bin, name)); chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(f.repo, 'sum.cjs'), 'module.exports = (a,b) => a-b\n')
  writeFileSync(join(f.repo, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)\n")
  f.git('add', '.'); f.git('commit', '-qm', 'Add failing sum')
  const before = f.git('rev-parse', 'HEAD')
  const log = join(f.temp, 'turns.jsonl')
  const result = spawnSync(process.execPath, [join(root, 'plugins/dark-factory/bin/dark-factory-codex'), '--workflow', 'run-plan', '--cwd', f.repo, '--plan-file', f.file], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(f.temp, 'codex-config'), CLAUDE_CONFIG_DIR: join(f.temp, 'claude-config'), FACTORY_TEST_REPO: f.repo,
      FACTORY_TEST_RUN_PATH: join(f.temp, 'run-path'), FACTORY_TEST_LOG: log, COUNCIL_JOB_POLL: '0.01', COUNCIL_TRANSCRIPT_WAIT: '0' },
  })
  const output = JSON.parse(result.stdout)
  const kinds = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).kind)
  assert.ok(kinds.includes('intake') && kinds.includes('solve') && !kinds.some(k => k.startsWith('pair')), `ran Factory Simple: ${kinds.join(',')}`)
  assert.equal(output.tasks?.sum.status, 'done', result.stdout + result.stderr)
  assert.notEqual(f.git('rev-parse', 'HEAD'), before, 'the ready Simple task was committed')
  assert.match(f.git('show', 'HEAD:sum.cjs'), /a \+ b/, 'the commit carries the implemented change')
  assert.notEqual(output.tasks?.after.status, 'waiting', 'the dependent task was released')
})

test('untracked execution plans and instruction files remain frozen outside delivery commits', async t => {
  const f = fixture(t, plan([task('one')]))
  f.git('rm', '--cached', 'plan.json'); f.git('commit', '-qm', 'Keep plan local')
  writeFileSync(join(f.repo, 'CLAUDE.md'), 'Keep local instructions.\n')
  const original = readFileSync(f.file, 'utf8')
  const result = await f.invoke()
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result))
  assert.equal(readFileSync(f.file, 'utf8'), original)
  assert.equal(f.git('ls-files', 'plan.json', 'CLAUDE.md'), '')
  assert.match(f.git('status', '--porcelain'), /\?\? plan.json/)
  assert.equal(f.state().tasks.one.status, 'done')
  assert.equal(readFileSync(join(f.repo, '.council/one-1/wt/A/CLAUDE.md'), 'utf8'), 'Keep local instructions.\n')
  writeFileSync(join(f.repo, 'CLAUDE.md'), 'Changed local instructions.\n')
  assert.match((await f.invoke()).error, /control files changed/)
})

for (const boundary of ['after-apply', 'after-commit']) {
  test(`untracked plan delivery recovers ${boundary} without staging the plan`, async t => {
    const f = fixture(t, plan([task('one')]))
    f.git('rm', '--cached', 'plan.json'); f.git('commit', '-qm', 'Keep plan local')
    await f.invoke({ at: name => { if (name === boundary) throw new Error('interrupt') } })
    const resumed = await f.invoke()
    assert.equal(resumed.final.readiness.state, 'ready', JSON.stringify(resumed))
    assert.equal(f.calls.filter(c => c.id === 'one').length, 1)
    assert.equal(f.git('ls-files', 'plan.json'), '')
  })
}

test('budget extensions require a reason, retain spent reservations, and do not change frozen scope', async t => {
  const p = plan([task('one')]); p.limits = { maxTurns: 2, taskMaxTurns: 2, maxAttempts: 1 }
  const f = fixture(t, p)
  await f.invoke({ runTask: async () => ({ status: 'failed', error: 'Task timed out.', metrics: { turns: 2 } }) })
  assert.equal(f.state().turns, 2)
  assert.match((await f.invoke({}, { extendLimits: { limits: { maxTurns: 20 } } })).error, /requires a reason/)
  assert.match((await f.invoke({}, { extendLimits: { reason: 'Invalid decrease.', limits: { maxTurns: 1 } } })).error, /only increase/)
  const result = await f.invoke({}, { extendLimits: { reason: 'Allow reviewed work to finish.', limits: { maxTurns: 20, taskMaxTurns: 10, maxAttempts: 2 } }, answers: { one: 'Retry with the increased allowance.' } })
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result))
  assert.equal(result.tasks.one.attempts, 2)
  assert.equal(result.budget.turns, 7)
  assert.equal(result.limitChanges[0].spentTurns, 2)
  assert.equal(result.limitChanges[0].reason, 'Allow reviewed work to finish.')
  assert.equal((await f.invoke()).final.readiness.state, 'ready')
})

test('live checks pending on committed Pair tasks reach the plan report; they change neither commit nor park', async t => {
  const f = fixture(t)
  const check = { criterion: 'C1', check: 'Run `node cli.js fetch` against the real API.', reason: 'The tests stub the HTTP call.', source: 'setup' }
  const runTask = async (S, item, args) => {
    const result = await f.runTask(S, item, args)
    if (item.id === 'one') result.final.readiness = { ...result.final.readiness, liveChecks: [check] }
    return result
  }
  const result = await f.invoke({ runTask })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.equal(result.final.readiness.state, 'ready')
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '3')
  assert.deepEqual(result.liveChecks, [{ task: 'one', ...check }])
  assert.deepEqual(result.final.readiness.liveChecks, [{ task: 'one', ...check }])
  assert.equal('liveChecks' in result.tasks.two, false)
  const lib = new Function(readFileSync(join(root, 'src/lib/run-plan.js'), 'utf8') + '\nreturn {runPlanLiveChecks,runPlanReport}')()
  const S = { plan: policy.runPlanDefinition(plan([task('one'), task('two')])), tasks: { one: { status: 'parked' }, two: { status: 'done' }, acceptance: { status: 'pending' } }, turns: 0, elapsedMs: 0 }
  for (const id of ['one', 'two']) lib.runPlanLiveChecks(S, { id }, { final: { readiness: { state: 'ready', liveChecks: [check] } } })
  assert.deepEqual(lib.runPlanReport(S).liveChecks, [{ task: 'two', ...check }], 'a parked task\'s checks are not pending')
  lib.runPlanLiveChecks(S, { id: 'two' }, { final: { readiness: { state: 'ready', liveChecks: [] } } })
  assert.deepEqual([lib.runPlanReport(S).liveChecks, 'liveChecks' in S.tasks.two], [[], false], 'a later attempt without live checks clears them')
})

// The grooming pre-pass, with a dark-factory:brief stand-in. Each task's pass has its own host run
// under .council, whose host.json counts turns across resumes as the shipped runner does.
const groomQuestion = id => ({ id, question: `Question ${id}?`, wording: 'the task', outcomeA: `A ${id}.`, outcomeB: `B ${id}.`,
  evidence: 'The code allows both.', recommendation: `A ${id}.`, changes: 'What the user sees.' })
function briefStub(f, plans = {}, turns = 1) {
  const calls = []
  const runBrief = async (S, item, args) => {
    calls.push({ id: item.id, resume: item.resume, args, head: f.git('rev-parse', 'HEAD'), tasksRun: f.calls.length })
    // A fresh pass starts its own host run; a resume continues the one its answers belong to.
    const host = item.resume ? S.groom.tasks[item.id].hostRunDir : join(f.repo, '.council', `host-${item.id}-${calls.length}`), hostFile = join(host, 'host.json')
    mkdirSync(host, { recursive: true })
    const spent = (existsSync(hostFile) ? read(hostFile).spentTurns : 0) + turns
    writeFileSync(hostFile, JSON.stringify({ spentTurns: spent, elapsedMs: 0 }))
    const how = plans[item.id] || {}, answered = new Set((args.clarifications || []).map(c => c.id))
    const base = { hostRunDir: host, metrics: { turns: spent } }
    if (how.verdict === 'failed') return { status: 'failed', error: 'Brief CLI failed.', ...base }
    if (how.verdict === 'not-actionable') return { status: 'not-actionable', verdict: 'not-actionable', reason: 'It names no outcome.', ...base }
    if (how.verdict === 'needs-split') return { status: 'done', verdict: 'needs-split', split: [{ title: 'Part A', task: 'a' }, { title: 'Part B', task: 'b' }], ticket: 'bundled', ...base }
    const open = (how.questions || []).filter(id => !answered.has(id))
    if (open.length) return { status: 'needs-user', verdict: 'needs-answers', questions: open.map(groomQuestion), ...base }
    const decisions = (args.clarifications || []).map(c => `- ${c.id}: Question ${c.id}? → ${c.answer}`).join('\n')
    return { status: 'done', verdict: 'ready', ticket: `# Groomed ${item.id}\n\n## Decisions\n\n${decisions || 'None.'}\n\n---\n\nGroomed by dark-factory\n`, ...base }
  }
  return { calls, runBrief }
}

test('grooming validates its switch and leaves a default plan definition unchanged', () => {
  assert.throws(() => policy.runPlanDefinition({ ...plan([task('one')]), groom: 'no' }), /groom must be true or false/)
  assert.equal('groom' in policy.runPlanDefinition(groomed([task('one')])), false)
  assert.equal('groom' in policy.runPlanDefinition({ ...plan([task('one')]), groom: true }), false)
  assert.equal(policy.runPlanDefinition(plan([task('one')])).groom, false)
})

test('a fresh plan grooms every task at its starting revision before any runs; tickets become task text', async t => {
  const p = groomed([task('one'), task('two', ['one'])])
  p.defaults = { context: 'Shared context.' }; p.tasks[1].args = { context: 'Two context.', roles: { intake: 'sonnet', setup: 'sol' } }
  const f = fixture(t, p), b = briefStub(f), base = f.git('rev-parse', 'HEAD')
  const result = await f.invoke({ runBrief: b.runBrief })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(b.calls.map(c => [c.id, c.resume, c.head, c.tasksRun]), [['one', false, base, 0], ['two', false, base, 0]])
  assert.deepEqual(b.calls[0].args, { task: 'Implement one', criteria: ['one works'], context: 'Shared context.', repo: f.repo, maxTurns: 50, maxRunMin: 30 })
  assert.equal(b.calls[1].args.context, 'Two context.')
  assert.deepEqual(b.calls[1].args.roles, { intake: 'sonnet' }, 'the pass runs on the task\'s intake role, and only that')
  assert.deepEqual(f.calls.map(c => c.id), ['one', 'two', 'acceptance'])
  assert.match(f.calls[0].args.task, /^# Groomed one\n[\s\S]*Groomed by dark-factory\n$/)
  assert.match(f.calls[1].args.task, /^# Groomed two/)
  assert.match(f.calls[2].args.task, /^Independently verify/, 'acceptance is never groomed')
  assert.equal(result.groom.revision, base)
  assert.match(result.report.markdown, new RegExp(`\nGrooming at ${base.slice(0, 12)}: groomed tickets for one, two\\.\n`))
  assert.equal(result.budget.turns, 1 + 1 + 3 + 3 + 2, 'each pass settles to its measured turns')
  const again = await f.invoke({ runBrief: () => { throw new Error('A groomed plan must not groom again') } })
  assert.equal(again.status, 'done')
})

test('questions from several tasks stop the plan before any task runs, in one batch', async t => {
  const f = fixture(t, groomed([task('one'), task('two', ['one']), task('three')]))
  const b = briefStub(f, { one: { questions: ['G1', 'G2'] }, two: { questions: ['G1'] } })
  const result = await f.invoke({ runBrief: b.runBrief })
  assert.equal(result.status, 'blocked')
  assert.equal(resultExitCode(result), 2)
  assert.deepEqual(b.calls.map(c => c.id), ['one', 'two', 'three'], 'every task is groomed before the stop')
  assert.equal(f.calls.length, 0)
  assert.deepEqual(result.questions.map(q => [q.task, q.id]), [['one', 'G1'], ['one', 'G2'], ['two', 'G1']])
  assert.deepEqual(result.questions[0], { task: 'one', ...groomQuestion('G1') })
  assert.match(result.stopReason, /^Grooming raised 3 questions for one, two; no task has run\./)
  const story = result.report.markdown
  assert.match(story, /\n- one \(Implement one\): waiting on answers to G1, G2\n/)
  assert.match(story, /\n- two \(Implement two\): waiting on answers to G1\n/)
  assert.match(story, /\n- three \(Implement three\): not started\n/)
  assert.match(story, /groomed tickets for three; questions for one, two\./)
  assert.match(story, /\n- one G2: Question G2\? A: A G2\. B: B G2\. Recommended: A G2\. Changes: What the user sees\.\n/)
  assert.match(story, /\n- two G1: Question G1\?/)
  assert.equal(story.split('\n').at(-1), 'Budget used: 3 of 200 turns, 0 of 120 minutes.')
  const idle = await f.invoke({ runBrief: () => { throw new Error('No answers: nothing to groom again') } })
  assert.deepEqual(idle.questions, result.questions)
  assert.deepEqual(idle.budget, result.budget)
})

test('keyed answers resume their brief runs; a partly answered task stays open; answers are immutable', async t => {
  const f = fixture(t, groomed([task('one'), task('two', ['one'])]))
  const b = briefStub(f, { one: { questions: ['G1', 'G2'] }, two: { questions: ['G1'] } })
  await f.invoke({ runBrief: b.runBrief })
  const partial = await f.invoke({ runBrief: b.runBrief }, { answers: { one: { decisions: { G1: ' Keep A. ' } }, two: { decisions: { G1: 'Take B.' } } } })
  assert.equal(partial.status, 'blocked')
  assert.deepEqual(b.calls.slice(2).map(c => [c.id, c.resume]), [['two', true]], 'only the fully answered task resumes')
  assert.deepEqual(b.calls[2].args, { clarifications: [{ id: 'G1', answer: 'Take B.' }], maxTurns: 51, maxRunMin: 30 }, 'the host run budget counts its earlier pass')
  assert.deepEqual(partial.questions.map(q => [q.task, q.id]), [['one', 'G2']])
  assert.equal(partial.groom.tasks.two.status, 'ready')
  assert.equal(f.calls.length, 0)
  assert.equal(partial.budget.turns, 3, 'a resumed pass is charged only its own turns')
  assert.match((await f.invoke({ runBrief: b.runBrief }, { answers: { one: { decisions: { G1: 'Changed.' } } } })).error, /one G1 was already given and cannot change/)
  assert.match((await f.invoke({ runBrief: b.runBrief }, { answers: { one: { decisions: { G9: 'Unknown.' } } } })).error, /no open grooming question G9/)
  assert.match((await f.invoke({ runBrief: b.runBrief }, { answers: { two: { decisions: { G2: 'Late.' } } } })).error, /two is not waiting on grooming answers/)
  assert.match((await f.invoke({ runBrief: b.runBrief }, { answers: { one: { decisions: {} } } })).error, /invalid grooming answers/)
  assert.match((await f.invoke({ runBrief: b.runBrief }, { answers: { one: 'A plain answer.' } })).error, /one is not parked/)
  assert.equal(b.calls.length, 3, 'refused answers start no pass')
  const done = await f.invoke({ runBrief: b.runBrief }, { answers: { one: { decisions: { G1: 'Keep A.', G2: 'Also A.' } }, two: { decisions: { G1: 'Take B.' } } } })
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.deepEqual(b.calls[3].args.clarifications, [{ id: 'G1', answer: 'Keep A.' }, { id: 'G2', answer: 'Also A.' }])
  assert.match(f.calls[0].args.task, /- G1: Question G1\? → Keep A\.\n- G2: Question G2\? → Also A\./)
  assert.match(f.calls[1].args.task, /- G1: Question G1\? → Take B\./)
  assert.equal(done.questions, undefined)
  assert.deepEqual(f.state().groom.tasks.one.answers, { G1: 'Keep A.', G2: 'Also A.' })
  assert.equal(done.budget.turns, 4 + 3 + 3 + 2)
})

test('split, not-actionable and failed passes leave their tasks as written, noted in the report', async t => {
  const f = fixture(t, groomed([task('one'), task('two'), task('three')]))
  const b = briefStub(f, { one: { verdict: 'needs-split' }, two: { verdict: 'not-actionable' }, three: { verdict: 'failed' } })
  const result = await f.invoke({ runBrief: b.runBrief })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.args.task), ['Implement one', 'Implement two', 'Implement three'])
  assert.deepEqual(['one', 'two', 'three'].map(id => [result.groom.tasks[id].status, result.groom.tasks[id].verdict]),
    [['skipped', 'needs-split'], ['skipped', 'not-actionable'], ['skipped', 'failed']])
  assert.match(result.report.markdown, /\n- one: Grooming: it bundles 2 pieces of work \(Part A; Part B\)\. one runs as written; its own goal stage judges it\.\n/)
  assert.match(result.report.markdown, /\n- two: Grooming: no deliverable outcome was found: It names no outcome\./)
  assert.match(result.report.markdown, /\n- three: Grooming: the pass did not finish: Brief CLI failed\./)
})

test('groom: false skips the pass', async t => {
  const f = fixture(t, plan([task('one')]))
  const result = await f.invoke({ runBrief: () => { throw new Error('groom: false must not groom') } })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.deepEqual(result.groom, { enabled: false, reason: 'The plan sets groom: false.' })
  assert.equal(f.calls[0].args.task, 'Implement one')
  assert.doesNotMatch(result.report.markdown, /Grooming/)
})

test('a plan run whose state predates grooming skips the pass', async t => {
  const f = fixture(t, groomed([task('one')]))
  await f.invoke({ runBrief: briefStub(f).runBrief, at: name => { if (name === 'after-reserve') throw new Error('crash') } })
  // An older engine's journal: an attempt was interrupted, and nothing records grooming.
  const old = f.state(); delete old.groom
  writeFileSync(join(f.stateDir, 'state.json'), JSON.stringify(old, null, 2))
  assert.equal((await f.invoke({ runBrief: () => { throw new Error('A predating plan run must not groom') } })).tasks.one.status, 'parked')
  const result = await f.invoke({ runBrief: () => { throw new Error('A predating plan run must not groom') } }, { answers: { one: 'Retry.' } })
  assert.equal(result.status, 'done', JSON.stringify(result))
  assert.equal(result.groom.reason, 'The plan run predates the grooming pass.')
  assert.equal(f.calls[0].args.task, 'Implement one')
})

test('an interrupted pass keeps its charge, reruns once, then the task runs as written', async t => {
  const p = groomed([task('one'), task('two')]); p.limits = { maxTurns: 100, taskMaxTurns: 5 }
  const f = fixture(t, p), b = briefStub(f)
  const crash = { at: name => { if (name === 'after-groom-reserve') throw new Error('crash') } }
  const first = await f.invoke({ runBrief: b.runBrief, ...crash })
  assert.equal(first.status, 'blocked')
  assert.deepEqual([f.state().active.task, f.state().active.groom, f.state().turns], ['one', true, 5])
  const second = await f.invoke({ runBrief: b.runBrief, ...crash })
  assert.equal(second.status, 'blocked')
  assert.deepEqual([f.state().groom.tasks.one.interrupted, f.state().groom.tasks.one.passes, f.state().turns], [1, 2, 10], 'the rerun reserves anew; the lost one stays charged')
  assert.equal(b.calls.length, 0)
  const third = await f.invoke({ runBrief: b.runBrief })
  assert.equal(third.status, 'done', JSON.stringify(third))
  assert.deepEqual(b.calls.map(c => c.id), ['two'], 'two interruptions skip the pass')
  assert.match(third.groom.tasks.one.note, /interrupted 2 times; one runs as written/)
  assert.deepEqual(f.calls.map(c => c.args.task.split('\n')[0]), ['Implement one', '# Groomed two', 'Independently verify that the complete run-plan is implemented on the current repository revision. Inspect the code and evidence for every criterion. Report defects and unmet requirements; do not implement changes. Criteria describe the implemented repository: mark affected criteria unmet when defects remain. A complete investigation that finds defects is not successful acceptance.'])
  assert.equal(third.budget.turns, 10 + 1 + 3 + 3 + 2)
})

test('an interrupted pass after its result reruns; a resumed pass interrupted resumes its host run again', async t => {
  // Interruptions count across a task's fresh and resumed passes, up to maxAttempts.
  const p = groomed([task('one')]); p.limits = { maxAttempts: 3 }
  const f = fixture(t, p), b = briefStub(f, { one: { questions: ['G1'] } })
  await f.invoke({ runBrief: b.runBrief, at: name => { if (name === 'after-groom-result') throw new Error('crash') } })
  assert.equal(f.state().groom.tasks.one.status, 'pending', 'an unrecorded outcome is not trusted')
  const asked = await f.invoke({ runBrief: b.runBrief })
  assert.deepEqual(asked.questions.map(q => q.id), ['G1'])
  assert.equal(asked.budget.turns, 50 + 1, 'the lost pass keeps its reservation; the rerun is charged its own turns')
  await f.invoke({ runBrief: b.runBrief, at: name => { if (name === 'after-groom-reserve') throw new Error('crash') } }, { answers: { one: { decisions: { G1: 'Yes.' } } } })
  const done = await f.invoke({ runBrief: b.runBrief })
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.deepEqual(b.calls.map(c => c.resume), [false, false, true])
  assert.equal(done.groom.tasks.one.interrupted, 2)
  assert.equal(b.calls[2].args.maxTurns, 1 + 50, 'the resumed host run is capped at what it spent plus this reservation')
  assert.match(f.calls[0].args.task, /G1: Question G1\? → Yes\./)
})
