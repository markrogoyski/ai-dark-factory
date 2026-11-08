// Real Git and helper delivery, deterministic model substitutes. No provider/account calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPlan } from '../plugins/dark-factory/lib/run-plan-runner.mjs'
import { parseCLI, resultExitCode } from '../plugins/dark-factory/lib/codex-runner.mjs'
import { build } from '../tools/build.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(root, 'plugins/dark-factory/bin/dark-factory')
const ready = { state: 'ready', blocked: [], incomplete: [] }
const policy = new Function(readFileSync(join(root, 'src/lib/run-plan.js'), 'utf8') + '\nreturn {runPlanDefinition,runPlanNext,runPlanBrief,runPlanAnswer}')()
const task = (id, after = []) => ({ id, task: `Implement ${id}`, criteria: [`${id} works`], after })
const plan = tasks => ({ version: 1, id: 'test', tasks, decisions: ['Preserve public behavior.'], acceptance: { verify: 'true', criteria: ['The complete plan works together.'] } })
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
    if (item.id === 'acceptance') return { status: 'done', mode: 'investigate', final: { readiness: ready }, metrics: { turns: 2 } }
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
  return { temp, repo, git, file, stateDir, calls, runTask, invoke, options, state: () => read(join(stateDir, 'state.json')) }
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
  await f.invoke(deps, { answers: { one: 'Retry if budget allows.' } })
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
  rmSync(lock)
  assert.equal((await f.invoke()).final.readiness.state, 'ready')
  writeFileSync(reference, 'Changed contract')
  assert.match((await f.invoke()).error, /references.*changed/)
})

test('failed delivery is retained and never committed', async t => {
  const f = fixture(t)
  const result = await f.invoke({ verifyDelivery: async (S,d) => {
    writeFileSync(join(d.runDir, 'delivery.json'), JSON.stringify({ status: 'incomplete' })); return { status: 'done' }
  } })
  assert.match(result.error, /Delivery verification did not pass/)
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '1')
  assert.equal(f.calls.length, 1)
  assert.ok(existsSync(join(f.repo, 'one.txt')))
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

test('CLI routes run-plan inputs without a task and rejects checkpoint resume', () => {
  assert.equal(parseCLI(['--workflow', 'run-plan', '--plan-file', '/repo/plan.json']).args.planFile, '/repo/plan.json')
  assert.throws(() => parseCLI(['--workflow', 'run-plan', '--resume', '/repo/run']), /repeat it to resume/)
})

test('packaged CLI runs a Pair task through stub model CLIs and real delivery', async t => {
  const p = plan([{ ...task('sum'), workflow: 'pair', args: { author: 'sol', reviewer: 'astra', verify: 'node check.cjs' } }])
  p.limits = { maxTurns: 5, taskMaxTurns: 5 }
  const f = fixture(t, p), bin = join(f.temp, 'bin')
  mkdirSync(bin)
  for (const name of ['codex', 'claude']) {
    cpSync(join(root, 'test/fixtures/codex-cli.cjs'), join(bin, name)); chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(f.repo, 'sum.cjs'), 'module.exports = (a,b) => a-b\n')
  writeFileSync(join(f.repo, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)\n")
  f.git('add', '.'); f.git('commit', '-qm', 'Add failing sum')
  const result = spawnSync(process.execPath, [join(root, 'plugins/dark-factory/bin/dark-factory-codex'), '--workflow', 'run-plan', '--cwd', f.repo, '--plan-file', f.file], {
    encoding: 'utf8', timeout: 90000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(f.temp, 'codex-config'), CLAUDE_CONFIG_DIR: join(f.temp, 'claude-config'), FACTORY_TEST_REPO: f.repo,
      FACTORY_TEST_RUN_PATH: join(f.temp, 'run-path'), FACTORY_TEST_LOG: join(f.temp, 'turns.jsonl'), COUNCIL_JOB_POLL: '0.01', COUNCIL_TRANSCRIPT_WAIT: '0' },
  })
  const output = JSON.parse(result.stdout)
  assert.equal(output.tasks?.sum.status, 'done', result.stdout + result.stderr)
  assert.equal(result.status, 2, 'Final acceptance remains pending at the hard turn limit')
  assert.equal(output.budget.turns, 5)
  assert.equal(f.git('status', '--porcelain'), '')
})
