// tools/bench.mjs against throwaway repositories and the stub provider CLIs: no PHP, network or models.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLeakProof, benchPaths, grade, leakProblems, leakProofClone, manifestDigest, manifestProblems, mergeOutcome, prepare, resultFiles, run, runPlan, scan, validate, variantSummary, variantTable } from '../tools/bench.mjs'
import { contaminationNeedles, findHits } from '../tools/bench-scan.mjs'
import { launchRequirements } from '../plugins/dark-factory/lib/policy.mjs'
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
// A matched-task cell's cost fields when its runs recorded no tokens and no time.
const NO_COST = { tokenRuns: 0, tokenPartialRuns: 0, input: 0, cachedInput: 0, output: 0, timedRuns: 0, elapsedMs: 0 }

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

test('grade checks every snapshot, ready or not, against the hidden tests and keeps other outcomes', async t => {
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

  const out = await grade(paths, [falseBlock, escaped, noSnapshot, stale], { outcomes: outcomesFile })
  assert.deepEqual(out.graded.map(g => [g.status, g.readiness]), [['passed', 'blocked'], ['failed', 'ready'], ['ungraded', 'incomplete'], ['ungraded', 'ready']])
  assert.equal(out.graded[2].reason, 'the result has no reviewed snapshot')
  assert.match(out.graded[3].reason, /no longer has the tree/)
  // These results have no host events or transcripts, so their scans can't claim clean.
  assert.deepEqual(out.graded.map(g => g.scan), ['partial', 'partial', 'partial', 'partial'])
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
  await grade(paths, [falseBlock], { outcomes: outcomesFile })
  assert.notEqual(JSON.parse(readFileSync(outcomesFile, 'utf8'))[JSON.parse(readFileSync(falseBlock, 'utf8')).hostRunDir].gradedAt, passed.gradedAt)

  const group = Object.values(evaluateFiles([falseBlock, escaped, noSnapshot, stale], JSON.parse(readFileSync(outcomesFile, 'utf8'))).groups)[0]
  assert.deepEqual(group.hiddenTests, { graded: 2, ungraded: 2, readyPassed: 0, readyFailed: 1, notReadyPassed: 1, notReadyFailed: 0,
    contaminated: 0, scanPartial: 2, unscanned: 0, unknown: 0, escapedDefects: 1, falseBlocks: 1, passRate: 0.5, escapedDefectRate: 1, falseBlockRate: 1 })
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
    contaminated: 0, scanPartial: 0, unscanned: 5, unknown: 2, escapedDefects: 1, falseBlocks: 1, passRate: 0.6, escapedDefectRate: 1 / 3, falseBlockRate: 0.5 })
  assert.equal(group.postDeliveryObserved, 2)
  assert.equal(group.postDeliveryRegressions, 1)
  assert.deepEqual(out.matchedTasks['sum@revision-unknown'][Object.keys(out.groups)[0]], { runs: 8, ready: 5, turns: 16, hiddenGraded: 5, hiddenPassed: 3, hiddenContaminated: 0, ...NO_COST })
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
  const graded = await grade(paths, [join(paths.records, 'runs/sum-adds/default/rep-1.json')])
  assert.deepEqual(graded.graded.map(g => [g.status, g.readiness, g.variant, g.repetition, g.result]), [['passed', 'ready', 'default', 1, record.resultFile]])
  // These stub CLIs keep no transcripts, so the scan is partial and says which are missing.
  assert.equal(graded.graded[0].scan, 'partial')
  const outcomes = JSON.parse(readFileSync(graded.outcomes, 'utf8'))
  const group = Object.values(evaluateFiles([record.resultFile], outcomes).groups)[0]
  assert.equal(group.hiddenTests.readyPassed, 1)
  assert.equal(group.hiddenTests.escapedDefects, 0)
  // Per variant: pass rate beside what a run cost (the stub CLIs report 10 tokens in and out a turn).
  const [row] = variantSummary(paths)
  assert.deepEqual([row.variant, row.runs, row.ready, row.hiddenPassed, row.hiddenGraded, row.tokenRuns, row.tokenPartialRuns], ['default', 1, 1, 1, 1, 1, 0])
  assert.ok(row.input.median > 0 && row.output.median > 0 && row.minutes.n === 1, JSON.stringify(row))
  const table = variantTable([row]).split('\n')
  assert.match(table[0], /^variant +runs +ready +hidden pass +tokens in, median \(range\) +cached in +out +partial +minutes$/)
  assert.match(table[1], /^default +1 +1 +1\/1 +\d+ \(\d+-\d+\) +\d+ \(\d+-\d+\) +\d+ \(\d+-\d+\) +0\/1 +\d+ \(\d+-\d+\)$/)
})

test('the evaluator leaves contaminated runs out of the hidden-test 2x2 and validates the scan fields', () => {
  const metrics = { version: 1, host: 'codex', workflow: 'pair', strategy: 'pair', taskId: 'sum', turns: 2 }
  const row = (id, readiness, observation) => ({ source: id, result: { hostRunDir: id, metrics: { ...metrics, readiness } }, observation })
  const hit = { file: '/r/jobs/pair-code-2/events.jsonl', at: 'line 3 /item/command', excerpt: 'cat /src/sum.php' }
  const clean = { contaminated: false, scan: { status: 'clean', missing: [] } }
  const partial = { contaminated: false, scan: { status: 'partial', missing: ['no Codex rollout for thread t'] } }
  const dirty = { contaminated: true, contamination: [hit], scan: { status: 'contaminated', missing: [] } }
  const hidden = (status, scan) => ({ kind: 'hidden-tests', status, evidence: 'grade.log', ...scan })
  const out = summarize([row('1', 'ready', hidden('passed', clean)), row('2', 'ready', hidden('passed', dirty)), row('3', 'blocked', hidden('failed', partial)),
    row('4', 'ready', hidden('ungraded', dirty)), row('5', 'ready', hidden('failed'))])
  const group = Object.values(out.groups)[0]
  assert.deepEqual(group.hiddenTests, { graded: 3, ungraded: 0, readyPassed: 1, readyFailed: 1, notReadyPassed: 0, notReadyFailed: 1,
    contaminated: 2, scanPartial: 1, unscanned: 1, unknown: 0, escapedDefects: 1, falseBlocks: 0, passRate: 1 / 3, escapedDefectRate: 0.5, falseBlockRate: 0 })
  assert.deepEqual(out.matchedTasks['sum@revision-unknown'][Object.keys(out.groups)[0]], { runs: 5, ready: 4, turns: 10, hiddenGraded: 3, hiddenPassed: 1, hiddenContaminated: 2, ...NO_COST })
  const bad = scan => () => summarize([row('1', 'ready', hidden('passed', scan))])
  assert.throws(bad({ contaminated: true, scan: { status: 'contaminated' } }), /Invalid contamination scan/)
  assert.throws(bad({ contaminated: true, contamination: [{ file: 'f', at: '', excerpt: 'x' }], scan: { status: 'contaminated' } }), /Invalid contamination scan/)
  assert.throws(bad({ contaminated: false, scan: { status: 'contaminated' } }), /Invalid contamination scan/)
  assert.throws(bad({ contaminated: false, scan: { status: 'partial', missing: [] } }), /Invalid contamination scan/, 'a partial scan names what it missed')
  assert.throws(bad({ contaminated: 'no', scan: { status: 'clean' } }), /Invalid contamination scan/)
  assert.throws(bad({ contaminated: false }), /Invalid contamination scan/)
  assert.throws(bad({ contaminated: false, contamination: [hit], scan: { status: 'clean' } }), /Invalid contamination scan/)
})

test('a contamination needle matches the source and records paths in every spelling and the fix commit as a whole word', () => {
  const fix = '25a3f96a21be97852fc8f8ac91dfe6c56f8fdce5'
  const needles = contaminationNeedles({ source: '/src/math-php', records: '/bench/records', fixCommit: fix, allowed: ['/src/math-php/.bench/clone'] })
  const hits = text => findHits(text, needles).map(h => [h.match, text.slice(h.start, h.end)])
  assert.deepEqual(hits('cat /src/math-php/src/Algebra.php'), [['source repository', '/src/math-php']])
  assert.deepEqual(hits('I looked in /src/math-php.'), [['source repository', '/src/math-php']])
  assert.deepEqual(hits('ls "/src/math-php"; ls /src/math-php-old /src/math-php.bak /tmp/src/math-php'), [['source repository', '/src/math-php']])
  assert.deepEqual(hits('cd /src/math-php/.bench/clone && git status'), [], 'the run\'s own clone is allowed, wherever it is')
  assert.deepEqual(hits('cat /bench/records/grades/x.log'), [['bench records', '/bench/records']])
  assert.deepEqual(hits('ls /bench/recordsets /bench/tasks/x/repo'), [])
  assert.deepEqual(hits(`git show ${fix.slice(0, 7)}; git show ${fix.toUpperCase()}`), [['fix commit', fix.slice(0, 7)], ['fix commit', fix.toUpperCase()]])
  assert.deepEqual(hits(`${fix.slice(0, 6)} x${fix.slice(0, 9)} ${fix.slice(0, 9)}0 fae02480ef84 ${fix}0`), [], 'too short, inside a longer word, or not a prefix')
  const home = contaminationNeedles({ source: join(homedir(), 'Develop/php/math-php'), records: '/r', fixCommit: fix })
  assert.ok(home.paths.some(p => p.text === '~/Develop/php/math-php'))
})

// The smoke variant as tools/bench.mjs merges it over a real task's arguments.
function smokeArgs() {
  const paths = benchPaths({ root: join(tmpdir(), 'bench-smoke-unused') })
  const plan = runPlan(paths, 'math-gcd-int-min', { variant: 'smoke', rep: 1 })
  return { workflow: plan.workflow, args: plan.args }
}

const EXPENSIVE = /\b(astra|sol|opus|sonnet|fable|terra|gemini|gpt-6\.2-astra|gpt-6\.2-sol|gpt-6\.1-terra)\b/i

test('the smoke variant needs Codex Luna and Claude Haiku only, offline through --prepare and in a stub run', async t => {
  const { workflow, args } = smokeArgs()
  assert.equal(workflow, 'pair')
  assert.deepEqual({ author: args.author, reviewer: args.reviewer, spec: args.spec, retro: args.retro, maxReviews: args.maxReviews, maxDesignReviews: args.maxDesignReviews },
    { author: 'luna', reviewer: 'haiku', spec: { model: 'haiku', effort: 'low' }, retro: false, maxReviews: 2, maxDesignReviews: 1 })
  assert.ok(args.maxTurns > 0 && args.maxTurns <= 12)
  assert.ok(['low', 'medium'].includes(args.effort))
  // Every role the policy can reach on the standalone runner: Pair has setup (on the author's
  // model), the spec review, author and reviewer; no retro, and no other orchestration role.
  const requirements = launchRequirements({}, { workflow, args })
  assert.deepEqual(requirements.vendors, { codex: ['author', 'setup'], claude: ['review', 'spec-review'] })
  const dir = temporary(t), source = sourceRepo(dir), argsFile = join(dir, 'args.json')
  write(argsFile, JSON.stringify(args))
  const prepared = JSON.parse(execFileSync(process.execPath, [join(root, 'plugins/dark-factory/bin/dark-factory-codex'), '--cwd', source.repo,
    '--workflow', workflow, '--args-file', argsFile, '--prepare'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
  assert.deepEqual(Object.fromEntries(Object.entries(prepared.prepared.vendors).map(([v, c]) => [v, c.roles])), requirements.vendors)
  assert.doesNotMatch(JSON.stringify(prepared), EXPENSIVE)

  // A stub run of the same arguments: every CLI call and every turn the runner started.
  const variants = JSON.parse(readFileSync(join(root, 'bench/variants.json'), 'utf8'))
  const paths = bench(dir, [manifest(source)], { smoke: variants.smoke })
  assert.equal(validate(paths, 'sum-adds').valid, true)
  const { clone } = runPlan(paths, 'sum-adds', { variant: 'smoke', rep: 1 })
  const log = join(dir, 'calls.jsonl')
  const record = await run(paths, 'sum-adds', { variant: 'smoke', rep: 1, yes: true, progress: () => {},
    extraEnv: { FACTORY_TEST_REPO: clone, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: log, COUNCIL_JOB_POLL: '0.01' } })
  assert.equal(record.readiness, 'ready', JSON.stringify(record))
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const model = c => c.vendor === 'claude' ? c.args[c.args.indexOf('--model') + 1] : c.args[c.args.indexOf('-m') + 1]
  const effort = c => c.vendor === 'claude' ? c.args[c.args.indexOf('--effort') + 1] : /model_reasoning_effort="(\w+)"/.exec(c.args.join(' '))[1]
  // The fixture names each turn by its output schema; the spec review's is an audit's.
  assert.deepEqual(calls.map(c => [c.kind, c.vendor, model(c), effort(c)]), [
    ['setup', 'codex', 'gpt-6-luna', 'medium'], ['audit', 'claude', 'haiku', 'low'],
    ['pair-design', 'codex', 'gpt-6-luna', 'medium'], ['pair-review', 'claude', 'haiku', 'medium'],
    ['pair-implement', 'codex', 'gpt-6-luna', 'medium'], ['pair-review', 'claude', 'haiku', 'medium']])
  const events = readFileSync(join(record.hostRunDir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual([...new Set(events.filter(e => e.type === 'turn.started').map(e => `${e.vendor}:${e.model}`))].sort(), ['claude:haiku', 'codex:gpt-6-luna'])
  assert.doesNotMatch(JSON.stringify(events.filter(e => e.model || e.vendor)), EXPENSIVE)
})

// The job directories of a run's vendor turns.
function vendorJobs(runDir, vendor) {
  const jobs = join(runDir, 'jobs')
  return readdirSync(jobs).map(name => join(jobs, name)).filter(jd => existsSync(join(jd, 'spec.json')) && JSON.parse(readFileSync(join(jd, 'spec.json'), 'utf8')).kind === vendor)
}

function filesUnder(dir, suffix) {
  return readdirSync(dir, { recursive: true }).map(name => join(dir, name)).filter(path => path.endsWith(suffix)).sort()
}

test('the contamination scan reads what each turn recorded and flags the answer\'s places, never the harness\'s prompts', async t => {
  const dir = temporary(t), source = sourceRepo(dir)
  const variants = JSON.parse(readFileSync(join(root, 'bench/variants.json'), 'utf8'))
  // The task names the source repository, so every prompt the harness writes holds its path.
  const task = `sum(2, 3) returns -1 in the library at ${source.repo}. It should return the sum of its operands.`
  const paths = bench(dir, [manifest(source, { task })], { smoke: variants.smoke })
  assert.equal(validate(paths, 'sum-adds').valid, true)
  const { clone } = runPlan(paths, 'sum-adds', { variant: 'smoke', rep: 1 })
  const homes = { CODEX_HOME: join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude-home') }
  const record = await run(paths, 'sum-adds', { variant: 'smoke', rep: 1, yes: true, progress: () => {}, extraEnv: { ...homes, FACTORY_TEST_TRANSCRIPTS: '1',
    FACTORY_TEST_REPO: clone, FACTORY_TEST_RUN_PATH: join(dir, 'run-path'), FACTORY_TEST_LOG: join(dir, 'calls.jsonl'), COUNCIL_JOB_POLL: '0.01' } })
  assert.equal(record.readiness, 'ready', JSON.stringify(record))
  assert.deepEqual([record.homes.codex, record.homes.claude], [homes.CODEX_HOME, homes.CLAUDE_CONFIG_DIR])
  const recordFile = join(paths.records, 'runs/sum-adds/smoke/rep-1.json')
  const scanned = async () => (await scan(paths, [recordFile]))[0]
  const runDir = JSON.parse(readFileSync(record.resultFile, 'utf8')).runDir
  const rollouts = filesUnder(join(homes.CODEX_HOME, 'sessions'), '.jsonl'), transcripts = filesUnder(join(homes.CLAUDE_CONFIG_DIR, 'projects'), '.jsonl')
  const codexJob = vendorJobs(runDir, 'codex').find(jd => jd.endsWith('pair-code-2'))
  assert.ok(codexJob && rollouts.length && transcripts.length)

  // Clean, although the harness's prompts name the source repository: the job prompts, the
  // rollouts' user messages and the transcripts' prompts all hold it, and none of them counts.
  const clean = await scanned()
  assert.equal(clean.status, 'clean', JSON.stringify(clean, null, 2))
  assert.deepEqual(clean.missing, [])
  assert.equal(clean.sources.claudeTranscripts, 3, 'the spec review and two reviews')
  assert.equal(clean.sources.codexRollouts, 2, 'setup, and the author\'s thread across its turns')
  for (const file of [join(codexJob, 'prompt.md'), rollouts[0], transcripts[0]]) assert.ok(readFileSync(file, 'utf8').includes(source.repo), file)

  const appended = (file, line) => {
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, before + JSON.stringify(line) + '\n')
    return () => writeFileSync(file, before)
  }
  // A Codex job output: the author read the source repository.
  const events = join(codexJob, 'events.jsonl')
  let undo = appended(events, { type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: `/bin/zsh -lc 'cat ${source.repo}/sum.cjs'`,
    aggregated_output: 'module.exports = (a, b) => a + b\n', exit_code: 0, status: 'completed' } })
  const codexHit = await scanned()
  assert.equal(codexHit.status, 'contaminated')
  assert.deepEqual(codexHit.contamination.map(h => [h.file, h.at, h.match]), [[events, `line ${readFileSync(events, 'utf8').trim().split('\n').length} /item/command`, 'source repository']])
  assert.match(codexHit.contamination[0].excerpt, /cat .*source\/sum\.cjs/)
  undo()

  // A Claude transcript: a reviewer listed the bench records.
  const transcript = transcripts[0]
  undo = appended(transcript, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: `${paths.records}/grades/sum-adds/x.log` }] } })
  const claudeHit = await scanned()
  assert.deepEqual(claudeHit.contamination.map(h => [h.file, h.match, h.at.replace(/^line \d+ /, '')]), [[transcript, 'bench records', '/message/content/0/content']])
  undo()

  // A rollout: the author asked git for a prefix of the fix commit. Only the whole-word prefix counts.
  const rollout = rollouts.at(-1)
  undo = appended(rollout, { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_9',
    arguments: JSON.stringify({ cmd: `git show ${source.fix.slice(0, 9)}; git log ${source.fix.slice(0, 6)} x${source.fix.slice(0, 8)} ${source.base.slice(0, 8)}` }) } })
  const shaHit = await scanned()
  assert.deepEqual(shaHit.contamination.map(h => [h.file, h.match]), [[rollout, 'fix commit']])
  assert.match(shaHit.contamination[0].excerpt, new RegExp(source.fix.slice(0, 9)))
  undo()

  // A rollout that can't be found: the scan is partial and names it, never clean.
  const moved = rollouts[0] + '.moved'
  renameSync(rollouts[0], moved)
  const partial = await scanned()
  assert.equal(partial.status, 'partial')
  assert.match(partial.missing.join('\n'), /no Codex rollout for thread fixture-\d+/)
  renameSync(moved, rollouts[0])

  // grade scans every run it grades: a contaminated run is graded all the same, and the evaluator
  // leaves it out of the 2x2.
  undo = appended(events, { type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: `ls ${source.repo}`, aggregated_output: '', exit_code: 0, status: 'completed' } })
  const graded = await grade(paths, [recordFile])
  assert.deepEqual(graded.graded.map(g => [g.status, g.scan]), [['passed', 'contaminated']])
  const outcomes = JSON.parse(readFileSync(graded.outcomes, 'utf8'))
  const outcome = outcomes[record.hostRunDir]
  assert.equal(outcome.contaminated, true)
  assert.equal(outcome.contamination[0].file, events)
  assert.equal(outcome.scan.status, 'contaminated')
  const group = Object.values(evaluateFiles([record.resultFile], outcomes).groups)[0]
  assert.deepEqual([group.hiddenTests.contaminated, group.hiddenTests.graded, group.hiddenTests.readyPassed, group.hiddenTests.passRate], [1, 0, 0, null])
  undo()
  const regraded = JSON.parse(readFileSync((await grade(paths, [recordFile])).outcomes, 'utf8'))[record.hostRunDir]
  assert.deepEqual([regraded.contaminated, regraded.scan.status, 'contamination' in regraded], [false, 'clean', false])
})
