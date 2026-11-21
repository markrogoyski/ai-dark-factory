// tools/bench.mjs against throwaway repositories and the stub provider CLIs: no PHP, network or models.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLeakProof, benchPaths, grade, leakProblems, leakProofClone, manifestDigest, manifestProblems, mergeOutcome, prepare, resultFiles, run, runPlan, validate } from '../tools/bench.mjs'
import { evaluateFiles, summarize } from '../plugins/dark-factory/lib/evaluate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Every process this file starts, however it gets there, finds the stub provider CLIs first and
// unauthenticated homes, so no path through the tool reaches a real model.
const stubs = realpathSync(mkdtempSync(join(tmpdir(), 'bench-stubs-')))
for (const cli of ['codex', 'claude']) writeFileSync(join(stubs, cli), readFileSync(join(root, 'test/fixtures/codex-cli.cjs')), { mode: 0o755 })
writeFileSync(join(stubs, 'agy'), '#!/bin/sh\necho "agy stub: no models in tests" >&2\nexit 1\n', { mode: 0o755 })
Object.assign(process.env, { PATH: `${stubs}:${process.env.PATH}`, CODEX_HOME: join(stubs, 'codex-home'), CLAUDE_CONFIG_DIR: join(stubs, 'claude-home'), DARK_FACTORY_KEEP_AWAKE: '0' })
process.on('exit', () => rmSync(stubs, { recursive: true, force: true }))

function temporary(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD') }
const HIDDEN = "require('node:assert/strict').equal(require('../sum.cjs')(2, 3), 5)\n"

// base: sum subtracts. fix: it adds, with tests/hidden.cjs. Then a later commit, a tag and a side
// branch from the fix, none of which a prepared clone may hold.
function sourceRepo(dir) {
  const repo = join(dir, 'source')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 'Bench test'); git(repo, 'config', 'user.email', 'bench@example.invalid')
  write(join(repo, 'sum.cjs'), 'module.exports = (a, b) => a - b\n')
  write(join(repo, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2, 0), 2)\n")
  write(join(repo, 'tests/preserved.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2, 0), 2)\n")
  write(join(repo, '.gitignore'), 'deps/\n.council/\n')
  const base = commit(repo, 'Add sum')
  write(join(repo, 'sum.cjs'), 'module.exports = (a, b) => a + b\n')
  write(join(repo, 'tests/hidden.cjs'), HIDDEN)
  const fix = commit(repo, 'Fix sum to add')
  write(join(repo, 'README'), 'later\n')
  const later = commit(repo, 'Later work')
  git(repo, 'tag', 'v1')
  git(repo, 'checkout', '-qb', 'side', fix)
  write(join(repo, 'side.txt'), 'side\n')
  const side = commit(repo, 'Side work')
  git(repo, 'checkout', '-q', 'main')
  write(join(repo, 'deps/lib.cjs'), 'module.exports = 1\n')
  return { repo, base, fix, later, side }
}

function manifest(source, extra = {}) {
  return { id: 'sum-adds', repo: source.repo, fixCommit: source.fix,
    task: 'sum(2, 3) returns -1. It should return the sum of its operands.', hiddenTests: ['tests/hidden.cjs'],
    grade: 'node tests/hidden.cjs', args: { workflow: 'pair' }, tags: { kind: 'bug', size: 'small' }, ...extra }
}

function bench(dir, manifests, variants = { default: { description: 'The task as written.', args: {} } }) {
  const paths = benchPaths({ bench: join(dir, 'bench'), root: join(dir, 'root') })
  for (const m of manifests) write(join(paths.tasks, `${m.id}.json`), JSON.stringify(m, null, 2))
  write(paths.variants, JSON.stringify(variants))
  return paths
}

test('manifest validation names each problem and keeps the task from naming the hidden test or the fix', () => {
  const good = { id: 'rate-zero', repo: '~/src/lib', fixCommit: 'a'.repeat(40), task: 'rate(10, -100, 1000) throws instead of returning 0.',
    hiddenTests: ['tests/Finance/FinanceTest.php'], grade: 'vendor/bin/phpunit tests/Finance/FinanceTest.php',
    dependencies: { install: 'composer install', paths: ['vendor'] }, args: { workflow: 'factory', tier: 'fix' }, tags: { kind: 'bug', size: 'small' } }
  assert.deepEqual(manifestProblems(good, '/bench/tasks/rate-zero.json'), [])
  const problems = change => manifestProblems({ ...good, ...change })
  assert.match(problems({ id: 'Rate Zero' }).join(), /id must be/)
  assert.deepEqual(manifestProblems(good, '/bench/tasks/other.json'), ['id rate-zero does not match the file name other.json'])
  assert.match(problems({ fixCommit: 'abc1234' }).join(), /full 40-character/)
  assert.match(problems({ base: 'HEAD~1' }).join(), /base, when given/)
  assert.match(problems({ hiddenTests: [] }).join(), /at least one/)
  for (const path of ['/etc/passwd', '../x/Test.php', 'tests/../x.php', './tests/x.php', 'tests\\x.php']) assert.match(problems({ hiddenTests: [path] }).join(), /normalized repository-relative/, path)
  assert.match(problems({ hiddenTests: ['a.php', 'a.php'] }).join(), /twice/)
  assert.deepEqual(problems({ task: 'Make FinanceTest pass: rate(10, -100, 1000) throws.' }), ['task names the hidden test tests/Finance/FinanceTest.php'])
  assert.deepEqual(problems({ task: 'Revert aaaaaaa and fix rate(10, -100, 1000).' }), ['task names the fix commit'])
  assert.match(problems({ task: 'Fix it' }).join(), /the way a user would report it/)
  assert.match(problems({ grade: '' }).join(), /grade must be/)
  assert.match(problems({ gradeTimeoutSec: 0 }).join(), /gradeTimeoutSec/)
  assert.match(problems({ dependencies: { paths: [] } }).join(), /dependencies.paths/)
  assert.match(problems({ dependencies: { paths: ['vendor'], copy: true } }).join(), /unknown dependencies field copy/)
  assert.match(problems({ args: { workflow: 'run-plan' } }).join(), /args.workflow must be/)
  assert.match(problems({ args: { workflow: 'pair', task: 'x' } }).join(), /args.task is set by the harness/)
  assert.match(problems({ args: { workflow: 'pair', evaluation: {} } }).join(), /args.evaluation is set by the harness/)
  assert.match(problems({ args: { workflow: 'factory', tier: 'huge' } }).join(), /args.tier/)
  assert.match(problems({ tags: { kind: 'bug' } }).join(), /tags must have/)
  assert.match(problems({ extra: 1 }).join(), /unknown field extra/)
  assert.notEqual(manifestDigest(good), manifestDigest({ ...good, grade: 'vendor/bin/phpunit' }))
  assert.equal(manifestDigest(good), manifestDigest({ ...good, task: 'Reworded report of the same failure.' }))
  assert.throws(() => benchPaths({ root: join(root, 'bench-root') }), /inside this checkout/)
})

test('prepare makes a clone that holds base and its history only, and refuses one that holds more', t => {
  const dir = temporary(t), source = sourceRepo(dir)
  const paths = bench(dir, [manifest(source, { dependencies: { paths: ['deps'] } })])
  const record = prepare(paths, 'sum-adds')
  assert.equal(record.base, source.base)
  assert.equal(record.dependencies.method, 'copy')
  assert.match(record.dependencies.caveat, /not installed at base/)
  const clone = record.clone
  assert.ok(!clone.startsWith(root))
  assert.equal(git(clone, 'rev-parse', 'HEAD'), source.base)
  assert.throws(() => git(clone, 'cat-file', '-e', source.fix))
  assert.equal(git(clone, 'log', '--all', '--format=%H'), source.base)
  assert.equal(git(clone, 'remote'), '')
  assert.equal(git(clone, 'tag'), '')
  assert.equal(git(clone, 'status', '--porcelain'), '')
  assert.equal(readFileSync(join(clone, 'deps/lib.cjs'), 'utf8'), 'module.exports = 1\n')
  assert.equal(prepare(paths, 'sum-adds').reused, true)

  // An ordinary clone, or one fetched with more than base, is caught.
  const facts = { source: source.repo, base: source.base, fixCommit: source.fix, blobs: [{ path: 'tests/hidden.cjs', blob: git(source.repo, 'rev-parse', `${source.fix}:tests/hidden.cjs`) }] }
  const plain = join(dir, 'plain')
  execFileSync('git', ['clone', '-q', source.repo, plain])
  git(plain, 'checkout', '-q', source.base)
  const found = leakProblems(plain, facts).join('\n')
  assert.match(found, new RegExp(`the fix commit ${source.fix} is present`))
  assert.match(found, /remotes: origin/)
  assert.match(found, /commit\(s\) outside base's history are present/)
  assert.match(found, /fixed bytes of hidden test tests\/hidden.cjs/)
  assert.throws(() => assertLeakProof(plain, facts), /is not leak-proof/)
  const stray = join(dir, 'stray')
  leakProofClone(source.repo, source.base, stray)
  git(stray, '-c', 'protocol.version=2', 'fetch', '-q', '--no-write-fetch-head', source.repo, source.side)
  assert.match(leakProblems(stray, facts).join(), /fix commit .* is present/)

  // An install command that works is preferred to copying.
  const installing = bench(join(dir, 'b2'), [manifest(source, { dependencies: { install: 'mkdir -p deps && echo installed > deps/lib.cjs', paths: ['deps'] } })])
  const installed = prepare(installing, 'sum-adds')
  assert.equal(installed.dependencies.method, 'install')
  assert.equal(readFileSync(join(installed.clone, 'deps/lib.cjs'), 'utf8'), 'installed\n')
  // A dependency directory that isn't ignored would end up in every snapshot.
  const tracked = bench(join(dir, 'b3'), [manifest(source, { dependencies: { install: 'mkdir -p lib && echo x > lib/x', paths: ['lib'] } })])
  assert.throws(() => prepare(tracked, 'sum-adds'), /missing from|not ignored/)
})

test('validate requires the hidden tests to come from the fix, fail at base and pass at the fix', t => {
  const dir = temporary(t), source = sourceRepo(dir)
  const paths = bench(dir, [manifest(source),
    { ...manifest(source), id: 'not-from-fix', hiddenTests: ['tests/preserved.cjs'], grade: 'node tests/preserved.cjs' },
    { ...manifest(source), id: 'passes-at-base', grade: 'node check.cjs' },
    { ...manifest(source), id: 'fails-at-fix', grade: 'node tests/hidden.cjs && false' }])
  const good = validate(paths, 'sum-adds')
  assert.equal(good.valid, true, JSON.stringify(good.problems))
  assert.notEqual(good.atBase.exitCode, 0)
  assert.equal(good.atFix.exitCode, 0)
  assert.match(good.atBase.tail, /actual: -1/)
  assert.equal(good.manifestDigest, manifestDigest(manifest(source)))
  assert.deepEqual(JSON.parse(readFileSync(join(paths.validations, 'sum-adds.json'), 'utf8')).valid, true)
  assert.deepEqual(validate(paths, 'not-from-fix').problems, ['hidden test tests/preserved.cjs is not added or modified by the fix commit'])
  assert.deepEqual(validate(paths, 'passes-at-base').problems, ['the hidden tests pass at base, so they do not detect the problem'])
  assert.deepEqual(validate(paths, 'fails-at-fix').problems, ['the hidden tests fail at the fix commit'])
  assert.equal(git(source.repo, 'status', '--porcelain'), '', 'the source repository is untouched')
  assert.equal(git(source.repo, 'rev-parse', 'HEAD'), source.later)
  // run refuses a task that has not validated, and without --yes only says what it would launch.
  assert.throws(() => runPlan(paths, 'passes-at-base', { variant: 'default', rep: 1 }), /has not validated/)
  assert.throws(() => runPlan(paths, 'sum-adds', { variant: 'missing', rep: 1 }), /Unknown variant missing/)
  assert.throws(() => runPlan(paths, 'sum-adds', { variant: 'default', rep: 0 }), /positive integer/)
})

// A run's snapshot ref in its own clone, as the helper's measure records it.
function snapshot(clone, runId, label, files) {
  git(clone, 'checkout', '-q', '--detach')
  for (const [path, text] of Object.entries(files)) write(join(clone, path), text)
  const sha = commit(clone, `council ${runId} A ${label}`)
  const ref = `refs/council/${runId}/A-${label}`
  git(clone, 'update-ref', ref, sha)
  git(clone, 'checkout', '-q', 'main')
  return { ref, tree: git(clone, 'rev-parse', `${sha}^{tree}`) }
}

function fakeResult(dir, clone, name, { readiness, snap, rep }) {
  const hostRunDir = join(clone, '.council', `host-${name}`)
  write(join(hostRunDir, 'args.json'), JSON.stringify({ repo: clone, evaluation: { taskId: 'sum-adds', variant: 'default', repetition: rep } }))
  const result = { status: 'done', hostRunDir, runDir: join(clone, '.council', name),
    final: { readiness: { state: readiness }, ...(snap ? { snapshotRef: snap.ref, snapshotTree: snap.tree } : {}) },
    metrics: { version: 1, host: 'codex', workflow: 'pair', strategy: 'pair', taskId: 'sum-adds', variant: 'default', repetition: rep, readiness, turns: 4 } }
  const file = join(dir, `${name}.json`)
  write(file, JSON.stringify(result))
  return file
}

test('grade checks every snapshot, ready or not, against the hidden tests and keeps other outcomes', t => {
  const dir = temporary(t), source = sourceRepo(dir), paths = bench(dir, [manifest(source)])
  const prepared = prepare(paths, 'sum-adds')
  const clone = join(dir, 'run-clone')
  leakProofClone(prepared.clone, prepared.base, clone)
  const right = snapshot(clone, 'r1', 'final', { 'sum.cjs': 'module.exports = (a, b) => b + a\n' })
  // The solver's own copy of the hidden test passes; the graded copy is the fix's.
  const wrong = snapshot(clone, 'r2', 'final', { 'sum.cjs': 'module.exports = (a, b) => a * b + 0\n', 'tests/hidden.cjs': 'process.exit(0)\n' })
  const falseBlock = fakeResult(dir, clone, 'false-block', { readiness: 'blocked', snap: right, rep: 1 })
  const escaped = fakeResult(dir, clone, 'escaped', { readiness: 'ready', snap: wrong, rep: 2 })
  const noSnapshot = fakeResult(dir, clone, 'no-snapshot', { readiness: 'incomplete', snap: null, rep: 3 })
  const stale = fakeResult(dir, clone, 'stale', { readiness: 'ready', snap: { ref: right.ref, tree: wrong.tree }, rep: 4 })
  const outcomesFile = join(dir, 'outcomes.json')
  const delivered = JSON.parse(readFileSync(escaped, 'utf8')).hostRunDir
  write(outcomesFile, JSON.stringify({ [delivered]: { status: 'regression', evidence: 'integration.log:3' } }))

  const out = grade(paths, [falseBlock, escaped, noSnapshot, stale], { outcomes: outcomesFile })
  assert.deepEqual(out.graded.map(g => [g.status, g.readiness]), [['passed', 'blocked'], ['failed', 'ready'], ['ungraded', 'incomplete'], ['ungraded', 'ready']])
  assert.equal(out.graded[2].reason, 'the result has no reviewed snapshot')
  assert.match(out.graded[3].reason, /no longer has the tree/)
  const outcomes = JSON.parse(readFileSync(outcomesFile, 'utf8'))
  assert.equal(outcomes[delivered].length, 2, 'the post-delivery observation stays beside the grade')
  assert.equal(outcomes[delivered][0].status, 'regression')
  const passed = outcomes[JSON.parse(readFileSync(falseBlock, 'utf8')).hostRunDir]
  assert.equal(passed.kind, 'hidden-tests')
  assert.ok(existsSync(passed.evidence))
  assert.equal(passed.commit, git(clone, 'rev-parse', right.ref))
  assert.match(readFileSync(outcomes[delivered][1].evidence, 'utf8'), /AssertionError/)
  // Grading wrote nothing into the clone: no worktree, index or file changes.
  assert.equal(git(clone, 'status', '--porcelain', '--ignored'), '!! .council/')
  assert.equal(git(clone, 'worktree', 'list').split('\n').length, 1)

  // Regrading replaces the earlier grade.
  grade(paths, [falseBlock], { outcomes: outcomesFile })
  assert.notEqual(JSON.parse(readFileSync(outcomesFile, 'utf8'))[JSON.parse(readFileSync(falseBlock, 'utf8')).hostRunDir].gradedAt, passed.gradedAt)

  const group = Object.values(evaluateFiles([falseBlock, escaped, noSnapshot, stale], JSON.parse(readFileSync(outcomesFile, 'utf8'))).groups)[0]
  assert.deepEqual(group.hiddenTests, { graded: 2, ungraded: 2, readyPassed: 0, readyFailed: 1, notReadyPassed: 1, notReadyFailed: 0,
    unknown: 0, escapedDefects: 1, falseBlocks: 1, passRate: 0.5, escapedDefectRate: 1, falseBlockRate: 1 })
  assert.equal(group.postDeliveryRegressions, 1)
})

test('mergeOutcome keeps one outcome of each kind per run', () => {
  const outcomes = { a: { status: 'passed', evidence: 'x' } }
  mergeOutcome(outcomes, 'a', { kind: 'hidden-tests', status: 'failed', evidence: 'y' })
  mergeOutcome(outcomes, 'a', { kind: 'hidden-tests', status: 'passed', evidence: 'z' })
  assert.deepEqual(outcomes.a, [{ status: 'passed', evidence: 'x' }, { kind: 'hidden-tests', status: 'passed', evidence: 'z' }])
  mergeOutcome(outcomes, 'b', { kind: 'hidden-tests', status: 'ungraded', evidence: 'r.json' })
  assert.equal(outcomes.b.status, 'ungraded')
})

test('the evaluator reports readiness against hidden-test outcomes as a 2x2 and keeps the old outcome format', () => {
  const metrics = { version: 1, host: 'codex', workflow: 'pair', strategy: 'pair', taskId: 'sum', turns: 2 }
  const row = (id, readiness, observation) => ({ source: id, result: { hostRunDir: id, metrics: { ...metrics, readiness } }, observation })
  const hidden = (status, extra) => ({ kind: 'hidden-tests', status, evidence: 'grade.log', ...extra })
  const out = summarize([
    row('1', 'ready', hidden('passed')), row('2', 'ready', hidden('passed')), row('3', 'ready', [{ status: 'regression', evidence: 'log' }, hidden('failed')]),
    row('4', 'blocked', hidden('passed')), row('5', 'incomplete', hidden('failed')), row('6', 'blocked', hidden('ungraded')),
    row('7', 'ready', { status: 'passed', evidence: 'acceptance.log' }), row('8', 'ready')])
  const group = Object.values(out.groups)[0]
  assert.deepEqual(group.hiddenTests, { graded: 5, ungraded: 1, readyPassed: 2, readyFailed: 1, notReadyPassed: 1, notReadyFailed: 1,
    unknown: 2, escapedDefects: 1, falseBlocks: 1, passRate: 0.6, escapedDefectRate: 1 / 3, falseBlockRate: 0.5 })
  assert.equal(group.postDeliveryObserved, 2)
  assert.equal(group.postDeliveryRegressions, 1)
  assert.deepEqual(out.matchedTasks['sum@revision-unknown'][Object.keys(out.groups)[0]], { runs: 8, ready: 5, turns: 16, hiddenGraded: 5, hiddenPassed: 3 })
  const empty = Object.values(summarize([row('1', 'ready')]).groups)[0].hiddenTests
  assert.deepEqual([empty.graded, empty.unknown, empty.passRate, empty.escapedDefectRate, empty.falseBlockRate], [0, 1, null, null, null])
  assert.throws(() => summarize([row('1', 'ready', hidden('regression'))]), /Invalid hidden-test outcome for 1/)
  assert.throws(() => summarize([row('1', 'ready', hidden('passed', { evidence: ' ' }))]), /Invalid hidden-test outcome/)
  assert.throws(() => summarize([row('1', 'ready', { status: 'failed', evidence: 'x' })]), /Invalid post-delivery observation for 1/)
  assert.throws(() => summarize([row('1', 'ready', [hidden('passed'), hidden('failed')])]), /More than one hidden-test outcome/)
  assert.throws(() => summarize([row('1', 'ready', { kind: 'later', status: 'passed', evidence: 'x' })]), /Unknown outcome kind/)
})

test('run launches the standalone runner on a fresh leak-proof clone, and grade and evaluate read its result', async t => {
  const dir = temporary(t), source = sourceRepo(dir)
  const paths = bench(dir, [manifest(source, { args: { workflow: 'pair', author: 'sol' } })])
  assert.equal(validate(paths, 'sum-adds').valid, true)
  const dry = await run(paths, 'sum-adds', { variant: 'default', rep: 1 })
  assert.equal(dry.status, 'dry-run')
  assert.match(dry.warning, /live models/)
  assert.deepEqual(dry.args.evaluation, { taskId: 'sum-adds', variant: 'default', repetition: 1 })
  assert.equal(dry.args.task, manifest(source).task)
  assert.ok(!existsSync(dry.clone), 'a dry run creates nothing')
  const { clone } = runPlan(paths, 'sum-adds', { variant: 'default', rep: 1 })
  const extraEnv = { FACTORY_TEST_REPO: clone, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: join(dir, 'calls.jsonl'), COUNCIL_JOB_POLL: '0.01' }
  // validate prepared the task; without that clone, run refuses before launching anything.
  rmSync(join(paths.prepared, 'sum-adds'), { recursive: true, force: true })
  await assert.rejects(run(paths, 'sum-adds', { variant: 'default', rep: 1, yes: true, extraEnv }), /not prepared/)
  assert.ok(!existsSync(join(dir, 'calls.jsonl')))
  prepare(paths, 'sum-adds')
  const record = await run(paths, 'sum-adds', { variant: 'default', rep: 1, yes: true, extraEnv, progress: () => {} })
  assert.ok(readFileSync(join(dir, 'calls.jsonl'), 'utf8').includes('"kind":"pair-review"'), 'the stub CLIs served every turn')
  assert.equal(record.status, 'done', JSON.stringify(record))
  assert.equal(record.readiness, 'ready')
  assert.equal(record.exitCode, 0)
  assert.equal(record.clone, clone)
  assert.ok(record.resultFile.startsWith(join(clone, '.council')))
  assert.equal(JSON.parse(readFileSync(record.resultFile, 'utf8')).metrics.taskId, 'sum-adds')
  assert.ok(readFileSync(record.runnerLog, 'utf8').includes('run.started'))
  assert.equal(JSON.parse(readFileSync(join(paths.records, 'runs/sum-adds/default/rep-1.json'), 'utf8')).hostRunDir, record.hostRunDir)
  await assert.rejects(run(paths, 'sum-adds', { variant: 'default', rep: 1, yes: true, extraEnv }), /already exists/)

  assert.deepEqual(resultFiles(paths), [record.resultFile])
  assert.deepEqual(resultFiles(paths, ['other-task']), [])
  // A run record stands in for its result.
  const graded = grade(paths, [join(paths.records, 'runs/sum-adds/default/rep-1.json')])
  assert.deepEqual(graded.graded.map(g => [g.status, g.readiness, g.variant, g.repetition, g.result]), [['passed', 'ready', 'default', 1, record.resultFile]])
  const outcomes = JSON.parse(readFileSync(graded.outcomes, 'utf8'))
  const group = Object.values(evaluateFiles([record.resultFile], outcomes).groups)[0]
  assert.equal(group.hiddenTests.readyPassed, 1)
  assert.equal(group.hiddenTests.escapedDefects, 0)
})
