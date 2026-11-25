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
if ('brief' in schema.properties) {
  const challenge = 'questions' in schema.properties
  kind = 'decisionReview' in schema.properties ? 'brief-recheck' : challenge ? 'challenger' : 'planMissing' in schema.properties ? 'shaper' : 'brief-answered'
  result.brief = { outcome: 'sum adds both operands.', purpose: 'Callers receive the correct total.', scope: 'Arithmetic in sum.',
    nonGoals: 'Changing the public API.', acceptanceExamples: ['sum(2,3) returns 5.'], verification: 'Observe the returned total.',
    delegated: ['testing', 'implementation', 'internal design'] }
  // A re-check rules that every carried decision still holds.
  const carried = prompt.match(/^Carried decisions: (.*)$/m)
  if ('decisionReview' in schema.properties) result.decisionReview = (carried ? JSON.parse(carried[1]) : []).map(d => ({ id: d.id, status: 'holds', reason: 'The task still asks for it.' }))
  // BRIEF_TEST_ASK: the challenge (or re-check) asks the user one question about the goal.
  if (challenge && process.env.BRIEF_TEST_ASK) result.questions = [{ question: 'Should sum also accept strings?', wording: 'add its operands',
    outcomeA: 'Strings are concatenated.', outcomeB: 'Strings are rejected.', evidence: 'sum.cjs takes numbers only.',
    recommendation: 'Reject strings.', changes: 'Whether sum("a", "b") returns "ab" or throws.' }]
  if ('title' in schema.properties) result.title = 'Fix sum'
} else if ('signals' in schema.properties) {
  kind = 'intake'
  Object.assign(result, { status: 'ok', tier: 'simple', mode: 'implement', reasons: 'One-line arithmetic fix.' })
} else if ('runDir' in schema.properties) {
  kind = 'setup'
  const runId = prompt.match(/--run-id '?([\w.-]+)'?/)
  const refs = [...prompt.matchAll(/--ref '([^']+)'/g)].flatMap(m => ['--ref', m[1]])
  const run = helper('init', '--repo', repo, '--seats', prompt.match(/--seats ([A-F,]+)/)[1], ...(runId ? ['--run-id', runId[1]] : []), ...(prompt.includes('--factory') ? ['--factory'] : []), ...refs)
  fs.writeFileSync(path.join(run.runDir, 'verify.sh'), 'node check.cjs\n')
  const baseline = helper('measure', '--run-dir', run.runDir, '--seat', 'A', '--label', 'base')
  Object.assign(result, { status: 'ok', mode: 'implement', runId: run.runId, runDir: run.runDir, repoRoot: repo,
    refs: run.refs.map(({ source, path, inWorktrees }) => ({ source, path, inWorktrees })),
    verify: 'node check.cjs', baselinePasses: baseline.suite.passed, baselineNote: 'Arithmetic test initially fails.',
    criteria: [{ id: 'C1', text: 'sum(2,3) returns 5; node check.cjs passes.' }] })
  // Criteria the task supplied are kept as given, as the engine checks.
  const given = prompt.match(/Use exactly these, numbered C1, C2, …:\n((?:- .*\n)+)/)
  if (given) result.criteria = given[1].trimEnd().split('\n').map((line, i) => ({ id: `C${i + 1}`, text: line.slice(2) }))
  fs.writeFileSync(runPath, run.runDir)
  // FACTORY_TEST_SETTINGS: each setup directory holds its own eligible provider-settings record.
  if (process.env.FACTORY_TEST_SETTINGS) {
    fs.mkdirSync(path.join(run.runDir, 'jobs', 'settings'), { recursive: true })
    fs.writeFileSync(path.join(run.runDir, 'jobs', 'settings', 'spec.json'), JSON.stringify({ kind: 'codex', settingsHash: 'h-' + run.runId }))
  }
  if ('head' in schema.properties) result.head = run.head
} else if ('design' in schema.properties) {
  const design = /# Stage: design/.test(prompt)
  kind = design ? 'pair-design' : 'pair-implement'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const handoff = prompt.match(/Write a concise handoff at (.+\/A\.md)/)[1]
  fs.mkdirSync(path.dirname(handoff), { recursive: true })
  fs.writeFileSync(handoff, design ? 'Use addition and test the result.\n' : 'Implemented addition.\n')
  if (!design) fs.writeFileSync(path.join(runDir, 'wt/A/sum.cjs'), 'module.exports = (a, b) => a + b\n')
  Object.assign(result, { status: 'done', summary: 'Corrected sum.', design: design ? 'Replace subtraction with addition and verify with node check.cjs.' : '' })
  result.testContract = { testRoots: [{ path: 'tests', evidence: 'tests/preserved.cjs exists at base.' }], checks: [
    { id: 'T1', criteria: ['C1'], kind: 'test', purpose: 'changed', scenario: 'sum(2,3)', expected: '5', boundaries: 'Unequal operands.',
      file: 'tests/sum.cjs', command: 'node tests/sum.cjs', fixtures: [], inspection: '', reason: '' },
    { id: 'T2', criteria: ['C1'], kind: 'test', purpose: 'preserved', scenario: 'sum(2,0)', expected: '2', boundaries: 'Zero second operand.',
      file: 'tests/preserved.cjs', command: 'node tests/preserved.cjs', fixtures: [], inspection: '', reason: '' },
  ] }
  result.replayMapping = design ? [] : result.testContract.checks.map(c => ({ file: c.file, command: c.command, checkIds: [c.id], fixtures: [] }))
  // PAIR_TEST_ASK: the design author stops for the user until the prompt carries the answer; with
  // PAIR_TEST_ASK=2 it then asks a second question, until that answer is there too.
  if (design && process.env.PAIR_TEST_ASK && !prompt.includes('\n# Explicit user decisions\n')) Object.assign(result, { status: 'needs-user', summary: 'The author needs a choice.', questions: ['Keep the old flag?'] })
  else if (design && process.env.PAIR_TEST_ASK === '2' && !prompt.includes('\n- Q2 (')) Object.assign(result, { status: 'needs-user', summary: 'The author needs another choice.', questions: ['Rename the option?'] })
  if (!design) fs.writeFileSync(path.join(runDir, 'wt/A/tests/sum.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2, 3), 5)\n")
} else if ('version' in schema.properties) {
  kind = 'pair-review'
  const code = /# Review stage: code/.test(prompt)
  Object.assign(result, { version: prompt.match(/^Version: (.+)$/m)[1], complete: true,
    summary: 'Reviewed the artifact.', criteria: [{ criterion: 'C1', status: 'met', note: 'Checked sum behavior and the regression test.' }] })
  result.challenges = code ? [] : [{ criterion: 'C1', wrongImplementation: 'Subtract instead of add.', rejectingCheckIds: ['T1'] }]
  if (code) {
    if (!fs.readFileSync(path.join(process.cwd(), 'sum.cjs'), 'utf8').includes('a + b')) throw new Error('Reviewer did not receive the implementation snapshot')
    execFileSync(process.execPath, ['check.cjs'], { cwd: process.cwd() })
    if (process.env.PAIR_TEST_FIXES) {
      const countFile = process.env.FACTORY_TEST_LOG + '.reviews'
      const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1
      fs.writeFileSync(countFile, String(n))
      if (n <= 2) result.findings = [{ severity: 'major', statement: `Regression case ${n} needs attention.`, evidence: 'check.cjs:1', failure: `sum(${n}, -${n}) returns the wrong total.` }]
      if (n >= 2) result.resolutions = [{ id: `P${n - 1}`, status: 'fixed', evidence: 'Checked the implementation and tests.' }]
    }
  }
} else if ('approach' in schema.properties) {
  kind = 'ensemble-solve'
  const post = prompt.match(/Write your complete result to (.+\.md)\./)[1]
  fs.writeFileSync(path.join(process.cwd(), 'sum.cjs'), 'module.exports = (a, b) => a + b\n')
  fs.mkdirSync(path.dirname(post), { recursive: true }); fs.writeFileSync(post, 'Corrected addition. Verified node check.cjs.\n')
  Object.assign(result, { approach: 'Replace subtraction with addition.', worktreePath: process.cwd(), verification: 'node check.cjs passes', diff: 'See measured snapshot.', confidence: 5 })
} else if ('defects' in schema.properties) {
  kind = 'ensemble-review'
  execFileSync(process.execPath, ['check.cjs'], { cwd: process.cwd() })
  Object.assign(result, { complete: true, snapshotTree: prompt.match(/tree ([a-f0-9]{40,64})/)[1], verdict: 'sound', score: 9,
    criteria: [{ criterion: 'C1', status: 'met', note: 'Ran the regression against the pinned snapshot.' }] })
} else if ('ranking' in schema.properties) {
  kind = 'ensemble-compare'
  Object.assign(result, { ranking: [{ candidate: 1, rank: 1, why: 'Verified addition.' }], recommendation: 'adopt-one', mergePlan: 'Select one unchanged candidate.' })
} else if ('tooBig' in schema.properties) {
  kind = 'solve'
  const runDir = fs.readFileSync(runPath, 'utf8')
  fs.writeFileSync(path.join(runDir, 'wt/A/sum.cjs'), 'module.exports = (a, b) => a + b\n')
  fs.writeFileSync(path.join(runDir, 'room/r0/A.md'), 'Corrected the arithmetic operator. node check.cjs passes.\n')
  Object.assign(result, { summary: 'Corrected sum.', confidence: 5 })
} else if ('measured' in schema.properties) {
  kind = 'checker'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const command = prompt.match(/dark-factory measure --run-dir (?:'[^']*'|\S+) --seat (\w+) --label (\w+)(?: --since (\w+))?/)
  const [, seat, label, since] = command
  const measured = helper('measure', '--run-dir', runDir, '--seat', seat, '--label', label, ...(since ? ['--since', since] : []))
  const stat = measured.snapshot
  Object.assign(result, { measured: true, diff: { files: stat.files, added: stat.added, removed: stat.removed, tree: stat.tree },
    suite: { ran: measured.suite.ran, passed: measured.suite.passed, tail: measured.suite.tail || '', scratchFailed: 'scratchFailed' in measured.suite },
    postWords: 8, criteria: [{ criterion: 'C1', status: measured.suite.passed ? 'met' : 'unmet', note: 'Ran the verification command on the snapshot.' }] })
} else if (process.env.PAIR_TEST_SPEC && schema.properties.findings?.items?.properties?.settle) {
  kind = 'spec'
  result.summary = 'The criteria hold together.'
  // PAIR_TEST_SPEC: the spec review asks the user once, until the prompt carries the answer.
  if (!prompt.includes('\n# Explicit user decisions\n')) Object.assign(result, { summary: 'C1 conflicts with the test rule.', findings: [{
    criteria: ['C1'], statement: 'C1 and the test rule conflict.', quoted: ['sum(2,3) returns 5; node check.cjs passes.'], evidence: 'check.cjs:1',
    settle: 'user', reading: '', question: 'Keep check.cjs as the gate?', revisits: '', leftOpen: '' }] })
} else if ('findings' in schema.properties) {
  kind = 'audit'
  result.summary = 'The arithmetic fix is correct.'
  if (schema.properties.evidenceReview) {
    const runDir = fs.readFileSync(runPath, 'utf8')
    const evidence = helper('evidence', '--run-dir', runDir, '--seat', 'A', '--label', 'r0')
    const verified = helper('verify', '--run-dir', runDir, '--path', process.cwd(), '--label', 'audit')
    result.evidenceReview = { status: evidence.status === 'ok' && verified.suite.passed ? 'complete' : 'incomplete', note: 'Verified the snapshot bundle and reran the gate.' }
  }
} else if ('worked' in schema.properties) {
  kind = 'retro'
  const runDir = fs.readFileSync(runPath, 'utf8')
  const hash = prompt.match(/--expect ([\w-]+)/)[1]
  fs.writeFileSync(path.join(runDir, 'retro.md'), '# Council retro: fixture\n\nThe run went smoothly.\n')
  const saved = helper('retro', '--run-dir', runDir, '--expect', hash, '--payload-file', path.join(runDir, 'retro-data.md'))
  result.worked = [{ what: 'Fresh reviews', evidence: 'pair-review' }]
  result.saved = saved.path || ''
  result.error = saved.error || ''
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
fs.appendFileSync(process.env.FACTORY_TEST_LOG, JSON.stringify({ kind, thread, vendor: claude ? 'claude' : 'codex', cwd: process.cwd(), args,
  ...(prompt.includes('\n# Explicit user decisions\n') ? { decisions: true } : {}) }) + '\n')
// FACTORY_TEST_TRANSCRIPTS: keep a session record where the real CLI would, in the shape it uses (a
// Codex rollout by thread, a Claude transcript by session), with the prompt and one tool call. Only
// under explicit test homes, never the real ~/.codex or ~/.claude.
if (process.env.FACTORY_TEST_TRANSCRIPTS) {
  const home = process.env[claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']
  if (!home) throw new Error('FACTORY_TEST_TRANSCRIPTS needs CODEX_HOME and CLAUDE_CONFIG_DIR')
  const lines = records => records.map(r => JSON.stringify(r) + '\n').join('')
  const cwd = process.cwd(), now = new Date()
  if (claude) {
    const dir = path.join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `${thread}.jsonl`), lines([
      { type: 'queue-operation', operation: 'enqueue', content: prompt, sessionId: thread },
      { type: 'user', cwd, sessionId: thread, message: { role: 'user', content: prompt } },
      { type: 'assistant', cwd, sessionId: thread, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git ls-files' } }] } },
      { type: 'user', cwd, sessionId: thread, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'check.cjs\nsum.cjs\n' }] }, toolUseResult: { stdout: 'check.cjs\nsum.cjs\n', stderr: '' } },
      { type: 'assistant', cwd, sessionId: thread, message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] } },
      { type: 'last-prompt', lastPrompt: prompt, sessionId: thread },
    ]))
  } else {
    const day = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    fs.mkdirSync(day, { recursive: true })
    const existing = fs.readdirSync(day).find(name => name.endsWith(`-${thread}.jsonl`))
    const file = path.join(day, existing || `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${thread}.jsonl`)
    fs.appendFileSync(file, lines([
      ...(existing ? [] : [{ type: 'session_meta', payload: { id: thread, cwd, base_instructions: { text: 'You are Codex.' } } }]),
      { type: 'turn_context', payload: { cwd, model: get('-m') } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git ls-files' }), call_id: 'call_1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'check.cjs\nsum.cjs\n' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] } },
    ]))
  }
}
if (claude) console.log(JSON.stringify({ subtype: 'success', session_id: thread, structured_output: result, usage: { input_tokens: 10, output_tokens: 10 } }))
else {
  fs.writeFileSync(get('-o'), JSON.stringify(result))
  console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }))
}
