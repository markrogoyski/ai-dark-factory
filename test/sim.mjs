// Offline simulation of workflows/council.js: runs the real script with stub agents, through
// scripted scenarios, and asserts on control flow, ledger rulings, scorecards and prompts.
// No models are called.   node test/sim.mjs

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, utimesSync, chmodSync, realpathSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
// bin/dark-factory polls on a timer; shorten it so the CLI scenarios don't sit sleeping. Children inherit this.
process.env.COUNCIL_JOB_POLL ??= '0.05'
process.env.COUNCIL_TRANSCRIPT_POLL ??= '0.05'
process.env.COUNCIL_TRANSCRIPT_WAIT ??= '1'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const load = file => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
  readFileSync(join(here, '..', 'plugins', 'dark-factory', 'workflows', file), 'utf8').replace(/^export const meta\s*=/m, 'const meta ='))
const SCRIPTS = { council: load('council.js'), factory: load('factory.js') }

// ---------------------------------------------------------------- helpers shared with council.js

function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h = (h ^ str.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0 } return h }
const normalize = t => String(t).replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '')
const promptHash = t => { const n = normalize(t); return `${n.length}-${fnv(n).toString(16).padStart(8, '0')}` }
const MODEL_LEAK = /\b(Opus|Sonnet|Astra|Sol|Luna|Claude|Codex|Gemini|Flash|gpt-[\w.-]+|gemini-[\w.-]+)\b/

const RELAY_PROMPTS = []   // every relay prompt the scenarios produced, for scenarioTranscript
const RETRO_PROMPTS = []   // every retro prompt, for scenarioRetroSave
const RECORD_PROMPTS = []  // every factory facts-record prompt, for scenarioFactsSave

// What an auditor returns unless the scenario handles audit turns itself (hooks.audit).
const CLEAN_AUDIT = () => ({ summary: 'No problems found.', findings: [], tests: [], probes: [] })

// What a spec reviewer returns unless the scenario handles spec turns itself (hooks.spec).
const CLEAN_SPEC = () => ({ summary: 'The criteria are sound.', findings: [] })

// What the retro agent returns unless a scenario says otherwise.
const RETRO = () => ({
  worked: [{ what: 'Neutral checks caught a false claim', evidence: 'check r1:D' }],
  changes: [{ change: 'Cap the ledger digest by relevance, not by count', why: 'Seats re-read the room to find cut items.', evidence: 'r1:C.', where: 'the debate prompt' }],
  saved: '/x/retros/test.md', error: '',
})
const PAYLOAD_RE = /=====BEGIN PAYLOAD (\S+)=====\n([\s\S]*)\n=====END PAYLOAD \1=====/
const schemaIn = payload => JSON.parse(payload.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])

function itemIds(prompt) {
  const sec = prompt.split('# Step 2')[1] || ''
  return [...sec.matchAll(/^- \[([A-Za-z0-9]+)\]/gm)].map(m => m[1])
}

// ---------------------------------------------------------------- golden prompts
// The prompts are the product, and the retros drive changes to them. For the runs named here, the
// first prompt of each kind (role, round, Claude or relay vendor) is compared with a file under
// test/golden/<run>/, so a stray ${}, a dropped section or a reworded rule shows up as a diff to
// review. After an intended change: UPDATE_GOLDEN=1 node test/sim.mjs, then read `git diff test/golden`.

const GOLDEN_DIR = join(here, 'golden')
// run name -> the prompt kinds kept (null: every kind). One run covers the Claude and the
// external (Codex, Gemini) form of each of them; the others add the kinds it doesn't reach.
const GOLDEN_RUNS = new Map([
  ['consensus', null],
  ['deadlock', ['panel', 'fix', 'check']],
  ['focus', ['debate']],
  ['escalation', ['setup', 'cluster']],
  ['test-ballot', ['ballot']],
  ['blind', ['synth', 'ratify']],
  ['audit', ['audit', 'reaudit', 'auditfix', 'panel']],
  ['spec', ['spec', 'specamend', 'panel']],
  ['factory-simple', null],
  ['factory-findings', ['audit', 'auditfix', 'panel']],
  ['factory-escalate', ['setup', 'solve']],
  ['factory-feature', null],
  ['factory-feature-hard', ['build', 'auditfix']],
  ['factory-architecture', null],
])
const UPDATE_GOLDEN = !!process.env.UPDATE_GOLDEN

function goldenKey(c) {
  const r = c.role
  return [r.kind, r.round ?? r.tag ?? '', /\(relay/.test(c.label) ? 'external' : 'claude'].filter(x => x !== '').join('.')
}

function checkGoldens(name, calls) {
  const dir = join(GOLDEN_DIR, name)
  const seen = new Map()
  const kinds = GOLDEN_RUNS.get(name)
  for (const c of calls) {
    if (kinds && !kinds.includes(c.role.kind)) continue
    const key = goldenKey(c)
    if (!seen.has(key)) seen.set(key, c.prompt)           // for a relay turn, the payload for the other model
    // The relay's own instructions, once per vendor: they differ only by the CLI's name.
    const wrapper = `relay-wrapper.${c.role.key}`
    if (name === 'consensus' && /\(relay/.test(c.label) && c.role.kind === 'solve' && !seen.has(wrapper)) seen.set(wrapper, c.raw)
  }
  const problems = []
  if (UPDATE_GOLDEN) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const [key, text] of seen) writeFileSync(join(dir, `${key}.txt`), text.replace(/\n*$/, '\n'))
    return
  }
  const have = existsSync(dir) ? new Set(readdirSync(dir).map(f => f.replace(/\.txt$/, ''))) : new Set()
  for (const [key, text] of seen) {
    have.delete(key)
    const file = join(dir, `${key}.txt`)
    if (!existsSync(file)) { problems.push(`${name}/${key}: no golden file (UPDATE_GOLDEN=1 to create it)`); continue }
    const want = readFileSync(file, 'utf8'), got = text.replace(/\n*$/, '\n')
    if (want === got) continue
    const a = want.split('\n'), b = got.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    problems.push(`${name}/${key}: differs at line ${i + 1}\n    golden: ${(a[i] ?? '(end)').slice(0, 160)}\n    now:    ${(b[i] ?? '(end)').slice(0, 160)}`)
  }
  for (const key of have) problems.push(`${name}/${key}: golden file but no such prompt any more`)
  assert.deepEqual(problems, [], `${name}: prompts differ from test/golden (UPDATE_GOLDEN=1 node test/sim.mjs, then review the diff)`)
}

// ---------------------------------------------------------------- harness

// hooks.retro(prompt) stands in for the retro agent; the default returns RETRO(). hooks.allowThrown: the
// scenario expects thunks to throw inside parallel(). hooks.workflow: 'factory' runs workflows/factory.js.
async function run(name, scenario, args, hooks = {}) {
  const retroOn = !(args && typeof args === 'object' && args.retro === false)
  const calls = []
  const logs = []
  const leaks = []
  // The real runtime's parallel() catches a throwing thunk and returns null, and council.js catches
  // some agent() failures itself, so a TypeError in the script (or a failed assertion in a stub)
  // would look like a seat failing. Record every throw and fail the run at the end, unless the
  // scenario says it expects throws.
  const thrown = new Set()

  async function agent(prompt, opts = {}) {
    try { return await agentTurn(prompt, opts) } catch (e) { thrown.add(e); throw e }
  }

  async function agentTurn(prompt, opts = {}) {
    const label = opts.label || ''
    let p = prompt
    let relay = false
    let tag = null
    if (/\(relay/.test(label)) {
      relay = true
      const m = prompt.match(PAYLOAD_RE)
      assert.ok(m, `${label}: relay prompt has no payload`)
      p = m[2]
      const expect = prompt.match(/--expect (\S+)/)[1]
      assert.equal(promptHash(p), expect, `${label}: relay --expect does not match its payload`)
      assert.equal(m[1], expect, `${label}: payload markers don't carry the hash`)
      RELAY_PROMPTS.push(prompt)
      assert.ok(p.includes('<<<OUTPUT_SCHEMA'), `${label}: payload has no output schema`)
      assert.equal(opts.model, opts.model === 'sonnet' ? 'sonnet' : 'haiku')
      // Codex's structured output is strict: every property required.
      const inner = schemaIn(p)
      assert.equal('process' in inner.properties, retroOn, `${label}: Codex schema has a process field iff retro`)
      assert.deepEqual(inner.required.slice().sort(), Object.keys(inner.properties).sort(), `${label}: Codex schema not strict`)
      // Every external turn pins its own tag, so a stale answer from an earlier turn can't pass.
      tag = (p.match(/Set `turn` in your output to exactly "([^"]+)"\./) || [])[1]
      assert.ok(tag && /^[\w.-]+-[0-9a-f]{8}$/.test(tag), `${label}: no turn tag in the payload`)
      assert.deepEqual(inner.properties.turn && inner.properties.turn.enum, [tag], `${label}: turn tag is a one-value enum`)
    }
    const role = roleOf(label)
    if (role.kind === 'record') {
      assert.equal(calls.filter(c => ['retro', 'record'].includes(c.role.kind)).length, 0, 'one retro or record per run')
      RECORD_PROMPTS.push(prompt)
      calls.push({ label, role, prompt, opts })
      return { saved: '/x/retros/f.facts.json', error: '' }
    }
    if (role.kind === 'retro') {
      assert.equal(calls.filter(c => c.role.kind === 'retro').length, 0, 'one retro per run')
      RETRO_PROMPTS.push(prompt)
      calls.push({ label, role, prompt, opts })
      return hooks.retro ? hooks.retro(prompt, opts) : RETRO()
    }
    const s = opts.schema || {}
    assert.equal(!!(s.properties && s.properties.process), retroOn, `${label}: process field iff retro`)
    if (retroOn) assert.ok(s.required.includes('process'), `${label}: process field required`)
    if (['solve', 'debate', 'ballot', 'synth', 'fix', 'auditfix', 'ratify', 'build'].includes(role.kind) && MODEL_LEAK.test(p)) {
      leaks.push(`${label}: ${p.match(MODEL_LEAK)[0]}`)
    }
    calls.push({ label, role, prompt: p, raw: prompt, opts })
    const out = ['audit', 'reaudit'].includes(role.kind) && !hooks.audit ? CLEAN_AUDIT()
      : role.kind === 'spec' && !hooks.spec ? CLEAN_SPEC() : await scenario(role, p, opts)
    if (out === null) return null
    if (out && out.relayStatus) return out.relayStatus             // a relay that failed, as the relay reports it
    return relay ? { status: 'done', error: '', process: '', seconds: 42, result: { turn: tag, ...out } } : out
  }
  const parallel = async thunks => Promise.all(thunks.map(async t => { try { return await t() } catch (e) { thrown.add(e); return null } }))
  const pipeline = async () => { throw new Error('pipeline not expected') }
  const phase = t => logs.push(`[phase] ${t}`)
  const log = m => logs.push(m)

  const savedRandom = Math.random, savedNow = Date.now
  Math.random = () => { throw new Error('Math.random used') }
  Date.now = () => { throw new Error('Date.now used') }
  let result
  try {
    result = await SCRIPTS[hooks.workflow || 'council'](agent, parallel, pipeline, phase, log, args, { total: null, spent: () => 0, remaining: () => Infinity }, null)
  } finally {
    Math.random = savedRandom; Date.now = savedNow
    if (process.env.SHOW_LOGS) console.log(`\n===== ${name} log =====\n${logs.join('\n')}\n`)
  }
  if (!hooks.allowThrown) assert.deepEqual([...thrown].map(e => (e && e.stack) || String(e)), [], `${name}: a stub or thunk threw, which the workflow swallowed`)
  assert.deepEqual(leaks, [], `${name}: model identity leaked into seat prompts`)
  if (GOLDEN_RUNS.has(name)) checkGoldens(name, calls)
  if (process.env.SHOW_REPORT && result && result.report) console.log(`\n===== ${name} report =====\n${result.report.markdown}\n`)
  return { result, calls, logs }
}

function roleOf(label) {
  let m
  if (label === 'setup') return { kind: 'setup' }
  if (label === 'retro') return { kind: 'retro' }
  if (label === 'intake') return { kind: 'intake' }
  if (label === 'record') return { kind: 'record' }
  if ((m = label.match(/^r(\d+):([A-F]) (\w+)/))) return { kind: m[1] === '0' ? 'solve' : 'debate', round: +m[1], L: m[2], key: m[3] }
  if ((m = label.match(/^b(\d+):([A-F]) (\w+)/))) return { kind: 'ballot', round: +m[1], L: m[2], key: m[3] }
  if ((m = label.match(/^final2:([A-F]) (\w+)/))) return { kind: 'fix', L: m[1], key: m[2] }
  if ((m = label.match(/^final3:([A-F]) (\w+)/))) return { kind: 'auditfix', L: m[1], key: m[2] }
  if ((m = label.match(/^(audit|reaudit) (\w+): (\w+)/))) return { kind: m[1], tag: m[2], key: m[3] }
  if ((m = label.match(/^spec (\w+): (\w+)/))) return { kind: 'spec', tag: m[1], key: m[2] }
  if (label === 'spec amend') return { kind: 'specamend' }
  if ((m = label.match(/^final:([A-F]) (\w+)/))) return { kind: 'synth', L: m[1], key: m[2] }
  if ((m = label.match(/^inc(\d+):([A-F]) (\w+)/))) return { kind: 'build', round: +m[1], L: m[2], key: m[3] }
  if ((m = label.match(/^ratify:([A-F]) (\w+)/))) return { kind: 'ratify', L: m[1], key: m[2] }
  if ((m = label.match(/^check (\w+):([A-F])/))) return { kind: 'check', tag: m[1], L: m[2] }
  if ((m = label.match(/^panel (\w+): (\w+)/))) return { kind: 'panel', tag: m[1], member: m[2] }
  if ((m = label.match(/^questions (\w+)/))) return { kind: 'cluster', tag: m[1] }
  throw new Error(`unrecognised label: ${label}`)
}

// ---------------------------------------------------------------- canned outputs

const SETUP = runId => ({
  status: 'ok', error: '', runId, runDir: `/tmp/proj/.council/${runId}`, repoRoot: '/tmp/proj', dirty: [],
  verify: 'make test', baselinePasses: true, baselineNote: '',
  criteria: [{ id: 'C1', text: 'handles empty input' }, { id: 'C2', text: 'tests pass' }, { id: 'C3', text: 'no API change' }],
})
const solve = (L, extra = {}) => ({
  summary: `position ${L} v0`, claims: [{ kind: 'verification', statement: `${L}: suite passes`, evidence: 'make test → OK' }],
  tests: [], questions: [], confidence: 4, notes: `notes-${L}-r0`, ...extra,
})
const debate = (L, ship, extra = {}) => ({
  summary: `position ${L} revised`, changed: false, changeBasis: [], changeNote: '', findings: [], challenges: [],
  concessions: [], withdrawals: [], adopted: [], claims: [], tests: [],
  vote: { ship, amendments: [], reason: 'best' }, questions: [], seconds: [], notes: `notes-${L}-debate`, ...extra,
})
// o: {diff, postWords, criteria, suite} overrides. The delta mirrors `measure --since`, like the real CLI.
const check = (prompt, verdictFor = () => 'verified', fixedFor = () => 'no', crossFor = () => [], o = {}) => ({
  measured: true, diff: o.diff || { files: 1, added: 10, removed: 2 }, suite: o.suite || { ran: true, passed: true, tail: 'OK' },
  delta: (since => since ? { since, files: 1, added: 3, removed: 1 } : { since: '', files: 0, added: 0, removed: 0 })((prompt.match(/--since (\S+)/) || [])[1]),
  postWords: o.postWords || 500,
  crossTests: crossFor(),
  // Later rounds attach text to IDs, the way real checkers did: "1B3: the suite passes", "[1A2] …".
  rulings: itemIds(prompt).map((id, i) => ({
    claim: /^(T?0)/.test(id) ? id : (i % 2 ? `[${id}] checked it` : `${id}: checked it`),
    verdict: verdictFor(id), fixed: fixedFor(id), note: `checked ${id}`,
  })),
  criteria: o.criteria || [{ criterion: 'C1', status: 'met', note: '' }, { criterion: 'C2', status: 'met', note: '' }, { criterion: 'C3', status: 'partial', note: '' }],
})
const synth = () => ({ summary: 'final version', addressed: [], declined: [], adopted: [], claims: [{ kind: 'verification', statement: 'final suite passes', evidence: 'make test' }], notes: 'notes-final' })
const ratify = (endorse = true, objections = []) => ({ endorse, objections, note: endorse ? '' : 'disagree' })

// ---------------------------------------------------------------- scenario 1: consensus

async function scenarioConsensus() {
  const { result, calls, logs } = await run('consensus', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-consensus')
      case 'solve': return solve(role.L, { process: `Solve note from ${role.L}.`, ...(role.L === 'A'
        ? { tests: [{ id: 'T0A1', purpose: 'empty input returns []', command: 'phpunit T0A1Test.php' }] } : {}) })
      case 'check': return { ...check(prompt, () => 'verified', () => 'no',
        () => prompt.includes('--tests T0A1') ? [{ test: 'T0A1', outcome: ['A', 'B'].includes(role.L) ? 'pass' : 'fail', note: '' }] : []),
        process: role.tag === 'r1' && role.L === 'A' ? 'None.' : '' }
      case 'debate': {
        const ship = role.L === 'D' ? 'D' : 'B'
        const extra = role.L === 'C' ? { findings: [{ target: 'D', severity: 'major', kind: 'fact', statement: 'D breaks on empty input', evidence: 'T0A1 fails on D' }],
                                          adopted: [{ from: 'B', idea: 'guard clause' }],
                                          process: 'The digest cut the ledger at 25 items,\n so I re-read room/r0 to find 0D2.' } : {}
        return debate(role.L, ship, extra)
      }
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, 'Fix the empty-input crash in Parser::parse')

  assert.equal(result.status, 'converged', JSON.stringify(result.outcome))
  assert.equal(result.final.author, 'B')
  assert.equal(result.mode, 'implement')
  assert.equal(result.roundsRun, 1)
  assert.equal(result.final.endorsedBy.length, 3)
  assert.equal(result.final.fixPass, false)
  const seatsByL = Object.fromEntries(result.scorecards.seats.map(r => [r.seat, r]))
  assert.equal(seatsByL.C.findingsUpheld, 1, 'C finding upheld')
  assert.equal(seatsByL.B.ideasAdoptedByOthers, 1, 'B idea adopted by C')
  assert.equal(seatsByL.A.testsPublished, 1)
  // The default lineup: Opus, Sonnet, Astra and Gemini Flash, across three vendors.
  assert.deepEqual(result.seats.map(s => s.model).sort(), ['Claude Opus', 'Claude Sonnet', 'Codex Astra', 'Gemini Flash'])
  // Every Codex and Gemini seat went through a relay, every Claude seat did not.
  const codexSeats = result.seats.filter(s => s.vendor !== 'claude').map(s => s.seat)
  for (const c of calls.filter(c => ['solve', 'debate'].includes(c.role.kind))) {
    assert.equal(/\(relay/.test(c.label), codexSeats.includes(c.role.L), `${c.label}: relay iff codex or gemini`)
  }
  // Each relay runs the seat's own CLI; agy takes the effort in the model slug.
  const gem = calls.find(c => c.role.kind === 'solve' && c.role.key === 'gemini')
  const ast = calls.find(c => c.role.kind === 'solve' && c.role.key === 'astra')
  assert.ok(gem && /seat-run [^\n]*--vendor gemini [^\n]*--model 'gemini-3\.8-flash-high' --effort high/.test(gem.raw), 'gemini relay command')
  assert.ok(ast && /seat-run [^\n]*--vendor codex [^\n]*--model 'gpt-6-astra'/.test(ast.raw), 'codex relay command')
  assert.ok(gem.raw.startsWith('You are a relay between a workflow and the Antigravity CLI (agy).'))
  // Codex and Gemini debate prompts are the short resumed form; Claude ones carry the full protocol.
  const r1 = calls.filter(c => c.role.kind === 'debate')
  for (const c of r1) {
    const resumed = c.prompt.startsWith('The council continues.')
    assert.equal(resumed, codexSeats.includes(c.role.L), `${c.label}: resumed prompt iff codex`)
    assert.ok(c.prompt.includes('# Standings and ledger after round 0'))
    assert.ok(c.prompt.includes('[T0A1]'), 'digest lists the published test')
  }
  // The checker of D in round 1 was asked about C's finding against D, for both validity and fixed.
  const chkD = calls.find(c => c.label === 'check r1:D')
  assert.ok(chkD.prompt.includes('finding by C against D'), 'D checker got C finding')
  assert.ok(/round-0 version/.test(chkD.prompt))
  assert.ok(result.scorecards.markdown.includes('| Seat | Model |'))
  assert.ok(logs.some(l => /consensus on B/.test(l)))
  assert.equal(result.ledger.byStatus.open, undefined, `every claim ruled on: ${JSON.stringify(result.ledger.byStatus)}`)
  // The report: who was chosen and why, by model, with the votes' reasons and the debate.
  const rep = result.report, md = rep.markdown, name = L => result.seats.find(s => s.seat === L).model
  assert.deepEqual([rep.chosen.seat, rep.chosen.how, rep.chosen.round], ['B', 'consensus', 1])
  assert.ok(md.startsWith(`### Chosen: B (${name('B')})`), 'chosen seat named with its model')
  assert.ok(md.includes(`- Converged in round 1: A (${name('A')}), B (${name('B')}), C (${name('C')}) voted to ship it (consensus needs 3 of 4 seats, from at least two vendors).`))
  assert.ok(md.includes(`  - D (${name('D')}) → D: best`), 'dissenting vote and its reason listed')
  assert.ok(md.includes('On the scorecard, B ranked above A on votes from other seats (2 vs 0).'), 'scorecard comparison with the runner-up')
  assert.ok(md.includes(`**[1C1] C (${name('C')}) against D (${name('D')}), major, round 1.** D breaks on empty input`))
  assert.ok(md.includes('Ruling: upheld by the neutral checker'))
  assert.ok(md.includes("Adopted: C took B's idea (guard clause). Votes A→B, B→B, C→B, D→D. Consensus on B."), 'round story')
  assert.ok(md.includes(`**Ratification:** endorsed by A (${name('A')}), C (${name('C')}), D (${name('D')}).`))
  assert.ok(result.forTheOrchestrator.includes('report.markdown') && result.forTheOrchestrator.includes('summary in your own words'))
  const part1 = result.forTheOrchestrator.split('(1) ')[1].split('(2) ')[0]
  assert.ok(part1.includes("which seat's work the council went with (by model) and why") && part1.includes('the debate topics as a short list'), 'summary names the choice, why, and the debates')
  assert.ok(/suggested commit message[^;]*no references to plan documents[^;]*no Co-Authored-By/.test(result.forTheOrchestrator), 'implement: commit message asked for')
  // The retro: every seat's note kept, from both vendors, under its turn and model; "None." dropped.
  const retro = result.retro, notes = retro.notes
  assert.equal(notes.filter(n => n.role === 'seat' && /^Solve note from [A-D]\.$/.test(n.text)).length, 4, JSON.stringify(notes))
  for (const s of result.seats) {
    const n = notes.find(n => n.text === `Solve note from ${s.seat}.`)
    assert.equal(n.who, s.model, `${s.seat}: note attributed to its model`)
    assert.ok(n.turn.startsWith(`r0:${s.seat} `), `${s.seat}: note under its turn label`)
  }
  assert.ok(result.seats.some(s => s.vendor === 'codex') && result.seats.some(s => s.vendor === 'claude'))
  assert.ok(notes.some(n => /^r1:C \w+$/.test(n.turn) && n.text === 'The digest cut the ledger at 25 items, so I re-read room/r0 to find 0D2.'), 'multi-line note flattened')
  assert.ok(!notes.some(n => /^none\.?$/i.test(n.text)), '"None." is not a note')
  const rc = calls.filter(c => c.role.kind === 'retro')
  assert.equal(rc.length, 1)
  assert.equal(calls[calls.length - 1].role.kind, 'retro', 'the retro runs last')
  assert.deepEqual([rc[0].opts.model, rc[0].opts.phase], ['sonnet', 'Retro'])
  assert.equal(rc[0].opts.schema.properties.process, undefined, 'the retro leaves no process note itself')
  const pm = rc[0].prompt.match(PAYLOAD_RE)
  assert.ok(pm && promptHash(pm[2]) === pm[1] && rc[0].prompt.includes(`retro --run-dir '/tmp/proj/.council/test-consensus' --expect ${pm[1]}`), 'retro payload hash-checked by the CLI command')
  assert.ok(pm[2].startsWith('## Process notes\n\n- r0:'), pm[2].slice(0, 80))
  assert.ok(pm[2].includes('- Outcome: consensus on B in round 1, with up to 2 rounds allowed. Endorsed at ratification by A, C, D.'), pm[2])
  const turns = pm[2].match(/- Claude agent turns: (\d+) \(([^)]*)\)\. Codex turns: (\d+) \(spec 1, seat \d+, auditor 1\)\. Gemini turns: (\d+) \(seat \d+\)\./)
  assert.ok(turns, pm[2])
  const byRole = Object.fromEntries(turns[2].split(', ').map(x => x.split(' ')).map(([k, n]) => [k, +n]))
  const claudeCalls = calls.filter(c => c.role.kind !== 'retro')
  assert.equal(+turns[1], claudeCalls.length, 'every Claude agent counted, the retro excepted')
  assert.deepEqual(byRole, { setup: 1, spec: claudeCalls.filter(c => c.role.kind === 'spec' && !/\(relay/.test(c.label)).length, seat: claudeCalls.filter(c => ['solve', 'debate', 'synth', 'ratify'].includes(c.role.kind) && !/\(relay/.test(c.label)).length,
    relay: claudeCalls.filter(c => /\(relay/.test(c.label)).length, checker: claudeCalls.filter(c => c.role.kind === 'check').length,
    auditor: claudeCalls.filter(c => c.role.kind === 'audit' && !/\(relay/.test(c.label)).length })
  assert.equal(+turns[3] + +turns[4], byRole.relay, 'one Codex or Gemini turn per successful relay')
  assert.ok(!/[ \t]$/m.test(pm[2]), 'no trailing whitespace in the payload')
  assert.ok(rc[0].prompt.includes('### Chosen: B'), 'the retro sees the report')
  assert.ok(retro.markdown.startsWith('### Process retro'))
  assert.ok(retro.markdown.includes('1. **Cap the ledger digest by relevance, not by count.** Seats re-read the room to find cut items. Evidence: r1:C.'), retro.markdown)
  assert.ok(retro.markdown.includes('- Neutral checks caught a false claim. (check r1:D)'), retro.markdown)
  assert.ok(retro.markdown.includes('Saved to `/x/retros/test.md`'))
  assert.ok(result.forTheOrchestrator.includes("(6) last, retro.markdown as it is") && result.forTheOrchestrator.includes("don't act on them unless the user asks"))
  return 'converged on B in round 1; relays, resumed prompts, finding routing, scorecards, report and retro ok'
}

// ---------------------------------------------------------------- scenario 2: deadlock

async function scenarioDeadlock() {
  let dVerification = null
  const { result, calls, logs } = await run('deadlock', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-deadlock')
      case 'solve': return solve(role.L)
      case 'check': {
        if (role.tag === 'r0' && role.L === 'D') dVerification = itemIds(prompt).find(id => id.startsWith('0D'))
        return check(prompt,
          id => (role.tag === 'r0' && role.L === 'D' && id.startsWith('0D')) ? 'fabricated' : 'verified',
          id => role.tag === 'final2' ? 'yes' : 'no')
      }
      case 'debate': {
        const ship = { A: 'A', B: 'B', C: 'A', D: 'B' }[role.L]
        const extra = {}
        if (role.round === 1 && role.L === 'C') extra.findings = [{ target: 'B', severity: 'blocker', kind: 'fact', statement: 'B loses data on retry', evidence: 'src/Retry.php:40' }]
        if (role.round === 1 && role.L === 'A') extra.challenges = [{ claim: dVerification, reason: 'suite actually fails on D', evidence: 'ran make test in wt/D' }]
        if (role.round === 1 && role.L === 'D') Object.assign(extra, { changed: true, changeNote: 'switching approach' })
        if (role.L === 'B') extra.findings = role.round === 1 ? [{ target: 'A', severity: 'minor', kind: 'judgment', statement: 'A is less readable', evidence: '' }] : []
        return debate(role.L, ship, extra)
      }
      case 'panel': {
        const ids = [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => m[1])
        return { rulings: ids.map(id => ({ claim: id, verdict: id === dVerification ? 'fabricated' : 'verified', note: 'panel says so' })) }
      }
      case 'synth': return synth()
      case 'ratify': return role.L === 'B'
        ? ratify(false, [{ severity: 'blocker', kind: 'fact', statement: 'final still drops the retry header', evidence: 'src/Retry.php:52' }])
        : ratify(true)
      case 'fix': return { ...synth(), summary: 'final version, fixed' }
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the retry handling', rounds: 3 })

  assert.equal(result.status, 'scorecard', JSON.stringify(result.outcome))
  assert.equal(result.roundsRun, 2, 'stopped early when nothing changed')
  assert.ok(logs.some(l => /stopping the debate/.test(l)))
  assert.equal(result.outcome.base, 'A', 'B has a standing blocker, so A ranks first')
  assert.equal(result.scorecards.positions[0].seat, 'A')
  assert.equal(result.final.fixPass, true)
  assert.ok(calls.some(c => c.role.kind === 'fix'), 'fix pass ran')
  assert.ok(calls.some(c => c.label === 'check final2:A'), 'fix pass was re-checked')
  assert.ok(calls.some(c => c.role.kind === 'panel' && c.role.tag === 'r1'), 'challenge of a verification claim went to the panel')
  assert.ok(calls.some(c => c.role.kind === 'panel' && c.role.tag === 'final'), 'blocking objection went to the panel')
  const panelR1 = calls.filter(c => c.role.kind === 'panel' && c.role.tag === 'r1')
  assert.equal(panelR1.length, 2, 'two panel members')
  assert.ok(panelR1.some(c => /\(relay/.test(c.label)), 'one panel member is reached through a Codex relay')
  const S = Object.fromEntries(result.scorecards.seats.map(r => [r.seat, r]))
  assert.equal(S.D.fabricated, 1, 'D fabricated a verification claim')
  assert.equal(S.D.capitulations, 1, 'D changed with no basis')
  assert.equal(S.B.ignoredFindings, 1, 'B ignored a verified blocker in round 2')
  assert.equal(S.A.challengesWon, 1, 'A successfully challenged D')
  assert.equal(S.C.findingsUpheld, 1)
  assert.ok(S.A.refutationScore > 0 && S.C.refutationScore > 0)
  assert.ok(result.dissent.some(d => d.seat === 'B' && d.kind === 'did not endorse'), 'non-endorsement reported')
  assert.equal(result.final.reviews.length, 3)
  assert.equal(result.final.objections[0].status, 'fixed', 'upheld objection fixed in the fix pass')
  assert.equal(result.final.standingFindings.length, 0)
  assert.ok(result.scorecards.markdown.includes('### Final version (A)'))
  // D was gated in round 0 by the fabricated verification claim.
  const r1A = calls.find(c => c.role.kind === 'debate' && c.role.round === 1 && c.role.L === 'A')
  assert.ok(/DISQUALIFIED this round: fabricated verification claim/.test(r1A.prompt))
  // Judgment findings are recorded, not sent to a checker.
  const chkA1 = calls.find(c => c.label === 'check r1:A')
  assert.ok(!chkA1.prompt.includes('A is less readable'), 'judgment finding not adjudicated')
  // The report explains the scorecard decision and lists the debates most severe first.
  const md = result.report.markdown
  assert.equal(result.report.chosen.how, 'scorecard')
  assert.ok(md.includes('- No consensus after 2 rounds, so the evidence scorecard decided, and it ranked A first.'))
  assert.ok(md.includes('On the scorecard, A ranked above C on votes from other seats (1 vs 0).'))
  assert.ok(md.includes('No position or vote changed, so the debate stopped and the scorecard decided.'))
  assert.ok(/\*\*D \([^)]+\)\*\*, left contention after round 1 \(ranked 3 of 4\)/.test(md), 'narrowed seat reported')
  const order = ['[1C1]', '[0D1]', '[1B1]'].map(id => md.indexOf(id))
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `debates by severity: ${order}`)
  assert.ok(/\[0D1\] A \([^)]+\) disputed D \([^)]+\)'s verification claim, round 1/.test(md))
  assert.ok(md.includes('Ruling: ruled fabricated by the two-vendor panel'))
  assert.ok(md.includes('Ruling: a judgment call: argued, not adjudicated'))
  assert.ok(!md.split('### How it turned out')[0].includes('[FB1]'), 'ratification objections are not repeated among the debates')
  assert.ok(/Objection \[FB1\] from B \([^)]+\), blocker: final still drops the retry header → upheld and fixed in the fix pass/.test(md))
  assert.ok(/not endorsed by B \([^)]+\) \(disagree\)/.test(md))
  assert.ok(/dissent from B \([^)]+\) \(judgment\): A is less readable/.test(md))
  return 'scorecard picked A; panel, fabricated gate, capitulation, stubbornness, fix pass and report all ok'
}

// ---------------------------------------------------------------- scenario 3: escalation and resume

async function scenarioEscalation() {
  const q = L => ({ questions: [{ question: `${L}: does "sync" mean one-way or two-way?`, assumption: L === 'C' ? 'two-way' : 'one-way' }] })
  const scenario = async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-escalate')
      case 'solve': return solve(role.L, ['A', 'B', 'C'].includes(role.L) ? q(role.L) : {})
      case 'cluster': return { assignments: [0, 1, 2].map(i => ({ index: i, matches: 'new-1' })), newQuestions: [{ label: 'new-1', text: 'Does "sync" mean one-way or two-way?' }] }
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const first = await run('escalation', scenario, { task: 'Design the sync feature', mode: 'design' })
  assert.equal(first.result.status, 'needs-user')
  assert.equal(first.result.round, 0)
  assert.equal(first.result.questions.length, 1)
  assert.deepEqual(first.result.questions[0].raisedBy.sort(), ['A', 'B', 'C'])
  assert.equal(Object.keys(first.result.questions[0].assumptions).length, 3)
  // The pause comes with the debate so far.
  assert.ok(first.result.report.markdown.includes('### The positions so far'))
  assert.ok(first.result.report.markdown.includes('Then a question about the request reached the escalation threshold.'))
  assert.ok(first.result.forTheOrchestrator.includes('First show the user report.markdown'))

  const resumed = await run('resume', scenario, {
    task: 'Design the sync feature', mode: 'design',
    clarifications: [{ id: 'Q1', answer: 'One-way, server to client.', afterRound: 0 }],
  })
  assert.equal(resumed.result.status, 'converged')
  // Prompts up to and including round 0 are byte-identical to the first run, so a resume replays them from cache.
  const r0a = first.calls.filter(c => ['setup', 'spec', 'solve', 'check', 'cluster'].includes(c.role.kind)).map(c => c.prompt)
  const r0b = resumed.calls.slice(0, r0a.length).map(c => c.prompt)
  assert.deepEqual(r0b, r0a, 'round-0 prompts unchanged by clarifications')
  for (const c of resumed.calls.filter(c => c.role.kind === 'debate')) {
    assert.ok(c.prompt.includes('One-way, server to client.'), `${c.label}: clarification visible in round 1`)
  }
  assert.equal(resumed.result.assumptions.length, 0)
  // Design mode: checkers are told not to measure.
  assert.ok(resumed.calls.find(c => c.role.kind === 'check').prompt.includes('nothing to measure'))
  assert.ok(!resumed.result.forTheOrchestrator.includes('commit message'), 'no commit message outside implement mode')
  return 'escalated at 3 seats after round 0; resume kept round-0 prompts identical and injected the answer'
}

// ---------------------------------------------------------------- scenario 4: failures

async function scenarioFailures() {
  const alive = []
  let failedCheck = null
  let retroPrompt = ''
  const { result } = await run('failures', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-failures')
      case 'solve': if (role.key === 'gemini') return null; alive.push(role.L); return solve(role.L)
      case 'check':
        if (role.tag === 'r1' && !failedCheck) { failedCheck = role.L; return null }
        return check(prompt)
      case 'debate': return debate(role.L, alive.slice().sort()[0])
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, 'Investigate why the cache misses on cold start', { retro: p => { retroPrompt = p; return null } })
  assert.equal(result.mode, 'investigate')
  assert.equal(result.seats.filter(s => !s.active).length, 1, 'the failed seat was dropped')
  assert.ok(result.notes.some(n => /dropped/.test(n)))
  assert.ok(result.notes.some(n => n.includes(`check of ${failedCheck} in r1 failed`)))
  assert.equal(result.status, 'converged', '3 seats: quorum 2 of 3, needs both vendors')
  // The facts carry what went wrong; a failed retro is reported, and the result is intact.
  const sol = result.seats.find(s => s.model === 'Gemini Flash').seat
  // A relay that returns nothing was ended by Claude Code, not by the vendor, and the facts say so.
  assert.ok(new RegExp(`- Relay attempts that didn't return a result: ${sol}-r0 via haiku: relay ended \\(the relay agent returned nothing: Claude Code blocked it[^\n]*jobs/${sol}-r0 is absent[^\n]*; ${sol}-r0 via sonnet: relay ended`).test(retroPrompt), retroPrompt)
  assert.ok(retroPrompt.includes(`Gemini turn ${sol}-r0 failed: Claude Code ended both relay agents`), 'the failure names the harness')
  assert.ok(new RegExp(`- Turns that returned nothing: [^\\n]*r0:${sol} gemini \\(relay\\)[^\\n]*r0:${sol} gemini[,.]`).test(retroPrompt), 'empty turns listed')
  assert.ok(retroPrompt.includes(`check r1:${failedCheck}`), 'the failed checker is listed')
  assert.ok(retroPrompt.includes(`  - Seat ${sol} (Gemini Flash) failed in round 0 and was dropped.`))
  assert.equal(result.retro.error, 'the retro agent failed')
  assert.ok(result.retro.markdown.includes('The retro agent failed.'))
  return 'dropped a failed seat, survived a failed checker, quorum recomputed; a failed retro is reported'
}

async function scenarioDirty() {
  const { result, calls } = await run('dirty', async role => {
    if (role.kind === 'setup') return { ...SETUP('test-dirty'), status: 'dirty', dirty: [' M src/a.php'] }
    throw new Error('nothing should run after a dirty setup')
  }, 'Fix the bug in a.php')
  assert.equal(result.status, 'blocked')
  assert.equal(calls.length, 1)
  return 'dirty tree blocked the run before any seat started'
}

// ---------------------------------------------------------------- scenario 6: focus (narrowing, deltas, notes)

async function scenarioFocus() {
  const weak = [{ criterion: 'C1', status: 'unmet', note: '' }, { criterion: 'C2', status: 'met', note: '' }, { criterion: 'C3', status: 'partial', note: '' }]
  const { result, calls, logs } = await run('focus', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-focus')
      case 'solve': return solve(role.L)
      case 'check': return check(prompt, () => 'verified', () => 'no', () => [], {
        criteria: ['C', 'E'].includes(role.L) ? weak : undefined,
        diff: role.L === 'D' ? { files: 9, added: 480, removed: 40 } : undefined,
        postWords: role.L === 'B' && role.tag === 'r1' ? 1200 : undefined,
      })
      case 'debate': {
        const notes = `notes-${role.L}-r${role.round}`
        if (role.round === 1) {
          const ship = { A: 'A', B: 'A', C: 'C', D: 'D', E: 'E' }[role.L]
          const extra = { notes }
          if (role.L === 'C') extra.findings = [{ target: 'A', severity: 'major', kind: 'fact', statement: 'A drops the retry header', evidence: 'src/Retry.php:40' }]
          if (role.L === 'D') extra.findings = [{ target: 'E', severity: 'major', kind: 'fact', statement: 'E leaks the socket', evidence: 'src/Pool.php:12' }]
          return debate(role.L, ship, extra)
        }
        if (role.L === 'E') {
          return debate('E', 'E', {
            notes, changed: true, changeNote: 'rethought it',
            claims: [{ kind: 'fact', statement: 'E reviewer claim', evidence: 'x' }],
            adopted: [{ from: 'B', idea: 'borrowed' }],
            tests: [{ id: 'T2E1', purpose: 'retry keeps the header', command: 'phpunit T2E1Test.php' }],
            findings: [{ target: 'B', severity: 'minor', kind: 'fact', statement: 'B logs twice', evidence: 'src/Log.php:3' }],
          })
        }
        const extra = { notes }
        if (role.L === 'D') extra.findings = [{ target: 'E', severity: 'minor', kind: 'fact', statement: 'E is still slow', evidence: 'bench' }]
        if (role.L === 'A') extra.concessions = ['1C1']
        return debate(role.L, 'B', extra)
      }
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the retry handling', seats: ['opus', 'sonnet', 'astra', 'sol', 'luna'], rounds: 3 })

  assert.equal(result.status, 'converged', JSON.stringify(result.outcome))
  assert.equal(result.outcome.base, 'B')
  assert.equal(result.roundsRun, 2)
  // Narrowing after round 1: B and D rank top two, A has a vote from B, C has a verified major
  // against A. E has none of these and leaves contention.
  assert.deepEqual(result.outcome.leftContention, [{ seat: 'E', afterRound: 1, rank: 5, of: 5 }])
  assert.ok(logs.some(l => /field narrows to A, B, C, D; E now review/.test(l)), logs.join('\n'))
  // Reviewers aren't measured; their test goes to the leading contender's checker and gets a ruling.
  assert.ok(!calls.some(c => c.label === 'check r2:E'), 'E not measured in round 2')
  assert.ok(calls.some(c => c.role.kind === 'check' && c.role.tag === 'r2' && itemIds(c.prompt).includes('T2E1')), 'reviewer test routed')
  // E's claims, and D's finding against E, were not recorded (they would be left open otherwise).
  assert.equal(result.ledger.byStatus.open, undefined, `every claim ruled on: ${JSON.stringify(result.ledger.byStatus)}`)
  assert.equal(result.outcome.votesByRound[2].E, undefined, 'vote for a position out of contention not counted')
  assert.ok(result.notes.some(n => /E voted for E in round 2, which is out of contention/.test(n)))
  const S = Object.fromEntries(result.scorecards.seats.map(r => [r.seat, r]))
  assert.equal(S.E.capitulations, 0, 'a reviewer is not capitulating')
  assert.equal(S.E.ignoredFindings, 0, 'a reviewer is not ignoring findings against its frozen position')
  assert.equal(S.B.ideasAdoptedByOthers, 0, 'a reviewer adopts nothing')
  const ranked = result.scorecards.positions
  assert.equal(ranked[ranked.length - 1].seat, 'E')
  assert.ok(result.scorecards.markdown.includes('out of contention after round 1'))

  // Checkers measure against the previous snapshot.
  assert.ok(!/--since/.test(calls.find(c => c.label === 'check r0:A').prompt))
  assert.ok(calls.find(c => c.label === 'check r1:A').prompt.includes('--since r0'))
  assert.ok(calls.find(c => c.label === 'check r2:A').prompt.includes('--since r1'))
  assert.ok(calls.find(c => c.label === 'check final:B').prompt.includes('--since r2'))

  const debatePrompt = (L, r) => calls.find(c => c.role.kind === 'debate' && c.role.L === L && c.role.round === r).prompt
  // Round 1 reads everything; D's big diff points at its per-file summary first.
  const a1 = debatePrompt('A', 1)
  assert.ok(a1.includes('/room/r0/B.diff') && a1.includes('/room/r0/E.md'))
  assert.ok(a1.includes('start with the per-file summary /tmp/proj/.council/test-focus/room/r0/D.stat'))
  // Round 2 starts from what changed, and only for positions in contention.
  const a2 = debatePrompt('A', 2)
  assert.ok(a2.includes('/room/r1/B.delta.diff (1 files, +3/−1)'), a2)
  assert.ok(a2.includes('starting with its "Changes this round" section'))
  assert.ok(!a2.includes('/wt/E'), 'E is not in the reading list')
  assert.ok(a2.includes('Out of contention, now reviewing: E'))
  assert.ok(a2.includes('one of A, B, C, D'))
  assert.ok(a2.includes('post 1200 words, over the 800-word limit'), 'long post flagged')
  const facts = calls.find(c => c.role.kind === 'retro').prompt.split('## Run facts')[1]
  assert.ok(facts.includes('- Posts over the 800-word limit: r1:B 1200 words.'), 'long post in the retro facts')
  assert.ok(facts.includes('- Left contention: E after round 1.'), facts)
  const e2 = debatePrompt('E', 2)
  assert.ok(e2.includes('as a reviewer') && e2.includes('ranked 5 of 5'))
  // Claude seats carry their own notes forward, and only their own; Codex seats keep their thread.
  const claude = result.seats.filter(x => x.vendor === 'claude').map(x => x.seat)
  assert.equal(claude.length, 2)
  for (const L of 'ABCDE') {
    const p2 = debatePrompt(L, 2)
    const isClaude = claude.includes(L)
    assert.equal(p2.includes('# Your private notes from round 1'), isClaude, `${L}: notes iff Claude`)
    assert.equal(p2.includes(`notes-${L}-r1`), isClaude, `${L}: own notes`)
    for (const M of 'ABCDE') if (M !== L) assert.ok(!p2.includes(`notes-${M}-`), `${L} sees ${M}'s notes`)
    assert.equal(debatePrompt(L, 1).includes(`notes-${L}-r0`), isClaude)
    assert.equal(/fill `notes`/.test(p2), isClaude, `${L}: asked for notes iff Claude`)
  }
  // Ratifiers see what changed since the version they last reviewed.
  const rat = calls.find(c => c.role.kind === 'ratify').prompt
  assert.ok(rat.includes('/room/final/B.delta.diff'), 'final delta shown to ratifiers')
  // Chosen by vote over a higher-ranked position: the report says so, and what still stands.
  const md = result.report.markdown
  assert.ok(md.includes('On the scorecard it ranked 2 of 5: D ranked above B on standing minor findings (0 vs 1). The seats voted for B anyway.'))
  assert.ok(md.includes('No consensus, so the field narrowed: E (ranked 5 of 5) left contention.'))
  assert.ok(md.includes('Outcome: still stands against the final version'))
  assert.ok(/\[1C1\][^\n]*\n  - Ruling: [^\n]*\n  - Outcome: A conceded it in round 2\n/.test(md), 'concession reported with its round')
  assert.ok(/standing finding \[2E1\] from E \([^)]+\) \(minor, verified\): B logs twice/.test(md))
  return 'E left contention after round 1 and reviewed; deltas, notes, length flags, big-diff hints and report ok'
}

// ---------------------------------------------------------------- Codex blocked by the sandbox

// Codex can't run inside Claude Code's sandbox and the unsandboxed retry was refused: the Codex
// seats drop out after one relay each, later Codex turns (here a panel member) are skipped without
// spending a relay, and the report tells the user how to allow it.
async function scenarioSandbox() {
  const alive = []
  const { result, calls } = await run('sandbox', async (role, prompt, opts) => {
    if (/\(relay/.test(opts.label || '')) {
      return { relayStatus: { status: 'sandboxed', error: 'cannot write to /Users/x/.codex (Operation not permitted).', errorClass: '' } }
    }
    switch (role.kind) {
      case 'setup': return SETUP('test-sandbox')
      case 'solve': alive.push(role.L); return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': {
        const [first, second] = alive.slice().sort()
        return debate(role.L, first, role.L === first ? { challenges: [{ claim: `0${second}1`, reason: 'doubt it', evidence: '' }] } : {})
      }
      case 'panel': return { rulings: (prompt.match(/\[(0[A-F]1)\]/g) || []).map(x => ({ claim: x.slice(1, -1), verdict: 'verified', note: 'ran it' })) }
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', seats: ['opus', 'sonnet', 'astra', 'sol'], rounds: 1 })
  const relays = calls.filter(c => /\(relay/.test(c.label) && c.role.kind !== 'spec')
  assert.equal(relays.length, 2, `one relay per Codex seat, no Sonnet retry: ${relays.map(c => c.label)}`)
  assert.ok(relays.every(c => c.opts.model === 'haiku' && c.role.kind === 'solve'))
  assert.equal(result.seats.filter(s => !s.active).length, 2, 'both Codex seats dropped')
  assert.ok(calls.some(c => c.role.kind === 'panel' && c.role.member === 'opus'), 'the Claude panel member still ruled')
  assert.ok(result.notes.some(n => n.includes('"permissions": {"allow": ["Bash(dark-factory:*)"]}')), 'how to allow it')
  assert.ok(result.notes.some(n => /Codex turn panel-astra-r1 skipped: the Codex CLI can't run in this session's sandbox/.test(n)), 'later Codex turn skipped')
  assert.ok(result.report.markdown.includes('### Problems during the run') && result.report.markdown.includes('Bash(dark-factory:*)'))
  assert.equal(result.status, 'converged')
  return 'Codex seats dropped after one relay each; later Codex turns skipped; the report says how to allow it'
}

// ---------------------------------------------------------------- working from a plan

// The plan isn't committed, so worktrees don't have it. Setup snapshots it with `init --ref`, and
// every seat (Claude or Codex), checker and the final author is pointed at the snapshot.
async function scenarioPlan() {
  const runDir = '/tmp/proj/.council/test-plan'
  const snap = `${runDir}/refs/BUG_CHECK_LIST.md`
  const { result, calls } = await run('plan', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return { ...SETUP('test-plan'), planMissing: '', refs: [
        { source: '/tmp/proj/BUG_CHECK_LIST.md', path: snap, inWorktrees: false },
        { source: '/etc/passwd', path: '/etc/passwd', inWorktrees: false },
      ] }
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Do item 13 on the bug checklist', plan: '/tmp/proj/BUG_CHECK_LIST.md', rounds: 1 })
  const setupPrompt = calls.find(c => c.role.kind === 'setup').prompt
  assert.ok(setupPrompt.includes("--ref '/tmp/proj/BUG_CHECK_LIST.md' followed by --ref <path> for each other document"), 'setup snapshots the plan')
  assert.ok(setupPrompt.indexOf('## Step 1 — the documents the work follows') < setupPrompt.indexOf('## Step 2 — create the run'))
  assert.ok(/never pick one yourself/.test(setupPrompt), 'setup never guesses which plan')
  assert.deepEqual(result.refs, [{ source: '/tmp/proj/BUG_CHECK_LIST.md', path: snap, inWorktrees: false }], 'only snapshots inside refs/')
  assert.ok(result.notes.some(n => /outside the run's refs\/ directory/.test(n)))
  // Codex seats see it in round 0 and keep it in their thread; later they get only the round's part.
  const needs = ['solve', 'debate', 'check', 'synth', 'ratify']
  for (const c of calls.filter(c => needs.includes(c.role.kind) && (c.role.kind === 'solve' || !/\(relay/.test(c.label)))) {
    assert.ok(c.prompt.includes(`# Reference documents`) && c.prompt.includes(`- ${snap} (from /tmp/proj/BUG_CHECK_LIST.md)`), `${c.label}: pointed at the plan`)
    assert.ok(!c.prompt.includes('/etc/passwd'), `${c.label}: no stray path`)
  }
  assert.ok(calls.some(c => c.role.kind === 'solve' && /\(relay/.test(c.label)), 'a Codex seat got it through its relay payload')
  assert.ok(/don't cite it \(file names, step or item numbers\) in code, comments or tests/.test(calls.find(c => c.role.kind === 'solve').prompt))
  assert.equal(result.status, 'converged')
  return 'the plan was snapshotted and every seat, checker and the final author was pointed at it'
}

// "Implement the plan" with no plan the council can find: stop before any seat starts, and tell
// the launching session where to look and how to pass it.
async function scenarioPlanMissing() {
  const { result, calls } = await run('plan-missing', async role => {
    if (role.kind === 'setup') return { ...SETUP('x'), status: 'needs-plan', runDir: '', planMissing: 'the task says "implement the plan" but names no file' }
    throw new Error(`unexpected role ${role.kind}`)
  }, 'Implement the plan')
  assert.equal(calls.length, 1, 'only setup ran')
  assert.equal(result.status, 'needs-plan')
  assert.ok(result.forTheOrchestrator.includes('~/.claude/plans/') && result.forTheOrchestrator.includes('plan: ["/abs/path"]'))
  assert.ok(/ask the user/.test(result.forTheOrchestrator))
  return 'stopped before any seat; told the launching session to find the plan and pass args.plan'
}

// `council init --ref` against a real repository: copies byte for byte, says which documents the
// worktrees already have, de-duplicates names, and refuses a missing file before creating anything.
async function scenarioRefs() {
  const tmp = mkdtempSync(join(tmpdir(), 'council-refs-'))
  const repo = join(tmp, 'repo'), cli = join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, ...opts }).toString()
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'src.txt'), 'code\n')
  writeFileSync(join(repo, 'docs', 'SPEC.md'), 'spec v1\n')
  writeFileSync(join(repo, 'docs', 'NOTES.md'), 'notes v1\n')
  sh('git', ['init', '-q'])
  sh('git', ['add', '.'])
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  writeFileSync(join(repo, 'docs', 'NOTES.md'), 'notes v2, not committed\n')
  writeFileSync(join(repo, 'PLAN.md'), '# Plan\n\n1. Do the thing — “quoted” ✓\n')
  mkdirSync(join(tmp, 'elsewhere'))
  writeFileSync(join(tmp, 'elsewhere', 'PLAN.md'), 'a second plan with the same name\n')

  const fail = (() => { try { sh(cli, ['init', '--repo', repo, '--seats', 'A,B', '--run-id', 'r1', '--ref', 'NOPE.md']); return null } catch (e) { return e.stdout.toString() } })()
  assert.ok(fail && /reference document not found: NOPE.md/.test(fail), `missing ref: ${fail}`)
  assert.ok(!existsSync(join(repo, '.council', 'r1')), 'nothing created for a missing ref')

  const out = JSON.parse(sh(cli, ['init', '--repo', repo, '--seats', 'A,B', '--run-id', 'r2',
    '--ref', 'PLAN.md', '--ref', 'docs/SPEC.md', '--ref', 'docs/NOTES.md', '--ref', join(tmp, 'elsewhere', 'PLAN.md')]).trim().split('\n').pop())
  const refs = Object.fromEntries(out.refs.map(r => [r.path.split('/').pop(), r]))
  assert.deepEqual(Object.keys(refs), ['PLAN.md', 'SPEC.md', 'NOTES.md', 'PLAN-2.md'], 'names de-duplicated')
  assert.deepEqual(Object.values(refs).map(r => r.inWorktrees), [false, true, false, false], 'untracked, committed, modified, outside')
  for (const r of out.refs) {
    assert.ok(r.path.startsWith(join(out.runDir, 'refs') + '/'), r.path)
    assert.ok(readFileSync(r.path).equals(readFileSync(r.source)), `${r.path} is a byte-for-byte copy`)
  }
  assert.ok(!existsSync(join(out.runDir, 'wt', 'A', 'PLAN.md')), 'the plan really is missing from the worktrees')
  sh(cli, ['cleanup', '--run-dir', out.runDir, '--all'])
  return 'init --ref copies documents byte for byte, flags what worktrees lack, refuses missing files'
}

// ---------------------------------------------------------------- retro off

// retro: false: no agent is asked for process notes (Codex schemas included), no retro agent runs.
async function scenarioRetroOff() {
  const { result, calls } = await run('retro-off', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-retro-off')
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the empty-input crash', rounds: 1, retro: false })
  assert.ok(!calls.some(c => c.role.kind === 'retro'))
  assert.ok(calls.some(c => /\(relay/.test(c.label)), 'Codex schemas were checked too')
  assert.equal(result.retro, null)
  assert.ok(!result.forTheOrchestrator.includes('retro.markdown'))
  assert.equal(result.status, 'converged')
  return 'no process fields, no retro agent'
}

// ---------------------------------------------------------------- retro save (runs bin/dark-factory)

// The retro agent writes retro.md; `council retro` adds the process notes and run facts exactly as
// the workflow gave them, read from the agent's saved transcript, and keeps the lot outside the run.
async function scenarioRetroSave() {
  assert.ok(RETRO_PROMPTS.length, 'no retro prompts captured')
  const prompt = RETRO_PROMPTS[0]
  const [, expect, payload] = prompt.match(PAYLOAD_RE)
  const tmp = mkdtempSync(join(tmpdir(), 'council-retro-'))
  const config = join(tmp, 'claude'), runDir = join(tmp, 'proj', '.council', '20261011-120000'), out = join(tmp, 'retros')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: '20261011-120000', runDir, repoRoot: join(tmp, 'my proj') }))
  const cli = join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }
  const retro = (extra = [], outDir = out) => {
    let stdout
    try {
      stdout = execFileSync(cli, ['retro', '--run-dir', runDir, '--out-dir', outDir, '--transcript-wait', '0', ...extra], { env }).toString()
    } catch (e) { stdout = e.stdout.toString() }
    return JSON.parse(stdout.trim().split('\n').pop())
  }
  const saved = join(out, '20261011-120000-my-proj.md')

  // No retro.md yet: refused.
  assert.ok(/write the retro to .*retro\.md first/.test(retro().error))
  writeFileSync(join(runDir, 'retro.md'), '# Council retro: 20261011-120000\n\nBody.\n')
  // No transcript holds the notes: the retro alone is kept.
  let r = retro(['--expect', expect])
  assert.deepEqual([r.status, r.path, r.notes], ['ok', saved, false])
  assert.equal(readFileSync(saved, 'utf8'), '# Council retro: 20261011-120000\n\nBody.\n')
  // The retro agent's transcript, indented as the harness saves it: the notes are attached exactly.
  const indented = text => text.split('\n').map(l => `  ${l}`).join('\n')
  const dir = join(config, 'projects', 'p', 's', 'subagents', 'workflows', 'wf_1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-retro.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: `[Workflow harness — computed task] x\n${indented(prompt)}` } }) + '\n')
  r = retro(['--expect', expect])
  assert.deepEqual([r.status, r.notes], ['ok', true])
  assert.equal(readFileSync(saved, 'utf8'), `# Council retro: 20261011-120000\n\nBody.\n\n${payload}\n`)
  assert.equal(readFileSync(join(runDir, 'retro-data.md'), 'utf8'), `${payload}\n`)
  // Somewhere it may not write (as from inside the sandbox): reported, so the agent can retry outside it.
  const locked = join(tmp, 'locked')
  mkdirSync(locked); chmodSync(locked, 0o500)
  try {
    assert.equal(retro(['--expect', expect], join(locked, 'retros')).status, 'sandboxed')
  } finally { chmodSync(locked, 0o700) }
  return 'council retro keeps retro.md plus the exact notes from the transcript; refuses without retro.md; reports sandboxed'
}

// ---------------------------------------------------------------- relay transcript (runs bin/dark-factory)

// The relay doesn't copy its payload: `council seat-run` finds it in the relay's saved transcript.
// Build a transcript the way Claude Code saves one (the harness indents every line of the prompt),
// and check the CLI recovers the exact payload, and reports each way it can't.
async function scenarioTranscript() {
  assert.ok(RELAY_PROMPTS.length, 'no relay prompts captured')
  const prompt = RELAY_PROMPTS.find(p => /--job '[A-F]-r0'/.test(p))
  const expect = prompt.match(/--expect (\S+)/)[1]
  const payload = prompt.match(/=====BEGIN PAYLOAD \S+=====\n([\s\S]*)\n=====END PAYLOAD \S+=====/)[1]
  assert.ok(/\n {2,}\S/.test(payload) && /\n\n/.test(payload), 'payload exercises indented and blank lines')

  const tmp = mkdtempSync(join(tmpdir(), 'council-relay-'))
  const config = join(tmp, 'claude'), codexHome = join(tmp, 'codex'), runDir = join(tmp, 'run')
  mkdirSync(codexHome); mkdirSync(join(runDir, 'jobs'), { recursive: true })
  const cli = join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }
  const seatRun = (file, extra = {}) => {
    const out = execFileSync(cli, ['seat-run', '--run-dir', runDir, '--seat', 'A', '--job', 'A-r0', '--model', 'm',
      '--cwd', tmp, '--prompt-file', file, '--expect', expect, '--transcript-wait', '0', '--max-wait', '20'],
      { env: { ...env, ...extra } }).toString().trim().split('\n').pop()
    return JSON.parse(out)
  }

  // Nothing saved yet, no file: the relay is asked to copy.
  assert.equal(seatRun(join(runDir, 'jobs', 'a.prompt.md')).status, 'need-file')
  // A bad copy and nothing saved: hash mismatch.
  writeFileSync(join(runDir, 'jobs', 'b.prompt.md'), payload.replace('\n\n', '\n'))
  assert.equal(seatRun(join(runDir, 'jobs', 'b.prompt.md')).status, 'hash-mismatch')
  // Inside a sandbox (Codex home not writable): reported before anything else.
  writeFileSync(join(tmp, 'not-a-dir'), '')
  assert.equal(seatRun(join(runDir, 'jobs', 'c.prompt.md'), { CODEX_HOME: join(tmp, 'not-a-dir', 'codex') }).status, 'sandboxed')

  // The relay's transcript, as the harness saves it. A tampered copy elsewhere must not be taken.
  const indented = text => text.split('\n').map(l => `  ${l}`).join('\n')
  const line = text => JSON.stringify({ type: 'user', message: { role: 'user', content: `[Workflow harness — computed task] preamble\n${indented(text)}` } })
  const dir = join(config, 'projects', 'p', 's', 'subagents', 'workflows', 'wf_1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-relay.jsonl'), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n' + line(prompt) + '\n')
  writeFileSync(join(dir, 'agent-tampered.jsonl'), line(prompt.replace('Write your post', 'Write a post')) + '\n')
  const minuteAgo = new Date(new Date().getTime() - 60000)
  utimesSync(join(dir, 'agent-relay.jsonl'), minuteAgo, minuteAgo)   // the tampered one is newer, so it is read first

  // Recovered, even over a bad copy; then the job starts (and fails at once: no codex on PATH).
  const r = seatRun(join(runDir, 'jobs', 'b.prompt.md'))
  assert.equal(r.status, 'error', `seat-run with a saved transcript: ${JSON.stringify(r)}`)
  assert.equal(readFileSync(join(runDir, 'jobs', 'b.prompt.md'), 'utf8'), payload, 'prompt file is the exact payload')
  assert.ok(existsSync(join(runDir, 'jobs', 'A-r0', 'prompt.md')), 'the Codex job was started from it')
  assert.ok(!readFileSync(join(runDir, 'jobs', 'A-r0', 'prompt.md'), 'utf8').includes('OUTPUT_SCHEMA'), 'schema split off')
  // A process we may not signal (EPERM, as from inside a sandbox) is alive, not dead.
  const alive = execFileSync('python3', ['-I', '-c', `import importlib.machinery as m, importlib.util as u
l = m.SourceFileLoader('c', ${JSON.stringify(cli)}); mod = u.module_from_spec(u.spec_from_loader('c', l)); l.exec_module(mod)
print(mod.pid_alive(1))`], { env }).toString().trim()
  assert.equal(alive, 'True', 'pid_alive treats EPERM as alive')
  return 'seat-run recovers the exact payload from an indented transcript; need-file, hash-mismatch and sandboxed ok'
}

// ---------------------------------------------------------------- main

let failed = 0
// ---------------------------------------------------------------- choosing the lineup

// The default is Opus, Sonnet, Astra and Gemini Flash; any lineup can be picked instead, as a
// list, a comma-separated string, or a `--seats` prefix on a string task (how /council passes it).
async function scenarioLineup() {
  const quick = runId => async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP(runId)
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const models = r => r.result.seats.map(s => s.model).sort()

  const a = await run('lineup-prefix', quick('test-lineup-a'), '--seats opus,sonnet,astra,sol Fix the flaky retry')
  assert.deepEqual(models(a), ['Claude Opus', 'Claude Sonnet', 'Codex Astra', 'Codex Sol'])
  const setupA = a.calls.find(c => c.role.kind === 'setup').prompt
  assert.ok(setupA.includes('Fix the flaky retry') && !setupA.includes('--seats opus'), 'the prefix is not part of the task')
  assert.ok(!a.calls.some(c => /--vendor gemini/.test(c.raw)), 'no Gemini turn when it is swapped out')
  assert.equal(a.result.status, 'converged')

  const b = await run('lineup-string', quick('test-lineup-b'), { task: 'Fix the flaky retry', seats: 'opus, astra, gemini-pro', effort: 'medium', rounds: 1 })
  const pro = b.result.seats.find(s => s.model === 'Gemini Pro')
  assert.equal(pro.effort, 'high', 'Pro has no medium; a tie goes to the higher effort')
  assert.ok(b.calls.some(c => /--vendor gemini [^\n]*--model 'gemini-3\.1-pro-high'/.test(c.raw)), 'effort in the agy slug')
  assert.ok(b.result.report.markdown.includes('from at least two vendors'), 'three vendors: two among the voters suffice')

  const c = await run('lineup-slug', quick('test-lineup-c'), { task: 'Fix the flaky retry', seats: ['opus', 'gemini:gemini-3.6-flash-low'], effort: { opus: 'xhigh' }, rounds: 1 })
  assert.deepEqual(models(c), ['Claude Opus', 'Gemini gemini-3.6-flash-low'])
  assert.ok(c.calls.some(c => /--model 'gemini-3\.6-flash-low'/.test(c.raw)), 'a gemini:<slug> is passed through as it is')
  assert.equal(c.result.seats.find(s => s.model === 'Claude Opus').effort, 'xhigh')

  const flash = await run('lineup-flash', quick('test-lineup-d'), { task: 'Fix the flaky retry', effort: 'max', rounds: 1 })
  assert.ok(flash.calls.some(c => /--model 'gemini-3\.8-flash-high'/.test(c.raw)), 'max maps to Flash high')

  await assert.rejects(run('lineup-bad', quick('x'), { task: 'Fix it', seats: 'opus,gpt' }), /unknown seat 'gpt'.*gemini:<model-slug>/)
  return 'default lineup has Gemini; --seats prefix, comma string, gemini-pro, gemini:<slug> and effort mapping ok'
}

// ---------------------------------------------------------------- agy runner (runs bin/dark-factory)

// `council seat-run --vendor gemini` against a stub agy: the turn's result, the conversation
// resumed by id, per-turn usage, and agy's silent failures caught.
async function scenarioAgy() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'council-agy-')))
  const home = join(tmp, 'home'), bin = join(tmp, 'bin'), repo = join(tmp, 'repo'), runDir = join(repo, '.council', 'run1')
  const agyHome = join(home, '.gemini', 'antigravity-cli')
  for (const d of [agyHome, bin, join(runDir, 'jobs'), join(runDir, 'wt', 'A')]) mkdirSync(d, { recursive: true })
  const settings = join(agyHome, 'settings.json')
  // The stub replays the scripted reply for its turn and logs its argv and cwd.
  writeFileSync(join(bin, 'agy'), `#!/usr/bin/env python3
import json, os, sys
d = os.environ['AGY_STUB']
n = len(os.listdir(os.path.join(d, 'calls')))
json.dump({'argv': sys.argv[1:], 'cwd': os.getcwd()}, open(os.path.join(d, 'calls', f'{n}.json'), 'w'))
reply = json.load(open(os.path.join(d, 'replies.json')))[n]
sys.stderr.write(reply.pop('_stderr', ''))
print(json.dumps(reply))
`)
  chmodSync(join(bin, 'agy'), 0o755)
  const stub = join(tmp, 'stub'); mkdirSync(join(stub, 'calls'), { recursive: true })
  const env = { ...process.env, HOME: home, TMPDIR: join(tmp, 'tmp'), AGY_STUB: stub, PATH: `${bin}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: '1', COUNCIL_RETRY_WAIT: '0' }
  mkdirSync(join(tmp, 'tmp'))
  const cli = join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
  const ok = (conv, out, usage) => ({ conversation_id: conv, status: 'SUCCESS', response: '', structured_output: out, usage })
  writeFileSync(join(stub, 'replies.json'), JSON.stringify([
    ok('c-1', { answer: 'one', process: '' }, { input_tokens: 100, output_tokens: 10 }),
    ok('c-1', { answer: 'two', process: '' }, { input_tokens: 250, output_tokens: 25 }),
    // A resumed turn answered in text: agy hands back the previous turn's structured output.
    { ...ok('c-1', { summary: 'stale', process: '' }, { input_tokens: 300, output_tokens: 30 }), response: 'B is right.' },
    ok('c-1', { answer: 'three', process: '' }, { input_tokens: 360, output_tokens: 33 }),
    { ...ok('c-1', { summary: 'stale', process: '' }, { input_tokens: 400 }), response: 'Still text.' },
    { ...ok('c-1', { summary: 'stale', process: '' }, { input_tokens: 420 }), response: 'Still text.' },
    // A denial ends a headless turn; the job resumes once, and a second denial stands.
    { conversation_id: 'c-1', status: 'SUCCESS', response: '', usage: { input_tokens: 400 }, denied_actions: [{ action: 'command' }] },
    ok('c-1', { answer: 'resumed', process: '' }, { input_tokens: 450 }),
    { conversation_id: 'c-1', status: 'SUCCESS', response: '', usage: { input_tokens: 460 }, denied_actions: [{ action: 'command' }] },
    { conversation_id: 'c-1', status: 'SUCCESS', response: '', usage: { input_tokens: 470 }, denied_actions: [{ action: 'command' }] },
    ok('c-9', { answer: 'lost', process: '' }, { input_tokens: 50 }),
    { status: 'ERROR', error: 'Selected model is at capacity. Please try a different model.' },
    ok('c-1', { answer: 'after the wait', process: '' }, { input_tokens: 500, output_tokens: 40 }),
    { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: you have exceeded your quota' },
  ]))
  const turn = (job, extra = []) => {
    const file = join(runDir, 'jobs', `${job}.prompt.md`)
    writeFileSync(file, `Seat prompt ${job}\n\n<<<OUTPUT_SCHEMA\n{"type":"object","additionalProperties":false,"required":["answer","process"],"properties":{"answer":{"type":"string"},"process":{"type":"string"}}}\nOUTPUT_SCHEMA>>>\n`)
    const out = execFileSync(cli, ['seat-run', '--run-dir', runDir, '--vendor', 'gemini', '--seat', 'A', '--job', job,
      '--model', 'gemini-3.8-flash-high', '--cwd', join(runDir, 'wt', 'A'), '--prompt-file', file, ...extra], { env }).toString()
    return JSON.parse(out.trim().split('\n').pop())
  }
  const calls = n => JSON.parse(readFileSync(join(stub, 'calls', `${n}.json`), 'utf8'))

  // Without proceed-in-sandbox, headless agy would deny everything: refuse up front.
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['command(git status)'] } }))
  let refused = null
  try { turn('A-r0') } catch (e) { refused = e.stdout.toString() + e.stderr.toString() }
  assert.ok(refused && /proceed-in-sandbox/.test(refused), refused)

  writeFileSync(settings, JSON.stringify({ toolPermission: 'proceed-in-sandbox', permissions: { allow: ['command(git status)'] } }))
  const r0 = turn('A-r0b')
  assert.equal(r0.status, 'done', JSON.stringify(r0))
  assert.deepEqual(r0.result, { answer: 'one', process: '' })
  const c0 = calls(0)
  assert.ok(c0.argv.includes('--sandbox') && c0.argv.includes('--json-schema') && !c0.argv.includes('--conversation'))
  assert.equal(c0.argv[c0.argv.indexOf('--model') + 1], 'gemini-3.8-flash-high')
  assert.equal(c0.argv[c0.argv.indexOf('-p') + 1].trim(), 'Seat prompt A-r0b')
  assert.ok(!c0.cwd.startsWith(repo) && /council-agy\/run1-[0-9a-f]{8}\/A$/.test(c0.cwd), `agy starts outside the repository, so its shell can read and write the worktree: ${c0.cwd}`)
  const allow = JSON.parse(readFileSync(settings, 'utf8')).permissions.allow
  assert.deepEqual(allow, ['command(git status)', `write_file(${join(repo, '.council')})`], 'one grant per repo, existing rules kept')

  const r1 = turn('A-r1')
  assert.equal(r1.status, 'done')
  assert.deepEqual(r1.usage, { input_tokens: 150, output_tokens: 15 }, 'running totals turned into per-turn usage')
  const c1 = calls(1)
  assert.equal(c1.argv[c1.argv.indexOf('--conversation') + 1], 'c-1', 'the seat resumes its conversation')
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).permissions.allow.length, 2, 'the grant is added once')

  const rs = turn('A-r1s')
  assert.equal(rs.status, 'done', JSON.stringify(rs))
  assert.deepEqual([rs.result.answer, rs.nudged], ['three', true], 'stale structured output caught; one follow-up asked for it')
  assert.ok(/as structured output/.test(calls(3).argv[calls(3).argv.indexOf('-p') + 1]) && calls(3).argv.includes('c-1'), 'the follow-up resumes the same conversation')
  assert.deepEqual(rs.usage, { input_tokens: 110, output_tokens: 8 }, 'usage covers the turn and its follow-up')
  const rx = turn('A-r1x')
  assert.equal(rx.status, 'error')
  assert.ok(/does not match this turn's schema \(also after a follow-up asking for it\)\. Its text: Still text\./.test(rx.error), rx.error)

  const r2 = turn('A-r2')
  assert.deepEqual([r2.status, r2.result && r2.result.answer, r2.resumedAfter], ['done', 'resumed', 'command'], JSON.stringify(r2))
  assert.ok(/outside the sandbox again/.test(calls(7).argv[calls(7).argv.indexOf('-p') + 1]) && calls(7).argv.includes('c-1'), 'the resume continues the same conversation')
  const r2d = turn('A-r2d')
  assert.equal(r2d.status, 'error')
  assert.ok(/agy denied command, which ended the turn early \(also after resuming once\)/.test(r2d.error), r2d.error)

  const r3 = turn('A-r3')
  assert.equal(r3.status, 'error')
  assert.ok(/did not resume conversation c-1/.test(r3.error), r3.error)

  // A model at capacity is retried once inside the job; a used-up quota is not.
  const rc = turn('A-r5')
  assert.equal(rc.status, 'done', JSON.stringify(rc))
  assert.deepEqual([rc.result.answer, rc.retried], ['after the wait', 'Selected model is at capacity. Please try a different model.'])
  assert.equal(calls(12).argv[calls(12).argv.indexOf('--conversation') + 1], 'c-1', 'the retry resumes the same conversation')
  const rq = turn('A-r6')
  assert.equal(rq.status, 'error')
  assert.ok(/quota/.test(rq.error) && !rq.retried, JSON.stringify(rq))
  assert.equal(readdirSync(join(stub, 'calls')).length, 14, 'no retry after a quota error')

  // Inside a sandbox that blocks agy's home: reported as sandboxed, before anything runs.
  chmodSync(agyHome, 0o555)
  try { assert.equal(turn('A-r4').status, 'sandboxed') } finally { chmodSync(agyHome, 0o755) }
  return 'agy turn ran from a neutral cwd with the repo grant; resume, per-turn usage, denial resumed once, lost conversation, capacity retry and sandbox caught'
}

// ---------------------------------------------------------------- escalation after a debate round

// The math-php run: a question reached the threshold only after round 1. The answer must not
// change round 1's prompts, or the resumed run re-runs round 1 instead of replaying it.
async function scenarioLateEscalation() {
  const scenario = async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-late')
      case 'solve': return solve(role.L, ['A', 'B'].includes(role.L) ? { questions: [{ question: `${role.L}: round up at the boundary?`, assumption: 'no' }] } : {})
      case 'cluster': return { assignments: [0, 1].map(i => ({ index: i, matches: 'new-1' })), newQuestions: [{ label: 'new-1', text: 'Round up at the boundary?' }] }
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, role.round === 1 ? (['A', 'B'].includes(role.L) ? 'A' : role.L) : 'A', role.round === 1 && role.L === 'C' ? { seconds: ['Q1'] } : {})
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const args = { task: 'Design the boundary rounding', mode: 'design' }
  const first = await run('late-escalation', scenario, args)
  assert.equal(first.result.status, 'needs-user')
  assert.equal(first.result.round, 1)
  assert.ok(first.calls.some(c => c.role.kind === 'debate' && c.prompt.includes('[Q1] Round up at the boundary?')), 'round 1 shows Q1 as open')

  const resumed = await run('late-resume', scenario, { ...args, clarifications: [{ id: 'Q1', answer: 'Never round up.', afterRound: 1 }] })
  assert.equal(resumed.result.status, 'converged', JSON.stringify(resumed.result.reason || ''))
  const before = first.calls.map(c => c.prompt)
  assert.deepEqual(resumed.calls.slice(0, before.length).map(c => c.prompt), before, 'every prompt through round 1 is unchanged, so the resume replays it')
  const later = resumed.calls.slice(before.length).filter(c => ['debate', 'synth'].includes(c.role.kind))
  assert.ok(later.length && later.every(c => c.prompt.includes('Never round up.')), 'the answer reaches the turns after round 1')
  return 'escalated after round 1; the resume replayed rounds 0-1 unchanged and gave the answer to later turns'
}

// ---------------------------------------------------------------- setup picks the mode; seat guidance

async function scenarioModeAndGuidance() {
  const claimsA = [
    { kind: 'fact', statement: 'empty input returns []', evidence: 'src/a.php:10', criterion: 'C1' },
    { kind: 'fact', statement: 'the helper is private', evidence: 'src/a.php:3', criterion: '' },
    { kind: 'fact', statement: 'unknown criterion', evidence: 'src/a.php:4', criterion: 'C9' },
    ...Array.from({ length: 12 }, (_, i) => ({ kind: 'verification', statement: `check ${i}`, evidence: 'make test', criterion: '' })),
  ]
  const scenario = async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return { ...SETUP('test-mode'), mode: 'implement' }
      case 'solve': return solve(role.L, role.L === 'A' ? { claims: claimsA } : {})
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const before = RELAY_PROMPTS.length
  const { result, calls } = await run('mode', scenario, 'Do the next item in BUG_CHECK_LIST.md')
  assert.equal(result.mode, 'implement', 'setup chose implement although the wording guessed investigate')
  const setupPrompt = calls.find(c => c.role.kind === 'setup').prompt
  assert.ok(setupPrompt.includes('## Step 1b — the mode') && setupPrompt.includes('If the mode is implement and dirty is non-empty'))
  for (const c of calls.filter(c => c.role.kind === 'solve')) {
    assert.ok(c.prompt.includes('the diff in your worktree is the deliverable itself'), `${c.label}: implement deliverable`)
    assert.ok(c.prompt.includes("is meant for the user's own session, not for a council seat"), `${c.label}: gate-run guidance`)
    assert.ok(c.prompt.includes('Only the post file counts toward the limit'), `${c.label}: word-limit guidance`)
    assert.ok(c.prompt.includes('at most 12: every verification claim'), `${c.label}: claim limit`)
  }
  for (const c of calls.filter(c => c.role.kind === 'debate')) {
    assert.ok(c.prompt.includes("Don't open their files under /tmp/proj/.council/test-mode/room/r1/"), `${c.label}: blind-round note`)
  }
  assert.ok(result.notes.some(n => n === 'A made 2 fact claims in r0 that named no acceptance criterion; not recorded.'), result.notes.join('\n'))
  assert.ok(result.notes.some(n => n === 'A made 13 claims in r0; only the first 12 were recorded.'), result.notes.join('\n'))
  const relays = RELAY_PROMPTS.slice(before)
  assert.ok(relays.length && relays.every(p => p.includes('- timeout: 600000\n- dangerouslyDisableSandbox: true')), 'relays skip the sandbox on the first try')
  // The relay is told the printed JSON is the vendor's outcome, not a Bash problem, and not to rerun an error.
  assert.ok(relays.every(p => p.includes('not a problem with your Bash call') && p.includes("Don't run the command again")), 'relay reads errors as the vendor\'s')

  const given = await run('mode-given', async role => {
    if (role.kind === 'setup') return { ...SETUP('test-mode-given'), status: 'error', error: 'stop here', mode: 'implement' }
    throw new Error('nothing runs after a failed setup')
  }, { task: 'Do the next item in BUG_CHECK_LIST.md', mode: 'investigate' })
  const p = given.calls[0].prompt
  assert.ok(p.includes('Mode: investigate.') && !p.includes('Step 1b') && !p.includes('dirty is non-empty'), 'a given mode is kept')
  return 'setup chose implement for a checklist item; seats get gate, word-limit, claim and blind-round guidance; relays skip the sandbox'
}

// ---------------------------------------------------------------- init copies ignored agent docs

async function scenarioInitDocs() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'council-init-')))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).toString()
  git('init', '-q')
  writeFileSync(join(repo, '.gitignore'), 'CLAUDE.md\n')
  writeFileSync(join(repo, 'AGENTS.md'), 'tracked\n')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.'); git('commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'CLAUDE.md'), 'Run phpstan with --memory-limit=1G.\n')
  const out = execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['init', '--repo', repo, '--seats', 'A,B', '--run-id', 'r1'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).toString()
  const res = JSON.parse(out.trim().split('\n').pop())
  assert.deepEqual(res.agentDocs, ['CLAUDE.md'], 'only the ignored doc is copied; a tracked one is already there')
  for (const L of ['A', 'B']) {
    const wt = join(repo, '.council', 'r1', 'wt', L)
    assert.equal(readFileSync(join(wt, 'CLAUDE.md'), 'utf8'), 'Run phpstan with --memory-limit=1G.\n')
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt }).toString(), '', `${L}: the copy stays out of the diff`)
  }
  return 'init copied the gitignored CLAUDE.md into every worktree, outside the diff'
}

// ---------------------------------------------------------------- relay outcomes come as fields

// The live itertools run: Gemini's own "Malformed function call" came back through the relay as
// "sandboxed: …", and the workflow, matching on that text, blocked Gemini for the rest of the run.
async function scenarioRelayErrors() {
  const keyOf = {}
  const { result, calls } = await run('relay-errors', async (role, prompt, opts) => {
    const relay = /\(relay/.test(opts.label || '')
    if (relay && role.key === 'gemini' && role.kind === 'debate') {
      return { relayStatus: { status: 'error', error: 'sandboxed: not run. Your previous response contained an improperly formatted function call: Malformed function call', errorClass: 'transient' } }
    }
    if (relay && role.key === 'astra' && role.kind === 'debate' && opts.model === 'haiku') {
      return { relayStatus: { status: 'error', error: 'relay: the Bash tool rejected the call twice', errorClass: '' } }
    }
    if (relay && role.key === 'astra' && role.kind === 'ratify') return { ...ratify(true), turn: 'A-r1-00000000' }   // an earlier turn's answer
    switch (role.kind) {
      case 'setup': return SETUP('test-relay-errors')
      case 'solve': keyOf[role.key] = role.L; return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, keyOf.opus)        // a Claude author, so both externals ratify
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', rounds: 1, timeoutMin: { debate: 30 } })
  const L = key => result.seats.find(s => s.model === key).seat
  const G = L('Gemini Flash'), X = L('Codex Astra')
  const relays = (kind, key) => calls.filter(c => c.role.kind === kind && c.role.key === key && /\(relay/.test(c.label))
  assert.equal(relays('debate', 'gemini').length, 1, 'a vendor error is not retried with a second relay')
  assert.ok(relays('ratify', 'gemini').length === 1, 'Gemini was not blocked by an error that mentions a sandbox')
  assert.ok(!result.notes.some(n => /can't run inside Claude Code's sandbox/.test(n)), result.notes.join('\n'))
  assert.ok(result.notes.some(n => n.startsWith(`Gemini turn ${G}-r1 failed: sandboxed: not run.`) && n.endsWith('[transient]')), result.notes.join('\n'))
  assert.deepEqual(relays('debate', 'astra').map(c => c.opts.model), ['haiku', 'sonnet'], "the relay's own failure gets a stronger relay")
  assert.ok(result.notes.some(n => n.startsWith(`Codex turn ${X}-ratify failed: the result's turn tag "A-r1-00000000" is not ${X}-ratify-`)), 'a stale answer is refused')
  assert.equal(result.final.readiness.state, 'incomplete')
  assert.ok(result.final.readiness.incomplete.some(r => r.includes(`no ratification review from ${X}`)), JSON.stringify(result.final.readiness))
  assert.ok(relays('debate', 'gemini')[0].raw.includes('--timeout-min 30') && !relays('solve', 'gemini')[0].raw.includes('--timeout-min'), 'per-phase timeout')
  const retro = calls.find(c => c.role.kind === 'retro').prompt
  assert.ok(retro.includes(`${G}-r1 via haiku: error [transient] (sandboxed: not run.`), 'relay failures carry their class')
  assert.ok(/- Codex and Gemini turn times: median 42s; slowest /.test(retro), 'turn times in the facts')
  return 'a vendor error mentioning a sandbox no longer blocks the vendor; relay failures retry; stale turns refused; per-phase timeout'
}

// ---------------------------------------------------------------- preflight

async function scenarioPreflight() {
  const blocked = await run('preflight', async role => {
    if (role.kind === 'setup') {
      return { ...SETUP('test-preflight'), status: 'preflight', runDir: '', preflight: [
        { vendor: 'codex', ok: true, error: '' },
        { vendor: 'gemini', ok: false, error: 'cannot write to /Users/x/.gemini/antigravity-cli (Operation not permitted). This command is running inside a sandbox' }] }
    }
    throw new Error(`unexpected role ${role.kind}`)
  }, 'Fix the flaky retry')
  assert.equal(blocked.result.status, 'blocked')
  assert.equal(blocked.calls.length, 1, 'nothing but setup ran')
  const sp = blocked.calls[0].prompt
  assert.ok(sp.includes('preflight --vendors codex,gemini') && sp.includes('dangerouslyDisableSandbox: true'), 'setup checks both CLIs, outside the sandbox')
  assert.ok(sp.indexOf('## Step 0') < sp.indexOf('## Step 2'), 'before the run is created')
  const fto = blocked.result.forTheOrchestrator
  assert.ok(fto.includes('gemini: cannot write to') && fto.includes('"Bash(dark-factory:*)"') && fto.includes('the seat(s) gemini'), fto)
  assert.ok(!fto.includes('codex:'), 'only the failing vendor is named')

  const claudeOnly = await run('preflight-none', async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-preflight-none')
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', seats: ['opus', 'sonnet', 'fable'], panel: ['opus', 'sonnet'], audit: { correctness: 'sonnet' }, spec: { coverage: 'sonnet' }, rounds: 1 })
  assert.ok(!claudeOnly.calls[0].prompt.includes('preflight'), 'no preflight when no seat, panel member, spec reviewer or auditor needs another CLI')
  assert.equal(claudeOnly.result.status, 'converged')
  return 'a CLI that fails preflight stops the run before anything is created, naming the fix and the seat to swap'
}

// ---------------------------------------------------------------- readiness

async function scenarioReadiness() {
  const go = (runId, finalCheck) => run(runId, async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP(runId)
      case 'solve': return solve(role.L)
      case 'check': return role.tag === 'final' ? finalCheck(prompt) : check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', seats: ['opus', 'sonnet', 'fable'], rounds: 1, audit: false })

  const ok = await go('test-ready', p => check(p))
  assert.deepEqual(ok.result.final.readiness, { state: 'ready', blocked: [], incomplete: [] })
  assert.ok(ok.result.report.markdown.includes('- **Readiness:** ready: the final version was checked and nothing known stands against it'))
  assert.ok(ok.result.forTheOrchestrator.startsWith('You present this'), 'nothing to flag')

  const unmet = await go('test-blocked', p => check(p, undefined, undefined, undefined,
    { criteria: [{ criterion: 'C1', status: 'met', note: '' }, { criterion: 'C2', status: 'unmet', note: 'no test' }, { criterion: 'C3', status: 'met', note: '' }] }))
  assert.equal(unmet.result.status, 'converged', 'readiness never changes the choice')
  assert.deepEqual(unmet.result.final.readiness.blocked, ['criteria unmet: C2'])
  assert.ok(unmet.result.forTheOrchestrator.startsWith('The final version is BLOCKED (final.readiness: criteria unmet: C2). Say so at the top'))

  const thin = await go('test-thin', p => ({ ...check(p, undefined, undefined, undefined, { criteria: [{ criterion: 'C1', status: 'met', note: '' }, { criterion: 'C2', status: 'met', note: '' }] }), measured: false }))
  assert.equal(thin.result.final.readiness.state, 'incomplete')
  assert.deepEqual(thin.result.final.readiness.incomplete, ['the verification command did not run on the final version', 'criteria not judged: C3'])

  const none = await go('test-unchecked', () => null)
  assert.ok(none.calls.some(c => c.label === 'check final:A (retry)'), 'a missing check is retried once')
  assert.deepEqual(none.result.final.readiness.incomplete, ['the final version was never checked'])
  return 'readiness reports ready, blocked (unmet criterion) and incomplete (unrun suite, unjudged criterion, no check) without changing the choice'
}

// ---------------------------------------------------------------- vote-timing experiments

async function scenarioApproval() {
  const go = (runId, ships, accept, extra) => run(runId, async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP(runId)
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, ships[role.L], { vote: { ship: ships[role.L], amendments: [], reason: 'best', acceptable: accept[role.L] || [] } })
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', rounds: 1, ...extra })
  const split = { A: 'A', B: 'B', C: 'A', D: 'D' }
  const dAccepts = { D: [{ seat: 'A', amendments: ['tighten the guard'] }] }

  const on = await go('test-approval', split, dAccepts, { approval: true })
  assert.equal(on.result.status, 'converged', JSON.stringify(on.result.outcome))
  assert.equal(on.result.final.author, 'A')
  assert.ok(/^Converged in round 1 by approval: /.test(on.result.outcome.how), on.result.outcome.how)
  assert.ok(on.calls.find(c => c.role.kind === 'synth').prompt.includes('D (accepts it): tighten the guard'), 'amendments from accepting seats carry over')
  assert.ok(on.result.report.markdown.includes('by approval, an experiment turned on for this run'))
  const d1 = on.calls.find(c => c.role.kind === 'debate' && !/\(relay/.test(c.label))
  assert.ok(d1.prompt.includes('`vote.acceptable`') && d1.opts.schema.properties.vote.properties.acceptable, 'asked for, in prompt and schema')

  const off = await go('test-approval-off', split, dAccepts, {})
  assert.equal(off.result.status, 'scorecard', 'off by default: the same votes do not converge')
  const d2 = off.calls.find(c => c.role.kind === 'debate' && !/\(relay/.test(c.label))
  assert.ok(!d2.prompt.includes('vote.acceptable') && !d2.opts.schema.properties.vote.properties.acceptable)

  const self = await go('test-approval-self', { A: 'A', B: 'B', C: 'C', D: 'D' },
    { B: [{ seat: 'A', amendments: [] }], C: [{ seat: 'A', amendments: [] }], D: [{ seat: 'A', amendments: [] }] }, { approval: true })
  assert.equal(self.result.status, 'scorecard', 'acceptance alone, with only its author choosing it first, does not carry a position')
  return 'approval (opt-in) converges on first-choice plus acceptable votes, carries amendments, needs a first choice from another seat'
}

async function scenarioBallot() {
  const go = (runId, r1, ballot, extra) => run(runId, async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP(runId)
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, role.round === 1 ? r1[role.L] : 'A')
      case 'ballot': return { vote: { ship: ballot[role.L], amendments: [], reason: ballot[role.L] === r1[role.L] ? 'unchanged' : 'ruling 1C1' } }
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }, { task: 'Fix the flaky retry', rounds: 2, ballot: true, ...extra })
  const r1 = { A: 'A', B: 'A', C: 'C', D: 'D' }

  const { result, calls } = await go('test-ballot', r1, { ...r1, D: 'A' })
  assert.equal(result.status, 'converged', JSON.stringify(result.outcome))
  assert.equal(result.roundsRun, 1, 'no second debate round')
  assert.ok(/^Converged in the ballot after round 1: /.test(result.outcome.how), result.outcome.how)
  assert.equal(result.outcome.ballotsByRound['1'].D.ship, 'A')
  const ballots = calls.filter(c => c.role.kind === 'ballot')
  assert.equal(ballots.length, 4, ballots.map(c => c.label).join(', '))
  assert.ok(ballots.some(c => /\(relay/.test(c.label)), 'external seats vote through their relay')
  for (const c of ballots) {
    assert.ok(c.prompt.includes('# Ballot after round 1') && c.prompt.includes('# Standings and ledger after round 1') && c.prompt.includes('Your round-1 vote: '), c.label)
    assert.ok(c.opts.phase === 'Round 1', 'grouped with its round')
  }
  assert.ok(result.report.markdown.includes('Ballot after the checks A→A, B→A, C→C, D→A. Consensus on A in the ballot after the round.'), result.report.markdown)
  assert.ok(calls.find(c => c.role.kind === 'retro').prompt.includes('- Votes by round: r1 A→A B→A C→C D→D · ballot b1 A→A B→A C→C D→A.'))

  const far = await go('test-ballot-far', { A: 'A', B: 'B', C: 'C', D: 'D' }, {})
  assert.ok(!far.calls.some(c => c.role.kind === 'ballot'), 'no ballot unless a position is one vote short')
  assert.ok(far.logs.some(l => l === 'round 1: no ballot (no position was one vote short)'))

  const last = await go('test-ballot-last', r1, { ...r1, D: 'A' }, { rounds: 1 })
  assert.ok(!last.calls.some(c => c.role.kind === 'ballot'), 'never in the last round')
  assert.equal(last.result.status, 'scorecard')
  return 'the ballot (opt-in) re-votes after the checks when one vote short, converges without another round, and is skipped otherwise'
}

// ---------------------------------------------------------------- CLI: relay-facing behaviour of seat-run

function agyRig(name, replies) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), `council-${name}-`)))
  const home = join(tmp, 'home'), bin = join(tmp, 'bin'), repo = join(tmp, 'repo'), runDir = join(repo, '.council', 'run1')
  const agyHome = join(home, '.gemini', 'antigravity-cli'), stub = join(tmp, 'stub')
  for (const d of [agyHome, bin, join(runDir, 'jobs'), join(runDir, 'wt', 'A'), join(stub, 'calls'), join(tmp, 'tmp')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(agyHome, 'settings.json'), JSON.stringify({ toolPermission: 'proceed-in-sandbox' }))
  writeFileSync(join(bin, 'agy'), `#!/usr/bin/env python3
import json, os, sys
d = os.environ['AGY_STUB']
n = len(os.listdir(os.path.join(d, 'calls')))
json.dump({'argv': sys.argv[1:]}, open(os.path.join(d, 'calls', f'{n}.json'), 'w'))
print(json.dumps(json.load(open(os.path.join(d, 'replies.json')))[n]))
`)
  chmodSync(join(bin, 'agy'), 0o755)
  writeFileSync(join(stub, 'replies.json'), JSON.stringify(replies))
  const env = { ...process.env, HOME: home, TMPDIR: join(tmp, 'tmp'), AGY_STUB: stub, PATH: `${bin}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: '1', COUNCIL_RETRY_WAIT: '0' }
  const turn = (job, schema, prompt = `Seat prompt ${job}`) => {
    const file = join(runDir, 'jobs', `${job}.prompt.md`)
    writeFileSync(file, `${prompt}\n\n<<<OUTPUT_SCHEMA\n${JSON.stringify(schema)}\nOUTPUT_SCHEMA>>>\n`)
    const out = execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['seat-run', '--run-dir', runDir, '--vendor', 'gemini', '--seat', 'A', '--job', job,
      '--model', 'gemini-3.8-flash-high', '--cwd', join(runDir, 'wt', 'A'), '--prompt-file', file], { env }).toString()
    return JSON.parse(out.trim().split('\n').pop())
  }
  return { turn, ncalls: () => readdirSync(join(stub, 'calls')).length }
}

async function scenarioSeatRunErrors() {
  const ok = (out, usage = { input_tokens: 10 }) => ({ conversation_id: 'c-1', status: 'SUCCESS', response: '', structured_output: out, usage })
  const tagged = t => ({ type: 'object', additionalProperties: false, required: ['answer', 'turn'],
    properties: { answer: { type: 'string' }, turn: { type: 'string', enum: [t] } } })
  const { turn, ncalls } = agyRig('seatrun', [
    ok({ answer: 'one', turn: 'A-r0-aaaaaaaa' }),
    // Gemini's own malformed tool call, passed through by agy: retried once inside the job.
    { status: 'ERROR', error: 'Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty' },
    ok({ answer: 'two', turn: 'A-r1-bbbbbbbb' }, { input_tokens: 30 }),
    // The right shape but the previous turn's tag: stale, so agy is asked again, then it is an error.
    { ...ok({ answer: 'one', turn: 'A-r0-aaaaaaaa' }, { input_tokens: 40 }), response: 'Agreed.' },
    { ...ok({ answer: 'one', turn: 'A-r0-aaaaaaaa' }, { input_tokens: 50 }), response: 'Agreed.' },
    // A quota error, twice: the second identical call reruns it, the third returns it without running.
    { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded' },
    { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded' },
  ])
  assert.equal(turn('A-r0', tagged('A-r0-aaaaaaaa')).status, 'done')
  const r1 = turn('A-r1', tagged('A-r1-bbbbbbbb'))
  assert.equal(r1.status, 'done', JSON.stringify(r1))
  assert.ok(/Malformed function call/.test(r1.retried), 'a malformed tool call by the vendor model is retried once')
  const stale = turn('A-r2', tagged('A-r2-cccccccc'))
  assert.equal(stale.status, 'error')
  assert.ok(/does not match this turn's schema \(also after a follow-up/.test(stale.error), stale.error)
  const q1 = turn('A-r3', tagged('A-r3-dddddddd'))
  assert.deepEqual([q1.status, q1.errorClass, ncalls()], ['error', 'quota', 6])
  const q2 = turn('A-r3', tagged('A-r3-dddddddd'))
  assert.deepEqual([q2.status, q2.repeated, ncalls()], ['error', undefined, 7], 'one rerun of a failed turn')
  const q3 = turn('A-r3', tagged('A-r3-dddddddd'))
  assert.deepEqual([q3.status, q3.repeated, q3.errorClass, ncalls()], ['error', true, 'quota', 7], 'then the error stands, without running agy again')
  return 'seat-run retries a vendor\'s malformed tool call, refuses a stale turn tag, classifies errors and caps reruns of a failed turn'
}

// ---------------------------------------------------------------- CLI: measurement in a scratch checkout

function gitRepo(name) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `council-${name}-`)))
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo }).toString()
  git('init', '-q')
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  git('add', '.'); git('commit', '-q', '-m', 'init')
  return repo
}

async function scenarioMeasure() {
  const repo = gitRepo('measure')
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  const cli = (...a) => JSON.parse(execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), a, { env }).toString().trim().split('\n').pop())
  const init = cli('init', '--repo', repo, '--seats', 'A', '--run-id', 'm1')
  const rd = init.runDir, wt = init.worktrees.A
  // The suite records where it ran, checks the seat's new file is there, and changes a tracked file.
  writeFileSync(join(rd, 'verify.sh'), `pwd > ${join(rd, 'tmp', 'suite-cwd')}\ntest -f new.txt\necho touched >> tracked.txt\n`)
  writeFileSync(join(wt, 'new.txt'), 'the seat\'s change\n')
  mkdirSync(join(rd, 'room', 'tests', 'T0A1', 'files'), { recursive: true })
  writeFileSync(join(rd, 'room', 'tests', 'T0A1', 'test.json'), JSON.stringify({ command: 'echo again >> tracked.txt; test -f new.txt', purpose: 'p' }))
  const m = cli('measure', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--tests', 'T0A1')
  assert.equal(m.status, 'done', JSON.stringify(m))
  assert.ok(m.scratch && m.suite.passed, JSON.stringify(m))
  const ranIn = readFileSync(join(rd, 'tmp', 'suite-cwd'), 'utf8').trim()
  assert.ok(ranIn !== wt && ranIn.startsWith(join(rd, 'scratch')), `the suite ran in a scratch checkout, not the live worktree: ${ranIn}`)
  assert.deepEqual(m.suite.mutated, ['tracked.txt'], 'a suite that changes tracked files is reported')
  assert.deepEqual([m.crossTests[0].outcome, m.crossTests[0].mutated], ['pass', ['tracked.txt']], 'the cross-test started from the snapshot again')
  assert.equal(readFileSync(join(wt, 'tracked.txt'), 'utf8'), 'base\n', 'the live worktree was not touched')
  assert.ok(!existsSync(ranIn), 'the scratch checkout is removed')
  assert.equal(cli('measure', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--tests', 'T0A1').reused, true, 'unchanged inputs reuse the result')
  writeFileSync(join(wt, 'new.txt'), 'edited after the measurement\n')
  const again = cli('measure', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--tests', 'T0A1')
  assert.ok(again.status === 'done' && !again.reused, 'a changed tree is measured again, not replayed')

  // An auditor's checkout of a snapshot: by name from materialize, or made by seat-run before the vendor starts.
  const mat = cli('materialize', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--name', 'audit-design')
  assert.equal(mat.path, join(rd, 'snap', 'audit-design'))
  assert.equal(readFileSync(join(mat.path, 'new.txt'), 'utf8'), 'edited after the measurement\n', 'the checkout holds the snapshot')
  assert.equal(cli('materialize', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--name', 'audit-design').path, mat.path, 'made once, reused after')
  assert.throws(() => execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['materialize', '--run-dir', rd, '--seat', 'A', '--label', 'r0', '--name', '../x'], { env, stdio: 'pipe' }))
  const codexHome = mkdtempSync(join(tmpdir(), 'council-codex-')), cwd = join(rd, 'snap', 'audit-correctness')
  const sr = JSON.parse(execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['seat-run', '--run-dir', rd, '--seat', 'audit-correctness', '--job', 'audit-correctness',
    '--model', 'm', '--cwd', cwd, '--checkout', 'A-r0', '--prompt-file', join(rd, 'jobs', 'none.md'), '--expect', '1-00000000'],
  { env: { ...env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: codexHome } }).toString().trim().split('\n').pop())
  assert.equal(sr.status, 'need-file', JSON.stringify(sr))
  assert.ok(existsSync(join(cwd, 'new.txt')), 'seat-run --checkout made the auditor\'s checkout before anything else')

  // Claude agents' usage is read from transcripts that name the run directory; a message logged twice counts once.
  const cfg = join(repo, 'claude-cfg'), proj = join(cfg, 'projects', 'p', 's', 'subagents', 'workflows', 'wf1')
  mkdirSync(proj, { recursive: true })
  const msg = (id, out) => JSON.stringify({ message: { id, role: 'assistant', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: out } } })
  writeFileSync(join(proj, 'agent-1.jsonl'), [JSON.stringify({ message: { role: 'user', content: `check ${rd}` } }), msg('m1', 10), msg('m1', 10), msg('m2', 7)].join('\n'))
  writeFileSync(join(proj, 'agent-1.meta.json'), JSON.stringify({ description: 'check r1:A' }))
  writeFileSync(join(proj, 'agent-2.jsonl'), [JSON.stringify({ message: { role: 'user', content: 'another run' } }), msg('m3', 99)].join('\n'))
  const u = JSON.parse(execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['usage', '--run-dir', rd], { env: { ...env, CLAUDE_CONFIG_DIR: cfg } }).toString().trim().split('\n').pop())
  assert.deepEqual(u.claude, { agents: 1, byModel: { 'claude-sonnet-5-5': { messages: 2, input_tokens: 10, output_tokens: 17 } },
    byRole: { checker: { messages: 2, input_tokens: 10, output_tokens: 17 } } }, JSON.stringify(u.claude))
  // A suite that needs an ignored file the scratch checkout lacks: the live tree's pass stands, and the mismatch is reported.
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '/.council/\n.env\n')
  writeFileSync(join(wt, '.env'), 'X=1\n')
  writeFileSync(join(rd, 'verify.sh'), 'test -f .env\n')
  const envm = cli('measure', '--run-dir', rd, '--seat', 'A', '--label', 'r1')
  assert.ok(envm.suite.passed && envm.suite.scratchFailed !== undefined, JSON.stringify(envm.suite))
  cli('cleanup', '--run-dir', rd, '--all')
  return 'measure runs the suite and cross-tests in a scratch checkout, reports mutation, reuses only unchanged inputs; usage counts Claude agents'
}

async function scenarioPreflightCli() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'council-preflight-')))
  const home = join(tmp, 'home'), bin = join(tmp, 'bin')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true }); mkdirSync(bin)
  for (const [exe, v] of [['codex', 'codex-cli 9.9'], ['agy', '1.3.4']]) { writeFileSync(join(bin, exe), `#!/bin/sh\necho ${v}\n`); chmodSync(join(bin, exe), 0o755) }
  const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), PATH: `${bin}:/usr/bin:/bin`, PYTHONDONTWRITEBYTECODE: '1' }
  const pre = () => JSON.parse(execFileSync(join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['preflight', '--vendors', 'codex,gemini'], { env }).toString().trim().split('\n').pop())
  let r = pre()
  assert.equal(r.status, 'error')
  assert.ok(r.vendors.codex.ok && !r.vendors.gemini.ok && /proceed-in-sandbox/.test(r.vendors.gemini.error), JSON.stringify(r))
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ toolPermission: 'proceed-in-sandbox' }))
  r = pre()
  assert.deepEqual([r.status, r.vendors.gemini.version], ['ok', '1.3.4'])
  chmodSync(join(home, '.gemini', 'antigravity-cli'), 0o555)
  try { r = pre() } finally { chmodSync(join(home, '.gemini', 'antigravity-cli'), 0o755) }
  assert.deepEqual([r.status, r.vendors.gemini.sandboxed], ['sandboxed', true], JSON.stringify(r))
  return 'preflight reports a missing agy setting, a working pair of CLIs, and a sandboxed one'
}

// Every blind round-0 version is the same tree and passes: the debate is skipped, the copy highest
// on the scorecard is finalised, and the others ratify. One differing tree and the debate runs.
async function scenarioBlind() {
  const T = 'c'.repeat(40)
  const handler = differ => async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-blind')
      case 'solve': return solve(role.L)
      case 'check': return check(prompt, undefined, undefined, undefined,
        { diff: { files: 1, added: 1, removed: 1, tree: role.tag === 'r0' && role.L === differ ? 'd'.repeat(40) : T } })
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls, logs } = await run('blind', handler(null), 'Fix the off-by-one in clamp()')
  assert.equal(result.status, 'converged', JSON.stringify(result.outcome))
  assert.equal(result.roundsRun, 0)
  assert.ok(!calls.some(c => c.role.kind === 'debate'), 'no debate turns')
  assert.ok(!calls.some(c => c.role.kind === 'check' && c.role.tag === 'r1'), 'no round-1 checks')
  const W = result.final.author
  assert.equal(result.report.chosen.seat, W)
  assert.equal(result.final.endorsedBy.length, 3)
  const syn = calls.find(c => c.role.kind === 'synth')
  assert.ok(syn.prompt.includes('converged before any debate'), 'the author is told why')
  assert.ok(/byte-identical/.test(result.report.markdown) && /debate was skipped/.test(result.report.markdown), 'the report says so')
  assert.ok(logs.some(l => /skipping the debate/.test(l)))

  const two = await run('blind-differ', handler('D'), 'Fix the off-by-one in clamp()')
  assert.ok(two.calls.some(c => c.role.kind === 'debate'), 'one differing tree: the debate runs')
  assert.equal(two.result.roundsRun, 1)
  return `identical round 0 skipped the debate (${W} finalised, ${calls.length} turns); a differing tree debated (${two.calls.length} turns)`
}

// ---------------------------------------------------------------- the independent audit

async function scenarioAudit() {
  let W = null
  const panelIds = prompt => [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => m[1])
  const handler = ({ failDesign = false } = {}) => async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-audit')
      case 'solve': return solve(role.L)
      case 'check': return check(prompt, () => 'verified', () => role.tag === 'final3' ? 'yes' : 'no',
        () => prompt.includes('TXC1') ? [{ test: 'TXC1', outcome: role.tag === 'final3' ? 'pass' : 'fail', note: '' }] : [])
      case 'debate': return debate(role.L, 'A')
      case 'synth': W = role.L; return synth()
      case 'ratify': return ratify(true)
      case 'audit': return role.tag === 'correctness'
        ? { summary: 'Crashes on an empty string.', probes: [],
            findings: [{ severity: 'major', kind: 'fact', statement: 'parse("") throws instead of returning []', evidence: 'TXC1 fails' },
                       { severity: 'minor', kind: 'fact', statement: 'the docblock still says it never throws', evidence: 'src/Parser.php:12' }],
            tests: [{ id: 'TXC1', purpose: 'parse("") returns []', command: 'phpunit TXC1Test.php' }, { id: 'T9Z1', purpose: 'bad id', command: 'x' }] }
        : failDesign ? null
        : { summary: 'Works, but adds a helper the codebase already has.', tests: [],
            probes: [{ change: 'accept a stream as input', touches: 'Parser::parse and Tokenizer only', verdict: 'easy' }],
            findings: [{ severity: 'major', kind: 'judgment', statement: 'inline trimInput(): Str::trim already does this', evidence: 'src/Str.php:40' },
                       { severity: 'minor', kind: 'judgment', statement: 'rename $x to $tokens', evidence: 'src/Parser.php:20' },
                       { severity: 'major', kind: 'judgment', statement: 'split parse() into two methods', evidence: 'src/Parser.php:10-60' }] }
      case 'panel': {
        // The design split: Opus would make the change, Astra would not.
        const split = id => id === 'XD3' && role.member === 'astra'
        return { rulings: panelIds(prompt).map(id => ({ claim: id, verdict: role.tag === 'reaudit' ? 'refuted' : split(id) ? 'refuted' : 'verified', note: `panel on ${id}` })) }
      }
      case 'auditfix': return { ...synth(), summary: 'final version, audited and fixed', addressed: [{ ref: 'XC1', how: 'guard added' }, { ref: 'XD2', how: 'renamed to $tokens' }],
        declined: [{ ref: 'XD3', why: 'one method reads better here' }] }
      case 'reaudit': return role.tag === 'correctness'
        ? { summary: 'The guard broke null input.', tests: [], probes: [], findings: [{ severity: 'major', kind: 'fact', statement: 'parse(null) now throws', evidence: 'src/Parser.php:14' }] }
        : { summary: 'The fix is fine.', findings: [], tests: [], probes: [] }
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const args = { task: 'Fix the empty-input crash in Parser::parse', seats: ['opus', 'sonnet', 'fable'], rounds: 1 }
  const { result, calls, logs } = await run('audit', handler(), args, { audit: true })
  const call = (kind, tag) => calls.find(c => c.role.kind === kind && (tag === undefined || c.role.tag === tag))
  const item = id => result.audit.items.find(x => x.id === id)

  // The auditors are blind: no protocol, no ledger, no posts; told to stay out of the room.
  const design = call('audit', 'design'), corr = call('audit', 'correctness')
  for (const c of [design, corr]) {
    assert.ok(!c.prompt.includes('# How the council works') && !c.prompt.includes('Standings and ledger'), `${c.label}: blind`)
    assert.ok(c.prompt.includes("Don't open anything else under /tmp/proj/.council/test-audit/room"), `${c.label}: kept out of the room`)
    assert.ok(c.prompt.includes(`room/final/${W}.diff`), `${c.label}: given the final diff`)
  }
  assert.ok(design.prompt.includes('# Your lens: design') && corr.prompt.includes('# Your lens: correctness'))
  assert.ok(design.prompt.includes(`materialize --run-dir /tmp/proj/.council/test-audit --seat ${W} --label final --name audit-design`))
  assert.deepEqual([design.opts.model, /\(relay/.test(corr.label)], ['opus', true], 'design by Opus, correctness by Astra through a relay')
  assert.ok(/seat-run [^\n]*--model 'gpt-6-astra'[^\n]*--cwd '\/tmp\/proj\/\.council\/test-audit\/snap\/audit-correctness'[^\n]*--fresh[^\n]*--checkout '[A-C]-final'/.test(corr.raw), 'a fresh Codex thread in its own checkout of the final version')
  assert.ok(result.notes.some(n => /Ignored test 'T9Z1' from the correctness auditor/.test(n)))

  // Triage: the checker runs the auditor's test and rules on fact findings; the panel takes blocker
  // and major ones, judgment included; the minor judgment goes to the author unadjudicated.
  const chk = calls.find(c => c.label === `check audit:${W}`)
  assert.ok(chk.prompt.includes('--tests TXC1') && chk.prompt.includes('[TXC1]') && chk.prompt.includes("An auditor's test is meant to fail"), 'the audit check runs and rules on the test')
  assert.ok(chk.prompt.includes('[XC2]') && !chk.prompt.includes('[XD1]') && !chk.prompt.includes('[XD2]'), 'fact findings to the checker, judgment ones not')
  const pan = calls.filter(c => c.role.kind === 'panel' && c.role.tag === 'audit')
  assert.equal(pan.length, 2)
  assert.deepEqual(panelIds(pan[0].prompt).sort(), ['XC1', 'XD1', 'XD3'])
  assert.ok(pan[0].prompt.includes('For a finding marked "judgment"') && pan[0].prompt.includes('Raised by an independent auditor'))
  assert.deepEqual([item('XC1').status, item('XD1').status, item('XD1').judgment, item('XD3').status, item('XD2').status],
    ['fixed', 'fixed', false, 'judgment', 'fixed'].map((x, i) => i === 4 ? 'judgment' : x), 'agreed judgment becomes a fact; a split stays a judgment')

  // One fix pass, given everything in its place, then checked again and re-reviewed on the delta.
  const fix = call('auditfix')
  for (const want of ['Upheld. Fix each one', '[XC1] correctness auditor, major', '[XD1] design auditor, major', '[XC2] correctness auditor, minor',
                      'Failing tests. Make each one pass', '[TXC1] test from the correctness auditor', 'Suggestions, not adjudicated', '[XD2]', '[XD3]']) {
    assert.ok(fix.prompt.includes(want), `fix prompt: ${want}`)
  }
  assert.ok(calls.some(c => c.label === `check final3:${W}`), 'the fix is checked')
  const re = call('reaudit', 'correctness')
  assert.ok(re.prompt.startsWith('The audit continues.') && !/--fresh/.test(re.raw) && /--checkout '[A-C]-final3'/.test(re.raw), 'the re-review resumes the thread on the fixed version')
  assert.ok(re.prompt.includes('[XC1] major: parse("") throws') && re.prompt.includes(`room/final3/${W}.delta.diff`), 're-review sees its findings and the fix delta')
  assert.ok(call('reaudit', 'design').prompt.includes('Apart from the files named below'), 'the Claude re-reviewer is told to stay blind too')
  assert.equal(item('XC3').status, 'refuted', 'the re-review finding went to the panel')
  assert.ok(logs.some(l => /re-review raised XC3/.test(l)))

  // The result: shipped from the audit fix, ready, and reported.
  assert.equal(result.final.diff, `/tmp/proj/.council/test-audit/room/final3/${W}.diff`)
  assert.equal(result.final.auditFixPass, true)
  assert.deepEqual(result.final.readiness, { state: 'ready', blocked: [], incomplete: [] })
  const md = result.report.markdown
  for (const want of ['### Independent audit', '- **Correctness, Codex Astra:** Crashes on an empty string.', 'Probe: accept a stream as input → easy',
                      '[XC1] major: parse("") throws instead of returning [] → upheld by the two-vendor panel', 'fixed in the audit fix pass',
                      '[XD2] minor, judgment: rename $x to $tokens → a suggestion to the author, not adjudicated; taken: renamed to $tokens',
                      '[XD3] major, judgment: split parse() into two methods → the panel split, so it stays a judgment call', 'declined by the author: one method reads better here',
                      '[TXC1] test: parse("") returns [] → a valid test; fail on the audited version, pass after the fix', '**Re-review of the fix** (correctness, design):',
                      '[XC3] major: parse(null) now throws → refuted by the two-vendor panel']) {
    assert.ok(md.includes(want), `report: ${want}\n${md.split('### Independent audit')[1]}`)
  }
  assert.ok(md.indexOf('### Independent audit') > md.indexOf('### How it turned out'))
  assert.ok(!md.split('### Independent audit')[0].includes('[XC1]'), 'audit findings are not repeated among the debates')
  assert.ok(result.forTheOrchestrator.includes('what the independent audit found'))
  const retro = calls.find(c => c.role.kind === 'retro')
  assert.ok(/- Audit: correctness by Codex Astra, design by Claude Opus; 5 findings \(/.test(retro.prompt), 'retro facts carry the audit')

  // An auditor that fails leaves the final version incomplete, and with nothing upheld there is no fix pass.
  const clean = async (role, prompt) => role.kind === 'audit' && role.tag === 'correctness' ? CLEAN_AUDIT() : handler({ failDesign: true })(role, prompt)
  const half = await run('audit-half', clean, args, { audit: true })
  assert.equal(half.result.final.auditFixPass, false)
  assert.ok(!half.calls.some(c => ['auditfix', 'reaudit'].includes(c.role.kind)))
  assert.deepEqual(half.result.final.readiness.incomplete, ['no review from the design auditor'])
  assert.equal(half.result.final.diff, `/tmp/proj/.council/test-audit/room/final/${half.result.final.author}.diff`)

  const off = await run('audit-off', handler(), { ...args, audit: false })
  assert.ok(!off.calls.some(c => ['audit', 'reaudit', 'auditfix'].includes(c.role.kind) || /^check audit/.test(c.label)), 'audit: false skips it')
  assert.equal(off.result.audit, null)
  return `audit on ${W}: panel upheld XC1 and XD1, split XD3; one fix pass; the re-review's XC3 refuted; a failed auditor leaves it incomplete; audit: false skips it`
}

// ---------------------------------------------------------------- the spec review

async function scenarioSpec() {
  const panelIds = prompt => [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => m[1])
  // S1 accepted, S2 rejected, S3 a decision (Opus calls it one, Astra would accept it), S4 split.
  const verdicts = { opus: { S1: 'accept', S2: 'reject', S3: 'decision', S4: 'accept' }, astra: { S1: 'accept', S2: 'reject', S3: 'accept', S4: 'reject' } }
  const handler = ({ failAmend = false } = {}) => async (role, prompt) => {
    switch (role.kind) {
      case 'setup': return SETUP('test-spec')
      case 'spec': return role.tag === 'coverage'
        ? { summary: 'C1 misses the empty case; the rest holds.', findings: [
            { severity: 'major', kind: 'fact', criterion: 'C1', statement: 'C1 says nothing about a null body, which the caller in src/Api.php:30 passes', evidence: 'src/Api.php:30', change: 'C1: handles empty and null input, returning []', readings: [] },
            { severity: 'minor', kind: 'fact', criterion: '', statement: 'add a criterion for logging every retry', evidence: '', change: 'C4: every retry is logged', readings: [] }] }
        : { summary: 'One real ambiguity about which errors are retried.', findings: [
            { severity: 'major', kind: 'decision', criterion: 'C2', statement: 'Should 5xx responses be retried, or only timeouts?', evidence: 'the task says "transient failures"', change: '', readings: ['only timeouts', 'timeouts and 5xx'] },
            { severity: 'minor', kind: 'fact', criterion: 'C3', statement: 'C3 should name the public methods', evidence: 'src/Api.php:1-80', change: 'C3: no change to Api\'s public methods', readings: [] }] }
      case 'panel': return { rulings: panelIds(prompt).map(id => ({ finding: `[${id}]`, verdict: verdicts[role.member][id], note: `${role.member} on ${id}` })) }
      case 'specamend': return failAmend ? null : {
        criteria: [{ id: 'C1', text: 'handles empty and null input, returning []' }, { id: 'C2', text: 'tests pass' }, { id: 'C3', text: 'no API change' },
                   { id: 'C4', text: prompt.includes("The user's answer") ? 'timeouts and 5xx responses are retried' : 'only timeouts are retried; a 5xx is returned at once' }],
        verify: 'make test', baselinePasses: true, baselineNote: '',
        applied: [{ finding: 'S1', change: 'C1 now covers null' }, { finding: 'S3: retry scope', change: 'added C4' }],
        assumptions: prompt.includes("The user's answer") ? [] : [{ finding: 'S3', question: 'Should 5xx responses be retried?', chosen: 'only timeouts', alternative: 'timeouts and 5xx', impact: 'a 5xx would be retried three times' }],
      }
      case 'solve': return solve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const args = { task: 'Make the HTTP client retry transient failures', mode: 'implement', seats: ['opus', 'sonnet', 'fable'], rounds: 1 }
  const { result, calls, logs } = await run('spec', handler(), args, { spec: true })
  const call = (kind, tag) => calls.find(c => c.role.kind === kind && (tag === undefined || c.role.tag === tag))

  // The reviewers see the task, the code and the criteria, nothing of a council; one lens each.
  const cov = call('spec', 'coverage'), int = call('spec', 'intent')
  for (const c of [cov, int]) {
    assert.ok(!c.prompt.includes('# How the council works') && c.prompt.includes('- C1: handles empty input') && c.prompt.includes('`make test`'), `${c.label}: task and criteria only`)
    assert.ok(c.prompt.includes("Don't attempt the task.") && c.prompt.includes('"decision"'), `${c.label}: facts and decisions`)
    assert.ok(calls.indexOf(c) < calls.findIndex(x => x.role.kind === 'solve'), 'before any seat starts')
  }
  assert.ok(cov.prompt.includes('# Your lens: coverage') && int.prompt.includes('# Your lens: intent'))
  assert.ok(/seat-run [^\n]*--model 'gpt-6-astra'[^\n]*--sandbox read-only --cwd '\/tmp\/proj'[^\n]*--fresh/.test(cov.raw), 'coverage by Astra, read-only in the repo')
  assert.equal(int.opts.model, 'opus')

  // The panel rules on all four; the amendment gets only what was accepted or is a decision.
  const pan = calls.filter(c => c.role.kind === 'panel' && c.role.tag === 'spec')
  assert.equal(pan.length, 2)
  assert.deepEqual(panelIds(pan[0].prompt), ['S1', 'S2', 'S3', 'S4'])
  assert.deepEqual(result.spec.findings.map(f => f.status), ['accepted', 'rejected', 'decision', 'disputed'])
  const amend = call('specamend')
  assert.ok(amend.prompt.includes('# Accepted: amend the criteria for each\n\n- [S1]') && amend.prompt.includes('# Decisions: questions about what the user wants\n\n- [S3]'))
  assert.ok(!amend.prompt.includes('[S2]') && !amend.prompt.includes('[S4]'), 'rejected and disputed findings are left alone')
  assert.ok(amend.prompt.includes('--label base2 --no-snapshot') && amend.prompt.includes('most conservative reading'))

  // Everything after works to the amended criteria and knows the assumption.
  const solve0 = call('solve')
  assert.ok(solve0.prompt.includes('- C1: handles empty and null input, returning []') && solve0.prompt.includes('- C4: only timeouts are retried'))
  assert.ok(solve0.prompt.includes('# Assumptions about the request') && solve0.prompt.includes('- S3: Should 5xx responses be retried? Assumed: only timeouts.'))
  assert.ok(call('check').prompt.includes('- C4: only timeouts are retried'), 'checkers judge against the amended criteria')
  assert.ok(logs.some(l => /spec: S1 accepted, S2 rejected, S3 decision, S4 disputed/.test(l)))

  // Reported: the assumptions first, then what happened to each finding.
  assert.deepEqual(result.spec.assumptions.map(a => a.id), ['S3'])
  assert.deepEqual(result.spec.criteriaBefore.map(c => c.id), ['C1', 'C2', 'C3'])
  const md = result.report.markdown
  assert.ok(md.startsWith('### Assumptions to check'), 'the report opens with the assumptions')
  for (const want of ['- **[S3]** Should 5xx responses be retried? Assumed: only timeouts. The alternative: timeouts and 5xx. Under it: a 5xx would be retried three times.',
                      '### Specification review', '- **Coverage, Codex Astra:** C1 misses the empty case', '- **Findings:**\n  - [S1]', '[S1] coverage, major, C1: C1 says nothing about a null body',
                      '→ accepted by the panel; amended: C1 now covers null', '[S2] coverage, minor: add a criterion for logging every retry → rejected by the panel',
                      '[S3] intent, major, C2: Should 5xx responses be retried, or only timeouts? → a question for the user; assumed: only timeouts; amended: added C4',
                      '[S4] intent, minor, C3: C3 should name the public methods → the panel split, so the criteria were left as they were',
                      '- **Criteria:** amended before work began: C1, C2, C3, C4 (setup wrote C1, C2, C3).']) {
    assert.ok(md.includes(want), `report: ${want}\n${md}`)
  }
  assert.ok(result.forTheOrchestrator.includes('the council assumed 1 answer to questions about the request'))
  assert.ok(/- Spec review: coverage by Codex Astra, intent by Claude Opus; 4 findings \([^)]*\); criteria amended; assumed S3\./.test(call('retro').prompt), 'retro facts carry the spec review')

  // spec: 'ask' stops before any seat on the open decision; the resume replays the review and builds to the answer.
  const asked = await run('spec-ask', handler(), { ...args, spec: 'ask' }, { spec: true })
  assert.equal(asked.result.status, 'needs-user')
  assert.equal(asked.result.round, 'spec')
  assert.deepEqual(asked.result.questions.map(q => [q.id, q.readings]), [['S3', ['only timeouts', 'timeouts and 5xx']]])
  assert.ok(!asked.calls.some(c => ['solve', 'specamend'].includes(c.role.kind)), 'nothing is built or amended before the answer')
  const answered = await run('spec-answered', handler(), { ...args, spec: 'ask', clarifications: [{ id: 'S3', answer: 'Retry 5xx too.' }] }, { spec: true })
  assert.deepEqual(answered.calls.slice(0, asked.calls.length).map(c => c.prompt), asked.calls.map(c => c.prompt), 'the review replays from cache')
  assert.equal(answered.result.status, 'converged')
  assert.ok(answered.calls.find(c => c.role.kind === 'specamend').prompt.includes("The user's answer: Retry 5xx too."))
  assert.deepEqual([answered.result.spec.assumptions, answered.result.spec.answered], [[], ['S3']])
  const s0 = answered.calls.find(c => c.role.kind === 'solve').prompt
  assert.ok(s0.includes('- C4: timeouts and 5xx responses are retried') && s0.includes('- S3 ("Should 5xx responses be retried, or only timeouts?"): Retry 5xx too.'))
  assert.ok(!answered.result.report.markdown.includes('### Assumptions to check'))

  // A failed amendment leaves setup's criteria; spec: false skips the review.
  const failed = await run('spec-failed', handler({ failAmend: true }), args, { spec: true })
  assert.ok(failed.calls.find(c => c.role.kind === 'solve').prompt.includes('- C1: handles empty input\n'))
  assert.ok(failed.result.notes.includes('The spec amendment failed; the criteria stand as setup wrote them.'))
  const off = await run('spec-off', handler(), { ...args, spec: false }, { spec: true })
  assert.ok(!off.calls.some(c => c.role.kind === 'spec' || c.role.tag === 'spec'))
  assert.equal(off.result.spec, null)
  return 'S1 amended, S2 rejected, S3 assumed on the conservative reading, S4 split and left; ask mode stops and resumes to the answer; a failed amendment and spec: false leave setup\'s criteria'
}

// ---------------------------------------------------------------- the factory

const INTAKE = (tier, o = {}) => ({
  status: 'ok', tier, mode: o.mode || (tier === 'architecture' ? 'design' : 'implement'), reasons: o.reasons || `it looks like ${tier} work`, planMissing: '',
  signals: { kind: 'change', files: 1, publicApi: false, crossModule: false, testsCover: 'yes', ambiguous: false, planGiven: false }, split: [],
})
const NOT_BIG = { tooBig: { tier: '', reason: '' } }
const factory = (name, handler, args, hooks = {}) => run(name, handler, args, { ...hooks, workflow: 'factory' })
const factsIn = prompt => JSON.parse(prompt.match(/## Run facts \(data\)\n\n```json\n([\s\S]*?)\n```/)[1])
const LOG_TASK = 'Add a debug log line with the retry count in Fetcher::retry'

async function scenarioFactorySimple() {
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('simple')
      case 'setup': return { ...SETUP('test-fsimple'), criteria: [{ id: 'C1', text: 'logs the retry count at debug level' }] }
      case 'solve': return solve(role.L, NOT_BIG)
      case 'check': return check(prompt, () => 'verified', () => 'no', () => [], { criteria: [{ criterion: 'C1', status: 'met', note: '' }] })
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls } = await factory('factory-simple', handler, { task: LOG_TASK })
  assert.deepEqual([result.status, result.tier, result.factory.chosenBy, result.final.readiness.state], ['done', 'simple', 'intake', 'ready'])
  assert.deepEqual(calls.map(c => c.role.kind), ['intake', 'setup', 'solve', 'check', 'audit', 'record'], 'no spec review, debate, ratification or model retro')
  const call = kind => calls.find(c => c.role.kind === kind)
  assert.deepEqual([call('intake').opts.model, call('setup').opts.model, call('solve').opts.model], ['opus', 'opus', 'sonnet'])
  assert.ok(call('intake').prompt.includes('# The tiers, cheapest first') && !/tierConfirmed|pinned/.test(call('intake').prompt))
  const setup = call('setup').prompt
  assert.ok(setup.includes('one AI model will make the change') && setup.includes('Write 1 to 3 acceptance criteria') && /--seats A(?!,)/.test(setup) && setup.includes('preflight --vendors codex'))
  assert.ok(setup.includes('Mode: implement.'), 'intake chose the mode')
  const sv = call('solve').prompt
  assert.ok(sv.includes('You are the implementer of a change that was judged simple') && sv.includes('`tooBig`') && !sv.includes('# How the council works') && !sv.includes('another seat'))
  const rv = call('audit')
  assert.ok(/\(relay/.test(rv.label) && rv.role.tag === 'review', 'Astra reviews through a relay')
  assert.ok(rv.prompt.includes('You are an independent reviewer') && rv.prompt.includes('# What to review') && rv.prompt.includes('room/r0/A.diff') &&
    rv.prompt.includes('the verifier then checks the fixed version again'))
  assert.ok(/--checkout 'A-r0'/.test(rv.raw), 'the reviewer gets a checkout of the round-0 snapshot')
  assert.ok(result.final.diff.endsWith('/room/r0/A.diff') && result.final.snapshotRef === 'refs/council/test-fsimple/A-r0')
  assert.ok(result.report.markdown.includes('### Simple change, by Claude Sonnet') && result.report.markdown.includes('### Review') && !result.report.markdown.includes('Independent audit'))
  assert.ok(result.forTheOrchestrator.includes('as a simple change') && result.forTheOrchestrator.includes('git apply'))
  const facts = factsIn(call('record').prompt)
  assert.deepEqual([facts.workflow, facts.tier, facts.chosenBy, facts.escalation, facts.readiness, facts.signals.files], ['factory', 'simple', 'intake', null, 'ready', 1])
  assert.ok(call('record').prompt.includes('retro --facts-only --run-dir'))
  assert.equal(result.retro.recorded, true)
  return 'intake → one Sonnet change, the neutral check, one Astra review; facts recorded, no model retro (6 turns)'
}

async function scenarioFactoryFindings() {
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('simple')
      case 'setup': return SETUP('test-ffind')
      case 'solve': return solve(role.L, NOT_BIG)
      case 'check': return check(prompt, () => 'verified', () => role.tag === 'final3' ? 'yes' : 'no',
        () => prompt.includes('TXR1') ? [{ test: 'TXR1', outcome: role.tag === 'final3' ? 'pass' : 'fail', note: '' }] : [])
      case 'audit': return { summary: 'Logs the wrong counter.', probes: [], tests: [{ id: 'TXR1', purpose: 'logs attempt 2 on the second try', command: 'phpunit TXR1Test.php' }],
        findings: [{ severity: 'major', kind: 'fact', statement: 'logs the attempt index from 0, not the count', evidence: 'TXR1 fails' },
                   { severity: 'minor', kind: 'judgment', statement: 'use the existing debug() helper', evidence: 'src/Log.php:10' }] }
      case 'panel': return { rulings: [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'upheld' })) }
      case 'auditfix': return { ...synth(), summary: 'counts from 1', addressed: [{ ref: 'XR1', how: 'count + 1' }, { ref: 'TXR1', how: 'passes' }], declined: [{ ref: 'XR2', why: 'debug() lacks context' }] }
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls } = await factory('factory-findings', handler, { task: LOG_TASK }, { audit: true })
  assert.deepEqual(calls.map(c => c.role.kind), ['intake', 'setup', 'solve', 'check', 'audit', 'check', 'panel', 'panel', 'auditfix', 'check', 'record'])
  const fix = calls.find(c => c.role.kind === 'auditfix')
  assert.ok(fix.prompt.startsWith('# How this works') && fix.prompt.includes('# Fix pass') && fix.prompt.includes('An independent reviewer read your change') && !fix.prompt.includes('After ratification'))
  assert.ok(fix.prompt.includes('[XR1] review auditor, major') && fix.prompt.includes('[TXR1] test from the review auditor') && fix.prompt.includes('Suggestions, not adjudicated'))
  assert.ok(!calls.some(c => c.role.kind === 'reaudit'), 'no re-review: the check of the fix is the verification')
  assert.deepEqual([result.status, result.final.readiness.state, result.final.fixPass], ['done', 'ready', true])
  assert.ok(result.final.diff.endsWith('/room/final3/A.diff'))
  assert.deepEqual(result.review.items.map(i => [i.id, i.status]), [['XR1', 'fixed'], ['XR2', 'judgment'], ['TXR1', 'verified']])
  assert.ok(result.report.markdown.includes('- **Fix pass:** A fixed what was upheld or failing') && !result.report.markdown.includes('Re-review'))
  return 'the review\'s upheld finding and failing test go to one fix pass, checked again; no re-review; still Simple'
}

// A Simple run that fails its checks after the fix pass escalates to the Fix tier, in the same run:
// a fresh setup and a blind two-seat council, told why but not shown the earlier change.
async function scenarioFactoryEscalate() {
  let council = false, setupCount = 0
  const FAIL = { ran: true, passed: false, tail: 'FAIL testRetryLogsCount: expected 2, got 1' }
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('simple')
      case 'setup': council = ++setupCount > 1
        return council ? SETUP('test-fix') : SETUP('test-fesc')
      case 'solve': return council ? solve(role.L) : solve(role.L, NOT_BIG)
      case 'check': return check(prompt, () => 'verified', () => 'no', () => [], council ? {} : { suite: FAIL })
      case 'auditfix': return { ...synth(), summary: 'tried again' }
      case 'debate': return debate(role.L, 'A')
      case 'synth': return synth()
      case 'ratify': return ratify(true)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const r = await factory('factory-escalate', handler, { task: 'Fix the retry count in Fetcher::retry' })
  const { result } = r
  const kinds = r.calls.map(c => c.role.kind)
  assert.deepEqual(kinds.slice(0, 6), ['intake', 'setup', 'solve', 'check', 'audit', 'auditfix'], 'Simple: the review is clean, but the failing suite earns the fix pass')
  assert.equal(kinds.filter(k => k === 'setup').length, 2, 'the Fix tier runs its own setup')
  assert.ok(kinds.includes('spec') && kinds.includes('debate') && kinds.includes('ratify') && kinds[kinds.length - 1] === 'retro', 'then the council, with its spec review, debate, ratification and a model retro')
  assert.deepEqual([result.escalated, result.status, result.factory.escalation.trigger, result.factory.escalation.to], [true, 'converged', 'verify-failed', 'fix'])
  assert.deepEqual(result.seats.map(s => s.model).sort(), ['Claude Opus', 'Codex Astra'])
  const setups = r.calls.filter(c => c.role.kind === 'setup')
  assert.ok(setups[1].prompt.includes('a council run') && setups[1].prompt.includes('# An earlier attempt') &&
    setups[1].prompt.includes('handed up because the verification command still fails after the fix pass') && setups[1].prompt.includes('- C1: handles empty input'))
  assert.ok(/--seats A,B /.test(setups[1].prompt) && setups[1].prompt.includes('Mode: implement.'))
  const fix = r.calls.find(c => c.role.kind === 'auditfix')
  assert.ok(fix.prompt.includes('The verification command fails on your version') && fix.prompt.includes('expected 2, got 1'))
  for (const c of r.calls.filter(c => c.role.kind === 'solve').slice(1)) {
    assert.ok(c.prompt.includes('# An earlier attempt') && c.prompt.includes('You are not shown that attempt\'s change') && c.prompt.includes('expected 2, got 1'), `${c.label}: told why`)
    assert.ok(!c.prompt.includes('test-fesc/room'), `${c.label}: not shown the earlier change`)
  }
  assert.ok(result.report.markdown.startsWith('### Escalated from Simple') && result.report.markdown.includes('/tmp/proj/.council/test-fesc'))
  assert.ok(result.forTheOrchestrator.startsWith('This run started as a simple change and the factory handed it to the fix tier'))
  const retro = r.calls.find(c => c.role.kind === 'retro').prompt
  assert.ok(retro.includes('one run of /factory') && retro.includes('- Factory tier: started simple, escalated to fix (verify-failed') && retro.includes('Simple attempt: /tmp/proj/.council/test-fesc'))
  const facts = factsIn(retro)
  assert.deepEqual([facts.tier, facts.escalation.trigger, facts.turns.byRole.intake], ['fix', 'verify-failed', 1])
  assert.ok(r.logs.some(l => /escalating from simple to fix \(verify-failed\)/.test(l)))
  return 'still failing after the fix pass → the Fix tier (Opus, Astra) in the same run, blind to the earlier change; one report and retro'
}

// The other ways Simple hands up, each stopped at the higher tier's setup (a dirty tree) to keep it short.
async function scenarioFactoryHandUp() {
  const handUp = async ({ solveOut = NOT_BIG, diff, audit }) => {
    let setups = 0
    const handler = async (role, prompt) => {
      switch (role.kind) {
        case 'intake': return INTAKE('simple')
        case 'setup': return ++setups === 1 ? SETUP('test-hand') : { ...SETUP('test-up'), status: 'dirty', dirty: [' M a.php'] }
        case 'solve': return solve(role.L, solveOut)
        case 'check': return check(prompt, () => 'verified', () => 'no', () => [], diff ? { diff } : {})
        case 'audit': return audit
        case 'panel': return { rulings: [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'upheld' })) }
        default: throw new Error(`unexpected role ${role.kind}`)
      }
    }
    return factory('factory-handup', handler, { task: LOG_TASK }, { audit: !!audit })
  }
  const design = await handUp({ audit: { summary: 'Wrong approach.', tests: [], probes: [],
    findings: [{ severity: 'major', kind: 'judgment', statement: 'log through the retry policy, not inline in three callers', evidence: 'src/Retry.php:5' }] } })
  assert.deepEqual([design.result.escalated, design.result.factory.escalation.trigger, design.result.factory.escalation.to, design.result.status], [true, 'design-finding', 'feature', 'blocked'])
  assert.ok(!design.calls.some(c => c.role.kind === 'auditfix'), 'a design finding hands up before any fix')
  const upSetup = design.calls.filter(c => c.role.kind === 'setup')[1].prompt
  assert.ok(/--seats A,B /.test(upSetup) && upSetup.includes('a factory run of a feature'), 'feature: two seats, plans first')
  const big = await handUp({ solveOut: { tooBig: { tier: 'fix', reason: 'the cause is unclear: two code paths retry' } } })
  assert.deepEqual([big.result.factory.escalation.trigger, big.result.factory.escalation.to], ['too-big', 'fix'])
  assert.deepEqual(big.calls.map(c => c.role.kind), ['intake', 'setup', 'solve', 'setup'], 'no check or review once the implementer says it is not simple')
  assert.ok(big.result.factory.escalation.why.includes('two code paths retry'))
  const wide = await handUp({ diff: { files: 3, added: 250, removed: 10 } })
  assert.deepEqual([wide.result.factory.escalation.trigger, wide.result.factory.escalation.to], ['over-budget', 'feature'])
  assert.ok(!wide.calls.some(c => c.role.kind === 'audit'), 'over budget: no review')
  return 'an upheld design finding and an over-budget change go to feature, the implementer\'s "not simple" to its tier'
}

// A pinned tier intake disagrees with stops once; keeping it or switching both replay intake.
async function scenarioFactoryTier() {
  const handler = (tier, setupOut) => async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE(tier)
      case 'setup': return setupOut || SETUP('test-ftier')
      case 'solve': return solve(role.L, NOT_BIG)
      case 'check': return check(prompt)
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const args = { task: 'Add retries to the sync client', tier: 'simple' }
  const first = await factory('factory-tier', handler('feature'), args)
  assert.deepEqual([first.result.status, first.result.asked, first.result.recommended], ['needs-tier', 'simple', 'feature'])
  assert.deepEqual(first.calls.map(c => c.role.kind), ['intake'], 'nothing is created before the user answers')
  assert.ok(first.result.forTheOrchestrator.includes('tierConfirmed: true') && first.result.forTheOrchestrator.includes('tier: "feature"'))
  const kept = await factory('factory-tier-kept', handler('feature'), { ...args, tierConfirmed: true })
  assert.equal(kept.calls[0].prompt, first.calls[0].prompt, 'intake replays from cache')
  assert.deepEqual([kept.result.status, kept.result.factory.chosenBy, kept.result.factory.recommended], ['done', 'overruled', 'feature'])
  assert.ok(kept.calls.some(c => c.role.kind === 'retro') && !kept.calls.some(c => c.role.kind === 'record'), 'an overruled router is worth a model retro')
  assert.equal(factsIn(kept.calls.find(c => c.role.kind === 'retro').prompt).chosenBy, 'overruled')
  const dirty = { ...SETUP('test-ftier2'), status: 'dirty', dirty: [' M a.php'] }
  const switched = await factory('factory-tier-switched', handler('feature', dirty), { ...args, tier: 'feature' })
  assert.equal(switched.calls[0].prompt, first.calls[0].prompt, 'intake replays from cache')
  assert.deepEqual([switched.result.factory.tier, switched.result.factory.chosenBy], ['feature', 'pinned'])
  const str = await factory('factory-tier-string', handler('simple'), '--tier simple Add a log line')
  assert.deepEqual([str.result.status, str.result.factory.chosenBy], ['done', 'pinned'])
  assert.ok(str.calls[0].prompt.includes('# Task\n\nAdd a log line\n'), 'the flag is not part of the task')
  return 'a disputed pin stops before anything is created; kept (overruled, with a retro) or switched, intake replays'
}

// Where intake sends a task: two seats for fix, design mode for architecture, and a missing plan stops.
async function scenarioFactoryRoute() {
  const route = async (intake, args = {}) => factory('factory-route', async role => {
    if (role.kind === 'intake') return intake
    if (role.kind === 'setup') return { ...SETUP('test-route'), status: 'dirty', dirty: [' M a.php'] }
    throw new Error(`unexpected role ${role.kind}`)
  }, { task: 'Find why the sync drops the last page', ...args })
  const fix = await route(INTAKE('fix'))
  const sp = fix.calls[1].prompt
  assert.ok(/--seats A,B /.test(sp) && sp.includes('preflight --vendors codex') && sp.includes('a council run'))
  assert.deepEqual([fix.result.factory.tier, fix.result.factory.chosenBy, fix.result.status], ['fix', 'intake', 'blocked'])
  assert.ok(fix.result.forTheOrchestrator.startsWith('The factory ran this at the fix tier'))
  const mine = await route(INTAKE('fix'), { seats: 'opus,sonnet,sol' })
  assert.ok(/--seats A,B,C /.test(mine.calls[1].prompt), 'the user\'s seats win')
  const arch = await route(INTAKE('architecture'))
  assert.ok(arch.calls[1].prompt.includes('Mode: design.') && /--seats A,B,C /.test(arch.calls[1].prompt) && arch.calls[1].prompt.includes('a factory run of an architecture'))
  const inv = await route(INTAKE('simple', { mode: 'investigate' }))
  assert.equal(inv.result.factory.tier, 'fix', 'Simple is for changes; an investigation goes to fix')
  const plan = await route({ ...INTAKE('feature'), status: 'needs-plan', planMissing: '"the plan": no file named' })
  assert.deepEqual([plan.result.status, plan.calls.length], ['needs-plan', 1])
  assert.ok(plan.result.forTheOrchestrator.includes('Workflow({name: "factory"'))
  return 'fix → Opus and Astra (or the user\'s seats); architecture → design mode, three seats; an investigation is never Simple; a missing plan stops at intake'
}

// A task of separate pieces stops at intake with the pieces listed; noSplit runs it as one, and intake replays.
async function scenarioFactorySplit() {
  const pieces = [
    { title: 'Gamma mode', task: 'Fix Gamma::mode for shape below 1, per item E of /abs/FIX-TRACKER.md.', tier: 'simple', after: [] },
    { title: 'ChiSquared cdf', task: 'Fix the ChiSquared cdf deep in the tail, per item A.', tier: 'fix', after: [1, 1, 2, 0] },
    { title: '', task: 'Fix the medians, per item D.', tier: 'nonsense', after: [2] },
  ]
  const intake = { ...INTAKE('feature', { reasons: 'three root causes, one commit each' }), status: 'needs-split', split: pieces }
  const handler = async role => {
    if (role.kind === 'intake') return intake
    if (role.kind === 'setup') return { ...SETUP('test-fsplit'), status: 'dirty', dirty: [' M a.php'] }
    throw new Error(`unexpected role ${role.kind}`)
  }
  const args = { task: 'Work items E, A and D of the tracker, one commit per root cause', plan: ['/abs/FIX-TRACKER.md'] }
  const first = await factory('factory-split', handler, args)
  assert.deepEqual([first.result.status, first.result.tier, first.calls.map(c => c.role.kind)], ['needs-split', 'feature', ['intake']], 'nothing is created before the user answers')
  assert.deepEqual(first.result.items.map(i => [i.n, i.title, i.tier, i.after]),
    [[1, 'Gamma mode', 'simple', []], [2, 'ChiSquared cdf', 'fix', [1]], [3, 'Piece 3', 'feature', [2]]], 'a piece builds only on earlier pieces')
  const fo = first.result.forTheOrchestrator
  assert.ok(fo.includes('noSplit: true') && fo.includes('with task replaced by the piece\'s task') && fo.includes('commit it before the next piece'), fo)
  assert.ok(first.calls[0].prompt.includes('# One task or several'))

  const whole = await factory('factory-split-whole', handler, { ...args, noSplit: true })
  assert.equal(whole.calls[0].prompt, first.calls[0].prompt, 'intake replays from cache')
  assert.deepEqual([whole.result.factory.tier, whole.calls[1].role.kind], ['feature', 'setup'])
  assert.ok(!whole.calls[1].prompt.includes('noSplit'), 'noSplit is the factory\'s, not the council\'s')

  const one = await factory('factory-split-one', async role => role.kind === 'intake' ? { ...intake, split: pieces.slice(0, 1) } : handler(role), args)
  assert.equal(one.calls[1].role.kind, 'setup', 'one piece is not a split')

  const pinned = await factory('factory-split-pinned', handler, { ...args, tier: 'fix' })
  assert.ok(pinned.result.status === 'needs-split' && pinned.result.forTheOrchestrator.includes('The user pinned fix for the whole task'))
  return 'separate pieces stop at intake, listed in order with earlier-only dependencies; noSplit runs it whole and intake replays; one piece is no split'
}

// ---------------------------------------------------------------- the Feature tier

const planSolve = L => ({
  summary: `plan ${L}`, claims: [{ kind: 'fact', statement: `${L}: Fetcher::retry loops at src/Fetcher.php:40`, evidence: 'src/Fetcher.php:40', criterion: 'C1' }],
  tests: [], questions: [], confidence: 4, notes: `notes-${L}-r0`,
})
const buildTurn = (n, extra = {}) => ({ summary: `built increment ${n}`, deviations: [], claims: [{ kind: 'verification', statement: 'suite passes', evidence: 'make test → OK' }], notes: `notes-inc${n}`, ...extra })
const uniqueRounds = cs => cs.filter((c, i) => cs.findIndex(x => x.role.round === c.role.round) === i)
const FEATURE_TASK = 'Add a retry budget to the sync client, configurable per endpoint'

// Two seats plan blind and agree on one plan; its author writes the final plan, merging an idea
// from the other, and builds it in two checked increments; three auditors find nothing.
async function scenarioFactoryFeature() {
  let W = null
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('feature')
      case 'setup': return SETUP('test-ffeat')
      case 'solve': return planSolve(role.L)
      case 'check': return check(prompt)
      case 'debate': W = W || 'A'
        return debate(role.L, 'A', role.L === 'B' ? { findings: [{ target: 'A', severity: 'minor', kind: 'fact', statement: 'A\'s plan never says where the budget is read', evidence: 'room/r0/A.md' }] } : {})
      case 'synth': return { ...synth(), summary: 'final plan', adopted: [{ from: 'B', idea: 'read the budget from the endpoint config' }],
        addressed: [{ ref: '1B1', how: 'step 1 reads it from EndpointConfig' }],
        increments: [{ title: 'Budget in the config', delivers: 'EndpointConfig::retryBudget, with tests' }, { title: 'Enforce the budget', delivers: 'Fetcher::retry stops at the budget, with tests' }] }
      case 'build': return buildTurn(role.round, role.round === 2 ? { deviations: ['kept the old Fetcher::retry signature, since three callers pass two arguments'] } : {})
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls, logs } = await factory('factory-feature', handler, { task: FEATURE_TASK })
  const kinds = calls.map(c => c.role.kind)
  const count = k => kinds.filter(x => x === k).length
  assert.deepEqual([count('solve'), count('debate'), count('synth'), count('ratify'), count('build'), count('audit'), count('reaudit'), count('retro')], [2, 2, 1, 0, 2, 3, 0, 1], kinds.join(' '))
  assert.deepEqual(kinds.slice(-8), ['build', 'check', 'build', 'check', 'audit', 'audit', 'audit', 'retro'], 'each increment checked, then the audit')
  assert.deepEqual(result.seats.map(s => s.model).sort(), ['Claude Opus', 'Codex Astra'])
  assert.deepEqual([result.status, result.tier, result.factory.tier, result.factory.chosenBy, result.final.readiness.state], ['done', 'feature', 'feature', 'intake', 'ready'])
  const setup = calls.find(c => c.role.kind === 'setup').prompt
  assert.ok(setup.includes('a factory run of a feature') && /--seats A,B /.test(setup) && setup.includes('each seat first writes a plan') && setup.includes('Mode: implement.'))
  for (const c of calls.filter(c => c.role.kind === 'solve')) {
    assert.ok(c.prompt.includes('This council plans before it builds') && c.prompt.includes('Write the plan for building this, not the code') &&
      c.prompt.includes('Leave your worktree as it is') && c.prompt.includes('## Position — the complete plan, ending with its increments') && !c.prompt.includes('Publishing tests'), `${c.label}: a plan, not code`)
  }
  const chk0 = calls.find(c => c.label === 'check r0:A').prompt
  assert.ok(chk0.includes('This is the planning stage, so there is nothing to measure') && chk0.includes('built as written') && !chk0.includes(' measure --run-dir'))
  const sy = calls.find(c => c.role.kind === 'synth').prompt
  assert.ok(sy.includes('Merge: take from the other plans') && sy.includes('`increments`'))
  const [b1, b2] = calls.filter(c => c.role.kind === 'build')
  assert.ok(b1.prompt.includes('# Build increment 1 of 2: Budget in the config') && b1.prompt.includes('1. Budget in the config ← this turn') &&
    b1.prompt.includes('Build only this increment') && b1.prompt.includes('clean starting commit') && b1.prompt.includes('/room/final/'))
  assert.ok(b2.prompt.includes('1. Budget in the config (done)') && b2.prompt.includes('The verifier\'s check of increment 1: suite PASS') && b2.prompt.includes('This is the last turn of the build'))
  assert.ok(!b1.prompt.includes('Publishing tests') && b1.prompt.includes('Make all code changes there'), 'build: the implement workspace, no published tests')
  const ci1 = calls.find(c => c.role.kind === 'check' && c.role.tag === 'inc1').prompt, ci2 = calls.find(c => c.role.kind === 'check' && c.role.tag === 'inc2').prompt
  assert.ok(/--label inc1(?! --since)/.test(ci1) && ci1.includes('build increment 1 of 2') && ci1.includes('a later increment is meant to meet'))
  assert.ok(ci2.includes('--label inc2 --since inc1') && !ci2.includes('a later increment is meant to meet'))
  const audits = calls.filter(c => c.role.kind === 'audit')
  assert.deepEqual(audits.map(c => c.role.tag).sort(), ['correctness', 'design', 'tests'])
  const at = lens => audits.find(c => c.role.tag === lens)
  assert.ok(at('tests').prompt.includes('# Your lens: the tests') && at('tests').opts.model === 'sonnet' && /\/room\/inc2\/[AB]\.diff/.test(at('tests').prompt))
  assert.ok(!at('correctness').prompt.includes('- The tests: whether they pin down'), 'the tests are the tests lens\'s, not correctness\'s')
  W = result.plan.author
  assert.ok(result.final.diff.endsWith(`/room/inc2/${W}.diff`) && result.final.snapshotRef === `refs/council/test-ffeat/${W}-inc2` && result.plan.post.endsWith(`/room/final/${W}.md`))
  assert.deepEqual(result.build.map(x => [x.n, x.title, x.reported, x.suite.passed]), [[1, 'Budget in the config', true, true], [2, 'Enforce the budget', true, true]])
  assert.deepEqual(result.audit.auditors.map(a => [a.lens, a.model]), [['correctness', 'Codex Astra'], ['design', 'Claude Opus'], ['tests', 'Claude Sonnet']])
  const md = result.report.markdown
  for (const h of ['### Plan chosen:', '### The plans', '### How the planning debate went', '### The debates', '### The build', '### How it turned out', '### Specification review', '### Independent audit']) assert.ok(md.includes(h), `report: ${h}`)
  assert.ok(md.includes('- **Merged from the other plans:**') && md.includes('read the budget from the endpoint config') && md.includes('- **Increment 2, Enforce the budget:** built increment 2. Check: suite PASS') &&
    md.includes('Departed from the plan: kept the old Fetcher::retry signature') && md.includes('correctness (Codex Astra), design (Claude Opus) and tests (Claude Sonnet)'), md)
  assert.ok(!md.includes('Ratification') && !md.includes('published tests none'))
  assert.ok(result.forTheOrchestrator.startsWith('The factory ran this at the feature tier (intake\'s choice)') && result.forTheOrchestrator.includes('built it in 2 increments') && result.forTheOrchestrator.includes('git apply'))
  const retro = calls.find(c => c.role.kind === 'retro').prompt
  assert.ok(retro.includes(`- Plan: consensus on ${W} in round 1`) && retro.includes(`- Build: 2 increments by ${W}: inc1 suite PASS; inc2 suite PASS, 1 deviation.`), retro)
  assert.equal(factsIn(retro).tier, 'feature')
  assert.ok(logs.some(l => /feature: [AB] builds the plan in 2 increments/.test(l)))
  return 'two blind plans, consensus, a merged final plan with two increments, each built and checked, a clean three-lens audit; no ratification'
}

// A plan of four increments: a build turn that returns nothing and an increment that fails its
// check are carried to the next turn; the plans never agree, so the scorecard picks; the tests
// auditor's upheld finding earns the fix pass.
async function scenarioFactoryFeatureHard() {
  const FAIL = { ran: true, passed: false, tail: 'FAIL testBudgetResets: expected 3, got 0' }
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('feature')
      case 'setup': return SETUP('test-ffhard')
      case 'solve': return planSolve(role.L)
      case 'check': return check(prompt, () => 'verified', () => role.tag === 'final3' ? 'yes' : 'no', () => [], role.tag === 'inc3' ? { suite: FAIL } : {})
      case 'debate': return debate(role.L, role.L)
      case 'synth': return { ...synth(), increments: [1, 2, 3, 4].map(n => ({ title: `Step ${n}`, delivers: `does step ${n}` })) }
      case 'build': return role.round === 1 ? null : buildTurn(role.round)
      case 'audit': return role.tag === 'tests'
        ? { summary: 'One gap.', tests: [], probes: [], findings: [{ severity: 'major', kind: 'fact', statement: 'no test pins the reset; deleting it passes the suite', evidence: 'removed src/Budget.php:22; make test → OK' }] }
        : { summary: 'Fine.', findings: [], tests: [], probes: [] }
      case 'reaudit': return { summary: 'The fix holds.', findings: [], tests: [], probes: [] }
      case 'panel': return { rulings: [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'upheld' })) }
      case 'auditfix': return { ...synth(), summary: 'added the reset test', addressed: [{ ref: 'XT1', how: 'testBudgetResets' }] }
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls } = await factory('factory-feature-hard', handler, { task: FEATURE_TASK }, { audit: true })
  const builds = uniqueRounds(calls.filter(c => c.role.kind === 'build'))     // a turn that returns nothing is retried by a second relay
  assert.equal(builds.length, 4, 'a build turn per increment')
  assert.ok(builds[3].prompt.includes('# Build increment 4 of 4: Step 4') && builds[3].prompt.includes('This turn: does step 4'))
  assert.ok(builds[1].prompt.includes('Your turn for increment 1 ended without a report'))
  assert.ok(builds[3].prompt.includes('The verification command fails on it. Fix that first') && builds[3].prompt.includes('expected 3, got 0'))
  assert.deepEqual(result.build.map(x => [x.n, x.reported, x.suite && x.suite.passed]), [[1, false, true], [2, true, true], [3, true, false], [4, true, true]])
  assert.ok(result.plan.how.startsWith('No consensus after 2 rounds') && result.report.markdown.includes('the evidence scorecard decided'))
  const fix = calls.find(c => c.role.kind === 'auditfix')
  assert.ok(fix.prompt.startsWith('# How the build works') || fix.prompt.startsWith('The council continues'), fix.prompt.slice(0, 80))
  assert.ok(fix.prompt.includes('After the build, auditors who never saw the planning reviewed your change, each through one lens: correctness, design and tests') && fix.prompt.includes('[XT1] tests auditor, major'))
  assert.equal(calls.filter(c => c.role.kind === 'reaudit').length, 3, 'every auditor re-reviews the fix')
  assert.deepEqual(result.audit.items.map(i => [i.id, i.status]), [['XT1', 'fixed']])
  assert.deepEqual([result.final.readiness.state, result.final.auditFixPass], ['ready', true])
  assert.ok(result.final.diff.endsWith('/room/final3/' + result.plan.author + '.diff'))
  const md = result.report.markdown
  assert.ok(md.includes('- **The final plan:** ') && md.includes(', built in 4 increments.') && md.includes('- **Increment 1, Step 1:** the turn returned nothing.') && md.includes('suite FAIL'), md)
  assert.ok(result.notes.some(n => n.includes('build turn for increment 1 returned nothing')))
  return 'four increments; a silent turn and a failing increment carried forward; scorecard pick; the tests lens\'s finding fixed and re-reviewed'
}

// ---------------------------------------------------------------- the Architecture tier

const designSolve = L => ({
  summary: `design ${L}`, claims: [{ kind: 'fact', statement: `${L}: SyncClient::pull pages through src/SyncClient.php:88`, evidence: 'src/SyncClient.php:88', criterion: 'C1' }],
  tests: [], questions: [], confidence: 4, notes: `notes-${L}-r0`,
})
const MILESTONES = [
  { title: 'Cursor store', task: 'Add a CursorStore that persists the sync cursor per endpoint, behind the existing Storage interface.', criteria: ['CursorStore round-trips a cursor', 'make test passes'], after: [], tier: 'simple', working: 'cursors are saved but not yet used' },
  { title: 'Resumable pull', task: 'Make SyncClient::pull resume from the stored cursor.', criteria: ['a pull interrupted after page 2 resumes at page 3'], after: [1, 3], tier: 'feature', working: 'an interrupted sync resumes' },
  { title: 'Backfill', task: 'Backfill cursors for endpoints synced before the store existed.', criteria: [], after: [2], tier: 'nonsense', working: '' },
]
const ARCH_TASK = 'Make the sync resumable across restarts, per endpoint, without re-downloading pages'

// Three seats design blind and agree; the author of the chosen design writes the milestone plan;
// the grounding reviewer's major finding against milestone 2 is upheld and revised, the risk
// reviewer's judgment stays a suggestion, and the re-review finds nothing. Nothing is built.
async function scenarioFactoryArchitecture() {
  const handler = async (role, prompt) => {
    switch (role.kind) {
      case 'intake': return INTAKE('architecture', { mode: 'implement', reasons: 'one connected change, too big for one feature' })
      case 'setup': return SETUP('test-farch')
      case 'solve': return designSolve(role.L)
      case 'check': return check(prompt, () => 'verified', id => role.tag === 'final3' && id === 'XG1' ? 'yes' : 'no')
      case 'debate': return debate(role.L, 'A', role.L === 'B' ? { findings: [{ target: 'A', severity: 'minor', kind: 'fact', statement: 'A never says where the cursor lives', evidence: 'room/r0/A.md' }] } : {})
      case 'synth': return { ...synth(), summary: 'final design', adopted: [{ from: 'C', idea: 'keep the cursor behind the Storage interface' }], milestones: MILESTONES }
      case 'audit': return role.tag === 'grounding'
        ? { summary: 'Milestone 2 relies on a hook that is not there.', findings: [{ severity: 'major', kind: 'fact', statement: 'SyncClient::pull has no page callback to resume from; milestone 2 must add one', evidence: 'src/SyncClient.php:88-120', milestone: 2 }] }
        : role.tag === 'risk'
        ? { summary: 'Sound; one alternative worth weighing.', findings: [{ severity: 'minor', kind: 'judgment', statement: 'B\'s event log would make the backfill unnecessary', evidence: 'room/r1/B.md', milestone: 3 }] }
        : { summary: 'The order works.', findings: [] }
      case 'reaudit': return { summary: 'The revision holds.', findings: [] }
      case 'panel': return { rulings: [...prompt.matchAll(/^## \[([A-Za-z0-9]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'upheld' })) }
      case 'auditfix': return { ...synth(), summary: 'milestone 2 adds the page callback', addressed: [{ ref: 'XG1', how: 'milestone 2 now adds SyncClient::onPage' }],
        milestones: MILESTONES.map((m, i) => i === 1 ? { ...m, task: 'Add a page callback to SyncClient::pull and resume from the stored cursor.' } : m) }
      default: throw new Error(`unexpected role ${role.kind}`)
    }
  }
  const { result, calls, logs } = await factory('factory-architecture', handler, { task: ARCH_TASK }, { audit: true })
  const kinds = calls.map(c => c.role.kind)
  const count = k => kinds.filter(x => x === k).length
  assert.deepEqual([count('solve'), count('debate'), count('synth'), count('ratify'), count('build'), count('audit'), count('auditfix'), count('reaudit'), count('retro')], [3, 3, 1, 0, 0, 3, 1, 3, 1], kinds.join(' '))
  assert.deepEqual(result.seats.map(s => s.model).sort(), ['Claude Opus', 'Claude Sonnet', 'Codex Astra'])
  assert.deepEqual([result.status, result.tier, result.mode, result.factory.tier, result.final.readiness.state, result.final.revised], ['done', 'architecture', 'design', 'architecture', 'ready', true])
  const setup = calls.find(c => c.role.kind === 'setup').prompt
  assert.ok(setup.includes('a factory run of an architecture') && /--seats A,B,C /.test(setup) && setup.includes('preflight --vendors codex,gemini') && setup.includes('Mode: design.') &&
    setup.includes('write criteria the design must meet') && setup.includes('a design ending in milestones'))
  for (const c of calls.filter(c => c.role.kind === 'solve')) {
    assert.ok(c.prompt.includes('This council designs work too big to build in one go') && c.prompt.includes('The milestones, in order, at most 8') &&
      c.prompt.includes('## Position — the complete design, ending with its milestones') && c.prompt.includes('nothing in your worktree ships'), `${c.label}: a design ending in milestones`)
  }
  const deb = calls.find(c => c.role.kind === 'debate' && !/\(relay/.test(c.label)).prompt
  assert.ok(deb.includes('a milestone that would leave the system broken') && deb.includes('Its author then writes the final design and its milestone plan.'))
  const sy = calls.find(c => c.role.kind === 'synth').prompt
  assert.ok(sy.includes('# Final turn — you write the final design and its milestone plan') && sy.includes('Merge: take from the other designs') && sy.includes('`milestones`') && sy.includes('`working`'))
  const audits = calls.filter(c => c.role.kind === 'audit')
  const at = lens => audits.find(c => c.role.tag === lens)
  assert.deepEqual(audits.map(c => c.role.tag).sort(), ['grounding', 'risk', 'sequencing'])
  assert.ok(at('grounding').prompt.includes('# Your lens: grounding') && at('sequencing').prompt.includes('# Your lens: sequencing') && at('sequencing').opts.model === 'opus')
  for (const lens of ['grounding', 'risk']) {
    const relay = at(lens).raw
    assert.ok(relay.includes('--sandbox read-only') && relay.includes("--cwd '/tmp/proj'") && !relay.includes('--checkout') && !at(lens).prompt.includes('materialize'), `${lens}: read-only, no checkout`)
  }
  assert.ok(at('risk').raw.includes('--vendor gemini') && at('risk').prompt.includes('The designs the council did not choose') && at('risk').prompt.includes('Git commands fail in your sandbox'))
  assert.ok(!at('grounding').prompt.includes('The designs the council did not choose'), 'only the risk lens reads the other designs')
  const W = result.design.author
  assert.ok(at('grounding').prompt.includes(`/room/final/${W}.md`))
  const chkH = calls.find(c => c.role.kind === 'check' && c.role.tag === 'audit').prompt
  assert.ok(chkH.includes('the final milestone plan, with the independent review\'s findings') && chkH.includes(`${W}'s final milestone plan (/tmp/proj/.council/test-farch/room/final/${W}.md)`), chkH)
  const panel = calls.find(c => c.role.kind === 'panel' && c.role.tag === 'audit').prompt
  assert.ok(panel.includes('[XG1] review finding by the grounding reviewer against') && panel.includes('Raised by an independent reviewer of the milestone plan'))
  const fix = calls.find(c => c.role.kind === 'auditfix').prompt
  assert.ok(fix.includes('# Revision pass') && fix.includes('[XG1] grounding reviewer, major, milestone 2') && fix.includes('Suggestions, not adjudicated') && fix.includes('`milestones`'), fix)
  const re = calls.filter(c => c.role.kind === 'reaudit')
  assert.ok(re.every(c => c.prompt.includes('# Re-review: the revision') && c.prompt.includes(`/room/final3/${W}.md`)))
  assert.ok(re.some(c => c.prompt.startsWith('The review continues. You are still the risk reviewer')))
  // The milestones: made safe, revised, and ready to run.
  assert.deepEqual(result.milestones.map(m => [m.n, m.title, m.tier, m.after]), [[1, 'Cursor store', 'simple', []], [2, 'Resumable pull', 'feature', [1]], [3, 'Backfill', 'feature', [2]]])
  assert.ok(result.milestones[1].task.startsWith('Add a page callback'), 'the revision\'s milestones replace the first ones')
  const a2 = result.milestones[1].args
  assert.deepEqual([a2.tier, a2.tierConfirmed, a2.noSplit, a2.plan], ['feature', true, true, [`/tmp/proj/.council/test-farch/room/final3/${W}.md`]])
  assert.ok(a2.task.includes('This is milestone 2 of 3 of a larger piece of work: Make the sync resumable') && a2.task.includes('it builds on milestone 1, already done') &&
    a2.task.includes('- a pull interrupted after page 2 resumes at page 3') && !a2.task.includes('Findings from the review'), a2.task)
  assert.deepEqual(result.audit.items.map(i => [i.id, i.lens, i.status]), [['XG1', 'grounding', 'fixed'], ['XK1', 'risk', 'judgment']])
  const md = result.report.markdown
  for (const h of ['### Design chosen:', '### The designs', '### How the design debate went', '### The debates', '### The milestone plan', '### How it turned out', '### Specification review', '### Independent review']) assert.ok(md.includes(h), `report: ${h}`)
  assert.ok(md.includes('- **3 milestones**, each to be built by a factory run of its own:') && md.includes('2. **Resumable pull** (feature, after 1)') &&
    md.includes('- **Nothing was built:**') && md.includes('keep the cursor behind the Storage interface') && md.includes('[XG1] major, milestone 2') &&
    md.includes('fixed in the revision') && md.includes('- **Revision:**') && md.includes('- **Re-review of the revision** (grounding, sequencing, risk): nothing new.') && !md.includes('Ratification'), md)
  const fo = result.forTheOrchestrator
  assert.ok(fo.startsWith('The factory ran this at the architecture tier (intake\'s choice)') && fo.includes('nothing in the repository changed') && fo.includes('milestones[i].args') &&
    fo.includes('Don\'t start one unasked') && fo.includes('(without --all)') && !fo.includes('git apply'), fo)
  const retro = calls.find(c => c.role.kind === 'retro').prompt
  assert.ok(retro.includes(`- Design: consensus on ${W} in round 1`) && retro.includes(`- Milestones: 3 (simple 1, feature 2) by ${W}, revised once after the review.`), retro)
  assert.deepEqual([factsIn(retro).tier, factsIn(retro).milestones], ['architecture', 3])
  assert.ok(logs.some(l => /architecture: [ABC]'s design, in 3 milestones: 1 simple, 2 feature, 3 feature/.test(l)))
  return 'three blind designs, consensus, a milestone plan; grounding upheld against milestone 2, revised and re-reviewed; milestones made safe, with args for their own runs'
}

// A Feature run whose chosen plan needs six increments goes to the Architecture tier before
// anything is built, with a fresh run and blind seats that are told why.
async function scenarioFactoryFeatureToArchitecture() {
  const handler = async (role, prompt) => {
    const arch = ['This council designs work too big', 'a factory run of an architecture', 'its milestone plan'].some(x => prompt.includes(x))
    switch (role.kind) {
      case 'intake': return INTAKE('feature')
      case 'setup': return SETUP(arch ? 'test-ffa-arch' : 'test-ffa-feat')
      case 'solve': return arch ? designSolve(role.L) : planSolve(role.L)
      case 'check': return check(prompt)
      case 'debate': return debate(role.L, 'A')
      case 'synth': return arch ? { ...synth(), milestones: MILESTONES.slice(0, 2) } : { ...synth(), increments: [1, 2, 3, 4, 5, 6].map(n => ({ title: `Step ${n}`, delivers: `does step ${n}` })) }
      default: throw new Error(`unexpected role ${role.kind} (${arch ? 'architecture' : 'feature'})`)
    }
  }
  const { result, calls, logs } = await factory('factory-feature-arch', handler, { task: FEATURE_TASK })
  const kinds = calls.map(c => c.role.kind)
  assert.deepEqual([kinds.filter(k => k === 'setup').length, kinds.filter(k => k === 'build').length, kinds.filter(k => k === 'synth').length], [2, 0, 2], kinds.join(' '))
  assert.deepEqual([result.status, result.tier, result.escalated, result.factory.startedAt, result.factory.escalation.from, result.factory.escalation.trigger, result.milestones.length],
    ['done', 'architecture', true, 'feature', 'feature', 'too-many-increments', 2])
  assert.ok(logs.some(l => l.startsWith('factory: escalating from feature to architecture (too-many-increments): the chosen plan lists 6 increments')))
  const setups = calls.filter(c => c.role.kind === 'setup')
  assert.ok(setups[1].prompt.includes('This task was first planned as one feature and handed up because the chosen plan lists 6 increments') && setups[1].prompt.includes('which this run designs and breaks into milestones'))
  const archSolve = calls.filter(c => c.role.kind === 'solve' && c.prompt.includes('This council designs work too big'))
  assert.equal(archSolve.length, 3)
  assert.ok(archSolve.filter(c => !/\(relay/.test(c.label)).every(c => c.prompt.includes('This task was first planned as one feature, and was handed up because') && c.prompt.includes('You are not shown that plan, on purpose')))
  assert.ok(result.report.markdown.startsWith('### Escalated from Feature\n\nThe factory first planned this as one feature and handed it to the architecture tier, before building anything'))
  assert.ok(result.forTheOrchestrator.startsWith('This run started as a feature and the factory handed it to the architecture tier because the chosen plan lists 6 increments') &&
    result.forTheOrchestrator.includes('The Feature attempt is in /tmp/proj/.council/test-ffa-feat') && result.forTheOrchestrator.includes('nothing in the repository changed') &&
    !result.forTheOrchestrator.includes('The factory ran this at'), result.forTheOrchestrator)
  const retro = calls.find(c => c.role.kind === 'retro').prompt
  assert.deepEqual(factsIn(retro).escalation, { from: 'feature', to: 'architecture', trigger: 'too-many-increments' })
  assert.ok(retro.includes('- Factory tier: started feature, escalated to architecture (too-many-increments: the chosen plan lists 6 increments') && retro.includes('- The Feature attempt: /tmp/proj/.council/test-ffa-feat.'))
  return 'a six-increment plan hands up to architecture before any build: a fresh, blind design run told why; the result says how it got there'
}

async function scenarioFactsSave() {
  assert.ok(RECORD_PROMPTS.length, 'no record prompts captured')
  const prompt = RECORD_PROMPTS[0]
  const [, expect, payload] = prompt.match(PAYLOAD_RE)
  const tmp = mkdtempSync(join(tmpdir(), 'council-facts-'))
  const config = join(tmp, 'claude'), runDir = join(tmp, 'proj', '.council', '20261020-120000'), out = join(tmp, 'retros')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: '20261020-120000', runDir, repoRoot: join(tmp, 'proj') }))
  const cli = join(here, '..', 'plugins', 'dark-factory', 'bin', 'dark-factory')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }
  const exec = argv => { try { return execFileSync(cli, argv, { env }).toString() } catch (e) { return e.stdout.toString() } }
  const last = text => JSON.parse(text.trim().split('\n').pop())
  // No transcript yet: nothing to save.
  assert.equal(last(exec(['retro', '--facts-only', '--run-dir', runDir, '--out-dir', out, '--expect', expect, '--transcript-wait', '0'])).status, 'error')
  const dir = join(config, 'projects', 'p', 's', 'subagents', 'workflows', 'wf_1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-record.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: `[Workflow harness — computed task] x\n${prompt.split('\n').map(l => `  ${l}`).join('\n')}` } }) + '\n')
  const r = last(exec(['retro', '--facts-only', '--run-dir', runDir, '--out-dir', out, '--expect', expect, '--transcript-wait', '0']))
  assert.deepEqual([r.status, r.path, r.facts], ['ok', join(out, '20261020-120000-proj.facts.json'), true])
  assert.deepEqual(JSON.parse(readFileSync(r.path, 'utf8')), factsIn(payload))
  assert.ok(!existsSync(join(out, '20261020-120000-proj.md')), 'facts only: no retro file')
  // A second run that escalated, so the tally has something to count.
  writeFileSync(join(out, 'x-proj.facts.json'), JSON.stringify({ tier: 'fix', chosenBy: 'overruled', recommended: 'fix', readiness: 'ready', turns: { claude: 30 },
    escalation: { from: 'simple', to: 'fix', trigger: 'verify-failed' }, overTierHints: [] }))
  const sum = exec(['retro', '--summary', '--out-dir', out])
  assert.ok(sum.includes('2 factory run(s)') && sum.includes('simple: 2 run(s)') && sum.includes('escalated: 1 (verify-failed -> fix 1)') &&
    sum.includes('overruled intake: 1 (intake said fix 1; 1 of them escalated)'), sum)
  assert.ok(exec(['retro', '--summary', '--out-dir', join(tmp, 'none')]).includes('No factory facts'))
  return 'council retro --facts-only saves the run facts from the record agent\'s transcript; --summary tallies them by starting tier'
}

const ONLY = process.env.SIM_ONLY ? process.env.SIM_ONLY.split(',') : null    // SIM_ONLY=scenarioAgy,scenarioBallot
for (const [name, fn] of Object.entries({ scenarioConsensus, scenarioDeadlock, scenarioEscalation, scenarioFailures, scenarioDirty, scenarioFocus, scenarioSandbox, scenarioPlan, scenarioPlanMissing, scenarioRefs, scenarioTranscript, scenarioRetroOff, scenarioRetroSave, scenarioLineup, scenarioAgy, scenarioLateEscalation, scenarioModeAndGuidance, scenarioInitDocs, scenarioRelayErrors, scenarioPreflight, scenarioReadiness, scenarioApproval, scenarioBallot, scenarioSeatRunErrors, scenarioMeasure, scenarioPreflightCli, scenarioBlind, scenarioAudit, scenarioSpec,
  scenarioFactorySimple, scenarioFactoryFindings, scenarioFactoryEscalate, scenarioFactoryHandUp, scenarioFactoryTier, scenarioFactoryRoute, scenarioFactorySplit,
  scenarioFactoryFeature, scenarioFactoryFeatureHard, scenarioFactoryArchitecture, scenarioFactoryFeatureToArchitecture, scenarioFactsSave })) {
  if (ONLY && !ONLY.includes(name)) continue
  try {
    console.log(`ok   ${name}: ${await fn()}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}: ${e.message}`)
    if (process.env.VERBOSE) console.log(e.stack)
  }
}
process.exit(failed ? 1 : 0)
