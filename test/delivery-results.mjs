// Each deliverable workflow's actual result, not a hand-built one, goes through `apply` and
// `verify-delivery` in a temporary repository. Model turns are scripted; setup, measurement,
// snapshots, evidence and delivery are the real helper's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simulate } from './fixtures/simulate.mjs'

const CLI = fileURLToPath(new URL('../plugins/dark-factory/bin/dark-factory', import.meta.url))
const GATE = 'node tests/changed.cjs && node tests/preserved.cjs'

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function cli(cwd, ...args) {
  const r = spawnSync(CLI, args, { cwd, encoding: 'utf8', env: { ...process.env, COUNCIL_JOB_POLL: '0.01' }, timeout: 60000 })
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}')
  return { code: r.status, out, stderr: r.stderr }
}

function ok(cwd, ...args) {
  const r = cli(cwd, ...args)
  assert.equal(r.code, 0, JSON.stringify(r.out) + r.stderr)
  return r.out
}

// A repository whose gate fails on the base and passes once worktree A holds the fix.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'df-delivery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Delivery test')
  git(repo, 'config', 'user.email', 'delivery@example.invalid')
  put(repo, 'value', 'broken\n')
  put(repo, 'unchanged', 'preserve\n')
  put(repo, 'tests/changed.cjs', "const fs = require('fs')\nif (fs.readFileSync('value', 'utf8') !== 'fixed\\n') process.exit(1)\n")
  put(repo, 'tests/preserved.cjs', "const fs = require('fs')\nif (fs.readFileSync('unchanged', 'utf8') !== 'preserve\\n') process.exit(1)\n")
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'Initial fixture')
  const run = ok(repo, 'init', '--repo', repo, '--seats', 'A,B', '--run-id', 'demo', '--factory')
  put(run.runDir, 'verify.sh', GATE)
  put(run.worktrees.A, 'value', 'fixed\n')
  const setup = { runId: 'demo', runDir: run.runDir, repoRoot: repo, head: run.head, verify: GATE }
  const measure = async ({ seat, label, replay }) => ok(repo, 'measure', '--run-dir', run.runDir, '--seat', seat, '--label', label,
    ...(replay ? ['--replay-json', JSON.stringify(replay)] : []), '--max-wait', '30')
  return { dir, repo, run, setup, measure }
}

async function deliver(f, result) {
  const file = join(f.dir, 'result.json')
  writeFileSync(file, JSON.stringify(result))
  ok(f.repo, 'apply', '--run-dir', f.run.runDir, '--result', file)
  assert.equal(readFileSync(join(f.repo, 'value'), 'utf8'), 'fixed\n')
  const delivery = ok(f.repo, 'verify-delivery', '--run-dir', f.run.runDir, '--result', file, '--max-wait', '30')
  assert.equal(delivery.status, 'delivered', JSON.stringify(delivery))
}

test('a ready Factory result is applied and its delivery verified', async t => {
  const f = fixture(t)
  const { snapshot } = await f.measure({ seat: 'A', label: 'r0' })
  const { result } = await simulate('factory', {}, { setup: f.setup, tree: () => snapshot.tree })
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result.final.readiness))
  assert.equal(result.final.snapshotRef, snapshot.ref)
  await deliver(f, result)
})

test('a ready Pair result is applied and its delivery verified', async t => {
  const f = fixture(t)
  const { result } = await simulate('pair', {}, { setup: f.setup, measure: f.measure })
  assert.equal(result.final.readiness.state, 'ready', JSON.stringify(result.final.readiness))
  await deliver(f, result)
})

// IterTools-PHP: a native run returned its result only inside the workflow task's output, and
// the orchestrator had to extract it before apply and verify-delivery would take it.
test('a native workflow task output file is accepted as the result as it stands', async t => {
  const f = fixture(t)
  const { result } = await simulate('pair', {}, { setup: f.setup, measure: f.measure })
  const file = join(f.dir, 'task.output')
  writeFileSync(file, JSON.stringify({ summary: 'Pair', agentCount: 6, logs: [], result, totalTokens: 1 }))
  ok(f.repo, 'apply', '--run-dir', f.run.runDir, '--result', file)
  assert.equal(readFileSync(join(f.repo, 'value'), 'utf8'), 'fixed\n')
  const delivery = ok(f.repo, 'verify-delivery', '--run-dir', f.run.runDir, '--result', file, '--max-wait', '30')
  assert.equal(delivery.status, 'delivered', JSON.stringify(delivery))
})

test('a ready Ensemble candidate, saved as its delivery result, is applied and its delivery verified', async t => {
  const f = fixture(t)
  const { snapshot } = await f.measure({ seat: 'A', label: 'r0' })
  const { result } = await simulate('ensemble', { candidates: 2 }, { setup: f.setup, tree: () => snapshot.tree })
  const candidate = result.candidates.find(c => c.final.author === 'A')
  assert.equal(candidate.final.readiness.state, 'ready', JSON.stringify(candidate.final.readiness))
  assert.equal(candidate.final.snapshotRef, snapshot.ref)
  await deliver(f, candidate)
})

test('the advisory Ensemble result itself is not a delivery result', async t => {
  const f = fixture(t)
  const { snapshot } = await f.measure({ seat: 'A', label: 'r0' })
  const { result } = await simulate('ensemble', { candidates: 2 }, { setup: f.setup, tree: () => snapshot.tree })
  const file = join(f.dir, 'advisory.json')
  writeFileSync(file, JSON.stringify(result))
  assert.equal(cli(f.repo, 'apply', '--run-dir', f.run.runDir, '--result', file).code, 1)
  assert.equal(git(f.repo, 'status', '--porcelain', '--untracked-files=no'), '')
})
