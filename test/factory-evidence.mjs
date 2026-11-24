// The pure Factory L2/L3 judges (tools/factory-evidence.mjs) on fixture evidence: first-leg
// boundaries, including the real stops both Factory builds return, and the resume judge's replay
// and answered-suffix checks.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PARAMS, runCandidate, runHosted } from './fixtures/workflow-host.mjs'
import { challenges, contract } from './fixtures/pair-contract.mjs'
import { judgeFirstLeg, judgeResume, snapshotRunDirectory } from '../tools/factory-evidence.mjs'

const head = 'a'.repeat(40)
const resumeText = 'Call Workflow({name: "dark-factory:factory", resumeFromRunId: <id>}).'

// A fixture repository holding one setup run directory with its run.json.
function setupRun(t, runId) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'factory-evidence-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const runDir = join(repo, '.council', runId)
  const room = join(runDir, 'room')
  mkdirSync(room, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ head, runId, repoRoot: repo, runDir, room }))
  return { repo, runDir, directory: snapshotRunDirectory(runDir, { repo, head }) }
}

const factoryScript = new (Object.getPrototypeOf(async function () {}).constructor)(...PARAMS,
  readFileSync(new URL('../plugins/dark-factory/workflows/factory.js', import.meta.url), 'utf8')
    .replace(/^export const meta\s*=/m, 'const meta ='))

for (const [scenario, candidate] of [['L2-ii inline', false], ['L2-ii candidate', true], ['L3 inline', false]]) {
  test(`${scenario} accepts a real Factory Pair design stop`, async t => {
    const runId = '20261124-123456'
    const { repo, runDir, directory } = setupRun(t, runId)
    const nativeId = 'wf_pairstop'
    const journal = join('subagents', 'workflows', nativeId)
    const args = { task: 'Change an increment and preserve its caller behavior.', brief: false, tier: 'simple',
      tierConfirmed: true, noSplit: true, strategy: 'pair', mode: 'implement', retro: false, verify: 'node --test',
      pair: { spec: false, maxDesignReviews: 1, maxReviews: 3 } }
    const rows = []
    const agent = async (prompt, { label, schema }) => {
      let result
      if (label === 'intake') {
        result = { status: 'ok', tier: 'simple', strategy: 'pair', mode: 'implement', reasons: 'One scoped change.' }
      } else if (label === 'setup') {
        result = { status: 'ok', mode: 'implement', runId, runDir, repoRoot: repo, head, verify: args.verify,
          baselinePasses: true, refs: [], dirty: [], criteria: [{ id: 'C1', text: 'The requested behavior works.' }] }
      } else if (label === 'pair-design-1') {
        result = { status: 'done', design: 'Change the increment and test the boundary and existing caller.',
          summary: 'A design for the increment.', testContract: contract() }
      } else if (label === 'review pair-design-1 (relay)') {
        result = { status: 'done', result: { turn: schema.properties.result.properties.turn.enum[0],
          version: prompt.match(/^Version: (.+)$/m)[1], complete: true, summary: 'Design leaves a boundary open.',
          criteria: [{ criterion: 'C1', status: 'met', note: 'The proposed design covers the named criterion.' }],
          challenges: challenges(),
          findings: [{ severity: 'major', statement: 'Caller behavior at zero is unspecified.',
            evidence: 'caller.cjs delegates directly to increment.', failure: 'The caller returns the wrong value at zero.' }] } }
      } else if (label === 'stop Q1') {
        result = { status: 'ok', reason: '' }
      } else {
        assert.fail(`Unexpected agent ${label}`)
      }
      const identity = { key: label, agentId: `agent-${rows.length}`, directory: journal }
      rows.push({ type: 'started', label, ...identity }, { type: 'result', result, ...identity })
      return result
    }
    const host = { agent, phase() {}, log() {}, parallel: async calls => Promise.all(calls.map(call => call())) }
    const result = candidate ? (await runCandidate(host, args)).result : await runHosted(factoryScript, host, args)
    assert.equal(result.status, 'needs-user')
    assert.equal(result.stage, 'design')
    assert.equal(result.questions[0].kind, 'design')
    assert.match(result.resumeSteps, /name: "dark-factory:factory"/)
    const call = { session: 'pair-session', input: { name: 'dark-factory:factory', args },
      output: { status: 'async_launched', runId: nativeId, taskId: 'pair-task' } }
    const judged = judgeFirstLeg(scenario.split(' ')[0], { call, rows, directory,
      state: { runId: nativeId, taskId: 'pair-task', status: 'completed', result } })
    assert.equal(judged.status, 'pass', `Factory returned workflow=${result.workflow}. ${judged.reason}`)
  })
}

// First-leg evidence for L2-i (budget stop) or L2-ii (Pair design stop).
function firstLeg(t, id) {
  const setupId = '20261121-123456'
  const { repo, runDir, directory } = setupRun(t, setupId)
  const pair = id === 'L2-ii'
  const route = { tier: 'simple', strategy: pair ? 'pair' : 'independent' }
  const metrics = { workflow: 'factory', ...route, turns: pair ? 7 : 2 }
  const journal = 'subagents/workflows/wf_1abc1234'
  const started = (label, key, agentId) => ({ type: 'started', label, key, agentId, directory: journal })
  const end = ({ key, agentId, directory }, result) => ({ type: 'result', key, agentId, directory, result })
  const intake = started('intake', 'k1', 'a1')
  const setup = started('setup', 'k2', 'a2')
  const rows = [intake, end(intake, { status: 'ok' }), setup, end(setup, { status: 'ok', runDir, runId: setupId, repoRoot: repo })]
  const result = pair
    ? { status: 'needs-user', workflow: 'factory', ...route, stage: 'design', resumable: true, resumeSteps: resumeText,
        runDir, metrics, questions: [{ id: 'Q1', question: 'Which?', kind: 'design' }] }
    : { status: 'blocked', stopReason: 'Run turn budget exhausted (2).', runDir, metrics }
  const call = {
    session: 's1', toolUseId: 't1', line: 1, resultLine: 2,
    input: { name: 'dark-factory:factory', args: { task: 'x', ...route } },
    output: { taskId: 'task1', runId: 'wf_1abc1234', status: 'async_launched' },
  }
  const first = {
    call, rows, directory,
    state: { runId: 'wf_1abc1234', taskId: 'task1', status: 'completed', result },
    terminal: { line: 3, session: 's1', taskId: 'task1', status: 'completed' },
  }
  return { first, end }
}

test('baseline first legs pass', t => {
  for (const id of ['L2-i', 'L2-ii']) assert.equal(judgeFirstLeg(id, firstLeg(t, id).first).status, 'pass', id)
})

test('L2-i is inconclusive when a third agent ran before the budget stop', t => {
  const { first, end } = firstLeg(t, 'L2-i')
  const extra = { type: 'started', label: 'r0:A sonnet', key: 'k3', agentId: 'a3', directory: first.rows[0].directory }
  first.rows.push(extra, end(extra, { status: 'ok' }))
  assert.equal(judgeFirstLeg('L2-i', first).status, 'inconclusive')
})

test('L2-i is inconclusive when metrics.turns is not 2', t => {
  const { first } = firstLeg(t, 'L2-i')
  first.state.result.metrics.turns = 3
  assert.equal(judgeFirstLeg('L2-i', first).status, 'inconclusive')
})

test('a first leg on the wrong tier or strategy route is inconclusive', t => {
  for (const id of ['L2-i', 'L2-ii']) {
    const { first } = firstLeg(t, id)
    first.state.result.metrics.strategy = id === 'L2-i' ? 'pair' : 'independent'
    assert.equal(judgeFirstLeg(id, first).status, 'inconclusive', id)
  }
})

test('a first leg whose result is not a factory workflow is inconclusive', t => {
  const { first } = firstLeg(t, 'L2-i')
  first.state.result.metrics.workflow = 'pair'
  assert.equal(judgeFirstLeg('L2-i', first).status, 'inconclusive')
  const pair = firstLeg(t, 'L2-ii').first
  pair.state.result.workflow = 'pair'
  assert.equal(judgeFirstLeg('L2-ii', pair).status, 'inconclusive')
})

test('L2-ii is inconclusive when the Pair stop is not resumable', t => {
  const { first } = firstLeg(t, 'L2-ii')
  first.state.result.resumable = false
  assert.equal(judgeFirstLeg('L2-ii', first).status, 'inconclusive')
})

test('a refused first launch is inconclusive and keeps the refusal text', t => {
  const { first } = firstLeg(t, 'L2-i')
  const refused = { call: { ...first.call, error: true, output: undefined, text: 'Workflow refused' },
    observationError: 'Factory did not launch in the checked session: Workflow refused' }
  const judged = judgeFirstLeg('L2-i', refused)
  assert.equal(judged.status, 'inconclusive')
  assert.match(judged.reason, /Workflow refused/)
})

const progressOf = (attempts, cached) => attempts.map(({ label, agentId }, index) =>
  ({ type: 'workflow_agent', index: index + 1, label, agentId, state: 'done', ...(cached ? { cached: true } : {}) }))

test('a budget resume passes only when the current invocation reports intake and setup as cached', t => {
  const runId = '20261124-123457'
  const { repo, runDir, directory } = setupRun(t, runId)
  const nativeRunId = 'wf_replay'
  const journal = join('subagents', 'workflows', nativeRunId)
  const agents = [
    { label: 'intake', agentId: 'a000000000000003', result: { status: 'ok' } },
    { label: 'setup', agentId: 'a000000000000004', result: { status: 'ok', runDir, repoRoot: repo, runId } },
  ]
  const rows = agents.flatMap(({ label, agentId, result }) => {
    const identity = { key: `key-${label}`, agentId, directory: journal }
    return [{ type: 'started', label, ...identity }, { type: 'result', result, ...identity }]
  })
  const args = { task: 'Fix a small regression', brief: false, tier: 'simple', tierConfirmed: true,
    noSplit: true, strategy: 'independent', maxTurns: 2 }
  const result = { status: 'blocked', stopReason: 'Run turn budget exhausted (2).', runDir,
    metrics: { workflow: 'factory', tier: args.tier, strategy: args.strategy, turns: 2 } }
  function snapshot(resume, workflowProgress) {
    const taskId = resume ? 'resumed' : 'initial'
    const call = { session: 'replay-session', line: resume ? 4 : 1, resultLine: resume ? 5 : 2,
      input: { name: 'dark-factory:factory', args, ...(resume ? { resumeFromRunId: nativeRunId } : {}) },
      output: { status: 'async_launched', taskId, runId: nativeRunId } }
    return { call, directory, rows, state: { taskId, runId: nativeRunId, status: 'completed', result, workflowProgress } }
  }
  const first = snapshot(false, progressOf(agents, false))
  assert.equal(judgeFirstLeg('L2-i', first).status, 'pass')
  assert.equal(judgeResume('L2-i', first, snapshot(true, progressOf(agents, true))).status, 'pass')

  // A retained journal supplies both prior attempts, even when the current invocation only
  // reports one cached call. That old journal cannot establish the missing replay.
  const incomplete = judgeResume('L2-i', first, snapshot(true, progressOf(agents, true).slice(0, 1)))
  assert.equal(incomplete.status, 'fail', 'the current invocation did not report a cached setup turn')
  assert.match(incomplete.reason, /cached/)
  assert.equal(judgeResume('L2-i', first, snapshot(true, undefined)).status, 'fail')
  const moved = progressOf(agents, true).map(entry => ({ ...entry, index: 3 - entry.index }))
  assert.equal(judgeResume('L2-i', first, snapshot(true, moved)).status, 'fail', 'cached labels at the wrong positions')
  const unjournaled = [...progressOf(agents, true), { type: 'workflow_agent', index: 3, label: 'r0:A sonnet', agentId: 'a9', state: 'done' }]
  assert.match(judgeResume('L2-i', first, snapshot(true, unjournaled)).reason, /fresh agents do not match/)
})

// First leg plus answered resume for L2-ii (Pair design stop) or L2-iii (Fix spec stop).
function answered(t, id) {
  const setupId = '20261121-123456'
  const { repo, runDir, directory } = setupRun(t, setupId)
  const pair = id === 'L2-ii'
  const route = { tier: pair ? 'simple' : 'fix', strategy: pair ? 'pair' : 'independent' }
  const metrics = { workflow: 'factory', ...route, turns: 7 }
  const dir = 'subagents/workflows/wf_1abc1234'
  const started = (label, key, agentId) => ({ type: 'started', label, key, agentId, directory: dir })
  const end = ({ key, agentId, directory }, result) => ({ type: 'result', key, agentId, directory, result })
  const intake = started('intake', 'k1', 'a1')
  const setup = started('setup', 'k2', 'a2')
  const rows = [intake, end(intake, { status: 'ok' }), setup, end(setup, { status: 'ok', runDir, runId: setupId, repoRoot: repo })]
  const questions = [{ id: 'Q1', question: 'Which?', ...(pair ? { kind: 'design' } : {}) }]
  const answer = { id: 'Q1', answer: 'Keep it.', ...(pair ? { implement: true } : {}) }
  const result = pair
    ? { status: 'needs-user', workflow: 'factory', ...route, stage: 'design', resumable: true, resumeSteps: resumeText, runDir, metrics, questions }
    : { status: 'needs-user', round: 'spec', forTheOrchestrator: resumeText, runDir, metrics, questions }
  const args = { task: 'x', ...route }
  const call = { session: 's1', toolUseId: 't1', line: 1, resultLine: 2, input: { name: 'dark-factory:factory', args },
    output: { taskId: 'task1', runId: 'wf_1abc1234', status: 'async_launched' } }
  const first = {
    call, rows, directory,
    state: { runId: 'wf_1abc1234', taskId: 'task1', status: 'completed', result },
    terminal: { line: 3, session: 's1', taskId: 'task1', status: 'completed' },
  }
  const next = started(pair ? 'resume-check Q1' : 'spec amend', 'k3', 'a3')
  const nextResult = { status: 'done', runDir, metrics: { ...metrics, turns: 12 },
    ...(pair ? { decisions: [{ ...answer }] } : { spec: { answered: ['Q1'] } }) }
  const workflowProgress = [...progressOf([intake, setup], true),
    { type: 'workflow_agent', index: 3, label: next.label, agentId: next.agentId, state: 'done' }]
  const resumed = {
    call: { ...call, line: 4, resultLine: 5, toolUseId: 't2', output: { ...call.output, taskId: 'task2' },
      input: { name: call.input.name, resumeFromRunId: 'wf_1abc1234', args: { ...args, clarifications: [answer] } } },
    rows: [...rows, next, end(next, pair ? { status: 'ok' } : { criteria: [{ id: 'C1' }] })],
    directory: snapshotRunDirectory(runDir, { repo, head }),
    state: { runId: 'wf_1abc1234', taskId: 'task2', status: 'completed', result: nextResult, workflowProgress },
    terminal: { line: 6, session: 's1', taskId: 'task2', status: 'completed' },
  }
  assert.equal(judgeFirstLeg(id, first).status, 'pass')
  return { first, resumed }
}

for (const id of ['L2-ii', 'L2-iii']) {
  test(`${id} baseline answered resume passes`, t => {
    const { first, resumed } = answered(t, id)
    const judged = judgeResume(id, first, resumed)
    assert.equal(judged.status, 'pass', judged.reason)
  })

  test(`${id} resume must name the parent's run id`, t => {
    const { first, resumed } = answered(t, id)
    resumed.call.input.resumeFromRunId = 'wf_other999'
    assert.equal(judgeResume(id, first, resumed).status, 'fail')
  })

  test(`${id} resume must run in the original session`, t => {
    const { first, resumed } = answered(t, id)
    resumed.call.session = 's2'
    assert.equal(judgeResume(id, first, resumed).status, 'fail')
  })
}

test('L2-ii design answer must carry implement:true', t => {
  const { first, resumed } = answered(t, 'L2-ii')
  delete resumed.call.input.args.clarifications[0].implement
  assert.equal(judgeResume('L2-ii', first, resumed).status, 'fail')
})

test('L2-iii resume must complete spec amendment with criteria', t => {
  const { first, resumed } = answered(t, 'L2-iii')
  resumed.rows.at(-1).result = { criteria: [] }
  assert.equal(judgeResume('L2-iii', first, resumed).status, 'fail')
})
