import test from 'node:test'
import assert from 'node:assert/strict'
import { simulate } from './fixtures/simulate.mjs'
import { parseCLI } from '../plugins/dark-factory/lib/codex-runner.mjs'

const task = 'Show the retry count in the debug log.'
const outcome = 'Log one entry per retry.'
const purpose = 'Help an operator diagnose repeated requests.'

test('brief clear goal reaches independent and Pair judgments', async () => {
  for (const pair of [false, true]) {
    const { result, calls } = await simulate('factory', { task }, { pair, modify(v, r) {
      if (r.label === 'brief shape') v.brief.outcome = 'Log all attempts.'
      if (r.label === 'brief challenge') {
        assert.match(r.prompt, /Log all attempts/)
        v.brief.outcome = outcome // The logging convention in the repository settles this.
      }
    } })
    assert.deepEqual(calls.slice(0, 3).map(r => r.label), ['brief shape', 'brief challenge', 'intake'])
    assert.equal(calls.filter(r => r.label?.startsWith('brief ')).length, 2)
    assert.ok(calls.slice(0, 2).every(r => r.fresh && !r.resumeSession && !r.threadKey))
    assert.deepEqual(result.questions || [], [])
    assert.equal(result.final.readiness.state, 'ready')
    assert.equal(result.task, task)
    const { brief } = result.brief
    assert.deepEqual(brief, { outcome, purpose, scope: 'Retries only.', nonGoals: 'Changing retry timing.',
      acceptanceExamples: ['Retry two logs count 2.'], verification: 'Observe the debug entry after a retry.',
      delegated: ['testing', 'implementation', 'internal design'] })
    for (const role of pair ? ['setup', 'author', 'reviewer', 'spec'] : ['setup', 'seat', 'auditor']) {
      const requests = calls.filter(r => r.role === role)
      assert.ok(requests.length, role)
      assert.ok(requests.every(r => r.prompt.includes(outcome) && r.prompt.includes(purpose)), role)
    }
    assert.ok(calls[2].prompt.includes(outcome) && calls[2].prompt.includes(purpose))
    const story = result.report.markdown.split('How the run went')[1]
    for (const value of [...Object.values(brief).flat(), result.briefFile]) assert.ok(story.includes(value), value)
  }
})

test('brief challenge stops once with both differences before a pinned tier', async () => {
  const make = (question, outcomeA, outcomeB) => ({ question, wording: 'Look into missing pages', outcomeA, outcomeB,
    evidence: 'No contract in the page reader or its history.', recommendation: outcomeA, changes: 'Determines the accepted deliverable.' })
  const batch = [make('What should ship?', 'Root-cause report', 'Integrated fix'), make('Which pages?', 'Archived and current pages', 'Current pages only')]
  const args = { task: 'Look into missing pages', tier: 'fix' }
  const { result, calls } = await simulate('factory', args, { modify(v, r) { if (r.label === 'brief challenge') v.questions = batch } })
  assert.equal(result.status, 'needs-user')
  assert.equal(result.brief.state, 'provisional')
  assert.deepEqual(calls.map(r => r.label), ['brief shape', 'brief challenge'])
  assert.deepEqual(result.questions, batch.map((q, i) => ({ ...q, id: 'B' + (i + 1), kind: 'brief' })))
  for (const term of ['wording', 'two plausible outcomes', 'user would judge differently', 'delivery or acceptance',
    'code', 'docs', 'git log', 'retros', 'issues', 'what/why', 'testing', 'implementation', 'internal design', 'preferences', 'speculative']) {
    assert.ok(calls[1].prompt.includes(term), term)
  }
  for (const broken of [{ fail: r => r.label === 'brief challenge' },
    { modify(v, r) { if (r.label === 'brief challenge') v.questions = [{ ...batch[0], changes: '' }] } }]) {
    const bad = await simulate('factory', args, broken)
    assert.equal(bad.result.status, 'failed')
    assert.deepEqual(bad.calls.map(r => r.label), ['brief shape', 'brief challenge'])
  }
})

test('brief opt-out matches string, object and CLI forms', async () => {
  for (const flags of [['--no-brief', '--tier', 'simple', '--explain'], ['--explain', '--tier', 'simple', '--no-brief']]) {
    const object = { task, tier: 'simple', explain: true, brief: false }
    const cli = parseCLI([...flags, task])
    assert.deepEqual(cli.args, object)
    for (const args of [object, cli.args, [...flags, task].join(' ')]) {
      const { calls, result } = await simulate('factory', args, { native: typeof args === 'string' })
      assert.deepEqual(calls.map(r => r.label), ['intake'])
      assert.deepEqual([result.task, result.status, result.plan.tier], [task, 'explained', 'simple'])
      assert.equal(result.briefFile, undefined)
    }
  }
  const direct = await simulate('factory', parseCLI(['--no-brief', task]).args)
  assert.equal(direct.calls[0].label, 'intake')
  assert.equal(direct.result.final.readiness.state, 'ready')
  assert.equal(direct.result.brief, undefined)
  const compact = parseCLI(['--brief', '--explain', task])
  assert.equal(compact.brief, true)
  assert.deepEqual((await simulate('factory', compact.args)).calls.map(r => r.label), ['brief shape', 'brief challenge', 'intake'])
})
