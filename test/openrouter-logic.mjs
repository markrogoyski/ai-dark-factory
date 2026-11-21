// OpenRouter seats in the pure lib: parsing, the preflight list, the vendor-diversity rule and the
// report. No runtime, models or CLIs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadLib, makeRun } from './lib.mjs'

const L = loadLib()
const OR = 'openrouter:deepseek/deepseek-v4-pro'
const KNOWN = "Known: opus, sonnet, fable, haiku, astra, sol, luna, terra, gemini, argon, neon, codex:<model-id>, gemini:<model-id> or openrouter:<model-id>."
const attempt = f => { try { return { value: f() } } catch (e) { return { error: e.message } } }

test('openrouter seat parsing', () => {
  const s = L.parseSeat(OR)
  assert.deepEqual(s, { key: OR, vendor: 'openrouter', model: 'deepseek/deepseek-v4-pro', name: 'OpenRouter deepseek/deepseek-v4-pro', effort: 'high' })
  assert.deepEqual(L.parseSeat(s.key), s, 'the key re-parses to the same seat')
  const mixed = L.parseSeat('OpenRouter:DeepSeek/X')
  assert.deepEqual([mixed.key, mixed.model, mixed.vendor], ['openrouter:DeepSeek/X', 'DeepSeek/X', 'openrouter'])
  assert.deepEqual(L.parseSeat(mixed.key), mixed)
  for (const id of ['~a/b', 'x-ai/grok-4:free', 'a.b_c@v+1', 'A'.repeat(128)]) {
    const seat = L.parseSeat(`openrouter:${id}`)
    assert.equal(seat.model, id)
    assert.deepEqual(L.parseSeat(seat.key), seat)
  }
  for (const bad of ['openrouter:', 'openrouter:a b', `openrouter:${'a'.repeat(129)}`, 'openrouter:---', 'openrouter: ', 'gpt']) {
    assert.throws(() => L.parseSeat(bad), e => e.message === `council: unknown seat '${bad}'. ${KNOWN}`, bad)
  }
  // Claude efforts, exactly as an Opus seat takes them.
  for (const e of [undefined, 'low', 'medium', 'high', 'xhigh', 'max', 'LOW', 'ultra', 'keyed', { other: 'low' }]) {
    const of = key => e === 'keyed' ? { [key]: 'medium' } : e
    const a = attempt(() => L.parseSeat(OR, of(OR)).effort), b = attempt(() => L.parseSeat('opus', of('opus')).effort)
    assert.equal(!!a.error, !!b.error, String(e))
    assert.equal(a.value, b.value, String(e))
  }
  assert.throws(() => L.parseSeat(OR, 'ultra'), e => e.message === "council: effort 'ultra' is not valid for OpenRouter deepseek/deepseek-v4-pro. Valid: low, medium, high, xhigh, max.")

  // Everywhere a seat name is taken.
  const c = L.parseConfig({ task: 'Fix it', seats: ['opus', OR], panel: [OR, 'astra'], audit: { correctness: OR }, spec: { coverage: OR } })
  assert.equal(c.lineup[1].vendor, 'openrouter'); assert.equal(c.panel[0].vendor, 'openrouter')
  assert.equal(c.auditors.find(a => a.lens === 'correctness').vendor, 'openrouter')
  assert.equal(c.specReviewers.find(r => r.lens === 'coverage').vendor, 'openrouter')
  const simple = L.parseConfig({ task: 'Fix it', simple: { implementer: OR, reviewer: OR } }, { workflow: 'factory', tier: 'simple' })
  assert.deepEqual([simple.lineup[0].vendor, simple.auditors[0].vendor], ['openrouter', 'openrouter'])
  for (const host of ['claude', 'codex']) {
    const p = L.parsePairConfig({ task: 'Fix it', host, author: OR, reviewer: OR })
    assert.deepEqual([p.pairOptions.author.key, p.pairOptions.reviewer.key, p.lineup[0].vendor], [OR, OR, 'openrouter'], host)
  }
  const ens = L.parseEnsembleConfig({ task: 'Fix it', seats: [OR, 'sonnet'], models: { compare: OR, review: OR } })
  assert.equal(ens.ensemble.compare.vendor, 'openrouter'); assert.equal(ens.lineup[0].vendor, 'openrouter')
  const roles = L.parseRoles({ host: 'codex', roles: Object.fromEntries(['intake', 'setup', 'checker', 'questions', 'spec', 'retro', 'record'].map(r => [r, OR])) })
  assert.deepEqual(Object.values(roles).map(r => r.vendor), Array(7).fill('openrouter'))

  // No default changed.
  assert.deepEqual(L.DEFAULT_SEATS, ['opus', 'sonnet', 'astra', 'gemini'])
  assert.deepEqual(L.CODEX_SEATS, ['opus', 'astra', 'sol'])
  assert.deepEqual(L.CODEX_ROLES, { intake: 'astra', setup: 'astra', checker: 'astra', questions: 'luna', spec: 'astra', retro: 'astra', record: 'luna' })
  assert.deepEqual(L.SPEC_LENSES, { coverage: 'astra', intent: 'opus' })
  const d = L.parseConfig({ task: 'Fix it' })
  assert.deepEqual([d.lineup.map(s => s.key), d.panel.map(s => s.key), d.auditors.map(s => s.key), d.specReviewers.map(s => s.key)],
    [['opus', 'sonnet', 'astra', 'gemini'], ['opus', 'astra'], ['astra', 'opus'], ['astra', 'opus']])
})

test('orSlug and preflightEntry', () => {
  assert.equal(L.orSlug('DeepSeek/DeepSeek-V4-Pro'), 'deepseek-deepseek-v4-pro')
  assert.equal(L.orSlug('~a/b'), 'a-b')
  assert.equal(L.orSlug('---'), 'model')
  assert.equal(L.orSlug('A'.repeat(128)), 'a'.repeat(32))
  assert.equal(L.preflightEntry(L.parseSeat(OR)), OR)
  assert.equal(L.preflightEntry(L.parseSeat('astra')), 'codex')
})

test('required CLIs', () => {
  const plan = args => L.executionPlan(L.newState(L.parseConfig({ task: 'Fix it', ...args }))).requiredCLIs
  assert.deepEqual(plan({ seats: ['opus', 'astra', 'openrouter:a/b'], panel: ['opus', 'astra'], audit: { correctness: 'astra' }, spec: { coverage: 'astra' } }), ['codex', 'openrouter:a/b'])
  assert.deepEqual(plan({ seats: ['opus', 'openrouter:a/b', 'openrouter:a/b'], panel: ['opus', 'sonnet'], audit: false, spec: false }), ['openrouter:a/b'])
  assert.deepEqual(plan({ seats: ['opus', 'openrouter:a/b', 'openrouter:c/d'], panel: ['opus', 'sonnet'], audit: false, spec: false }), ['openrouter:a/b', 'openrouter:c/d'])
  assert.deepEqual(plan({ seats: ['opus', 'sonnet'], panel: ['openrouter:p/q', 'opus'], audit: { correctness: 'openrouter:r/s', design: 'opus' }, spec: { coverage: 'openrouter:t/u', intent: 'opus' } }),
    ['openrouter:p/q', 'openrouter:t/u', 'openrouter:r/s'])
  const ens = L.newState(L.parseEnsembleConfig({ task: 'Fix it', seats: ['sonnet', 'sonnet'], models: { compare: 'openrouter:c/d' } }))
  assert.deepEqual(L.preflightTargets(ens), ['openrouter:c/d'])
  const roles = L.newState(L.parseConfig({ task: 'Fix it', host: 'codex', roles: { checker: 'openrouter:r/s' } }))
  assert.ok(L.preflightTargets(roles).includes('openrouter:r/s'))
  // Without OpenRouter, exactly the old list.
  const old = S => L.externalVendors(S).map(v => v === 'gemini' ? 'agy' : v)
  for (const seats of [['opus', 'sonnet'], ['opus', 'astra'], ['opus', 'gemini', 'sol'], ['astra', 'argon', 'codex:x', 'gemini:y']]) {
    for (const host of ['claude', 'codex']) {
      const S = L.newState(L.parseConfig({ task: 'Fix it', seats, host }))
      assert.deepEqual(L.executionPlan(S).requiredCLIs, old(S))
      assert.deepEqual(L.preflightTargets(S), L.externalVendors(S))
    }
  }
})

// The pre-change rule: every vendor counts, OpenRouter included.
function oldRule(S, k) {
  const vendors = seats => new Set(seats.map(s => s.vendor)).size
  const act = S.seats.filter(s => s.active), cross = vendors(act) > 1, K = L.consensusAt(S)
  const counts = {}
  for (const [V, v] of Object.entries(S.votes[k] || {})) if (act.some(s => s.L === V)) (counts[v.ship] ||= []).push(V)
  const win = Object.entries(counts).find(([, voters]) => voters.length >= K && (!cross || vendors(voters.map(V => S.seats.find(s => s.L === V))) >= 2))
  return { cross, text: vendors(act) > 2 ? 'at least two vendors' : 'both vendors', W: win ? win[0] : null }
}
// The rule as decided: the same, with OpenRouter seats supplying no vendor of their own.
function newRule(S, k) {
  const strip = s => s.vendor === 'openrouter' ? { ...s, vendor: null } : s
  const real = seats => new Set(seats.map(strip).map(s => s.vendor).filter(Boolean)).size
  const act = S.seats.filter(s => s.active), cross = real(act) > 1, K = L.consensusAt(S)
  const counts = {}
  for (const [V, v] of Object.entries(S.votes[k] || {})) if (act.some(s => s.L === V)) (counts[v.ship] ||= []).push(V)
  const win = Object.entries(counts).find(([, voters]) => voters.length >= K && (!cross || real(voters.map(V => S.seats.find(s => s.L === V))) >= 2))
  return { cross, text: real(act) > 2 ? 'at least two vendors' : 'both vendors', W: win ? win[0] : null }
}

test('vendor diversity', () => {
  const vote = (S, votes) => { S.votes[1] = Object.fromEntries(Object.entries(votes).map(([V, ship]) => [V, { ship, amendments: [], reason: '' }])) }
  let { S } = makeRun({ lineup: 'A:claude B:codex C:openrouter' })
  assert.equal(L.crossVendor(S), true); assert.equal(L.crossVendorText(S), 'both vendors')
  vote(S, { A: 'A', C: 'A', B: 'B' }); assert.equal(L.consensus(S, 1), null, 'Claude and OpenRouter votes are one vendor')
  vote(S, { A: 'A', B: 'A', C: 'C' }); assert.equal(L.consensus(S, 1).W, 'A')
  ;({ S } = makeRun({ lineup: 'A:claude B:claude C:openrouter' }))
  assert.equal(L.crossVendor(S), false)
  vote(S, { B: 'B', C: 'B', A: 'A' }); assert.equal(L.consensus(S, 1).W, 'B', 'an OpenRouter vote counts toward K')

  const base = ['claude', 'codex', 'gemini']
  const lineups = []
  for (const n of [2, 3, 4]) {
    const walk = (prefix) => { if (prefix.length === n) lineups.push(prefix); else for (const v of base) walk([...prefix, v]) }
    walk([])
  }
  let checked = 0
  for (const core of lineups) for (const extra of [0, 1, 2]) {
    const vendors = [...core, ...Array(extra).fill('openrouter')]
    if (vendors.length > 6) continue
    const letters = 'ABCDEF'.slice(0, vendors.length).split('')
    const { S } = makeRun({ lineup: letters.map((x, i) => `${x}:${vendors[i]}`).join(' ') })
    const assignments = vendors.length === 3 ? [...Array(27).keys()].map(i => letters.map((_, j) => letters[Math.floor(i / 3 ** j) % 3]))
      : [letters.map(() => letters[0]), letters.map((x, i) => letters[i % 2])]
    for (const drop of [null, letters.at(-1)]) {
      for (const s of S.seats) s.active = s.L !== drop
      for (const ships of assignments) {
        vote(S, Object.fromEntries(letters.map((x, i) => [x, ships[i]]).filter(([x, ship]) => x !== drop && ship !== drop)))
        const want = extra ? newRule(S, 1) : oldRule(S, 1)
        if (!extra) assert.deepEqual(oldRule(S, 1), newRule(S, 1))
        const c = L.consensus(S, 1)
        assert.deepEqual({ cross: L.crossVendor(S), text: L.crossVendorText(S), W: c ? c.W : null }, want, `${vendors} ${ships} drop ${drop}`)
        checked++
      }
    }
  }
  assert.ok(checked > 500)
})

test('openrouter report', () => {
  const state = kinds => {
    const { S } = makeRun({ lineup: 'A:claude B:codex' })
    S.turnLog = [{ turn: 'r0:A', role: 'seat', vendor: 'claude', ok: true }]
    S.vendorTimes = []
    const add = (vendor, turn, seconds, role = 'seat') => { S.turnLog.push({ turn, role, vendor, ok: true }); S.vendorTimes.push({ turn, vendor, seconds }) }
    if (kinds.includes('codex')) { add('codex', 'B-r0', 40); add('codex', 'B-r1', 60) }
    if (kinds.includes('gemini')) add('gemini', 'C-r0', 100)
    if (kinds.includes('openrouter')) { add('openrouter', 'D-r0', 20); add('openrouter', 'panel-or1-x-r1', 35, 'panel') }
    return S
  }
  const oldTimes = S => {
    if (!S.vendorTimes.length) return ''
    const xs = S.vendorTimes.map(t => t.seconds).sort((a, b) => a - b), median = xs[Math.floor(xs.length / 2)]
    const slow = S.vendorTimes.slice().sort((a, b) => b.seconds - a.seconds).slice(0, 3)
    return `- Codex and Gemini turn times: median ${Math.round(median)}s; slowest ${slow.map(t => `${t.turn} ${Math.round(t.seconds)}s`).join(', ')}.`
  }
  const facts = S => L.retroFacts(S, { outcome: { kind: 'consensus', W: 'A', round: 1 }, endorsements: [], fixPass: false, audit: null, ready: null })
  for (const kinds of [['codex', 'gemini'], []]) {
    const S = state(kinds)
    assert.equal(L.externalTimes(S), oldTimes(S))
    assert.ok(!facts(S).includes('OpenRouter'))
  }
  const mixed = state(['codex', 'gemini', 'openrouter'])
  assert.equal(L.externalTimes(mixed), `${oldTimes(state(['codex', 'gemini']))}\n- OpenRouter turn times: median 35s; slowest panel-or1-x-r1 35s, D-r0 20s.`)
  assert.ok(facts(mixed).includes(' OpenRouter turns: 2 (panel 1, seat 1).') || facts(mixed).includes(' OpenRouter turns: 2 (seat 1, panel 1).'), facts(mixed))
  const only = state(['openrouter'])
  assert.equal(L.externalTimes(only), '- OpenRouter turn times: median 35s; slowest panel-or1-x-r1 35s, D-r0 20s.')
  for (const S of [mixed, only]) assert.ok(!/\$|cost/.test(facts(S) + L.externalTimes(S)))
})
