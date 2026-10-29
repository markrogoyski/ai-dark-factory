// Table-driven tests of the council's decision logic (src/lib), called directly with a state
// object: consensus, tallies, narrowing, ranking, readiness, the gate, rulings, ingestion and the
// config. The scenarios in sim.mjs cover the same ground end to end, but each edge case there costs
// a scripted run; here it costs a few lines.
//   node --test test/logic.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { loadLib, makeRun, addItem } from './lib.mjs'

const vote = (ship, extra = {}) => ({ ship, amendments: [], reason: '', ...extra })

describe('quorum', () => {
  const { L, S } = makeRun()
  for (const [n, want] of [[2, 2], [3, 2], [4, 3], [5, 4], [6, 4]]) {
    test(`${n} seats need ${want}`, () => {
      S.seats = Array.from({ length: n }, (_, i) => ({ L: 'ABCDEF'[i], vendor: 'claude', active: true }))
      assert.equal(L.consensusAt(S), want)
    })
  }
  test('an override is clamped to 1..seats; 0 means the default', () => {
    assert.equal(L.quorum(S, 99), 6)
    assert.equal(L.quorum(S, 1), 1)
    assert.equal(L.quorum(S, 0), 4)
  })
  test('dropped seats shrink the field', () => {
    S.seats.forEach((s, i) => { s.active = i < 3 })
    assert.equal(L.consensusAt(S), 2)
  })
})

describe('tally and consensus', () => {
  test('three of four votes from two vendors carry', () => {
    const { L, S } = makeRun()
    S.votes[1] = { A: vote('B'), B: vote('B'), C: vote('B'), D: vote('D') }
    assert.deepEqual(L.tally(S, 1), { B: ['A', 'B', 'C'], D: ['D'] })
    const c = L.consensus(S, 1)
    assert.deepEqual([c.W, c.voters, c.via], ['B', ['A', 'B', 'C'], 'votes'])
  })
  test('two votes of four are not enough', () => {
    const { L, S } = makeRun()
    S.votes[1] = { A: vote('B'), B: vote('B'), C: vote('A'), D: vote('D') }
    assert.equal(L.consensus(S, 1), null)
  })
  test('votes from one vendor do not carry when there are several', () => {
    const { L, S } = makeRun({ lineup: 'A:claude B:claude C:claude D:codex' })
    S.votes[1] = { A: vote('B'), B: vote('B'), C: vote('B'), D: vote('D') }
    assert.equal(L.consensus(S, 1), null)
  })
  test('one vendor is enough when there is only one', () => {
    const { L, S } = makeRun({ lineup: 'A:claude B:claude C:claude' })
    S.votes[1] = { A: vote('B'), B: vote('B'), C: vote('A') }
    assert.equal(L.consensus(S, 1).W, 'B')
  })
  test('a disqualified position takes no votes', () => {
    const { L, S } = makeRun()
    S.votes[1] = { A: vote('B'), B: vote('B'), C: vote('B'), D: vote('D') }
    S.pos.B.gated = true
    assert.deepEqual(L.tally(S, 1), { D: ['D'] })
    assert.equal(L.consensus(S, 1), null)
  })
  test('votes for a position out of contention, and from dropped seats, are not counted', () => {
    const { L, S } = makeRun()
    S.inContention = new Set(['A', 'B', 'C'])
    S.seats[2].active = false
    S.votes[1] = { A: vote('D'), B: vote('B'), C: vote('B'), D: vote('B') }
    assert.deepEqual(L.tally(S, 1), { B: ['B', 'D'] })
  })
  test('a ballot is tallied from its own book', () => {
    const { L, S } = makeRun()
    S.votes[1] = { A: vote('A'), B: vote('B'), C: vote('C'), D: vote('D') }
    S.ballots[1] = { A: vote('B'), B: vote('B'), C: vote('B'), D: vote('D') }
    assert.equal(L.consensus(S, 1), null)
    assert.equal(L.consensus(S, 1, S.ballots).W, 'B')
  })

  describe('identical versions', () => {
    const T1 = 'a'.repeat(40), T2 = 'b'.repeat(40)
    // Every seat votes for its own copy of the same change, as in a smoke run where all four agreed.
    const same = (trees = { A: T1, B: T1, C: T1, D: T1 }, round = 1) => {
      const r = makeRun()
      for (const [X, hash] of Object.entries(trees)) r.S.pos[X].tree = { hash, round }
      r.S.votes[1] = { A: vote('A'), B: vote('A'), C: vote('C'), D: vote('D') }
      return r
    }
    test('votes for byte-identical versions count together, for the copy with the most votes', () => {
      const { L, S } = same()
      const c = L.consensus(S, 1)
      assert.deepEqual([c.W, c.via, c.voters.sort(), c.same.sort()], ['A', 'identical', ['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D']])
    })
    test('different trees are different positions', () => {
      const { L, S } = same({ A: T1, B: T2, C: T2, D: T2 })
      assert.equal(L.consensus(S, 1), null)
    })
    test('trees measured in an earlier round do not pool', () => {
      const { L, S } = same(undefined, 0)
      assert.equal(L.consensus(S, 1), null)
    })
    test('a disqualified copy brings no votes', () => {
      const { L, S } = same({ A: T1, C: T1, D: T1 })
      S.votes[1] = { A: vote('A'), B: vote('B'), C: vote('C'), D: vote('D') }
      S.pos.D.gated = true
      assert.equal(L.consensus(S, 1), null)
      S.pos.D.gated = false
      assert.equal(L.consensus(S, 1).W, 'A')
    })
    test('the vendor rule still applies to the pooled votes', () => {
      const { L, S } = makeRun({ lineup: 'A:claude B:claude C:claude D:codex' })
      for (const X of ['A', 'B', 'C']) S.pos[X].tree = { hash: T1, round: 1 }
      S.votes[1] = { A: vote('A'), B: vote('B'), C: vote('C'), D: vote('D') }
      assert.equal(L.consensus(S, 1), null)
    })
    test('a check records the tree only when it is a hash', () => {
      const { L, S } = makeRun()
      const r = tree => ({ measured: true, diff: { files: 1, added: 1, removed: 1, tree }, delta: null, postWords: 10,
        suite: { ran: true, passed: true, tail: '' }, crossTests: [], rulings: [], criteria: [] })
      L.applyCheck(S, 'A', 1, r(T1), [])
      assert.deepEqual(S.pos.A.tree, { hash: T1, round: 1 })
      L.applyCheck(S, 'A', 2, r('see snapshot'), [])
      assert.equal(S.pos.A.tree, null)
    })
  })

  describe('blind agreement in round 0', () => {
    const T1 = 'a'.repeat(40), T2 = 'b'.repeat(40)
    const blind = (trees = { A: T1, B: T1, C: T1, D: T1 }, o = {}) => {
      const r = makeRun(o)
      r.S.verify = 'make test'
      for (const s of r.S.seats) {
        r.S.pos[s.L].suite = { ran: true, passed: true, tail: '' }
        if (trees[s.L]) r.S.pos[s.L].tree = { hash: trees[s.L], round: 0 }
      }
      return r
    }
    test('every seat byte-identical and passing: the copy highest on the scorecard ships', () => {
      const { L, S } = blind()
      const b = L.blindAgreement(S)
      assert.deepEqual([b.W, b.same.slice().sort()], [L.rankPositions(S)[0].seat, ['A', 'B', 'C', 'D']])
    })
    test('one seat different: the debate runs', () => {
      const { L, S } = blind({ A: T1, B: T1, C: T1, D: T2 })
      assert.equal(L.blindAgreement(S), null)
    })
    test('a seat without a measured tree: the debate runs', () => {
      const { L, S } = blind({ A: T1, B: T1, C: T1 })
      assert.equal(L.blindAgreement(S), null)
    })
    test('a dropped seat does not block it', () => {
      const { L, S } = blind({ A: T1, B: T1, C: T1 })
      S.seats.find(s => s.L === 'D').active = false
      assert.ok(L.blindAgreement(S))
    })
    test('identical but failing verification: the debate runs, even when the baseline failed too', () => {
      const { L, S } = blind()
      S.baselineOk = false
      for (const X of ['A', 'B', 'C', 'D']) S.pos[X].suite = { ran: true, passed: false, tail: '' }
      assert.equal(L.blindAgreement(S), null)
    })
    test('a disqualified copy: the debate runs', () => {
      const { L, S } = blind()
      S.pos.B.gated = true
      assert.equal(L.blindAgreement(S), null)
    })
    test('trees from a later round do not count', () => {
      const { L, S } = blind()
      for (const X of ['A', 'B', 'C', 'D']) S.pos[X].tree.round = 1
      assert.equal(L.blindAgreement(S), null)
    })
    test('not in investigate or design mode', () => {
      const { L, S } = blind(undefined, { args: { mode: 'design' } })
      assert.equal(L.blindAgreement(S), null)
    })
  })

  describe('approval (an experiment)', () => {
    const approving = () => {
      const r = makeRun({ args: { approval: true } })
      // B has one first-choice vote (from A) and two "also acceptable" ones.
      r.S.votes[1] = {
        A: vote('B'), B: vote('A'),
        C: vote('C', { acceptable: [{ seat: 'B', amendments: ['tighten it'] }] }),
        D: vote('D', { acceptable: [{ seat: 'B', amendments: [] }] }),
      }
      return r
    }
    test('first-choice plus acceptable votes carry when no one reached the quorum', () => {
      const { L, S } = approving()
      const c = L.consensus(S, 1)
      assert.deepEqual([c.W, c.via, c.first, c.voters.sort()], ['B', 'approval', ['A'], ['A', 'C', 'D']])
    })
    test('off by default', () => {
      const { L, S } = approving()
      S.approval = false
      assert.equal(L.consensus(S, 1), null)
    })
    test('a standing verified blocker bars it', () => {
      const { L, S } = approving()
      addItem(L, S, { author: 'C', kind: 'finding', target: 'B', severity: 'blocker', status: 'verified' })
      assert.equal(L.consensus(S, 1), null)
    })
    test('the position needs a first-choice vote from another seat', () => {
      const { L, S } = approving()
      S.votes[1].A = vote('A')
      S.votes[1].B = vote('B', { acceptable: [] })
      S.votes[1].C = vote('C', { acceptable: [{ seat: 'B' }] })
      assert.equal(L.consensus(S, 1), null)
    })
  })
})

describe('recordVote', () => {
  test('a vote for a position out of contention is dropped, with a note', () => {
    const { L, S } = makeRun()
    S.inContention = new Set(['A', 'B'])
    L.recordVote(S, S.votes, 1, 'C', vote('D'))
    assert.deepEqual(S.votes[1], {})
    assert.match(S.notes[0], /C voted for D in round 1, which is out of contention/)
  })
  test('amendments are capped, and acceptable positions are de-duplicated and exclude the choice', () => {
    const { L, S } = makeRun({ args: { approval: true } })
    L.recordVote(S, S.votes, 1, 'A', vote('B', {
      amendments: Array.from({ length: 12 }, (_, i) => `a${i}`),
      acceptable: [{ seat: 'C', amendments: ['x'] }, { seat: 'C', amendments: ['y'] }, { seat: 'B' }, { seat: 'Z' }],
    }))
    assert.equal(S.votes[1].A.amendments.length, 8)
    assert.deepEqual(S.votes[1].A.acceptable, [{ seat: 'C', amendments: ['x'] }])
  })
  test('without approval the acceptable list is not kept', () => {
    const { L, S } = makeRun()
    L.recordVote(S, S.votes, 1, 'A', vote('B', { acceptable: [{ seat: 'C' }] }))
    assert.equal(S.votes[1].A.acceptable, undefined)
  })
})

describe('ranking', () => {
  // Each key, in strict priority order, with how to make seat X worse on it than the other seat.
  const KEYS = [
    ['out', (r, X, O) => { r.S.inContention = new Set([O]) }],
    ['gated', (r, X) => { r.S.pos[X].gated = true; r.S.pos[X].gateReasons = ['suite fails'] }],
    ['blockers', (r, X, O) => addItem(r.L, r.S, { author: O, kind: 'finding', target: X, severity: 'blocker', status: 'verified' })],
    ['majors', (r, X, O) => addItem(r.L, r.S, { author: O, kind: 'finding', target: X, severity: 'major', status: 'verified' })],
    ['crossRate', (r, X) => { r.S.testResults.T1A1[X] = 'fail' }],
    ['criteriaScore', (r, X) => { r.S.pos[X].criteria = [{ criterion: 'C1', status: 'unmet' }, { criterion: 'C2', status: 'partial' }] }],
    ['minors', (r, X, O) => addItem(r.L, r.S, { author: O, kind: 'finding', target: X, severity: 'minor', status: 'verified' })],
    ['votesFromOthers', (r, X, O) => { r.S.votes[1][X] = vote(O) }],
    ['authorHallucination', (r, X) => addItem(r.L, r.S, { author: X, kind: 'fact', status: 'fabricated' })],
    ['size', (r, X) => { r.S.pos[X].stats.added = 500 }],
  ]
  const base = () => {
    const r = makeRun({ lineup: 'A:claude B:codex' })
    for (const s of r.S.seats) {
      r.S.pos[s.L].criteria = [{ criterion: 'C1', status: 'met' }, { criterion: 'C2', status: 'met' }]
      r.S.pos[s.L].stats = { files: 1, added: 10, removed: 0 }
    }
    addItem(r.L, r.S, { id: 'T1A1', author: 'A', kind: 'test', status: 'verified' })
    r.S.testResults.T1A1 = { A: 'pass', B: 'pass' }
    r.S.votes[1] = {}
    return r
  }
  const order = r => r.L.rankPositions(r.S).map(x => x.seat)

  test('a tie is broken by seat letter', () => {
    assert.deepEqual(order(base()), ['A', 'B'])
  })
  KEYS.forEach(([key, worsen], i) => {
    test(`${key}: worse on it loses, even when better on everything after it`, () => {
      const r = base()
      worsen(r, 'A', 'B')
      for (const [, later] of KEYS.slice(i + 1)) later(r, 'B', 'A')
      assert.equal(order(r)[0], 'B')
    })
    test(`${key}: worse on it alone loses to a tie on the rest`, () => {
      const r = base()
      worsen(r, 'B', 'A')
      assert.equal(order(r)[0], 'A')
    })
  })
  test('separation names the first criterion that tells two positions apart', () => {
    const r = base()
    KEYS.find(k => k[0] === 'majors')[1](r, 'A', 'B')
    const [first, second] = L_rows(r)
    assert.match(r.L.separation(first, second), /^B ranked above A on standing major findings \(0 vs 1\)$/)
  })
  test('tied on everything', () => {
    const r = base()
    const [a, b] = L_rows(r)
    assert.match(r.L.separation(a, b), /tied on every criterion; seat order put A first/)
  })
  function L_rows(r) { return r.L.rankPositions(r.S) }

  test('findings that were fixed, withdrawn, judgment or against dropped seats do not stand', () => {
    const r = base()
    for (const o of [{ fixed: true }, { withdrawn: true }, { judgment: true }, { status: 'refuted' }]) {
      addItem(r.L, r.S, { author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified', ...o })
    }
    assert.equal(r.L.positionRows(r.S).find(x => x.seat === 'A').blockers, 0)
    r.S.seats[0].active = false
    addItem(r.L, r.S, { author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified' })
    assert.equal(r.L.isStanding(r.S, r.S.ledger.at(-1)), false)
  })
})

describe('narrowing', () => {
  const field = () => {
    const r = makeRun({ lineup: 'A:claude B:claude C:codex D:gemini E:claude' })
    r.S.votes[1] = {}
    return r
  }
  const finding = (r, author, target, severity, o = {}) =>
    addItem(r.L, r.S, { author, kind: 'finding', target, severity, status: 'verified', ...o })

  test('keeps the top two, and drops the rest with their rank', () => {
    const r = field()
    finding(r, 'A', 'D', 'blocker'); finding(r, 'A', 'E', 'major')
    const msg = r.L.narrow(r.S, 1)
    // ranked A B C E D; nobody voted for or presses on the bottom three except as below
    assert.deepEqual([...r.S.inContention].sort(), ['A', 'B'])
    assert.deepEqual(r.S.dropped.map(d => [d.seat, d.rank, d.of]), [['C', 3, 5], ['E', 4, 5], ['D', 5, 5]])
    assert.equal(msg, 'round 1: the field narrows to A, B; C, E, D now review')
  })
  test('a position another seat voted for stays, even ranked outside the top two', () => {
    const r = field()
    finding(r, 'A', 'C', 'blocker')                     // C ranks below D and E
    r.S.votes[1] = { B: vote('C') }
    r.L.narrow(r.S, 1)
    assert.deepEqual([...r.S.inContention].sort(), ['A', 'B', 'C'])
    assert.deepEqual(r.S.dropped.map(d => d.seat), ['D', 'E'])
  })
  test('a seat with a verified major finding against a position that stays, stays', () => {
    const r = field()
    for (const t of ['C', 'D', 'E']) finding(r, 'A', t, 'blocker')     // B, then A, lead; C, D and E trail
    finding(r, 'E', 'A', 'major')
    r.L.narrow(r.S, 1)
    assert.deepEqual([...r.S.inContention].sort(), ['A', 'B', 'E'], 'E presses on A')
  })
  test('a minor finding does not keep a seat', () => {
    const r = field()
    finding(r, 'E', 'A', 'minor')
    r.L.narrow(r.S, 1)
    assert.ok(!r.S.inContention.has('E'))
  })
  test('narrow: false leaves the field alone', () => {
    const r = makeRun({ args: { narrow: false }, lineup: 'A:claude B:claude C:codex D:gemini' })
    r.S.votes[1] = {}
    assert.equal(r.L.narrow(r.S, 1), null)
    assert.equal(r.S.inContention, null)
  })
  test('two or fewer contenders are not narrowed', () => {
    const r = makeRun({ lineup: 'A:claude B:codex' })
    r.S.votes[1] = {}
    assert.equal(r.L.narrow(r.S, 1), null)
  })
  test('nothing leaves when everyone has a reason to stay', () => {
    const r = makeRun({ lineup: 'A:claude B:claude C:codex' })
    r.S.votes[1] = { A: vote('B'), B: vote('C'), C: vote('A') }
    assert.equal(r.L.narrow(r.S, 1), null)
    assert.equal(r.S.inContention, null)
  })
  test('contenders() and contending() follow the narrowed field', () => {
    const r = field()
    r.L.narrow(r.S, 1)
    assert.deepEqual(r.L.contenders(r.S).map(s => s.L), ['A', 'B'])
    assert.equal(r.L.contending(r.S, 'C'), false)
    assert.equal(r.L.isLetter(r.S, 'C'), true)
  })
})

describe('the gate', () => {
  test('a failing suite disqualifies', () => {
    const { L, S } = makeRun()
    S.pos.A.suite = { ran: true, passed: false }
    L.gate(S, 'A', 1)
    assert.deepEqual([S.pos.A.gated, S.pos.A.gateReasons], [true, ['verification command fails']])
  })
  test('not when the suite already failed at baseline', () => {
    const { L, S } = makeRun()
    S.baselineOk = false
    S.pos.A.suite = { ran: true, passed: false }
    L.gate(S, 'A', 1)
    assert.equal(S.pos.A.gated, false)
  })
  test('not when there is no suite, or it did not run', () => {
    const { L, S } = makeRun()
    L.gate(S, 'A', 1)
    S.pos.B.suite = { ran: false, passed: false }
    L.gate(S, 'B', 1)
    assert.deepEqual([S.pos.A.gated, S.pos.B.gated], [false, false])
  })
  test('a fabricated verification claim in that round disqualifies, even in design mode', () => {
    const { L, S } = makeRun({ args: { mode: 'design' } })
    const c = addItem(L, S, { author: 'A', kind: 'verification', status: 'fabricated' })
    L.gate(S, 'A', 1)
    assert.deepEqual([S.pos.A.gated, S.pos.A.gateReasons], [true, [`fabricated verification claim ${c.id}`]])
    L.gate(S, 'A', 2)
    assert.equal(S.pos.A.gated, false, 'only that round')
  })
  test('a fabricated fact claim is not a verification claim', () => {
    const { L, S } = makeRun()
    addItem(L, S, { author: 'A', kind: 'fact', status: 'fabricated' })
    L.gate(S, 'A', 1)
    assert.equal(S.pos.A.gated, false)
  })
})

describe('behaviour', () => {
  const turn = (o = {}) => ({ round: 1, reviewing: false, changed: false, note: '', adopted: 0, basis: [], conceded: [], challenged: [], ...o })
  test('changing with nothing verified behind it is a capitulation', () => {
    const { L, S } = makeRun()
    S.behaviour.A.turns.push(turn({ changed: true, note: 'gave in' }))
    L.behaviourAfter(S, 1, {})
    assert.deepEqual(S.behaviour.A.capitulations, [{ round: 1, note: 'gave in' }])
  })
  test('a basis made only of refuted claims is still a capitulation', () => {
    const { L, S } = makeRun()
    const c = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'refuted' })
    S.behaviour.A.turns.push(turn({ changed: true, basis: [c.id] }))
    L.behaviourAfter(S, 1, {})
    assert.equal(S.behaviour.A.capitulations.length, 1)
  })
  test('a verified basis, or an adopted idea, is not', () => {
    const { L, S } = makeRun()
    const c = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'verified' })
    S.behaviour.A.turns.push(turn({ changed: true, basis: [c.id] }))
    S.behaviour.B.turns.push(turn({ changed: true, adopted: 1 }))
    L.behaviourAfter(S, 1, {})
    assert.deepEqual([S.behaviour.A.capitulations.length, S.behaviour.B.capitulations.length], [0, 0])
  })
  test('ignoring a verified blocker is recorded; conceding, challenging, citing or fixing it is not', () => {
    for (const [label, t, fixed, ignored] of [
      ['silent', turn(), false, 1],
      ['conceded', turn({ conceded: ['X'] }), false, 0],
      ['challenged', turn({ challenged: ['X'] }), false, 0],
      ['cited as basis', turn({ basis: ['X'] }), false, 0],
      ['fixed', turn(), true, 0],
    ]) {
      const { L, S } = makeRun()
      const c = addItem(L, S, { id: 'X', author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified', fixed })
      S.behaviour.A.turns.push(t)
      L.behaviourAfter(S, 1, { A: [c.id] })
      assert.equal(S.behaviour.A.ignored.length, ignored, label)
    }
  })
  test('knownStanding lists verified blocker and major findings against contenders only', () => {
    const { L, S } = makeRun()
    const a = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified' })
    addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'minor', status: 'verified' })
    addItem(L, S, { author: 'B', kind: 'finding', target: 'C', severity: 'major', status: 'unresolved' })
    assert.deepEqual(L.knownStanding(S), { A: [a.id], B: [], C: [], D: [] })
  })
  test('stable: no change and the same votes as the round before', () => {
    const { L, S } = makeRun()
    S.behaviour.A.turns.push(turn({ round: 2 }))
    S.votes[1] = { A: vote('B'), B: vote('B') }
    S.votes[2] = { A: vote('B'), B: vote('B') }
    assert.equal(L.stable(S, 2), true)
    S.votes[2].B = vote('A')
    assert.equal(L.stable(S, 2), false)
    S.votes[2].B = vote('B')
    S.behaviour.B.turns.push(turn({ round: 2, changed: true }))
    assert.equal(L.stable(S, 2), false)
  })
})

describe('readiness', () => {
  const finished = () => {
    const r = makeRun({ lineup: 'A:claude B:claude C:codex' })
    const p = r.S.pos.A
    p.assessment = { round: 'F', checked: true, measured: true, missingCriteria: [], missingItems: [] }
    p.suite = { ran: true, passed: true }
    r.S.verify = 'make test'
    p.criteria = [{ criterion: 'C1', status: 'met' }, { criterion: 'C2', status: 'met' }]
    r.raters = r.S.seats.filter(s => s.L !== 'A')
    r.reviews = [{ endorse: true }, { endorse: true }]
    r.ready = () => r.L.readiness(r.S, 'A', 'F', r.raters, r.reviews)
    return r
  }
  test('ready', () => {
    const r = finished()
    assert.deepEqual(r.ready(), { state: 'ready', blocked: [], incomplete: [] })
    assert.match(r.L.readinessText(r.ready()), /^ready: /)
  })
  const blocked = (name, mutate, re) => test(`blocked: ${name}`, () => {
    const r = finished(); mutate(r)
    const got = r.ready()
    assert.equal(got.state, 'blocked')
    assert.match(got.blocked.join('; '), re)
  })
  const incomplete = (name, mutate, re) => test(`incomplete: ${name}`, () => {
    const r = finished(); mutate(r)
    const got = r.ready()
    assert.equal(got.state, 'incomplete')
    assert.match(got.incomplete.join('; '), re)
  })
  blocked('the suite fails on the final version', r => { r.S.pos.A.suite.passed = false }, /verification command fails/)
  blocked('an unmet criterion', r => { r.S.pos.A.criteria[1].status = 'unmet' }, /criteria unmet: C2/)
  blocked('a fabricated verification claim in the final round', r => addItem(r.L, r.S, { round: 'F', author: 'A', kind: 'verification', status: 'fabricated' }), /fabricated verification claim/)
  blocked('a published test fails', r => {
    addItem(r.L, r.S, { id: 'T1B1', author: 'B', kind: 'test', status: 'verified' })
    r.S.testResults.T1B1 = { A: 'fail' }
  }, /published tests not passing: T1B1/)
  blocked('an upheld blocker stands', r => addItem(r.L, r.S, { author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified' }), /standing blocker/)
  incomplete('never checked', r => { r.S.pos.A.assessment = null }, /never checked/)
  incomplete('checked in an earlier round only', r => { r.S.pos.A.assessment.round = 2 }, /never checked/)
  incomplete('the suite did not run', r => { r.S.pos.A.assessment.measured = false }, /did not run/)
  incomplete('a criterion was not judged', r => { r.S.pos.A.assessment.missingCriteria = ['C2'] }, /criteria not judged: C2/)
  incomplete('an item has no ruling', r => { r.S.pos.A.assessment.missingItems = ['1B1'] }, /no ruling on 1B1/)
  incomplete('a major finding is unresolved', r => addItem(r.L, r.S, { author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'unresolved' }), /unresolved major/)
  incomplete('a blocking objection was ruled by one adjudicator', r =>
    addItem(r.L, r.S, { round: 'F', author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'refuted', ruledBy: 'panel (one adjudicator)' }), /ruled by one adjudicator/)
  incomplete('a rater returned no review', r => { r.reviews = [{ endorse: true }, null] }, /no ratification review from C/)
  test('a failing suite that failed at baseline is incomplete, not blocked', () => {
    const r = finished()
    r.S.baselineOk = false
    r.S.pos.A.suite.passed = false
    const got = r.ready()
    assert.equal(got.state, 'incomplete')
    assert.match(got.incomplete.join(), /as it already did at baseline/)
  })
  test('design mode does not need the suite', () => {
    const r = finished()
    r.S.mode = 'design'
    r.S.pos.A.assessment.measured = false
    r.S.pos.A.suite = null
    assert.equal(r.ready().state, 'ready')
  })
})

describe('rulings', () => {
  const item = (c, o = {}) => ({ c, validity: true, fixed: false, test: false, challenges: [], ...o })
  const result = (o = {}) => ({
    measured: true, diff: { files: 2, added: 30, removed: 4 }, delta: { since: 'r0', files: 1, added: 5, removed: 1 },
    postWords: 100, suite: { ran: true, passed: true, tail: 'OK' }, crossTests: [], rulings: [], criteria: [], ...o,
  })

  test('verdicts become statuses, the checker is recorded, and unverifiable means unresolved', () => {
    const { L, S } = makeRun()
    const a = addItem(L, S, { author: 'A', kind: 'verification' }), b = addItem(L, S, { author: 'A', kind: 'fact' })
    L.applyCheck(S, 'A', 1, result({ rulings: [
      { claim: `[${a.id}] checked`, verdict: 'verified', fixed: 'n/a', note: 'ran it' },
      { claim: b.id, verdict: 'unverifiable', fixed: 'n/a', note: 'no way to tell' },
    ] }), [item(a), item(b)])
    assert.deepEqual([a.status, a.note, a.ruledBy, b.status], ['verified', 'ran it', 'checker', 'unresolved'])
  })
  test('measurements land on the position: diff, delta (only when it is against the expected snapshot), suite, cross-tests', () => {
    const { L, S } = makeRun()
    addItem(L, S, { id: 'T1A1', author: 'A', kind: 'test' })
    L.applyCheck(S, 'A', 1, result({ crossTests: [{ test: 'T1A1', outcome: 'fail' }, { test: 'T9Z9', outcome: 'pass' }] }), [])
    const p = S.pos.A
    assert.deepEqual(p.stats, { files: 2, added: 30, removed: 4 })
    assert.deepEqual(p.delta, { files: 1, added: 5, removed: 1 })
    assert.equal(p.deltaPath, '/r/room/r1/A.delta.diff')
    assert.deepEqual(S.testResults, { T1A1: { A: 'fail' } }, 'an unknown test is ignored')
    L.applyCheck(S, 'A', 2, result({ delta: { since: 'r0', files: 9, added: 9, removed: 9 } }), [])
    assert.equal(S.pos.A.delta, null, 'a delta against the wrong snapshot is not used')
  })
  test('fixed is applied only to findings that were asked about', () => {
    const { L, S } = makeRun()
    const f = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'verified' })
    const g = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'verified' })
    L.applyCheck(S, 'A', 2, result({ rulings: [{ claim: f.id, verdict: 'n/a', fixed: 'yes', note: '' }, { claim: g.id, verdict: 'n/a', fixed: 'yes', note: '' }] }),
      [item(f, { validity: false, fixed: true })])
    assert.deepEqual([f.fixed, f.fixedIn, g.fixed], [true, 2, false])
    L.applyCheck(S, 'A', 3, result({ rulings: [{ claim: f.id, verdict: 'n/a', fixed: 'no', note: '' }] }), [item(f, { validity: false, fixed: true })])
    assert.equal(f.fixed, false, 'it came back')
  })
  test('a failed check leaves everything unchecked, and says so', () => {
    const { L, S } = makeRun()
    const a = addItem(L, S, { author: 'A', kind: 'fact' })
    L.applyCheck(S, 'A', 1, null, [item(a)])
    assert.deepEqual(S.pos.A.assessment, { round: 1, checked: false, measured: false, missingCriteria: ['C1', 'C2'], missingItems: [a.id] })
    assert.equal(a.status, 'open')
    assert.match(S.notes[0], /check of A in r1 failed/)
  })
  test('a long post is noted', () => {
    const { L, S } = makeRun()
    L.applyCheck(S, 'A', 1, result({ postWords: 950 }), [])
    assert.deepEqual(S.longPosts, [{ turn: 'r1:A', words: 950 }])
  })
  test('criteria that do not exist are dropped', () => {
    const { L, S } = makeRun()
    L.applyCheck(S, 'A', 1, result({ criteria: [{ criterion: 'C1', status: 'met' }, { criterion: 'C7', status: 'met' }] }), [])
    assert.deepEqual(S.pos.A.criteria, [{ criterion: 'C1', status: 'met' }])
  })

  describe('panel', () => {
    const rule = (verdict, note = 'n') => ({ rulings: [{ claim: 'X', verdict, note }] })
    const setup = () => {
      const r = makeRun()
      r.c = addItem(r.L, r.S, { id: 'X', author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'unresolved' })
      return r
    }
    test('agreement settles it, and says two adjudicators ruled', () => {
      const r = setup()
      r.L.applyPanel(r.S, ['X'], [rule('refuted'), rule('refuted')])
      assert.deepEqual([r.c.status, r.c.ruledBy], ['refuted', 'panel'])
    })
    test('a split leaves it unresolved', () => {
      const r = setup()
      r.L.applyPanel(r.S, ['X'], [rule('verified'), rule('refuted')])
      assert.deepEqual([r.c.status, r.c.ruledBy], ['unresolved', 'panel'])
    })
    test('one adjudicator is recorded as such', () => {
      const r = setup()
      r.L.applyPanel(r.S, ['X'], [null, rule('verified')])
      assert.deepEqual([r.c.status, r.c.ruledBy], ['verified', 'panel (one adjudicator)'])
      assert.match(r.c.note, /^adjudicator 1: verified/)
    })
    test('no one answering leaves earlier rulings and says so', () => {
      const r = setup()
      r.L.applyPanel(r.S, ['X'], [null, null])
      assert.equal(r.c.status, 'unresolved')
      assert.match(r.S.notes[0], /panel failed on X/)
    })
  })
})

describe('checker items', () => {
  test('what each checker is asked', () => {
    const { L, S } = makeRun()
    const own = addItem(L, S, { id: '1A1', round: 1, author: 'A', kind: 'verification' })
    const test_ = addItem(L, S, { id: 'T1A1', round: 1, author: 'A', kind: 'test' })
    const against = addItem(L, S, { id: '1B1', round: 1, author: 'B', kind: 'finding', target: 'A', severity: 'major' })
    const old = addItem(L, S, { id: '0B1', round: 0, author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'verified' })
    const judg = addItem(L, S, { id: '1B2', round: 1, author: 'B', kind: 'finding', target: 'A', severity: 'minor', judgment: true })
    const gone = addItem(L, S, { id: '1A2', round: 1, author: 'A', kind: 'fact', withdrawn: true })
    const byId = Object.fromEntries(L.checkerItems(S, 'A', 1, []).map(it => [it.c.id, it]))
    assert.deepEqual(Object.keys(byId).sort(), ['0B1', '1A1', '1B1', 'T1A1'])
    assert.deepEqual([byId['1A1'].validity, byId['1A1'].fixed], [true, false])
    assert.equal(byId['T1A1'].test, true)
    assert.deepEqual([byId['1B1'].validity, byId['1B1'].fixed], [true, true])
    assert.deepEqual([byId['0B1'].validity, byId['0B1'].fixed], [false, true], 'a standing finding from before is asked only whether it is fixed')
  })
  test('routed claims bring their challenges along', () => {
    const { L, S } = makeRun()
    addItem(L, S, { id: '1B1', round: 1, author: 'B', kind: 'fact' })
    S.challenges.push({ round: 1, by: 'A', claim: '1B1', reason: 'wrong', evidence: '' }, { round: 0, by: 'C', claim: '1B1', reason: 'old', evidence: '' })
    const [it] = L.checkerItems(S, 'D', 1, ['1B1'])
    assert.deepEqual(it.challenges.map(x => x.by), ['A'])
  })
})

describe('ingestion', () => {
  test('fact claims that name no criterion are dropped; verification claims never are', () => {
    const { L, S } = makeRun()
    L.ingestClaims(S, 'A', 0, [
      { kind: 'fact', statement: 'no criterion', evidence: '' },
      { kind: 'fact', statement: 'bears on C2', evidence: 'f:1', criterion: 'C2' },
      { kind: 'fact', statement: 'bears on a made-up one', criterion: 'C9' },
      { kind: 'verification', statement: 'suite passes', evidence: 'make test' },
      { kind: 'fact', statement: '' },
    ])
    assert.deepEqual(S.ledger.map(c => [c.id, c.kind, c.criterion]), [['0A1', 'fact', 'C2'], ['0A2', 'verification', '']])
    assert.match(S.notes[0], /A made 2 fact claims in r0 that named no acceptance criterion/)
  })
  test('without criteria every claim is kept', () => {
    const { L, S } = makeRun({ criteria: [] })
    L.ingestClaims(S, 'A', 0, [{ kind: 'fact', statement: 'x' }])
    assert.equal(S.ledger.length, 1)
  })
  test('at most 12 claims per turn', () => {
    const { L, S } = makeRun()
    L.ingestClaims(S, 'A', 0, Array.from({ length: 15 }, (_, i) => ({ kind: 'verification', statement: `v${i}` })))
    assert.equal(S.ledger.length, 12)
    assert.match(S.notes[0], /only the first 12/)
  })
  test('claim IDs count up within a round and author', () => {
    const { L, S } = makeRun()
    L.ingestClaims(S, 'B', 1, [{ kind: 'verification', statement: 'a' }, { kind: 'verification', statement: 'b' }])
    assert.deepEqual(S.ledger.map(c => c.id), ['1B1', '1B2'])
  })
  test('tests need an ID of their own round and seat, and only count in implement mode', () => {
    const { L, S } = makeRun()
    L.ingestTests(S, 'A', 1, [{ id: 'T1A1', purpose: 'p', command: 'c' }, { id: 'T1B1' }, { id: 'T1A1' }, { id: 'bogus' }, null])
    assert.deepEqual(S.ledger.map(c => c.id), ['T1A1'])
    assert.equal(S.notes.length, 3)
    const d = makeRun({ args: { mode: 'design' } })
    d.L.ingestTests(d.S, 'A', 1, [{ id: 'T1A1' }])
    assert.equal(d.S.ledger.length, 0)
  })
  test('questions are queued, at most five', () => {
    const { L, S } = makeRun()
    L.ingestQuestions(S, 'A', 1, Array.from({ length: 7 }, (_, i) => ({ question: `q${i}`, assumption: 'a' })).concat([{ question: '' }]))
    assert.equal(S.pendingQ.length, 5)
  })

  describe('a debate turn', () => {
    const turn = o => ({ summary: 'revised', changed: false, changeBasis: [], changeNote: '', findings: [], challenges: [], concessions: [],
      withdrawals: [], adopted: [], claims: [], tests: [], vote: vote('B'), questions: [], seconds: [], ...o })
    test('findings against oneself, an unknown seat or a seat out of contention are dropped; severity is normalised', () => {
      const { L, S } = makeRun()
      S.inContention = new Set(['A', 'B', 'C'])
      L.ingestDebate(S, S.seats[0], 1, turn({ findings: [
        { target: 'A', severity: 'major', kind: 'fact', statement: 'self' },
        { target: 'D', severity: 'major', kind: 'fact', statement: 'out of contention' },
        { target: 'Z', severity: 'major', kind: 'fact', statement: 'nobody' },
        { target: 'B', severity: 'catastrophic', kind: 'judgment', statement: 'odd severity' },
        { target: 'C', severity: 'blocker', kind: 'fact', statement: 'real' },
      ] }))
      assert.deepEqual(S.ledger.map(c => [c.target, c.severity, c.judgment]), [['B', 'minor', true], ['C', 'blocker', false]])
      assert.equal(S.ledger[0].status, 'judgment')
    })
    test('challenges: not to one\'s own claims, judgments, this round\'s claims, or twice', () => {
      const { L, S } = makeRun()
      const mine = addItem(L, S, { id: '0A1', round: 0, author: 'A', kind: 'fact' })
      const theirs = addItem(L, S, { id: '0B1', round: 0, author: 'B', kind: 'fact' })
      const fresh = addItem(L, S, { id: '1B1', round: 1, author: 'B', kind: 'fact' })
      const judg = addItem(L, S, { id: '0B2', round: 0, author: 'B', kind: 'finding', target: 'C', judgment: true })
      L.ingestDebate(S, S.seats[0], 1, turn({ challenges: [
        { claim: mine.id, reason: 'r' }, { claim: `[${theirs.id}]`, reason: 'wrong' }, { claim: theirs.id, reason: 'again' }, { claim: fresh.id }, { claim: judg.id }, { claim: 'nope' },
      ] }))
      assert.deepEqual(S.challenges.map(x => [x.by, x.claim, x.reason]), [['A', '0B1', 'wrong']])
    })
    test('concessions apply only to findings against the conceder; withdrawals only to one\'s own claims', () => {
      const { L, S } = makeRun()
      const against = addItem(L, S, { id: '0B1', round: 0, author: 'B', kind: 'finding', target: 'A', severity: 'major' })
      const other = addItem(L, S, { id: '0B2', round: 0, author: 'B', kind: 'finding', target: 'C', severity: 'major' })
      const mine = addItem(L, S, { id: '0A1', round: 0, author: 'A', kind: 'fact' })
      const theirs = addItem(L, S, { id: '0C1', round: 0, author: 'C', kind: 'fact' })
      L.ingestDebate(S, S.seats[0], 1, turn({ concessions: ['0B1', '0B2'], withdrawals: ['0A1', '0C1'] }))
      assert.deepEqual([against.conceded, against.concededIn, other.conceded, mine.withdrawn, theirs.withdrawn], [true, 1, false, true, false])
      assert.deepEqual(S.behaviour.A.turns[0].conceded, ['0B1'])
    })
    test('a reviewer (out of contention) keeps its position and claims, and adopts nothing', () => {
      const { L, S } = makeRun()
      S.inContention = new Set(['A', 'B'])
      L.ingestDebate(S, S.seats[2], 1, turn({ summary: 'changed my mind', adopted: [{ from: 'A', idea: 'x' }],
        claims: [{ kind: 'verification', statement: 'v' }], findings: [{ target: 'A', severity: 'major', kind: 'fact', statement: 'f' }], vote: vote('A') }))
      assert.equal(S.pos.C.summary, 'position C')
      assert.deepEqual([S.adoptions.length, S.ledger.map(c => c.kind), S.behaviour.C.turns[0].reviewing], [0, ['finding'], true])
      assert.equal(S.votes[1].C.ship, 'A')
    })
    test('adoption: from another active seat only, with an idea', () => {
      const { L, S } = makeRun()
      L.ingestDebate(S, S.seats[0], 1, turn({ adopted: [{ from: 'B', idea: 'guard clause' }, { from: 'A', idea: 'self' }, { from: 'Z', idea: 'x' }, { from: 'C', idea: '' }] }))
      assert.deepEqual(S.adoptions, [{ round: 1, by: 'A', from: 'B', idea: 'guard clause' }])
    })
    test('seconds attach to open questions, once, and not for the seat that raised it', () => {
      const { L, S } = makeRun()
      S.questions.push({ id: 'Q1', text: 't', raisedBy: ['B'], seconds: [], assumptions: {}, round: 0 })
      L.ingestDebate(S, S.seats[0], 1, turn({ seconds: ['Q1', 'Q1', 'Q9'] }))
      L.ingestDebate(S, S.seats[1], 1, turn({ seconds: ['Q1'] }))
      assert.deepEqual(S.questions[0].seconds, ['A'])
    })
    test('the change is recorded with only the basis the ledger knows', () => {
      const { L, S } = makeRun()
      addItem(L, S, { id: '0B1', round: 0, author: 'B', kind: 'fact' })
      L.ingestDebate(S, S.seats[0], 1, turn({ changed: true, changeNote: 'moved', changeBasis: ['0B1', '9Z9'] }))
      const t = S.behaviour.A.turns[0]
      assert.deepEqual([t.changed, t.note, t.basis], [true, 'moved', ['0B1']])
      assert.equal(S.pos.A.summary, 'revised')
    })
  })
})

describe('questions', () => {
  test('a clarification counts only from the round after it arrived', () => {
    const { L, S } = makeRun({ args: { clarifications: [{ id: 'Q1', answer: 'yes', afterRound: 1 }, { id: 'Q2' }] } })
    assert.deepEqual(S.clarifications, [{ id: 'Q1', answer: 'yes', afterRound: 1 }])
    assert.equal(L.answered(S, 'Q1', 0), false)
    assert.equal(L.answered(S, 'Q1', 1), true)
    assert.equal(L.answered(S, 'Q1'), true)
  })
  test('a question escalates when enough seats raised or seconded it, and not once answered', () => {
    const { L, S } = makeRun()
    S.questions.push({ id: 'Q1', text: 't', raisedBy: ['A'], seconds: ['B'], assumptions: {}, round: 0 })
    assert.deepEqual(L.escalation(S, 1), [])
    S.questions[0].seconds.push('C')
    assert.deepEqual(L.escalation(S, 1).map(q => q.id), ['Q1'])
    S.clarifications.push({ id: 'Q1', answer: 'a', afterRound: 0 })
    assert.deepEqual(L.escalation(S, 1), [])
  })
  test('seconds from dropped seats do not count', () => {
    const { L, S } = makeRun()
    S.seats[2].active = false
    assert.equal(L.support(S, { raisedBy: ['A'], seconds: ['C', 'C'] }), 1)
  })
})

describe('scorecard rows', () => {
  test('refutation score: upheld findings and won challenges earn, refuted findings and lost challenges cost half again as much', () => {
    const { L, S } = makeRun()
    addItem(L, S, { author: 'A', kind: 'finding', target: 'B', severity: 'blocker', status: 'verified' })     // +3
    addItem(L, S, { author: 'A', kind: 'finding', target: 'C', severity: 'major', status: 'refuted' })        // -3
    const bad = addItem(L, S, { author: 'B', kind: 'verification', status: 'fabricated' })                    // challenged and won: +3
    const good = addItem(L, S, { author: 'B', kind: 'fact', status: 'verified' })                             // challenged and lost: -1.5
    S.challenges.push({ round: 1, by: 'A', claim: bad.id }, { round: 1, by: 'A', claim: good.id }, { round: 1, by: 'A', claim: good.id })
    const row = L.seatRows(S).find(r => r.seat === 'A')
    assert.deepEqual([row.findingsUpheld, row.findingsRefuted, row.challengesWon, row.challengesLost, row.refutationScore], [1, 1, 1, 1, 3 + 3 - 1.5 * (2 + 1)])
    assert.equal(row.findingPrecision, 0.5)
  })
  test('hallucination rate counts fabricated claims among those the checkers ruled on', () => {
    const { L, S } = makeRun()
    addItem(L, S, { author: 'A', kind: 'fact', status: 'fabricated' })
    addItem(L, S, { author: 'A', kind: 'fact', status: 'verified' })
    addItem(L, S, { author: 'A', kind: 'fact', status: 'verified' })
    addItem(L, S, { author: 'A', kind: 'fact', status: 'open' })
    const row = L.seatRows(S).find(r => r.seat === 'A')
    assert.deepEqual([row.claimsChecked, row.fabricated, row.hallucinationRate], [3, 1, 0.33])
  })
  test('the same idea adopted twice by one seat counts once', () => {
    const { L, S } = makeRun()
    S.adoptions.push({ round: 1, by: 'B', from: 'A', idea: 'Guard clause' }, { round: 2, by: 'B', from: 'A', idea: 'guard clause' }, { round: 'F', by: 'C', from: 'A', idea: 'other' })
    const row = L.seatRows(S).find(r => r.seat === 'A')
    assert.deepEqual([row.ideasAdoptedByOthers, row.ideasInFinal], [2, 1])
  })
})

describe('state queries', () => {
  test('round tags and phases', () => {
    const { L } = makeRun()
    assert.deepEqual([0, 2, 'F', 'G', 'ratify', 'H', 'I', 'J'].map(L.roundTag), ['r0', 'r2', 'final', 'final2', 'ratify', 'audit', 'final3', 'reaudit'])
    assert.deepEqual([0, 2, 'b1', 'ratify', 'F', 'H', 'I', 'J'].map(L.phaseOf), ['Solve', 'Round 2', 'Round 1', 'Ratify', 'Synthesize', 'Audit', 'Audit', 'Audit'])
    assert.deepEqual([2, 'b3', 'F'].map(L.roundNum), [2, 3, 99])
  })
  test('crossVendor and its wording', () => {
    const { L, S } = makeRun()
    assert.deepEqual([L.crossVendor(S), L.crossVendorText(S)], [true, 'at least two vendors'])     // three vendors
    S.seats = S.seats.slice(0, 3)
    assert.equal(L.crossVendorText(S), 'both vendors')                                              // two
    S.seats = S.seats.slice(0, 2)                                                                   // both Claude
    assert.equal(L.crossVendor(S), false)
  })
  test('externalVendors: the seats\', the panel\'s, the spec reviewers\' and the auditors\'', () => {
    const { L, S } = makeRun({ args: { seats: ['opus', 'sonnet'], panel: ['opus', 'gemini'] } })
    assert.deepEqual(L.externalVendors(S), ['gemini', 'codex'])
    const spec = makeRun({ args: { seats: ['opus', 'sonnet'], panel: ['opus', 'gemini'], audit: false } })
    assert.deepEqual(spec.L.externalVendors(spec.S), ['gemini', 'codex'], 'the coverage reviewer is Astra')
    const off = makeRun({ args: { seats: ['opus', 'sonnet'], panel: ['opus', 'gemini'], audit: false, spec: false } })
    assert.deepEqual(off.L.externalVendors(off.S), ['gemini'])
  })
  test('postPath', () => {
    const { L, S } = makeRun()
    assert.equal(L.postPath(S, 'A', 'F'), '/r/room/final/A.md')
  })
})

describe('config', () => {
  const lib = loadLib()
  test('no task is an error', () => {
    assert.throws(() => lib.parseConfig({}), /no task given/)
    assert.throws(() => lib.parseConfig('   '), /no task given/)
  })
  test('a string task, with or without a --seats prefix', () => {
    assert.equal(lib.parseConfig('Fix the bug').task, 'Fix the bug')
    const c = lib.parseConfig('--seats opus,sonnet,sol Fix the bug')
    assert.deepEqual([c.task, c.lineup.map(s => s.key)], ['Fix the bug', ['opus', 'sonnet', 'sol']])
  })
  test('the mode is guessed from the wording until given', () => {
    for (const [task, mode] of [['Fix the crash', 'implement'], ['Design a cache for sessions', 'design'], ['Why is the parser slow on empty input?', 'investigate'], ['Do item 3', 'investigate']]) {
      assert.equal(lib.parseConfig(task).mode, mode, task)
    }
    const given = lib.parseConfig({ task: 'Fix the crash', mode: 'design' })
    assert.deepEqual([given.mode, given.modeGiven, lib.parseConfig('Fix it').modeGiven], ['design', true, false])
  })
  test('the number of rounds is 1 to 3, defaulting to 2', () => {
    for (const [r, want] of [[undefined, 2], [0, 2], [1, 1], [3, 3], [9, 3], ['2', 2]]) {
      assert.equal(lib.parseConfig({ task: 't', rounds: r }).rounds, want, String(r))
    }
  })
  test('the lineup: default, count and unknown seats', () => {
    assert.deepEqual(lib.parseConfig('t').lineup.map(s => s.key), ['opus', 'sonnet', 'astra', 'gemini'])
    assert.deepEqual(lib.parseConfig('t').letters, ['A', 'B', 'C', 'D'])
    assert.throws(() => lib.parseConfig({ task: 't', seats: ['opus'] }), /between 2 and 6/)
    assert.throws(() => lib.parseConfig({ task: 't', seats: 'a,b,c,d,e,f,g'.split(',').map(() => 'opus') }), /between 2 and 6/)
    assert.throws(() => lib.parseConfig({ task: 't', seats: 'opus,gpt' }), /unknown seat 'gpt'/)
  })
  test('efforts: per seat, validated per vendor, and mapped onto what Gemini has', () => {
    const c = lib.parseConfig({ task: 't', seats: 'opus,astra,gemini,gemini-pro', effort: { astra: 'ultra', gemini: 'max', 'gemini-pro': 'medium' } })
    assert.deepEqual(c.lineup.map(s => [s.key, s.effort, s.model]), [
      ['opus', 'high', 'opus'], ['astra', 'ultra', 'gpt-6-astra'], ['gemini', 'high', 'gemini-3.8-flash-high'], ['gemini-pro', 'high', 'gemini-3.1-pro-high'],
    ])
    assert.throws(() => lib.parseConfig({ task: 't', effort: 'ultra', seats: 'opus,sonnet' }), /effort 'ultra' is not valid for Claude Opus/)
  })
  test('slug seats are passed through', () => {
    const c = lib.parseConfig({ task: 't', seats: ['opus', 'gemini:gemini-3.6-flash-low', 'codex:gpt-x'] })
    assert.deepEqual(c.lineup.slice(1).map(s => [s.vendor, s.model]), [['gemini', 'gemini-3.6-flash-low'], ['codex', 'gpt-x']])
  })
  test('flags: narrow and retro default on; approval, ballot and allowDirty default off', () => {
    const c = lib.parseConfig('t')
    assert.deepEqual([c.narrow, c.retro, c.approval, c.ballot, c.allowDirty], [true, true, false, false, false])
    const d = lib.parseConfig({ task: 't', narrow: false, retro: false, approval: true, ballot: true, allowDirty: true })
    assert.deepEqual([d.narrow, d.retro, d.approval, d.ballot, d.allowDirty], [false, false, true, true, true])
  })
  test('plan: one path or several, trimmed', () => {
    assert.deepEqual(lib.parseConfig({ task: 't', plan: ' /a.md ' }).plan, ['/a.md'])
    assert.deepEqual(lib.parseConfig({ task: 't', plan: ['/a.md', '', '/b.md'] }).plan, ['/a.md', '/b.md'])
  })
  test('the post word limit follows the mode, and newState starts clean', () => {
    const s = lib.newState(lib.parseConfig({ task: 't', mode: 'design' }))
    assert.deepEqual([s.postWords, s.ledger, s.inContention, s.lastRound, s.run], [2000, [], null, 0, null])
    const t = lib.newState(lib.parseConfig({ task: 't', mode: 'design' }))
    assert.notEqual(s.ledger, t.ledger, 'states do not share arrays')
  })
})

describe('util', () => {
  const lib = loadLib()
  test('idOf takes the first ledger ID out of a decorated string', () => {
    for (const [text, want] of [['1B3', '1B3'], ['[1B3] checked it', '1B3'], ['1B3: the suite passes', '1B3'], ['T0A1', 'T0A1'], ['finding FA2 holds', 'FA2'],
      ['Q2', 'Q2'], ['  1B3  ', '1B3'], ['no id', 'no id'], [null, '']]) {
      assert.equal(lib.idOf(text), want, String(text))
    }
  })
  test('permutation is a seeded permutation', () => {
    for (const n of [2, 4, 6]) assert.deepEqual([...lib.permutation(n, 12345)].sort(), Array.from({ length: n }, (_, i) => i))
    assert.deepEqual(lib.permutation(6, 99), lib.permutation(6, 99))
    assert.notDeepEqual(lib.permutation(6, 1), lib.permutation(6, 2))
  })
  test('the prompt hash ignores trailing whitespace and CRLF', () => {
    assert.equal(lib.promptHash('plain ascii'), '11-69939bb0')
    assert.equal(lib.promptHash('plain ascii  \n\t\n'), lib.promptHash('plain ascii'))
    assert.equal(lib.promptHash('a\r\nb'), lib.promptHash('a\nb'))
  })
  test('strict makes every property required and closes objects, recursively', () => {
    const s = lib.strict({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'integer' } } } } } })
    assert.deepEqual(s.required, ['a', 'b'])
    assert.equal(s.additionalProperties, false)
    assert.deepEqual(s.properties.b.items.required, ['c'])
    assert.equal(s.properties.b.items.additionalProperties, false)
  })
  test('clip, oneLine and plural', () => {
    assert.equal(lib.clip('abcdef', 3), 'abc […]')
    assert.equal(lib.oneLine('a\n  b\t c', 100), 'a b c')
    assert.deepEqual([lib.plural(1, 'claim'), lib.plural(2, 'claim')], ['1 claim', '2 claims'])
    assert.equal(lib.shq("it's"), `'it'\\''s'`)
  })
})

describe('debates in the report', () => {
  test('ordered by severity, then contested, then the chosen position', () => {
    const { L, S } = makeRun()
    const minor = addItem(L, S, { author: 'A', kind: 'finding', target: 'B', severity: 'minor', status: 'verified' })
    const major = addItem(L, S, { author: 'B', kind: 'finding', target: 'C', severity: 'major', status: 'verified' })
    const blocker = addItem(L, S, { author: 'C', kind: 'finding', target: 'D', severity: 'blocker', status: 'verified' })
    const disputed = addItem(L, S, { author: 'D', kind: 'verification', status: 'refuted' })
    S.challenges.push({ round: 1, by: 'A', claim: disputed.id, reason: 'it fails' })
    addItem(L, S, { round: 'F', author: 'A', kind: 'finding', target: 'B', severity: 'blocker' })          // ratification objections are reported elsewhere
    assert.deepEqual(L.debates(S, null).map(d => d.c.id), [blocker.id, disputed.id, major.id, minor.id])
    assert.equal(L.debates(S, 'B')[0].c.id, blocker.id)
    assert.deepEqual(L.debates(S, 'B').slice(2).map(d => d.c.id), [major.id, minor.id])
  })
})

// The prompt and report builders read a lot of state. The golden files pin their bytes for the
// scenarios sim.mjs runs; this runs every builder over a fuller state, in the isolated loader, so a
// builder that reaches for something it was not given (a stray `S`, a runtime call) throws here.
describe('every builder runs on a populated state', () => {
  const populated = (args = {}) => {
    const r = makeRun({ args })
    const { L, S } = r
    S.verify = 'make test'
    S.refs = [{ source: '/plans/p.md', path: '/r/refs/p.md', inWorktrees: false }]
    S.lastRound = 2
    for (const s of S.seats) {
      Object.assign(S.pos[s.L], { stats: { files: 2, added: 600, removed: 5 }, diffPath: `/r/room/r1/${s.L}.diff`, statPath: `/r/room/r1/${s.L}.stat`,
        suite: { ran: true, passed: true, tail: 'OK' }, criteria: [{ criterion: 'C1', status: 'met' }, { criterion: 'C2', status: 'partial' }],
        postWords: 900, snapTag: 'r1', delta: { files: 1, added: 2, removed: 0 }, deltaPath: `/r/room/r2/${s.L}.delta.diff`, deltaRound: 1,
        assessment: { round: 'F', checked: true, measured: true, missingCriteria: [], missingItems: [] } })
      S.behaviour[s.L].turns.push({ round: 1, reviewing: false, changed: true, note: 'moved', adopted: 1, basis: [], conceded: [], challenged: [] })
      S.seatNotes[s.L] = { round: 1, text: 'my notes' }
    }
    addItem(L, S, { id: 'T0A1', round: 0, author: 'A', kind: 'test', status: 'verified' })
    S.testResults.T0A1 = { A: 'pass', B: 'fail' }
    const f = addItem(L, S, { author: 'B', kind: 'finding', target: 'A', severity: 'blocker', status: 'verified', statement: 'breaks on empty input', evidence: 'T0A1' })
    addItem(L, S, { author: 'C', kind: 'finding', target: 'A', severity: 'minor', judgment: true, statement: 'naming' })
    addItem(L, S, { round: 'F', author: 'B', kind: 'finding', target: 'A', severity: 'major', status: 'verified', note: 'upheld' })
    const v = addItem(L, S, { author: 'A', kind: 'verification', status: 'fabricated', statement: 'suite passes' })
    S.challenges.push({ round: 1, by: 'B', claim: v.id, reason: 'it fails', evidence: 'ran it' })
    S.adoptions.push({ round: 1, by: 'B', from: 'A', idea: 'guard clause' })
    S.votes[1] = { A: vote('A'), B: vote('A', { amendments: ['rename'], reason: 'best' }), C: vote('B'), D: vote('A') }
    S.questions.push({ id: 'Q1', text: 'one-way or two-way?', raisedBy: ['A'], seconds: ['B'], assumptions: { A: 'two-way' }, round: 0 })
    S.notes.push('a note'); S.processNotes.push({ turn: 'r1:A', role: 'seat', who: 'Claude', text: 'the digest was cut' })
    S.turnLog.push({ turn: 'r0:A opus', role: 'seat', vendor: 'claude', ok: true }, { turn: 'r0:C astra', role: 'seat', vendor: 'codex', ok: false })
    S.relayFailures.push({ turn: 'C-r0', model: 'haiku', status: 'error', error: 'x', errorClass: 'vendor' })
    S.vendorTimes.push({ turn: 'C-r0', vendor: 'codex', seconds: 42 })
    return { ...r, finding: f }
  }
  const isText = x => typeof x === 'string' && x.length > 50

  for (const [name, args, narrowed] of [['implement', {}, false], ['design, narrowed, with approval', { mode: 'design', approval: true, plan: ['/p.md'], context: 'ctx' }, true]]) {
    test(name, () => {
      const { L, S, finding } = populated(args)
      if (narrowed) { S.inContention = new Set(['A', 'B']); S.dropped.push({ seat: 'C', afterRound: 1, rank: 3, of: 4 }, { seat: 'D', afterRound: 1, rank: 4, of: 4 }) }
      const A = S.seats[0], C = S.seats[2], D = S.seats[3]
      const consensus = { kind: 'consensus', W: 'A', voters: ['A', 'B', 'D'], via: 'votes', round: 1 }
      const scorecard = { kind: 'scorecard', W: 'A', voters: [], round: 2 }
      const checks = Y => L.checkerItems(S, Y, 1, [])
      const texts = [
        L.setupPrompt(S), L.solvePrompt(S, A), L.solvePrompt(S, C),
        L.debatePrompt(S, A, 2), L.debatePrompt(S, C, 2), L.debatePrompt(S, D, 2),
        L.ballotPrompt(S, A, 1), L.ballotPrompt(S, C, 1),
        L.synthPrompt(S, A, consensus, 2), L.synthPrompt(S, A, scorecard, 2), L.synthPrompt(S, C, consensus, 2),
        L.ratifyPrompt(S, S.seats[1], A), L.ratifyPrompt(S, C, A),
        L.fixPrompt(S, A, [finding]), L.fixPrompt(S, C, [finding]),
        L.checkerPrompt(S, 'A', 1, checks('A')), L.checkerPrompt(S, 'B', 'F', []),
        L.panelPrompt(S, 1, [S.byId['1A1']].filter(Boolean).concat(S.ledger.slice(-1))),
        L.clusterPrompt(S, [{ L: 'A', question: 'one-way?', assumption: 'two' }]),
        L.relayPrompt(S, 'codex', '/r/jobs/x.prompt.md', 'council seat-run …', 'C-r0', 'the payload', '11-aaaaaaaa'),
        L.digest(S, 'A', 1), L.positionTable(S), L.seatTable(S), L.finalSummary(S, 'A'),
      ]
      texts.forEach((t, i) => assert.ok(isText(t), `builder #${i} returned ${JSON.stringify(String(t).slice(0, 60))}`))

      const rows = L.rankPositions(S)
      const ready = L.readiness(S, 'A', 'F', S.seats.slice(1), [{}, {}, {}])
      const report = L.finalReport(S, { outcome: consensus, W: A, rows, endorsements: ['B'], raters: S.seats.slice(1), reviewNotes: [{ seat: 'C', endorse: false, note: 'no' }],
        objections: S.ledger.filter(c => c.round === 'F'), fixPass: false, dissent: [{ seat: 'C', kind: 'judgment', note: 'naming' }],
        remaining: [finding], unanswered: S.questions, ready })
      assert.ok(isText(report.markdown) && report.chosen.seat === 'A')
      const other = L.finalReport(S, { outcome: scorecard, W: A, rows, endorsements: [], raters: [], reviewNotes: [], objections: [], fixPass: true, dissent: [], remaining: [], unanswered: [], ready: null })
      assert.match(other.markdown, /No consensus after 2 rounds/)
      assert.ok(isText(L.interimReport(S, 1).markdown))
      const facts = L.retroFacts(S, { outcome: consensus, endorsements: ['B'], fixPass: false, ready })
      const payload = L.retroPayload(S, facts)
      assert.ok(isText(L.retroPrompt(S, report.markdown, payload, L.promptHash(payload))))
      assert.ok(isText(L.retroMarkdown({ worked: [{ what: 'w', evidence: 'e' }], changes: [{ change: 'c', why: 'y', evidence: 'r1:A' }], saved: '/x.md' })))
      assert.ok(isText(L.needsUser(S, 1, S.questions).forTheOrchestrator))
      assert.ok(isText(L.failure(S, 'failed', 'why', {}).forTheOrchestrator))
      assert.ok(isText(L.preflightStop(S, [{ vendor: 'codex', error: 'sandboxed' }]).forTheOrchestrator))
      assert.equal(L.reveal(S).length, 4)
    })
  }
})

describe('the audit', () => {
  const audited = (args = {}) => {
    const r = makeRun({ lineup: 'A:claude B:claude C:codex', args })
    r.S.auditedTag = 'final'
    r.a = lens => r.S.auditors.find(x => x.lens === lens)
    return r
  }
  test('config: on by default, Astra for correctness and Opus for design; swappable; false turns it off', () => {
    const { S } = audited()
    assert.deepEqual(S.auditors.map(a => [a.lens, a.id, a.key, a.vendor, a.effort]), [['correctness', 'XC', 'astra', 'codex', 'high'], ['design', 'XD', 'opus', 'claude', 'high']])
    assert.deepEqual(audited({ audit: { design: 'sonnet', effort: 'xhigh' } }).S.auditors.map(a => [a.key, a.effort]), [['astra', 'xhigh'], ['sonnet', 'xhigh']])
    assert.deepEqual(audited({ audit: false }).S.auditors, [])
    assert.throws(() => audited({ audit: { correctness: 'nobody' } }), /unknown seat 'nobody'/)
  })
  test('IDs: audit findings and tests, and claims from the audit fix pass, are recognised with text attached', () => {
    const { L } = audited()
    assert.deepEqual(['XC1: holds', '[XD12] ok', 'TXC3 fails', 'IA2: suite passes'].map(L.idOf), ['XC1', 'XD12', 'TXC3', 'IA2'])
  })
  test('ingestAudit: findings and tests under the auditor\'s own IDs, against the final version', () => {
    const r = audited(), { L, S } = r
    const review = L.ingestAudit(S, r.a('correctness'), 'H', 'A', {
      summary: 'Crashes.', probes: [{ change: 'x', touches: 'y', verdict: 'easy' }, { change: '' }],
      findings: [{ severity: 'major', kind: 'fact', statement: 'crash', evidence: 'TXC1' }, { severity: 'huge', kind: 'judgment', statement: 'odd', evidence: '' }, { statement: '' }],
      tests: [{ id: 'TXC1', purpose: 'p', command: 'c' }, { id: 'TXD1', purpose: 'p', command: 'c' }, { id: 'TXC1', purpose: 'dup', command: 'c' }],
    })
    assert.deepEqual(review, { summary: 'Crashes.', probes: [{ change: 'x', touches: 'y', verdict: 'easy' }] })
    assert.deepEqual(S.ledger.map(c => [c.id, c.kind, c.author, c.target, c.severity, c.status]),
      [['XC1', 'finding', 'XC', 'A', 'major', 'open'], ['XC2', 'finding', 'XC', 'A', 'minor', 'judgment'], ['TXC1', 'test', 'XC', 'A', null, 'open']])
    assert.equal(S.notes.filter(n => /Ignored test/.test(n)).length, 2, 'another lens\'s ID and a duplicate are refused')
    L.ingestAudit(S, r.a('correctness'), 'J', 'A', { findings: [{ severity: 'minor', kind: 'fact', statement: 'late' }], tests: [{ id: 'TXC2' }] })
    assert.deepEqual(S.ledger.slice(3).map(c => c.id), ['XC3'], 'numbering continues; the re-review publishes no tests')
    assert.match(L.describe(S, S.byId.XC3), /^re-review finding by the correctness auditor against A's fixed final version/)
  })
  test('triage: blocker and major findings to the panel, judgment included; tests to the checker', () => {
    const r = audited(), { L, S } = r
    L.ingestAudit(S, r.a('design'), 'H', 'A', { findings: [
      { severity: 'blocker', kind: 'fact', statement: 'a' }, { severity: 'major', kind: 'judgment', statement: 'b' },
      { severity: 'minor', kind: 'fact', statement: 'c' }, { severity: 'minor', kind: 'judgment', statement: 'd' }], tests: [{ id: 'TXD1', purpose: 'p', command: 'c' }] })
    assert.deepEqual(L.auditTriage(S, 'H'), { panel: ['XD1', 'XD2'], tests: ['TXD1'] })
    const items = L.checkerItems(S, 'A', 'H', ['TXD1'])
    assert.deepEqual(items.map(it => [it.c.id, it.validity, it.test]), [['XD1', true, false], ['XD3', true, false], ['TXD1', false, true]], 'the checker never gets a judgment finding')
  })
  test('the panel on a judgment finding: agreement makes it a fact, a split keeps it a judgment', () => {
    const r = audited(), { L, S } = r
    L.ingestAudit(S, r.a('design'), 'H', 'A', { findings: [{ severity: 'major', kind: 'judgment', statement: 'a' }, { severity: 'major', kind: 'judgment', statement: 'b' }] })
    const ruling = (id, verdict) => ({ rulings: [{ claim: id, verdict, note: '' }] })
    L.applyPanel(S, ['XD1'], [ruling('XD1', 'verified'), ruling('XD1', 'verified')])
    L.applyPanel(S, ['XD2'], [ruling('XD2', 'verified'), ruling('XD2', 'refuted')])
    assert.deepEqual([S.byId.XD1.judgment, S.byId.XD1.status, S.byId.XD2.judgment, S.byId.XD2.status], [false, 'verified', true, 'judgment'])
    assert.ok(L.isStanding(S, S.byId.XD1) && !L.isStanding(S, S.byId.XD2))
  })
  test('the fix list: upheld, disputed and failing earn a fix pass; suggestions alone do not', () => {
    const r = audited(), { L, S } = r
    addItem(L, S, { id: 'XC1', round: 'H', author: 'XC', kind: 'finding', target: 'A', severity: 'major', status: 'verified' })
    addItem(L, S, { id: 'XC2', round: 'H', author: 'XC', kind: 'finding', target: 'A', severity: 'major', status: 'unresolved' })
    addItem(L, S, { id: 'XC3', round: 'H', author: 'XC', kind: 'finding', target: 'A', severity: 'minor', status: 'refuted' })
    const sug = addItem(L, S, { id: 'XD1', round: 'H', author: 'XD', kind: 'finding', target: 'A', severity: 'minor', judgment: true })
    addItem(L, S, { id: 'TXC1', round: 'H', author: 'XC', kind: 'test', target: 'A', status: 'verified' })
    S.testResults.TXC1 = { A: 'fail' }
    const todo = L.auditFixList(S, 'A')
    assert.deepEqual([todo.upheld, todo.disputed, todo.failing, todo.suggestions].map(xs => xs.map(c => c.id)), [['XC1'], ['XC2'], ['TXC1'], ['XD1']])
    assert.equal(todo.needed, true)
    for (const c of S.ledger) if (c !== sug) c.withdrawn = true
    assert.equal(L.auditFixList(S, 'A').needed, false)
  })
  test('readiness: an audit gap leaves the final version incomplete', () => {
    const r = audited(), { L, S } = r
    S.pos.A.assessment = { round: 'H', checked: true, measured: true, missingCriteria: [], missingItems: [] }
    S.pos.A.suite = { ran: true, passed: true }
    S.pos.A.criteria = [{ criterion: 'C1', status: 'met' }, { criterion: 'C2', status: 'met' }]
    const raters = S.seats.filter(s => s.L !== 'A')
    assert.equal(L.readiness(S, 'A', 'H', raters, [{}, {}]).state, 'ready')
    assert.deepEqual(L.readiness(S, 'A', 'H', raters, [{}, {}], ['no review from the design auditor']).incomplete, ['no review from the design auditor'])
  })
  test('who: an auditor is named by its lens and model', () => {
    const { L, S } = audited()
    assert.equal(L.who(S, 'XD'), 'the design auditor (Claude Opus)')
  })
})

describe('the spec review', () => {
  const reviewed = (args = {}) => {
    const r = makeRun({ args: { panel: ['opus', 'astra'], ...args }, criteria: ['C1', 'C2', 'C3'] })
    r.rev = lens => r.S.specReviewers.find(x => x.lens === lens)
    return r
  }
  const finding = (o = {}) => ({ severity: 'major', kind: 'fact', criterion: 'C1', statement: 'misses null', evidence: 'src/a.php:3', change: 'C1: null too', readings: [], ...o })
  test('config: on by default, Astra for coverage and Opus for intent; ask, swaps and false', () => {
    const { S } = reviewed()
    assert.deepEqual(S.specReviewers.map(r => [r.lens, r.key, r.vendor]), [['coverage', 'astra', 'codex'], ['intent', 'opus', 'claude']])
    assert.equal(S.specAsk, false)
    assert.equal(reviewed({ spec: 'ask' }).S.specAsk, true)
    const swapped = reviewed({ spec: { intent: 'sonnet', ask: true, effort: 'medium' } }).S
    assert.deepEqual([swapped.specReviewers.map(r => [r.key, r.effort]), swapped.specAsk], [[['astra', 'medium'], ['sonnet', 'medium']], true])
    assert.deepEqual(reviewed({ spec: false }).S.specReviewers, [])
  })
  test('ingestSpec: S-numbered across reviewers, severity and kind normalised, capped', () => {
    const r = reviewed(), { L, S } = r
    L.ingestSpec(S, r.rev('coverage'), { summary: 'one gap', findings: [finding(), finding({ severity: 'huge', kind: 'other', readings: ['a', '', 7] }), { statement: '' }] })
    L.ingestSpec(S, r.rev('intent'), { summary: 'clean', findings: Array.from({ length: 10 }, () => finding({ kind: 'decision' })) })
    assert.deepEqual(S.spec.findings.slice(0, 3).map(f => [f.id, f.lens, f.severity, f.kind, f.readings]),
      [['S1', 'coverage', 'major', 'fact', []], ['S2', 'coverage', 'minor', 'fact', ['a']], ['S3', 'intent', 'major', 'decision', []]])
    assert.equal(S.spec.findings.length, 10, 'eight per reviewer')
    assert.deepEqual(S.spec.reviews, { coverage: { summary: 'one gap' }, intent: { summary: 'clean' } })
    assert.equal(L.idOf('[S10] ok'), 'S10')
  })
  test('applySpecPanel: amended only on agreement; any decision makes a question; accept against reject is disputed', () => {
    const r = reviewed(), { L, S } = r
    L.ingestSpec(S, r.rev('coverage'), { findings: [finding(), finding(), finding(), finding(), finding()] })
    const one = { rulings: [['S1', 'accept'], ['S2', 'reject'], ['S3', 'decision'], ['S4', 'accept'], ['S5', 'maybe']].map(([finding, verdict]) => ({ finding: `${finding}: x`, verdict, note: 'n1' })) }
    const two = { rulings: [['S1', 'accept'], ['S2', 'reject'], ['S3', 'reject'], ['S4', 'reject']].map(([finding, verdict]) => ({ finding, verdict, note: 'n2' })) }
    L.applySpecPanel(S, [one, two])
    assert.deepEqual(S.spec.findings.map(f => f.status), ['accepted', 'rejected', 'decision', 'disputed', 'unruled'])
    assert.equal(S.spec.findings[0].note, 'adjudicator 1: accept, n1 | adjudicator 2: accept, n2')
    const { todo, open } = L.specTodo(S)
    assert.deepEqual([todo.map(f => f.id), open.map(f => f.id)], [['S1', 'S3'], ['S3']])
    S.clarifications.push({ id: 'S3', answer: 'yes', afterRound: -1 })
    assert.deepEqual(L.specTodo(S).open, [], 'an answered decision is no longer open')
  })
  test('applySpecPanel: a panel that failed leaves every finding unruled, and the criteria as they were', () => {
    const r = reviewed(), { L, S } = r
    L.ingestSpec(S, r.rev('coverage'), { findings: [finding()] })
    L.applySpecPanel(S, [null, null])
    assert.deepEqual([S.spec.findings[0].status, L.specTodo(S).todo], ['unruled', []])
    assert.ok(S.notes.some(n => /adjudication panel failed on the spec review/.test(n)))
  })
  test('applyAmend: criteria replaced, a new verification command brings its baseline, assumptions only for unanswered decisions', () => {
    const r = reviewed(), { L, S } = r
    S.verify = 'make test'
    L.ingestSpec(S, r.rev('coverage'), { findings: [finding(), finding({ kind: 'decision' }), finding({ kind: 'decision' })] })
    L.applySpecPanel(S, [{ rulings: [{ finding: 'S1', verdict: 'accept' }, { finding: 'S2', verdict: 'decision' }, { finding: 'S3', verdict: 'decision' }] }])
    S.clarifications.push({ id: 'S3', answer: 'no', afterRound: -1 })
    const { todo } = L.specTodo(S)
    const ok = L.applyAmend(S, {
      criteria: [{ id: 'C1', text: 'null too' }, { id: 'C4', text: 'new' }, { id: '', text: 'dropped' }], verify: 'make test-all', baselinePasses: false, baselineNote: 'fails  at\nbase',
      applied: [{ finding: 'S1: x', change: 'reworded C1' }, { finding: 'S9', change: 'not ours' }],
      assumptions: [{ finding: 'S2', question: 'q?', chosen: 'keep it', alternative: 'change it', impact: 'more' }, { finding: 'S3', chosen: 'answered anyway' }, { finding: 'S2', chosen: '' }],
    }, todo)
    assert.equal(ok, true)
    assert.deepEqual(S.criteria.map(c => c.id), ['C1', 'C4'])
    assert.deepEqual(S.spec.before.criteria.map(c => c.id), ['C1', 'C2', 'C3'])
    assert.deepEqual([S.verify, S.baselineOk, S.baselineNote], ['make test-all', false, 'fails at base'])
    assert.deepEqual(S.spec.applied, [{ id: 'S1', change: 'reworded C1' }])
    assert.deepEqual(S.spec.assumptions, [{ id: 'S2', question: 'q?', chosen: 'keep it', alternative: 'change it', impact: 'more' }])
    assert.deepEqual(S.spec.answered, ['S3'])
    assert.ok(L.taskBlock(S, 0).includes('# Assumptions about the request') && L.taskBlock(S, 0).includes('- S2: q? Assumed: keep it.'))
    assert.ok(L.taskBlock(S, 0).includes('- S3 ("misses null"): no'), 'an answer is shown with its question')
  })
  test('applyAmend: no criteria back leaves setup\'s, and a missing assumption is noted', () => {
    const r = reviewed(), { L, S } = r
    L.ingestSpec(S, r.rev('intent'), { findings: [finding({ kind: 'decision' })] })
    L.applySpecPanel(S, [{ rulings: [{ finding: 'S1', verdict: 'decision' }] }])
    assert.equal(L.applyAmend(S, { criteria: [] }, L.specTodo(S).todo), false)
    assert.deepEqual([S.criteria.map(c => c.id), S.spec.before], [['C1', 'C2', 'C3'], null])
    L.applyAmend(S, { criteria: [{ id: 'C1', text: 'x' }], verify: '', assumptions: [] }, L.specTodo(S).todo)
    assert.ok(S.notes.includes('The spec amendment recorded no assumption for S1.'))
  })
  test('report: assumptions first, then each finding\'s fate; nothing when it did not run', () => {
    const r = reviewed(), { L, S } = r
    assert.deepEqual([L.assumptionsSection(S), L.specSection(S)], ['', ''])
    S.spec.ran = true
    S.spec.reviews.coverage = { summary: 'fine' }
    assert.equal(L.specSection(S), '\n\n### Specification review\n\n- **Coverage, Codex Astra:** fine\n- **Intent, Claude Opus:** returned no review.\n- **Findings:** none.\n- **Criteria:** as setup wrote them.')
    S.spec.assumptions = [{ id: 'S2', question: 'Retry 5xx?', chosen: 'no', alternative: '', impact: '' }]
    assert.ok(L.assumptionsSection(S).startsWith('### Assumptions to check\n\nThe request left this question open.'))
    assert.ok(L.assumptionsSection(S).includes('- **[S2]** Retry 5xx? Assumed: no.\n'))
  })
})

describe('the factory', () => {
  const lib = loadLib()
  // A Simple run after its round-0 check: one seat, one reviewer, the factory record.
  const simpleState = (args = {}, factory = {}) => {
    const L = loadLib()
    const S = L.newState(L.parseConfig({ task: 'Add a log line', ...args }, { workflow: 'factory', tier: 'simple' }))
    S.run = { runId: 'run-s', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
    S.seats = [{ L: 'A', ...S.lineup[0], wt: '/r/wt/A', active: true }]
    S.criteria = [{ id: 'C1', text: 'logs the count' }]
    S.verify = 'make test'
    S.pos.A = { round: 0, summary: 'logged it', post: '/r/room/r0/A.md', stats: { files: 1, added: 3, removed: 0 }, suite: { ran: true, passed: true, tail: 'OK' },
      criteria: [{ criterion: 'C1', status: 'met' }], delta: null, deltaRound: null, gated: false, gateReasons: [],
      assessment: { round: 0, checked: true, measured: true, missingCriteria: [], missingItems: [] } }
    S.behaviour.A = { turns: [], capitulations: [], ignored: [] }
    S.factory = { tier: 'simple', asked: null, tierConfirmed: false, chosenBy: 'intake', recommended: 'simple', escalation: null,
      intake: { tier: 'simple', mode: 'implement', reasons: 'one line', signals: { kind: 'change', files: 1 } }, ...factory }
    return { L, S }
  }

  test('parseFactory: the tier, the confirmation and the Simple options', () => {
    assert.deepEqual(lib.parseFactory({}), { tier: null, tierConfirmed: false, noSplit: false, simple: { implementer: 'sonnet', reviewer: 'astra', maxLines: 200, maxFiles: 8 } })
    assert.equal(lib.parseFactory({ tier: 'Simple', tierConfirmed: true }).tier, 'simple')
    assert.equal(lib.parseFactory({ tier: 'simple', tierConfirmed: 'yes' }).tierConfirmed, false, 'only true confirms')
    assert.throws(() => lib.parseFactory({ tier: 'huge' }), /unknown tier 'huge'/)
    assert.deepEqual(lib.parseFactory({ simple: { implementer: 'opus', maxLines: '50', maxFiles: -1 } }).simple, { implementer: 'opus', reviewer: 'astra', maxLines: 50, maxFiles: 8 })
  })

  test('a string task may carry --tier and --seats, in either order', () => {
    for (const [s, want] of [
      ['--tier simple Add a log line', { task: 'Add a log line', tier: 'simple' }],
      ['--seats opus,astra --tier fix Fix it', { task: 'Fix it', seats: 'opus,astra', tier: 'fix' }],
      ['--tier=feature --seats=opus,sol Build it', { task: 'Build it', tier: 'feature', seats: 'opus,sol' }],
      ['Fix the --tier flag parser', { task: 'Fix the --tier flag parser' }],
    ]) assert.deepEqual(lib.parseArgs(s), want, s)
  })

  test('parseConfig for the Simple tier: one seat, one reviewer from another vendor, no spec review', () => {
    const c = lib.parseConfig({ task: 't', mode: 'design', seats: 'opus,sonnet' }, { workflow: 'factory', tier: 'simple' })
    assert.deepEqual([c.lineup.map(s => s.key), c.auditors.map(a => [a.lens, a.id, a.key]), c.specReviewers, c.mode, c.modeGiven, c.letters],
      [['sonnet'], [['review', 'XR', 'astra']], [], 'implement', true, ['A']])
    assert.deepEqual([c.workflowName, c.tier, c.simple.maxLines], ['factory', 'simple', 200])
    const other = lib.parseConfig({ task: 't', simple: { implementer: 'opus', reviewer: 'sol' } }, { tier: 'simple' })
    assert.deepEqual([other.lineup[0].key, other.auditors[0].key], ['opus', 'sol'])
    const council = lib.parseConfig({ task: 't', tier: 'simple' })
    assert.deepEqual([council.lineup.length, council.tier, council.workflowName, council.simple], [4, null, 'council', null], '/council ignores tier')
    assert.equal(lib.lensOf('XR'), 'review')
  })

  test('tierArgs: each tier\'s seats and mode, the user\'s own args winning', () => {
    const intake = { mode: 'investigate' }
    assert.deepEqual(lib.tierArgs({ task: 't', tier: 'fix', tierConfirmed: true, noSplit: true, simple: {} }, 'fix', intake), { task: 't', mode: 'investigate', seats: ['opus', 'astra'] })
    assert.deepEqual(lib.tierArgs({ task: 't', seats: 'opus,sol' }, 'fix', intake).seats, 'opus,sol')
    assert.equal(lib.tierArgs({ task: 't', mode: 'implement' }, 'architecture', intake).mode, 'design')
    assert.equal(lib.tierArgs({ task: 't' }, 'simple', intake).mode, 'implement')
    assert.equal(lib.tierArgs({ task: 't' }, 'feature', { mode: 'design' }).mode, 'implement')
    assert.deepEqual(lib.tierArgs({ task: 't', mode: 'investigate' }, 'feature', intake), { task: 't', mode: 'implement', seats: ['opus', 'astra'] }, 'feature builds a change, with two seats')
  })

  test('intakeTier: Simple and Feature are for changes; anything unknown is a feature', () => {
    for (const [i, want] of [[{ tier: 'simple', mode: 'implement' }, 'simple'], [{ tier: 'simple', mode: 'investigate' }, 'fix'],
      [{ tier: 'simple', mode: 'design' }, 'architecture'], [{ tier: 'fix', mode: 'investigate' }, 'fix'], [{ tier: 'huge' }, 'feature'], [null, 'feature'],
      [{ tier: 'feature', mode: 'implement' }, 'feature'], [{ tier: 'feature', mode: 'investigate' }, 'fix'], [{ tier: 'feature', mode: 'design' }, 'architecture']]) {
      assert.equal(lib.intakeTier(i), want, JSON.stringify(i))
    }
  })

  test('tierPushback: only a pin intake would not pick, in either direction, until confirmed', () => {
    const at = (asked, tierConfirmed = false) => ({ factory: { asked, tierConfirmed } })
    assert.equal(lib.tierPushback(at(null), { tier: 'feature' }), null)
    assert.deepEqual(lib.tierPushback(at('simple'), { tier: 'feature', mode: 'implement' }), { asked: 'simple', recommended: 'feature' })
    assert.deepEqual(lib.tierPushback(at('feature'), { tier: 'simple', mode: 'implement' }), { asked: 'feature', recommended: 'simple' })
    assert.equal(lib.tierPushback(at('fix'), { tier: 'fix' }), null)
    assert.equal(lib.tierPushback(at('simple', true), { tier: 'feature' }), null)
  })

  test('simpleTrigger after the solve: the implementer\'s word, then the size budget', () => {
    const { L, S } = simpleState()
    assert.equal(L.simpleTrigger(S, 'solve', {}), null)
    assert.deepEqual(L.simpleTrigger(S, 'solve', { tooBig: { tier: 'fix', reason: 'unclear cause' } }).to, 'fix')
    assert.deepEqual(L.simpleTrigger(S, 'solve', { tooBig: { tier: 'feature', reason: 'needs design' } }).trigger, 'too-big')
    S.pos.A.stats = { files: 2, added: 190, removed: 20 }
    assert.deepEqual([L.simpleTrigger(S, 'solve').trigger, L.simpleTrigger(S, 'solve').to], ['over-budget', 'feature'])
    S.pos.A.stats = { files: 9, added: 10, removed: 0 }
    assert.match(L.simpleTrigger(S, 'solve').why, /9 files/)
    S.pos.A.stats = null
    assert.equal(L.simpleTrigger(S, 'solve'), null, 'unmeasured: no evidence, no escalation')
  })

  test('simpleTrigger after the review: only an agreed blocker or major about the approach', () => {
    const { L, S } = simpleState()
    const add = o => addItem(L, S, { round: 'H', author: 'XR', kind: 'finding', target: 'A', statement: 'x', ...o })
    add({ severity: 'major', status: 'verified' })
    add({ severity: 'minor', status: 'verified', wasJudgment: true })
    add({ severity: 'major', status: 'judgment', judgment: true })
    assert.equal(L.simpleTrigger(S, 'review'), null, 'a fact, a minor and a split judgment go to the fix pass')
    const d = add({ severity: 'major', status: 'verified' })
    d.wasJudgment = true
    const t = L.simpleTrigger(S, 'review')
    assert.deepEqual([t.trigger, t.to, t.findings], ['design-finding', 'feature', [d.id]])
  })

  test('simpleTrigger at the end: a failing suite or a blocked result, never an incomplete one', () => {
    const { L, S } = simpleState()
    assert.equal(L.simpleTrigger(S, 'final', { ready: { state: 'ready', blocked: [], incomplete: [] } }), null)
    assert.equal(L.simpleTrigger(S, 'final', { ready: { state: 'incomplete', blocked: [], incomplete: ['no review'] } }), null)
    assert.deepEqual(L.simpleTrigger(S, 'final', { ready: { state: 'blocked', blocked: ['standing major XR1'], incomplete: [] } }).trigger, 'blocked')
    S.pos.A.suite = { ran: true, passed: false, tail: 'FAIL' }
    assert.deepEqual([L.simpleTrigger(S, 'final', {}).trigger, L.simpleTrigger(S, 'final', {}).to], ['verify-failed', 'fix'])
    S.baselineOk = false
    assert.equal(L.simpleTrigger(S, 'final', {}), null, 'failing already at baseline is not this change\'s doing')
  })

  test('escalationBrief: the evidence, never the earlier change', () => {
    const { L, S } = simpleState()
    addItem(L, S, { round: 'H', author: 'XR', kind: 'finding', target: 'A', severity: 'major', status: 'verified', statement: 'counts from 0', evidence: 'TXR1' })
    addItem(L, S, { id: 'TXR1', round: 'H', author: 'XR', kind: 'test', target: 'A', status: 'verified', statement: 'counts from 1' })
    S.testResults.TXR1 = { A: 'fail' }
    S.pos.A.suite = { ran: true, passed: false, tail: 'expected 2, got 1' }
    const b = L.escalationBrief(S, { trigger: 'verify-failed', to: 'fix', why: 'it still fails' })
    assert.deepEqual([b.from, b.to, b.runDir, b.criteria], ['simple', 'fix', '/r', ['C1: logs the count']])
    assert.ok(b.findings[0].includes('counts from 0') && b.tests[0].startsWith('/r/room/tests/TXR1/') && b.suiteTail === 'expected 2, got 1')
    assert.ok(!JSON.stringify(b).includes('.diff'), 'no diff')
    S.escalation = b
    const block = L.escalationBlock(S)
    assert.ok(block.includes('# An earlier attempt') && block.includes('You are not shown that attempt\'s change') && block.includes('TXR1'))
    assert.ok(L.taskBlock(S, 0).includes('# An earlier attempt'))
  })

  test('retroWanted and runFacts: a clean Simple run only records; anything notable gets the retro', () => {
    const ready = { state: 'ready', blocked: [], incomplete: [] }
    const want = (args, factory, o = { ready }) => { const { L, S } = simpleState(args, factory); return L.retroWanted(S, o) }
    assert.equal(want({}, {}), false)
    assert.equal(want({ retro: true }, {}), true)
    assert.equal(want({ retro: false }, { chosenBy: 'overruled' }), false)
    assert.equal(want({}, { chosenBy: 'overruled' }), true)
    assert.equal(want({}, { escalation: { to: 'fix' } }), true)
    assert.equal(want({}, { tier: 'fix' }), true)
    assert.equal(want({}, { split: { pieces: 3, declined: true } }), true, 'a split the user declined is worth a look')
    assert.equal(want({}, {}, { ready: { state: 'incomplete', blocked: [], incomplete: ['x'] } }), true)
    const { L, S } = simpleState()
    S.turnLog.push({ turn: 'intake', role: 'intake', vendor: 'claude', ok: true }, { turn: 'audit review', role: 'auditor', vendor: 'codex', ok: true })
    const f = L.runFacts(S, { ready })
    assert.deepEqual([f.workflow, f.tier, f.chosenBy, f.escalation, f.readiness, f.turns, f.overTierHints],
      ['factory', 'simple', 'intake', null, 'ready', { claude: 1, byRole: { intake: 1 }, external: 1 }, []])
    const payload = L.retroPayload(S, 'facts', f)
    assert.ok(payload.includes('## Run facts (data)\n\n```json\n{') && JSON.parse(payload.split('```json\n')[1].split('\n```')[0]).tier === 'simple')
  })

  test('splitItems: two or more pieces, each building only on earlier ones; needsSplit asks once', () => {
    const intake = { status: 'needs-split', tier: 'feature', mode: 'implement', reasons: 'three causes', split: [
      { title: 'One', task: 'Fix one.', tier: 'simple', after: [1] },
      { title: '', task: ' Fix two. ', tier: 'fix', after: [1, 1, 3, 1.5] },
      { title: 'Empty', task: '  ', tier: 'fix', after: [] },
    ] }
    assert.deepEqual(lib.splitItems(intake), [
      { n: 1, title: 'One', task: 'Fix one.', tier: 'simple', after: [] },
      { n: 2, title: 'Piece 2', task: 'Fix two.', tier: 'fix', after: [1] },
    ])
    assert.deepEqual(lib.splitItems({ ...intake, split: intake.split.slice(0, 1) }), [], 'one piece is not a split')
    assert.deepEqual(lib.splitItems({ ...intake, status: 'ok' }), [], 'only a needs-split answer splits')
    const { L, S } = simpleState()
    S.factory.asked = null
    const res = L.needsSplit(S, L.splitItems(intake), intake)
    assert.deepEqual([res.status, res.tier, res.items.length], ['needs-split', 'feature', 2])
    assert.ok(res.forTheOrchestrator.includes('the whole task as one feature run') && !res.forTheOrchestrator.includes('pinned'))
    S.factory.split = { pieces: 2, declined: true }
    assert.deepEqual(L.runFacts(S, {}).split, { pieces: 2, declined: true })
    assert.ok(L.factoryFacts(S).includes('Intake proposed 2 separate runs for this task; the user ran it as one.'))
  })

  test('overTierHints: a fix run whose seats agreed blind, or a clean audit on a small change', () => {
    const { L, S } = makeRun()
    S.factory = { tier: 'fix' }
    const W = S.seats[0]
    S.pos.A.stats = { files: 1, added: 10, removed: 2 }
    assert.deepEqual(L.overTierHints(S, { outcome: { via: 'blind' }, W, audit: { ran: true, fixPass: false } }),
      ['every seat wrote the same change in round 0', 'a clean audit on a 12-line change'])
    S.factory.tier = 'simple'
    assert.deepEqual(L.overTierHints(S, { outcome: { via: 'blind' }, W }), [])
  })

  test('the factory\'s builders run, and the intake never sees a pinned tier', () => {
    const { L, S } = simpleState({ tier: 'simple', tierConfirmed: true, plan: ['/p.md'], context: 'ctx' })
    const isText = x => typeof x === 'string' && x.length > 50
    const intake = L.intakePrompt(S)
    assert.ok(isText(intake) && !/tierConfirmed|"simple" tier was|pinned/.test(intake) && intake.includes('- /p.md'))
    const W = S.seats[0]
    const audit = { ran: true, checked: false, reviews: { review: { summary: 'fine', probes: [] } }, fixPass: false, gaps: [] }
    const ready = L.readiness(S, 'A', 0, [], [])
    const report = L.simpleReport(S, { W, ready, audit })
    assert.ok(report.markdown.includes('### Simple change, by Claude Sonnet') && report.markdown.includes('### Review') && report.markdown.includes('Codex Astra, read the change'))
    S.auditedTag = 'r0'
    const res = L.simpleResult(S, { W, ready, audit, report, retro: null })
    assert.deepEqual([res.status, res.final.diff, res.factory.chosenBy], ['done', '/r/room/r0/A.diff', 'intake'])
    for (const t of [L.simpleSolvePrompt(S, W), L.setupPrompt(S), L.recordPrompt(S, 'payload', '7-aaaaaaaa'),
      L.needsTier(S, { asked: 'simple', recommended: 'feature' }, { reasons: 'API change' }).forTheOrchestrator,
      L.needsPlan(S, 'the plan', null).forTheOrchestrator, L.auditPrompt(S, S.auditors[0], W, 'H'), res.forTheOrchestrator]) assert.ok(isText(t))
    assert.ok(L.setupPrompt(S).includes('Write 1 to 3 acceptance criteria') && L.needsPlan(S, 'x').forTheOrchestrator.includes('name: "factory"'))
    const fix = L.auditFixPrompt(S, W, { upheld: [], disputed: [], failing: [], suggestions: [], suite: 'FAIL x', needed: true })
    assert.ok(fix.startsWith('# How this works') && fix.includes('# Fix pass') && fix.includes('The verification command fails on your version'))
    S.factory.escalation = { from: 'simple', to: 'fix', trigger: 'verify-failed', why: 'it fails', runDir: '/r' }
    const up = L.escalatedResult(S, { status: 'converged', report: { markdown: 'the council' }, forTheOrchestrator: 'present it' })
    assert.ok(up.escalated && up.report.markdown.startsWith('### Escalated from Simple') && up.forTheOrchestrator.endsWith('present it'))
    assert.ok(L.factoryFacts(S).includes('started simple, escalated to fix (verify-failed: it fails)'))
    S.factory = { tier: 'fix', chosenBy: 'pinned', recommended: 'fix' }
    assert.ok(L.routedResult(S, { status: 'converged', forTheOrchestrator: 'x' }).forTheOrchestrator.startsWith('The factory ran this at the fix tier'))
  })
})

describe('the Feature tier', () => {
  // A Feature run whose plan A won and was built in two increments, each checked.
  const featureState = () => {
    const L = loadLib()
    const S = L.newState(L.parseConfig({ task: 'Add a retry budget', mode: 'implement', seats: ['opus', 'astra'] }, { workflow: 'factory', tier: 'feature' }))
    S.run = { runId: 'run-f', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
    S.seats = [{ L: 'A', ...S.lineup[0], wt: '/r/wt/A', active: true }, { L: 'B', ...S.lineup[1], wt: '/r/wt/B', active: true }]
    S.criteria = [{ id: 'C1', text: 'the budget stops retries' }]
    S.verify = 'make test'
    for (const L1 of ['A', 'B']) {
      S.pos[L1] = { round: 1, summary: `plan ${L1}`, opening: `plan ${L1}`, post: `/r/room/r1/${L1}.md`, stats: null, delta: null, deltaRound: null, suite: null,
        criteria: [{ criterion: 'C1', status: 'met' }], gated: false, gateReasons: [] }
      S.behaviour[L1] = { turns: [], capitulations: [], ignored: [] }
    }
    S.votes[1] = { A: { ship: 'A', amendments: [], reason: 'clearer' }, B: { ship: 'A', amendments: [], reason: 'fine' } }
    S.lastRound = 1
    S.factory = { tier: 'feature', asked: null, chosenBy: 'intake', recommended: 'feature', escalation: null, intake: { tier: 'feature', mode: 'implement', reasons: 'new behaviour' } }
    S.build = { plan: '/r/room/final/A.md', ...L.planIncrements([{ title: 'Config', delivers: 'the budget in the config' }, { title: 'Enforce', delivers: 'retry stops at it' }]) }
    S.pos.A = { ...S.pos.A, post: '/r/room/inc2/A.md', stats: { files: 2, added: 40, removed: 3 }, suite: { ran: true, passed: true, tail: 'OK' }, snapTag: 'inc2',
      assessment: { round: 'K2', checked: true, measured: true, missingCriteria: [], missingItems: [] } }
    S.build.increments.forEach(x => Object.assign(x, { reported: true, summary: `did ${x.title}`, check: { suite: { ran: true, passed: true, tail: 'OK' }, stats: { files: 1, added: 20, removed: 1 } } }))
    S.mode = 'implement'
    return { L, S }
  }

  test('planIncrements: the plan\'s list, one turn each; one turn when there is none', () => {
    const L = loadLib()
    const two = L.planIncrements([{ title: 'One', delivers: 'a' }, { title: '', delivers: 'b only' }, null, { title: ' ', delivers: '' }])
    assert.deepEqual([two.listed, two.increments.map(x => [x.n, x.title, x.delivers, x.reported])], [2, [[1, 'One', 'a', false], [2, 'b only', 'b only', false]]])
    const six = L.planIncrements([1, 2, 3, 4, 5, 6].map(n => ({ title: `S${n}`, delivers: `d${n}` })))
    assert.deepEqual([six.listed, six.increments.length, L.FEATURE_INCREMENTS], [6, 6, 4])
    assert.deepEqual(L.planIncrements(undefined), { listed: 0, increments: [{ n: 1, title: 'The whole plan', delivers: 'Everything in the final plan.', reported: false, summary: '', deviations: [], check: null }] })
  })

  test('featureTrigger: a plan of more than four increments goes to architecture before the build', () => {
    const { L, S } = featureState()
    assert.equal(L.featureTrigger(S, 'A'), null)
    S.build = { plan: '/r/room/final/A.md', ...L.planIncrements([1, 2, 3, 4].map(n => ({ title: `S${n}`, delivers: `d${n}` }))) }
    assert.equal(L.featureTrigger(S, 'A'), null, 'four is one build')
    S.build = { plan: '/r/room/final/A.md', ...L.planIncrements([1, 2, 3, 4, 5].map(n => ({ title: `S${n}`, delivers: `d${n}` }))) }
    assert.deepEqual(L.featureTrigger(S, 'A'), { trigger: 'too-many-increments', to: 'architecture', L: 'A', why: 'the chosen plan lists 5 increments, more than one feature build makes (4)' })
  })

  test('config: Opus and Astra, three auditors with the tests lens on Sonnet; audit swaps and false', () => {
    const L = loadLib()
    const c = L.parseConfig(L.tierArgs({ task: 't' }, 'feature', { mode: 'implement' }), { workflow: 'factory', tier: 'feature' })
    assert.deepEqual([c.lineup.map(s => s.key), c.auditors.map(a => [a.lens, a.id, a.key]), c.specReviewers.length],
      [['opus', 'astra'], [['correctness', 'XC', 'astra'], ['design', 'XD', 'opus'], ['tests', 'XT', 'sonnet']], 2])
    assert.equal(L.parseConfig({ task: 't', audit: { tests: 'haiku' } }, { tier: 'feature' }).auditors[2].key, 'haiku')
    assert.deepEqual(L.parseConfig({ task: 't', audit: false }, { tier: 'feature' }).auditors, [])
    assert.deepEqual(L.parseConfig({ task: 't' }).auditors.map(a => a.lens), ['correctness', 'design'], 'the council keeps two lenses')
    assert.equal(L.lensOf('XT'), 'tests')
  })

  test('rounds K1, K2: snapshot tags, phase, IDs and wording', () => {
    const L = loadLib()
    assert.deepEqual([L.roundTag('K1'), L.roundTag('K12'), L.phaseOf('K2'), L.atRound('K3'), L.buildStep('K4'), L.buildStep('F'), L.buildStep(2)],
      ['inc1', 'inc12', 'Build', 'in build increment 3', 4, null, null])
    assert.deepEqual(['K2A1: suite passes', '[XT3] gap', 'TXT1'].map(L.idOf), ['K2A1', 'XT3', 'TXT1'])
    const { S } = featureState()
    assert.equal(L.describe(S, L.addClaim(S, { round: 'K2', author: 'A', kind: 'verification', target: 'A', statement: 's' })), 'verification claim by A about its build increment 2 version')
    assert.deepEqual([L.sinceTag(S, 'K1'), L.sinceTag(S, 'K2')], [null, 'inc1'])
  })

  test('the fix list mends a failing suite after the build, as in Simple, but not in the council', () => {
    const { L, S } = featureState()
    S.pos.A.suite = { ran: true, passed: false, tail: 'FAIL x' }
    assert.equal(L.auditFixList(S, 'A').suite, 'FAIL x')
    S.tier = null
    assert.equal(L.auditFixList(S, 'A').suite, '')
  })

  test('report, facts and result: the plan, the build and the audit; no ratification', () => {
    const { L, S } = featureState()
    S.auditedTag = 'inc2'
    S.build.increments[1].deviations = ['kept the signature']
    S.adoptions.push({ round: 'F', by: 'A', from: 'B', idea: 'config-driven' })
    const W = S.seats[0], outcome = { kind: 'consensus', W: 'A', voters: ['A', 'B'], via: 'votes', round: 1 }
    const rows = L.rankPositions(S)
    const audit = { ran: true, checked: false, reviews: { correctness: { summary: 'ok', probes: [] }, design: { summary: 'ok', probes: [] }, tests: { summary: 'ok', probes: [] } }, fixPass: false, gaps: [], addressed: [], rereviews: {} }
    const ready = L.readiness(S, 'A', 'K2', [], [])
    const report = L.featureReport(S, { outcome, W, rows, ready, audit })
    const md = report.markdown
    assert.equal(ready.state, 'ready')
    assert.ok(md.startsWith('### Plan chosen: A (Claude Opus)') && md.includes('### The build') && md.includes('- **Merged from the other plans:** B (Codex Astra): config-driven') &&
      md.includes('- **Increment 2, Enforce:** did Enforce. Check: suite PASS, 1 file +20/−1 so far. Departed from the plan: kept the signature.') &&
      md.includes('correctness (Codex Astra), design (Claude Opus) and tests (Claude Sonnet)') && !md.includes('Ratification') && !md.includes('published tests'), md)
    const facts = L.retroFacts(S, { outcome, W, endorsements: [], ready, audit })
    assert.ok(facts.includes('- Plan: consensus on A in round 1, with up to 2 rounds allowed. No ratification') && facts.includes('- Build: 2 increments by A: inc1 suite PASS; inc2 suite PASS, 1 deviation.'), facts)
    const res = L.featureResult(S, { outcome, W, rows, table: L.positionTable(S), ready, audit, report, retro: null })
    assert.deepEqual([res.status, res.tier, res.final.diff, res.final.snapshotRef, res.plan.post, res.build.length, res.audit.auditors.length],
      ['done', 'feature', '/r/room/inc2/A.diff', 'refs/council/run-f/A-inc2', '/r/room/final/A.md', 2, 3])
    assert.ok(res.forTheOrchestrator.includes('built it in 2 increments') && res.forTheOrchestrator.includes('(correctness, design and tests)') && !res.forTheOrchestrator.includes('feature tier ('))
    assert.ok(L.routedResult(S, res).forTheOrchestrator.startsWith('The factory ran this at the feature tier (intake\'s choice)'))
  })

  test('prompts: plan mode for the debate, implement mode for the build, the build intro for the fix pass', () => {
    const { L, S } = featureState()
    const [A, B] = S.seats
    S.mode = 'plan'
    const plan = L.solvePrompt(S, A)
    assert.ok(plan.includes('This council plans before it builds') && plan.includes('Write the plan for building this, not the code') && plan.includes('This is the planning stage'))
    assert.ok(!plan.includes('re-runs the verification command'), 'nothing measures a plan')
    S.mode = 'implement'
    const b1 = L.buildPrompt(S, A, 'K1'), b2ext = L.buildPrompt(S, B, 'K2')
    assert.ok(b1.startsWith('# How the build works') && b1.includes('# Build increment 1 of 2: Config') && b1.includes('Build only this increment'))
    assert.ok(b2ext.startsWith('The council continues.') && !b2ext.includes('# How the build works') && b2ext.includes('This is the last turn of the build'))
    const fix = L.auditFixPrompt(S, A, { upheld: [], disputed: [], failing: [], suggestions: [], suite: 'FAIL x', needed: true })
    assert.ok(fix.startsWith('# How the build works') && fix.includes('each through one lens: correctness, design and tests'))
  })
})

describe('the Architecture tier', () => {
  // An Architecture run whose design A won, with two milestones.
  const archState = () => {
    const L = loadLib()
    const S = L.newState(L.parseConfig(L.tierArgs({ task: 'Make the sync resumable' }, 'architecture', { mode: 'implement' }), { workflow: 'factory', tier: 'architecture' }))
    S.run = { runId: 'run-a', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
    S.seats = S.lineup.map((s, i) => ({ L: 'ABC'[i], ...s, wt: `/r/wt/${'ABC'[i]}`, active: true }))
    S.criteria = [{ id: 'C1', text: 'an interrupted sync resumes' }]
    for (const s of S.seats) {
      S.pos[s.L] = { round: 1, summary: `design ${s.L}`, opening: `design ${s.L}`, post: `/r/room/r1/${s.L}.md`, stats: null, delta: null, deltaRound: null, suite: null,
        criteria: [{ criterion: 'C1', status: 'met' }], gated: false, gateReasons: [] }
      S.behaviour[s.L] = { turns: [], capitulations: [], ignored: [] }
    }
    S.pos.A = { ...S.pos.A, post: '/r/room/final/A.md', assessment: { round: 'F', checked: true, measured: false, missingCriteria: [], missingItems: [] } }
    S.votes[1] = { A: { ship: 'A', amendments: [], reason: 'clear' }, B: { ship: 'A', amendments: [], reason: 'fine' }, C: { ship: 'A', amendments: [], reason: 'ok' } }
    S.lastRound = 1
    S.factory = { tier: 'architecture', asked: null, chosenBy: 'intake', recommended: 'architecture', escalation: null, intake: { tier: 'architecture', mode: 'implement', reasons: 'too big' } }
    S.milestones = L.planMilestones([
      { title: 'Store', task: 'Add a cursor store.', criteria: ['round-trips a cursor'], after: [], tier: 'simple', working: 'cursors are saved' },
      { title: 'Resume', task: 'Resume from the cursor.', criteria: [], after: [1], tier: 'feature', working: '' },
    ])
    S.auditedTag = 'final'
    return { L, S }
  }

  test('config: Opus, Astra and Sonnet; the plan\'s reviewers on Astra, Opus and Gemini; risk swaps', () => {
    const L = loadLib()
    const c = L.parseConfig(L.tierArgs({ task: 't' }, 'architecture', { mode: 'implement' }), { workflow: 'factory', tier: 'architecture' })
    assert.deepEqual([c.mode, c.lineup.map(s => s.key), c.auditors.map(a => [a.lens, a.id, a.key]), c.specReviewers.length],
      ['design', ['opus', 'astra', 'sonnet'], [['grounding', 'XG', 'astra'], ['sequencing', 'XS', 'opus'], ['risk', 'XK', 'gemini']], 2])
    assert.equal(L.parseConfig({ task: 't', audit: { risk: 'sonnet' } }, { tier: 'architecture' }).auditors[2].key, 'sonnet')
    assert.deepEqual(L.parseConfig(L.tierArgs({ task: 't', seats: ['opus', 'sol'] }, 'architecture', null)).lineup.map(s => s.key), ['opus', 'sol'], 'the user\'s seats win')
    assert.deepEqual(['XG', 'XS', 'XK'].map(L.lensOf), ['grounding', 'sequencing', 'risk'])
    assert.deepEqual(['XG2: no hook', '[XS1] order', 'XK3'].map(L.idOf), ['XG2', 'XS1', 'XK3'])
  })

  test('planMilestones: a task each, earlier-only dependencies, simple or feature, at most eight', () => {
    const L = loadLib()
    const ms = L.planMilestones([{ title: '', task: 'one', criteria: ['a', '', 'b'], after: [1, 0], tier: 'simple', working: 'w' }, null, { title: 'x', task: ' ' },
      { title: 'Two', task: 'two', criteria: 'not a list', after: [1, 1, 2, 5, 'x'], tier: 'architecture' }])
    assert.deepEqual(ms, [
      { n: 1, title: 'Milestone 1', task: 'one', criteria: ['a', 'b'], after: [], tier: 'simple', working: 'w' },
      { n: 2, title: 'Two', task: 'two', criteria: [], after: [1], tier: 'feature', working: '' },
    ])
    assert.equal(L.planMilestones(Array.from({ length: 11 }, (_, i) => ({ task: `t${i}` }))).length, L.MAX_MILESTONES)
    assert.deepEqual(L.planMilestones(undefined), [])
  })

  test('report, facts and result: the milestones, with args for their own runs and the findings still open on each', () => {
    const { L, S } = archState()
    const W = S.seats[0]
    const c = L.addClaim(S, { id: 'XS1', round: 'H', author: 'XS', kind: 'finding', target: 'A', severity: 'minor', statement: 'Resume needs the store\'s read path', evidence: 'final/A.md' })
    Object.assign(c, { status: 'verified', milestone: 2 })
    const outcome = { kind: 'consensus', W: 'A', voters: ['A', 'B', 'C'], via: 'votes', round: 1 }
    const rows = L.rankPositions(S)
    const audit = { ran: true, checked: true, reviews: { grounding: { summary: 'ok', probes: [] }, sequencing: { summary: 'one gap', probes: [] }, risk: { summary: 'ok', probes: [] } }, fixPass: false, gaps: [], addressed: [], rereviews: {} }
    const ready = L.readiness(S, 'A', 'F', [], [])
    const report = L.architectureReport(S, { outcome, W, rows, ready, audit })
    const md = report.markdown
    assert.ok(md.startsWith('### Design chosen: A (Claude Opus)') && md.includes('- **2 milestones**, each to be built by a factory run of its own:') &&
      md.includes('  1. **Store** (simple): Add a cursor store. Once it lands: cursors are saved. Draft criteria: round-trips a cursor.') &&
      md.includes('  2. **Resume** (feature, after 1): Resume from the cursor. Draft criteria: none. Still open: [XS1] Resume needs the store\'s read path.') &&
      md.includes('- **Nothing was built:**') && md.includes('### Independent review') && md.includes('[XS1] minor, milestone 2') && md.includes('- **Revision:** not needed'), md)
    const facts = L.retroFacts(S, { outcome, W, endorsements: [], ready, audit })
    assert.ok(facts.includes('- Design: consensus on A in round 1, with up to 2 rounds allowed. No ratification: the review checks the milestone plan.') && facts.includes('- Milestones: 2 (simple 1, feature 1) by A.'), facts)
    assert.equal(L.runFacts(S, { outcome, W, ready, audit }).milestones, 2)
    const res = L.architectureResult(S, { outcome, W, rows, table: L.positionTable(S), ready, audit, report, retro: null })
    assert.deepEqual([res.status, res.tier, res.design.post, res.milestones.length, res.final.standingFindings.map(f => [f.id, f.milestone])], ['done', 'architecture', '/r/room/final/A.md', 2, [['XS1', 2]]])
    const [m1, m2] = res.milestones
    assert.deepEqual([m1.args.tier, m1.args.tierConfirmed, m1.args.noSplit, m1.args.plan, m1.findings, m2.findings.map(f => f.id)], ['simple', true, true, ['/r/room/final/A.md'], [], ['XS1']])
    assert.equal(m2.args.task, 'Resume from the cursor.\n\nThis is milestone 2 of 2 of a larger piece of work: Make the sync resumable\n' +
      'Its design is the reference document /r/room/final/A.md. Build this milestone only; it builds on milestone 1, already done.\n\n' +
      'Findings from the review of the plan that still stand against this milestone:\n- Resume needs the store\'s read path')
    assert.ok(m1.args.task.includes('Once it lands: cursors are saved.') && m1.args.task.includes('Draft acceptance criteria from the plan, to check against the code as it now is:\n- round-trips a cursor'))
    assert.ok(res.forTheOrchestrator.includes('nothing in the repository changed') && res.forTheOrchestrator.includes('milestones[i].args') && !res.forTheOrchestrator.includes('commit message'))
    S.factory.intake.mode = 'design'
    assert.ok(!L.architectureResult(S, { outcome, W, rows, table: '', ready, audit, report, retro: null }).forTheOrchestrator.includes('nothing in the repository changed'), 'a design asked for is no surprise')
  })

  test('prompts: design mode with milestones for the tier, unchanged for the council; the review reads, the revision returns milestones', () => {
    const { L, S } = archState()
    const A = S.seats[0]
    const solve = L.solvePrompt(S, A)
    assert.ok(solve.includes('This council designs work too big to build in one go') && solve.includes('The milestones, in order, at most 8') && !solve.includes('re-runs the verification command'))
    const council = makeRun({ args: { mode: 'design' } })
    const plain = council.L.solvePrompt(council.S, council.S.seats[0])
    assert.ok(plain.includes('Produce a complete design: the problem and constraints') && !plain.includes('milestones') && plain.includes('re-runs the verification command'), 'the council\'s design mode as it was')
    const g = L.auditPrompt(S, S.auditors[0], A, 'H'), r = L.auditPrompt(S, S.auditors[2], A, 'H')
    assert.ok(g.includes('# Your lens: grounding') && g.includes('/r/room/final/A.md') && !g.includes('did not choose') && !g.includes('materialize'))
    assert.ok(r.includes('/r/room/r1/B.md, /r/room/r1/C.md') && r.includes('say in your summary what you couldn\'t check'), 'risk reads the other designs; Gemini is told about its sandbox')
    assert.ok(L.auditPrompt(S, S.auditors[0], A, 'J').startsWith('The review continues. You are still the grounding reviewer') && L.auditPrompt(S, S.auditors[1], A, 'J').includes('# Re-review: the revision'))
    const fix = L.auditFixPrompt(S, A, { upheld: [], disputed: [], failing: [], suggestions: [], suite: '', needed: true })
    assert.ok(fix.includes('# Revision pass') && fix.includes('each through one lens: grounding, sequencing and risk') && fix.includes('`milestones`') && !fix.includes('re-run the verification command'))
    assert.match(L.describe(S, L.addClaim(S, { round: 'J', author: 'XG', kind: 'finding', target: 'A', severity: 'major', statement: 's' })), /^re-review finding by the grounding reviewer against A's revised milestone plan/)
  })

  test('preflight: the factory names the auditors that use the failing vendor; the council\'s advice is unchanged', () => {
    const { L, S } = archState()
    const fo = L.preflightStop(S, [{ vendor: 'gemini', ok: false, error: 'agy not found' }]).forTheOrchestrator
    assert.ok(fo.includes('and the auditor(s) risk (args.audit, e.g. {risk: "sonnet"})'), fo)
    const council = makeRun()
    assert.ok(!council.L.preflightStop(council.S, [{ vendor: 'codex', ok: false, error: 'x' }]).forTheOrchestrator.includes('auditor(s)'))
  })

  test('escalation chain: Simple, then Feature, then Architecture, reported and tallied from where it started', () => {
    const { L, S } = archState()
    const fromSimple = { from: 'simple', to: 'feature', trigger: 'over-budget', why: 'the change is 400 lines', runDir: '/r1', earlier: null }
    S.factory.escalation = { from: 'feature', to: 'architecture', trigger: 'too-many-increments', why: 'the chosen plan lists 6 increments', runDir: '/r2', earlier: fromSimple }
    assert.deepEqual(L.escalationChain(S.factory.escalation).map(e => e.from), ['simple', 'feature'])
    assert.deepEqual(L.runFacts(S, {}).escalation, { from: 'simple', to: 'architecture', trigger: 'too-many-increments',
      steps: [{ from: 'simple', to: 'feature', trigger: 'over-budget' }, { from: 'feature', to: 'architecture', trigger: 'too-many-increments' }] })
    const facts = L.factoryFacts(S)
    assert.ok(facts.includes('- Factory tier: started simple, escalated to feature (over-budget: the change is 400 lines), then escalated to architecture (too-many-increments: the chosen plan lists 6 increments)') &&
      facts.includes('- The Simple attempt: /r1.') && facts.includes('- The Feature attempt: /r2.'), facts)
    const res = L.escalatedResult(S, { status: 'done', report: { markdown: 'body' }, forTheOrchestrator: 'rest' })
    assert.ok(res.report.markdown.startsWith('### Escalated from Simple') && res.report.markdown.includes('### Escalated from Feature') && res.report.markdown.endsWith('body'))
    assert.ok(res.forTheOrchestrator.startsWith('This run started as a simple change and the factory handed it to the feature tier because the change is 400 lines, then to the architecture tier because'))
    assert.deepEqual([res.factory.startedAt, res.factory.escalation.from, res.factory.escalation.earlier.map(e => e.to)], ['simple', 'feature', ['feature']])
    assert.equal(L.escalatedResult(S, res), res, 'wrapped once')
    assert.equal(L.routedResult(S, res), res, 'a handed-up result already says how it got there')
    const single = L.escalationFacts({ from: 'simple', to: 'fix', trigger: 'verify-failed', earlier: null })
    assert.deepEqual(single, { from: 'simple', to: 'fix', trigger: 'verify-failed' }, 'one hand-up records as before')
  })
})
