#!/usr/bin/env node
// Model-free transport fixture. Real helper processes create and measure the worktrees.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-fixture'); process.exit(0) }
const get = flag => args[args.indexOf(flag) + 1]
const claude = args.includes('--json-schema')
const schema = JSON.parse(claude ? get('--json-schema') : fs.readFileSync(get('--output-schema'), 'utf8'))
const prompt = fs.readFileSync(0, 'utf8')
const repo = process.env.FACTORY_TEST_REPO
const runPath = process.env.FACTORY_TEST_RUN_PATH || path.join(repo, '.test-run-path')
function empty(s) {
  if (s.enum) return s.enum[0]
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, empty(v)]))
  if (s.type === 'array') return []
  if (s.type === 'boolean') return false
  if (s.type === 'string') return ''
  return 0
}
let result = empty(schema), kind
function helper(...argv) {
  const output = execFileSync('dark-factory', argv, { encoding: 'utf8', cwd: repo })
  let value = JSON.parse(output.trim().split('\n').at(-1))
  while (value.status === 'running') value = JSON.parse(execFileSync('dark-factory', ['wait', '--run-dir', argv[argv.indexOf('--run-dir') + 1], '--job', value.job], { encoding: 'utf8', cwd: repo }).trim().split('\n').at(-1))
  return value
}
if ('signals' in schema.properties) {
  kind = 'intake'
  Object.assign(result, { status: 'ok', tier: 'simple', mode: 'implement', reasons: 'One-line arithmetic fix.' })
} else if ('runDir' in schema.properties) {
  kind = 'setup'
  const runId = prompt.match(/--run-id '?([\w.-]+)'?/)
  const run = helper('init', '--repo', repo, '--seats', 'A', ...(runId ? ['--run-id', runId[1]] : []), ...(prompt.includes('--factory') ? ['--factory'] : []))
  fs.writeFileSync(path.join(run.runDir, 'verify.sh'), 'node check.cjs\n')
  const baseline = helper('measure', '--run-dir', run.runDir, '--seat', 'A', '--label', 'base')
  Object.assign(result, { status: 'ok', mode: 'implement', runId: run.runId, runDir: run.runDir, repoRoot: repo,
    verify: 'node check.cjs', baselinePasses: baseline.suite.passed, baselineNote: 'Arithmetic test initially fails.',
    criteria: [{ id: 'C1', text: 'sum(2,3) returns 5; node check.cjs passes.' }] })
  fs.writeFileSync(runPath, run.runDir)
} else if ('design' in schema.properties) {
  const design = /# Stage: design/.test(prompt)
  kind = design ? 'pair-design' : 'pair-implement'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const handoff = prompt.match(/Write a concise handoff at (.+\/A\.md)/)[1]
  fs.mkdirSync(path.dirname(handoff), { recursive: true })
  fs.writeFileSync(handoff, design ? 'Use addition and test the result.\n' : 'Implemented addition.\n')
  if (!design) fs.writeFileSync(path.join(runDir, 'wt/A/sum.cjs'), 'module.exports = (a, b) => a + b\n')
  Object.assign(result, { status: 'done', summary: 'Corrected sum.', design: design ? 'Replace subtraction with addition and verify with node check.cjs.' : '' })
} else if ('version' in schema.properties) {
  kind = 'pair-review'
  const code = /# Review stage: code/.test(prompt)
  Object.assign(result, { version: prompt.match(/^Version: (.+)$/m)[1], complete: true,
    summary: 'Reviewed the artifact.', criteria: [{ criterion: 'C1', status: 'met', note: 'Checked sum behavior and the regression test.' }] })
  if (code) {
    if (!fs.readFileSync(path.join(process.cwd(), 'sum.cjs'), 'utf8').includes('a + b')) throw new Error('Reviewer did not receive the implementation snapshot')
    execFileSync(process.execPath, ['check.cjs'], { cwd: process.cwd() })
    if (process.env.PAIR_TEST_FIXES) {
      const countFile = process.env.FACTORY_TEST_LOG + '.reviews'
      const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1
      fs.writeFileSync(countFile, String(n))
      if (n <= 2) result.findings = [{ severity: 'minor', statement: `Regression case ${n} needs attention.`, evidence: 'check.cjs:1' }]
      if (n >= 2) result.resolutions = [{ id: `P${n - 1}`, status: 'fixed', evidence: 'Checked the implementation and tests.' }]
    }
  }
} else if ('tooBig' in schema.properties) {
  kind = 'solve'
  const runDir = fs.readFileSync(runPath, 'utf8')
  fs.writeFileSync(path.join(runDir, 'wt/A/sum.cjs'), 'module.exports = (a, b) => a + b\n')
  fs.writeFileSync(path.join(runDir, 'room/r0/A.md'), 'Corrected the arithmetic operator. node check.cjs passes.\n')
  Object.assign(result, { summary: 'Corrected sum.', confidence: 5 })
} else if ('measured' in schema.properties) {
  kind = 'checker'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const command = prompt.match(/dark-factory measure --run-dir \S+ --seat (\w+) --label (\w+)(?: --since (\w+))?/)
  const [, seat, label, since] = command
  const measured = helper('measure', '--run-dir', runDir, '--seat', seat, '--label', label, ...(since ? ['--since', since] : []))
  const stat = measured.snapshot
  Object.assign(result, { measured: true, diff: { files: stat.files, added: stat.added, removed: stat.removed, tree: stat.tree },
    suite: { ran: measured.suite.ran, passed: measured.suite.passed, tail: measured.suite.tail || '' },
    postWords: 8, criteria: [{ criterion: 'C1', status: measured.suite.passed ? 'met' : 'unmet', note: 'Ran the verification command on the snapshot.' }] })
} else if ('findings' in schema.properties) {
  kind = 'audit'
  result.summary = 'The arithmetic fix is correct.'
  if (schema.properties.evidenceReview) {
    const runDir = fs.readFileSync(runPath, 'utf8')
    const evidence = helper('evidence', '--run-dir', runDir, '--seat', 'A', '--label', 'r0')
    const verified = helper('verify', '--run-dir', runDir, '--path', process.cwd(), '--label', 'audit')
    result.evidenceReview = { status: evidence.status === 'ok' && verified.suite.passed ? 'complete' : 'incomplete', note: 'Verified the snapshot bundle and reran the gate.' }
  }
} else if ('saved' in schema.properties) {
  kind = 'record'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const hash = prompt.match(/--expect ([\w-]+)/)[1]
  const saved = helper('retro', '--facts-only', '--run-dir', runDir, '--expect', hash, '--payload-file', path.join(runDir, 'retro-data.md'))
  result.saved = saved.path || ''
  result.error = saved.error || ''
} else throw new Error('Unhandled fixture schema')
const thread = claude ? get(args.includes('--resume') ? '--resume' : '--session-id')
  : args.includes('resume') ? args.at(-2) : `fixture-${process.pid}`
fs.appendFileSync(process.env.FACTORY_TEST_LOG, JSON.stringify({ kind, thread, vendor: claude ? 'claude' : 'codex', cwd: process.cwd(), args }) + '\n')
if (claude) console.log(JSON.stringify({ subtype: 'success', session_id: thread, structured_output: result, usage: { input_tokens: 10, output_tokens: 10 } }))
else {
  fs.writeFileSync(get('-o'), JSON.stringify(result))
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }))
}
