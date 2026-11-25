// The goal stage (src/goal.js) and the groomed ticket (src/lib/groom.js): the ticket's parser and
// renderer, decision numbering and re-check verdicts, and the stage as Factory, a standalone Pair or
// council run and the Brief workflow settle it, on the built workflows with scripted turns.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadLib } from './lib.mjs'
import { simulate } from './fixtures/simulate.mjs'
import { launchRequirements } from '../plugins/dark-factory/lib/policy.mjs'

const L = loadLib()
const BRIEF = { outcome: 'Emit the retry count in the debug log.', purpose: 'Help an operator diagnose repeated requests.',
  scope: 'Retries only.', nonGoals: 'Changing retry timing.', acceptanceExamples: ['Retry two logs count 2.', 'No retry logs nothing.'],
  verification: 'Observe the debug entry after a retry.', delegated: ['testing', 'implementation', 'internal design'] }
const DECISIONS = [{ id: 'G1', question: 'Count or list?', answer: 'A number.' }, { id: 'G2', question: 'Which level?', answer: 'Debug.' }]
const ticket = (decisions = DECISIONS, title = 'Log the retry count') => L.renderTicket(title, { version: 1, state: 'settled', brief: BRIEF, decisions })
const QUESTION = { question: 'Count or list?', wording: 'retry count', outcomeA: 'a number', outcomeB: 'a list of attempts',
  evidence: 'No logging convention settles it.', recommendation: 'a number', changes: 'What the log line shows.' }
const labels = r => r.calls.map(c => c.label)
const SAVED = '/repo/.council/host-test/BRIEF.json'
const held = (...ids) => ids.map(([id, status]) => ({ id, status, reason: `${id} ${status}.` }))

// ---------------------------------------------------------------- the ticket

test('a rendered ticket parses back to its title, brief and decisions', () => {
  const text = ticket()
  assert.ok(text.trimEnd().endsWith('Groomed by dark-factory'))
  assert.deepEqual(L.parseGroomedTicket(text), { title: 'Log the retry count', brief: BRIEF, decisions: DECISIONS })
  assert.deepEqual(L.parseGroomedTicket(ticket([])), { title: 'Log the retry count', brief: BRIEF, decisions: [] }, '"None." is no decision')
  assert.deepEqual(L.parseGroomedTicket(text.replace(/\n/g, '\r\n')), L.parseGroomedTicket(text), 'CRLF line ends')
  assert.equal(L.ticketTitleOf('\n  Log the retry count\nmore'), 'Log the retry count')
})

test('a ticket in Jira wiki markup parses to the same brief', () => {
  const jira = `h1. Log the retry count

h2. Outcome
Emit the retry count in the debug log.

h2. Why
Help an operator diagnose repeated requests.

*Scope*
Retries only.

Out of scope:
Changing retry timing.

h2. Acceptance examples
* Retry two logs count 2.
* No retry logs
  nothing.

h2. How we’ll know it’s done
Observe the debug entry after a retry.

h3. Left to the implementers
# testing
# implementation
# internal design

h2. Decisions
* G1: Count or list? -> A number.
* G2. Which level? → Debug.

----
_Groomed by dark-factory on 2026-11-25_
`
  assert.deepEqual(L.parseGroomedTicket(jira), { title: 'Log the retry count', brief: BRIEF, decisions: DECISIONS })
})

test('a ticket without the footer, a section or a delegated item is not groomed', () => {
  const text = ticket()
  assert.equal(L.parseGroomedTicket(text.replace('Groomed by dark-factory', 'Reviewed by hand')), null, 'no footer')
  assert.equal(L.parseGroomedTicket(text.replace(/## Left to the implementers\n\n(- .*\n)+\n/, '')), null, 'no "Left to the implementers"')
  assert.equal(L.parseGroomedTicket(text.replace(/(## Left to the implementers\n\n)(- .*\n)+/, '$1')), null, 'an empty "Left to the implementers"')
  assert.equal(L.parseGroomedTicket(text.replace(/## Why\n\n.*\n\n/, '')), null, 'no "Why"')
  assert.equal(L.parseGroomedTicket(text.replace('## Scope\n\nRetries only.', '## Scope\n\n')), null, 'an empty section')
  assert.deepEqual(L.parseGroomedTicket(text + '\n## Scope\n\nAgain.\n'), L.parseGroomedTicket(text), 'text after the footer is ignored')
  assert.equal(L.parseGroomedTicket(text.replace('## Why', '## Scope\n\nTwice.\n\n## Why')), null, 'a repeated section')
  assert.equal(L.parseGroomedTicket(text.replace('- G2: Which level? → Debug.', '- G2: Which level? Debug.')), null, 'a decision with no arrow')
  assert.equal(L.parseGroomedTicket(text.replace('- G2:', '- G1:')), null, 'a repeated decision ID')
  assert.equal(L.parseGroomedTicket(''), null)
  assert.equal(L.parseGroomedTicket('Log the retry count'), null)
})

test('a decision answer keeps every arrow after the first', () => {
  const text = ticket().replace('- G2: Which level? → Debug.', '- G2: Which level? → Debug → then info -> after a week.')
  assert.deepEqual(L.parseGroomedTicket(text).decisions[1], { id: 'G2', question: 'Which level?', answer: 'Debug → then info -> after a week.' })
  const rendered = { id: 'B4', question: 'Map a → b?', answer: 'Yes.' }
  assert.deepEqual(L.parseGroomedTicket(ticket([rendered])).decisions, [{ id: 'B4', question: 'Map a', answer: 'b? → Yes.' }],
    'the first arrow splits, even one inside the question')
})

test('new decision IDs follow every ID with the prefix', () => {
  assert.deepEqual(L.nextDecisionIds([{ id: 'G1' }, { id: 'G3' }], 'G', 1), ['G4'])
  assert.deepEqual(L.nextDecisionIds([{ id: 'G3' }, { id: 'G1' }, { id: 'B7' }], 'G', 2), ['G4', 'G5'])
  assert.deepEqual(L.nextDecisionIds([{ id: 'B7' }], 'G', 1), ['G1'], 'another prefix does not count')
  assert.deepEqual(L.nextDecisionIds([], 'B', 0), [])
})

test('a re-check rules once on every carried decision, with a known status and a reason', () => {
  assert.deepEqual(L.heldDecisions(DECISIONS, held(['G2', 'holds'], ['G1', 'obsolete'])), [DECISIONS[1]])
  assert.deepEqual(L.heldDecisions(DECISIONS, held(['G1', 'holds'], ['G2', 'superseded'])), [DECISIONS[0]])
  assert.deepEqual(L.heldDecisions([], []), [])
  for (const [why, review] of [
    ['a missing verdict', held(['G1', 'holds'])],
    ['a duplicate verdict', held(['G1', 'holds'], ['G1', 'obsolete'])],
    ['an unknown decision', held(['G1', 'holds'], ['G9', 'holds'])],
    ['an unknown status', held(['G1', 'holds'], ['G2', 'kept'])],
    ['no reason', [...held(['G1', 'holds']), { id: 'G2', status: 'holds', reason: ' ' }]],
    ['no list', undefined],
  ]) assert.equal(L.heldDecisions(DECISIONS, review), null, why)
})

// ---------------------------------------------------------------- Factory

test('Factory re-checks a groomed ticket instead of shaping it, drops an obsolete decision and hands back the ticket', async () => {
  const { result, calls } = await simulate('factory', { task: ticket() }, { modify(v, r) {
    if (r.label === 'brief recheck') v.decisionReview = held(['G1', 'holds'], ['G2', 'obsolete'])
  } })
  assert.deepEqual(labels({ calls }).slice(0, 3), ['brief recheck', 'intake', 'setup'])
  const recheck = calls[0].prompt
  assert.ok(recheck.includes('from a groomed ticket') && recheck.includes(JSON.stringify(DECISIONS)) && !recheck.includes('--reuse'))
  assert.equal(result.final.readiness.state, 'ready')
  assert.deepEqual(result.brief.decisions, [DECISIONS[0]])
  assert.deepEqual(L.parseGroomedTicket(result.ticket), { title: 'Log the retry count', brief: result.brief.brief, decisions: [DECISIONS[0]] })
  assert.ok(result.report.markdown.includes('Earlier decision G2 no longer applies (obsolete): G2 obsolete.'))
  assert.ok(!result.report.markdown.includes('Earlier decision G1'))

  const incomplete = await simulate('factory', { task: ticket() }, { modify(v, r) { if (r.label === 'brief recheck') v.decisionReview = held(['G1', 'holds']) } })
  assert.deepEqual([incomplete.result.status, labels(incomplete)], ['failed', ['brief recheck']])
  assert.match(incomplete.result.reason || incomplete.result.error, /re-check returned no usable verdict/)
})

test('natively a groomed ticket\'s re-check must save exactly the decisions that hold', async () => {
  const recheck = savedDecisions => ({ native: true, modify(v, r) {
    if (r.label === 'brief recheck') Object.assign(v, { decisionReview: held(['G1', 'holds'], ['G2', 'obsolete']), briefFile: SAVED, savedDecisions })
  } })
  // Natively the stub runs stop at intake: an explanation runs no tier.
  const kept = await simulate('factory', { task: ticket(), explain: true }, recheck([DECISIONS[0]]))
  assert.deepEqual(labels(kept).slice(0, 2), ['brief recheck', 'intake'])
  assert.ok(kept.calls[0].prompt.includes('Copy the printed document.decisions into savedDecisions.'))
  assert.deepEqual([kept.result.status, kept.result.brief.decisions, kept.result.briefFile.endsWith('/BRIEF.json')], ['explained', [DECISIONS[0]], true])
  for (const wrong of [[], DECISIONS, [{ ...DECISIONS[0], answer: 'A list.' }]]) {
    const bad = await simulate('factory', { task: ticket(), explain: true }, recheck(wrong))
    assert.deepEqual([bad.result.status, labels(bad)], ['failed', ['brief recheck']])
    assert.equal(bad.result.reason || bad.result.error, 'The saved goal brief does not keep exactly the carried decisions that hold.')
  }
})

const DOC = { version: 1, state: 'settled', brief: BRIEF, decisions: [{ id: 'B1', question: 'Count or list?', answer: 'A number.' }] }

test('a brief file that other inputs bear on is loaded, then re-checked once, before intake', async () => {
  const requests = []
  const brief = async request => {
    requests.push(request.source ? { source: request.source } : { state: request.document.state, decisions: request.document.decisions })
    return request.source ? { document: DOC, briefFile: request.source } : { document: request.document, briefFile: SAVED }
  }
  const args = { brief: SAVED, criteria: ['The boundary works.'] }
  const { result, calls } = await simulate('factory', args, { brief, modify(v, r) {
    if (r.label === 'brief recheck') v.decisionReview = held(['B1', 'holds'])
  } })
  assert.deepEqual(labels({ calls }).slice(0, 2), ['brief recheck', 'intake'])
  assert.deepEqual(requests, [{ source: SAVED }, { state: 'settled', decisions: DOC.decisions }])
  assert.ok(calls[0].prompt.includes(JSON.stringify(BRIEF)) && calls[0].prompt.includes('The boundary works.') && !calls[0].prompt.includes('--reuse'))
  assert.ok(!calls[1].prompt.includes('--reuse'))
  assert.deepEqual([result.final.readiness.state, result.brief.decisions, result.ticket], ['ready', DOC.decisions, undefined], 'no ticket without a groomed task')

  // Natively the re-check turn loads the file itself, and intake does not load it again.
  const native = await simulate('factory', { ...args, explain: true }, { native: true, modify(v, r) {
    if (r.label === 'brief recheck') Object.assign(v, { document: DOC, decisionReview: held(['B1', 'holds']), briefFile: SAVED, savedDecisions: DOC.decisions })
  } })
  assert.deepEqual(labels(native).slice(0, 2), ['brief recheck', 'intake'])
  assert.ok(native.calls[0].prompt.includes(`brief --repo "$PWD" --reuse '${SAVED}'`) && 'document' in native.calls[0].schema.properties)
  assert.ok(!native.calls[1].prompt.includes('--reuse') && !('document' in native.calls[1].schema.properties))
  assert.deepEqual([native.result.status, native.result.brief.decisions], ['explained', DOC.decisions])
  const unread = await simulate('factory', { ...args, explain: true }, { native: true, modify(v, r) {
    if (r.label === 'brief recheck') Object.assign(v, { decisionReview: [], briefFile: SAVED })
  } })
  assert.deepEqual([unread.result.status, labels(unread)], ['failed', ['brief recheck']], 'a re-check that read no document')
})

test('a brief file with no other goal input costs Factory no brief turn', async () => {
  const requests = []
  const brief = async request => { requests.push(Object.keys(request)); return { document: DOC, briefFile: request.source } }
  const hosted = await simulate('factory', { brief: SAVED }, { brief })
  assert.deepEqual([labels(hosted)[0], requests, hosted.result.status], ['intake', [['source']], 'done'])
  const native = await simulate('factory', { brief: SAVED, explain: true }, { native: true, modify(v, r) {
    if (r.label === 'intake') Object.assign(v, { document: DOC, briefFile: SAVED })
  } })
  assert.equal(labels(native)[0], 'intake')
  assert.ok(native.calls[0].prompt.includes(`--reuse '${SAVED}'`))
  assert.deepEqual([native.result.status, native.result.brief.decisions], ['explained', DOC.decisions])
  for (const bad of ['BRIEF.json', 7]) {
    const out = await simulate('factory', { brief: bad })
    assert.deepEqual([out.result.status, labels(out)], ['failed', []], String(bad))
  }
})

// ---------------------------------------------------------------- standalone Pair and council

test('a standalone Pair or council run shapes and challenges its goal before setup, and returns the brief', async () => {
  for (const workflow of ['pair', 'council']) {
    const { result, calls } = await simulate(workflow, { brief: undefined })
    assert.deepEqual(labels({ calls }).slice(0, 3), ['brief shape', 'brief challenge', 'setup'], workflow)
    assert.deepEqual(calls.slice(0, 3).map(c => c.role), ['intake', 'intake', 'setup'], `${workflow}: the goal turns run as the read-only intake role`)
    assert.ok(calls[2].prompt.includes(`--ref '${SAVED}'`) && calls[2].prompt.includes('Emit the retry count in the debug log.'), workflow)
    assert.equal(result.final.readiness.state, 'ready', workflow)
    assert.deepEqual([result.brief.state, result.brief.brief.outcome, result.briefFile], ['settled', 'Emit the retry count in the debug log.', '/repo/.council/demo/refs/BRIEF.json'], workflow)
    assert.ok(result.report.markdown.includes('Brief file: /repo/.council/demo/refs/BRIEF.json'), workflow)
    assert.equal(result.ticket, undefined, workflow)
    const off = await simulate(workflow, { brief: false })
    assert.equal(labels(off)[0], 'setup', workflow)
    assert.equal(off.result.brief, undefined, workflow)
  }
  const groomed = await simulate('pair', { task: ticket(), brief: undefined }, { modify(v, r) {
    if (r.label === 'brief recheck') v.decisionReview = held(['G1', 'holds'], ['G2', 'holds'])
  } })
  assert.deepEqual(labels(groomed).slice(0, 2), ['brief recheck', 'setup'])
  assert.deepEqual(L.parseGroomedTicket(groomed.result.ticket).decisions, DECISIONS)
})

test('a Pair brief question answered as B1 is taken by the brief, never by Pair\'s own answer check', async () => {
  const asked = { modify(v, r) { if (r.label === 'brief challenge') v.questions = [QUESTION] } }
  const stopped = await simulate('pair', { brief: undefined }, asked)
  assert.deepEqual([stopped.result.status, labels(stopped), stopped.result.questions.map(q => [q.id, q.kind])],
    ['needs-user', ['brief shape', 'brief challenge'], [['B1', 'brief']]])
  assert.equal(stopped.result.brief.state, 'provisional')
  const answered = await simulate('pair', { brief: undefined, clarifications: [{ id: 'B1', answer: 'A number.' }] }, asked)
  assert.deepEqual(labels(answered).slice(0, 4), ['brief shape', 'brief challenge', 'brief answered', 'setup'])
  assert.equal(answered.result.status, 'done')
  assert.equal(answered.result.final.readiness.state, 'ready')
  assert.deepEqual(answered.result.brief.decisions, [{ id: 'B1', question: QUESTION.question, answer: 'A number.' }])
  assert.doesNotMatch(JSON.stringify(answered.result), /Unknown: B1|Unused answers: B1/)
})

test('--no-brief skips the goal stage of a string Pair task', async () => {
  for (const args of ['--no-retro --no-brief Fix the boundary', '--no-brief --no-retro Fix the boundary']) {
    const { result, calls } = await simulate('pair', args)
    assert.deepEqual([labels({ calls })[0], result.task, result.brief], ['setup', 'Fix the boundary', undefined], args)
  }
  assert.deepEqual(labels(await simulate('pair', '--no-retro Fix the boundary')).slice(0, 2), ['brief shape', 'brief challenge'])
})

// ---------------------------------------------------------------- the Brief workflow

test('the Brief workflow returns a ready ticket, or the questions with G IDs, and takes their answers on resume', async () => {
  const ready = await simulate('brief', { task: 'Log the retry count' }, { modify(v, r) { if (r.label === 'brief shape') v.title = 'Retry count in the debug log' } })
  assert.deepEqual(labels(ready), ['brief shape', 'brief challenge'])
  assert.ok(ready.calls[0].prompt.includes('notActionable') && ready.calls[1].prompt.includes('separate tickets'))
  assert.deepEqual([ready.result.status, ready.result.verdict, ready.result.split, ready.result.droppedDecisions], ['done', 'ready', [], []])
  assert.deepEqual(L.parseGroomedTicket(ready.result.ticket), { title: 'Retry count in the debug log', brief: ready.result.brief.brief, decisions: [] })
  assert.ok(ready.result.report.markdown.includes('Verdict: ready.') && ready.result.briefFile)

  const asked = { modify(v, r) { if (r.label === 'brief challenge') v.questions = [QUESTION, { ...QUESTION, question: 'Which level?' }] } }
  const open = await simulate('brief', { task: 'Log the retry count' }, asked)
  assert.deepEqual([open.result.status, open.result.verdict, open.result.questions.map(q => q.id)], ['needs-user', 'needs-answers', ['G1', 'G2']])
  assert.ok(open.result.report.markdown.includes('Open questions: G1 Count or list?; G2 Which level?.'))
  assert.ok(open.result.forTheOrchestrator.includes('clarifications') && open.result.brief.state === 'provisional')
  assert.match(open.result.ticket, /# Log the retry count/, 'the ticket as it stands, titled by the task')

  const partly = await simulate('brief', { task: 'Log the retry count', clarifications: [{ id: 'G1', answer: 'A number.' }] }, asked)
  assert.deepEqual([partly.result.verdict, partly.result.questions.map(q => q.id), labels(partly).length], ['needs-answers', ['G2'], 2])
  const answers = [{ id: 'G1', answer: 'A number.' }, { id: 'G2', answer: 'Debug.' }]
  const done = await simulate('brief', { task: 'Log the retry count', clarifications: answers }, asked)
  assert.deepEqual(labels(done), ['brief shape', 'brief challenge', 'brief answered'])
  assert.deepEqual([done.result.verdict, done.result.brief.state], ['ready', 'settled'])
  assert.deepEqual(L.parseGroomedTicket(done.result.ticket).decisions, [{ id: 'G1', question: 'Count or list?', answer: 'A number.' }, { id: 'G2', question: 'Which level?', answer: 'Debug.' }])
})

test('the Brief workflow asks for a split, stops on a text with no outcome, and refuses a brief file', async () => {
  const pieces = [{ title: 'Retry count', task: 'Log the retry count.' }, { title: 'Timeouts', task: 'Raise the timeout to 30s.' }]
  const split = await simulate('brief', { task: 'Log the retry count and raise the timeout' }, { modify(v, r) {
    if (r.label === 'brief challenge') { v.split = [...pieces, { title: '', task: 'dropped' }]; v.questions = [QUESTION] }
  } })
  assert.deepEqual([split.result.verdict, split.result.split, split.result.questions.map(q => q.id)], ['needs-split', pieces, ['G1']])
  assert.ok(split.result.report.markdown.includes('2 separate pieces of work: Retry count; Timeouts.'))
  assert.ok(split.result.forTheOrchestrator.includes('Do not hand the bundled ticket'))

  const vague = await simulate('brief', { task: 'Make it better' }, { modify(v, r) { if (r.label === 'brief shape') v.notActionable = 'It names nothing to change.' } })
  assert.deepEqual([vague.result.status, vague.result.verdict, labels(vague), vague.result.ticket], ['not-actionable', 'not-actionable', ['brief shape'], undefined])
  assert.ok(vague.result.forTheOrchestrator.includes('It names nothing to change.'))

  for (const brief of [SAVED, false]) {
    const refused = await simulate('brief', { task: 'Log the retry count', brief })
    assert.deepEqual([refused.result.status, refused.result.verdict, labels(refused)], ['failed', 'failed', []], String(brief))
  }
})

test('the Brief workflow re-checks a groomed ticket: a superseded decision is dropped and its question numbered after it', async () => {
  const replaced = { ...QUESTION, question: 'Count, or count and delays?' }
  const { result, calls } = await simulate('brief', { task: ticket().replace('Retries only.', 'Retries and their delays.') }, { modify(v, r) {
    if (r.label === 'brief recheck') { v.decisionReview = held(['G1', 'superseded'], ['G2', 'holds']); v.questions = [replaced] }
  } })
  assert.deepEqual(labels({ calls }), ['brief recheck'])
  assert.ok(calls[0].prompt.includes('Retries and their delays.') && calls[0].prompt.includes('separate tickets'))
  assert.deepEqual([result.verdict, result.questions.map(q => q.id)], ['needs-answers', ['G3']])
  assert.deepEqual(result.droppedDecisions, held(['G1', 'superseded']))
  assert.deepEqual(result.brief.decisions, [DECISIONS[1]])
  assert.deepEqual(result.decisions, [DECISIONS[1]])
  assert.deepEqual(L.parseGroomedTicket(result.ticket).decisions, [DECISIONS[1]])
  assert.ok(result.ticket.startsWith('# Log the retry count\n'))

  // A ticket pasted from Jira's description field, without its title line, is titled by its outcome.
  const untitled = await simulate('brief', { task: ticket().replace(/^# .*\n\n/, '') }, { modify(v, r) { if (r.label === 'brief recheck') v.decisionReview = held(['G1', 'holds'], ['G2', 'holds']) } })
  assert.ok(untitled.calls[0].prompt.includes('from a groomed ticket'))
  assert.deepEqual([untitled.result.verdict, L.parseGroomedTicket(untitled.result.ticket).title], ['ready', BRIEF.outcome])

  const answered = await simulate('brief', { task: ticket(), clarifications: [{ id: 'G3', answer: 'Count only.' }] }, { modify(v, r) {
    if (r.label === 'brief recheck') { v.decisionReview = held(['G1', 'superseded'], ['G2', 'holds']); v.questions = [replaced] }
  } })
  assert.deepEqual([labels(answered), answered.result.verdict], [['brief recheck', 'brief answered'], 'ready'])
  assert.deepEqual(L.parseGroomedTicket(answered.result.ticket).decisions.map(d => d.id), ['G2', 'G3'])
})

test('a native Brief pass saves through the helper and checks the saved file', async () => {
  const ok = await simulate('brief', { task: 'Log the retry count' }, { native: true, modify(v, r) { if (r.label === 'brief challenge') v.briefFile = SAVED } })
  assert.deepEqual([ok.result.verdict, ok.result.briefFile], ['ready', SAVED])
  assert.ok(ok.calls[1].prompt.includes(' brief --repo "$PWD" --content FILE --state STATE --decisions \'[]\''))
  const unsaved = await simulate('brief', { task: 'Log the retry count' }, { native: true })
  assert.deepEqual([unsaved.result.status, unsaved.result.verdict], ['failed', 'failed'])
})

// ---------------------------------------------------------------- launch requirements

test('launch requirements reach the intake route for every goal stage brief: false leaves out', () => {
  const vendors = (workflow, args = {}) => launchRequirements({}, { workflow, args: { task: 'x', ...args } }).vendors
  assert.deepEqual(vendors('brief'), { codex: ['intake'] }, 'a grooming pass needs only the goal turns')
  for (const workflow of ['pair', 'council']) {
    const all = Object.values(vendors(workflow)).flat(), off = Object.values(vendors(workflow, { brief: false })).flat()
    assert.ok(all.includes('intake') && all.includes('setup'), workflow)
    assert.ok(!off.includes('intake') && off.includes('setup'), `${workflow} with brief: false`)
  }
  assert.ok(vendors('factory', { brief: false }).codex.includes('intake'), 'Factory always runs intake')
})
