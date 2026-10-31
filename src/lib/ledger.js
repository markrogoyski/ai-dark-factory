// The council's decisions, all computed by code from the ledger: ingesting what seats return,
// applying neutral rulings, the gate, tallies and consensus, narrowing the field, the ranking and
// the scorecards, and the final readiness. Pure functions of the state.

function finalSummary(S, L) {
  const p = S.pos[L]
  const bits = []
  if (S.mode === 'implement') {
    bits.push(!p.suite ? 'suite not measured' : !p.suite.ran ? 'no suite' : p.suite.passed ? 'suite PASS' : 'suite FAIL')
    const cx = crossFor(S, L)
    if (!S.build || cx.total) bits.push(`published tests ${cx.pass}/${cx.total}`)
  }
  bits.push(`criteria ${critSummary(S, p.criteria)}`)
  const standing = S.ledger.filter(c => isStanding(S, c) && c.target === L)
  bits.push(standing.length ? `still-standing findings: ${standing.map(c => c.id).join(', ')}` : 'no standing findings')
  return bits.join(' · ')
}

// Whether the final version is ready to use, separate from how it was chosen: agreement says the
// seats preferred it, readiness says what the evidence on the final version shows. Reported, never
// used to pick: blocked means known problems, incomplete means evidence that should exist doesn't.
function readiness(S, L, finalRound, raters, reviews, gaps = []) {
  const p = S.pos[L], a = p.assessment
  const blocked = [], incomplete = []
  const checked = a && a.round === finalRound && a.checked
  if (!checked) incomplete.push('the final version was never checked')
  else {
    if (S.mode === 'implement' && S.verify && !a.measured) incomplete.push('the verification command did not run on the final version')
    if (a.missingCriteria.length) incomplete.push(`criteria not judged: ${a.missingCriteria.join(', ')}`)
    if (a.missingItems.length) incomplete.push(`no ruling on ${a.missingItems.join(', ')}`)
  }
  if (checked && S.mode === 'implement' && a.measured && p.suite && !p.suite.passed) {
    if (S.baselineOk) blocked.push('the verification command fails on the final version')
    else incomplete.push('the verification command fails, as it already did at baseline')
  }
  if (checked) {
    const unmet = (p.criteria || []).filter(c => c.status === 'unmet').map(c => c.criterion)
    if (unmet.length) blocked.push(`criteria unmet: ${unmet.join(', ')}`)
  }
  const fab = S.ledger.filter(c => c.author === L && c.round === finalRound && c.kind === 'verification' && c.status === 'fabricated')
  if (fab.length) blocked.push(`fabricated verification claim ${fab.map(c => c.id).join(', ')}`)
  if (S.mode === 'implement') {
    const failing = validTests(S).filter(t => S.testResults[t.id] && S.testResults[t.id][L] && S.testResults[t.id][L] !== 'pass')
    if (failing.length) blocked.push(`published tests not passing: ${failing.map(t => t.id).join(', ')}`)
  }
  const heavy = c => c.severity === 'blocker' || c.severity === 'major'
  const standing = S.ledger.filter(c => isStanding(S, c) && c.target === L && heavy(c))
  const upheld = standing.filter(c => c.status === 'verified')
  const open = standing.filter(c => c.status === 'unresolved')
  if (upheld.length) blocked.push(`standing ${upheld.map(c => `${c.severity} ${c.id}`).join(', ')}`)
  if (open.length) incomplete.push(`unresolved ${open.map(c => `${c.severity} ${c.id}`).join(', ')}`)
  const thin = S.ledger.filter(c => c.target === L && c.kind === 'finding' && heavy(c) && c.ruledBy === 'panel (one adjudicator)' && !c.fixed)
  if (thin.length) incomplete.push(`ruled by one adjudicator only: ${thin.map(c => c.id).join(', ')}`)
  const silent = raters.filter((s, i) => !reviews[i]).map(s => s.L)
  if (silent.length) incomplete.push(`no ratification review from ${silent.join(', ')}`)
  incomplete.push(...gaps)
  const state = blocked.length ? 'blocked' : incomplete.length ? 'incomplete' : 'ready'
  return { state, blocked, incomplete }
}

const readinessText = r => r.state === 'ready'
  ? 'ready: the final version was checked and nothing known stands against it'
  : `${r.state}: ${[...r.blocked, ...r.incomplete].join('; ')}`

function checkerItems(S, Y, k, routed) {
  const items = new Map()
  const item = c => {
    if (!items.has(c.id)) items.set(c.id, { c, validity: false, fixed: false, test: false, challenges: [] })
    return items.get(c.id)
  }
  for (const c of S.ledger) {
    if (c.withdrawn) continue
    if (c.author === Y && c.round === k && (c.kind === 'fact' || c.kind === 'verification')) item(c).validity = true
    if (c.author === Y && c.round === k && c.kind === 'test') item(c).test = true
    if (c.kind === 'finding' && !c.judgment && c.target === Y && c.round === k) { const it = item(c); it.validity = true; it.fixed = true }
    if (isStanding(S, c) && c.target === Y && c.round !== k) item(c).fixed = true
  }
  for (const id of routed) {
    const c = S.byId[id]
    const it = item(c)
    if (c.kind === 'test') it.test = true
    else it.validity = true
    it.challenges = S.challenges.filter(x => x.claim === id && x.round === k)
  }
  return [...items.values()]
}

function ingestClaims(S, L, round, claims) {
  const ids = new Set(S.criteria.map(c => c.id))
  const all = (claims || []).filter(c => c && c.statement)
  const named = c => (String(c.criterion || '').match(/C\d+/g) || []).some(id => ids.has(id))
  const list = all.filter(c => c.kind === 'verification' || !ids.size || named(c))
  if (list.length < all.length) S.notes.push(`${L} made ${plural(all.length - list.length, 'fact claim')} in ${roundTag(round)} that named no acceptance criterion; not recorded.`)
  if (list.length > MAX_CLAIMS) S.notes.push(`${L} made ${list.length} claims in ${roundTag(round)}; only the first ${MAX_CLAIMS} were recorded.`)
  for (const c of list.slice(0, MAX_CLAIMS)) {
    addClaim(S, { round, author: L, kind: c.kind === 'verification' ? 'verification' : 'fact', target: L, statement: c.statement, evidence: c.evidence,
               criterion: String(c.criterion || '').trim() })
  }
}

function ingestTests(S, L, round, tests) {
  if (S.mode !== 'implement') return
  const re = new RegExp(`^T${round}${L}\\d+$`)
  for (const t of (tests || []).slice(0, 10)) {
    if (!t || !t.id) continue
    if (!re.test(t.id) || S.byId[t.id]) { S.notes.push(`Ignored test '${t.id}' from ${L}: bad or duplicate ID.`); continue }
    addClaim(S, { id: t.id, round, author: L, kind: 'test', target: L, statement: t.purpose, evidence: t.command })
  }
}

function ingestQuestions(S, L, round, qs) {
  for (const q of (qs || []).slice(0, 5)) {
    if (q && q.question) S.pendingQ.push({ round, L, question: q.question, assumption: q.assumption || '' })
  }
}

function keepNotes(S, s, round, res) {
  if (!external(s) && res && res.notes) S.seatNotes[s.L] = { round, text: clip(String(res.notes).trim(), NOTES_CHARS) }
}

function keepDeclined(S, round, res) {
  for (const d of (res.declined || []).slice(0, 12)) if (d && d.ref) S.declined.push({ round, ref: String(d.ref), why: d.why || '' })
}

function ingestSolve(S, s, res) {
  S.pos[s.L] = {
    round: 0, summary: res.summary || '', opening: res.summary || '', post: postPath(S, s.L, 0), confidence: res.confidence,
    stats: null, diffPath: null, statPath: null, delta: null, deltaPath: null, deltaRound: null, postWords: null,
    suite: null, criteria: null, gated: false, gateReasons: [],
  }
  keepNotes(S, s, 0, res)
  ingestClaims(S, s.L, 0, res.claims)
  ingestTests(S, s.L, 0, res.tests)
  ingestQuestions(S, s.L, 0, res.questions)
}

// A reviewer (a seat whose position left contention) critiques, challenges, publishes tests and
// votes, but no longer revises: its position, claims and adoptions are left as they were.
function ingestDebate(S, s, k, res) {
  const L = s.L
  const reviewing = !contending(S, L)
  if (!reviewing) S.pos[L] = { ...S.pos[L], round: k, summary: res.summary || S.pos[L].summary, post: postPath(S, L, k) }
  keepNotes(S, s, k, res)

  for (const f of (res.findings || []).slice(0, 15)) {
    if (!f || !f.statement || !contending(S, f.target) || f.target === L) continue
    addClaim(S, {
      round: k, author: L, kind: 'finding', target: f.target,
      severity: W8[f.severity] ? f.severity : 'minor', judgment: f.kind === 'judgment',
      statement: f.statement, evidence: f.evidence,
    })
  }
  const challenged = []
  for (const ch of (res.challenges || []).slice(0, 15)) {
    const c = ch && S.byId[idOf(ch.claim)]
    if (!c || c.author === L || c.judgment || c.round === k || challenged.includes(c.id)) continue
    S.challenges.push({ round: k, by: L, claim: c.id, reason: ch.reason || '', evidence: ch.evidence || '' })
    challenged.push(c.id)
  }
  const conceded = []
  for (const id of (res.concessions || []).map(idOf)) {
    const c = S.byId[id]
    if (c && c.kind === 'finding' && c.target === L) { if (!c.conceded) c.concededIn = k; c.conceded = true; conceded.push(id) }
  }
  for (const id of (res.withdrawals || []).map(idOf)) {
    const c = S.byId[id]
    if (c && c.author === L) c.withdrawn = true
  }
  const adopted = reviewing ? [] : (res.adopted || []).filter(a => a && isLetter(S, a.from) && a.from !== L && a.idea).slice(0, 10)
  for (const a of adopted) S.adoptions.push({ round: k, by: L, from: a.from, idea: a.idea })
  if (!reviewing) ingestClaims(S, L, k, res.claims)
  ingestTests(S, L, k, res.tests)
  ingestQuestions(S, L, k, res.questions)
  for (const id of (res.seconds || []).map(idOf)) {
    const q = S.questions.find(x => x.id === id)
    if (q && !q.raisedBy.includes(L) && !q.seconds.includes(L)) q.seconds.push(L)
  }
  recordVote(S, S.votes, k, L, res.vote)

  S.behaviour[L].turns.push({
    round: k, reviewing, changed: !reviewing && !!res.changed, note: res.changeNote || '', adopted: adopted.length,
    basis: reviewing ? [] : (res.changeBasis || []).map(idOf).filter(id => S.byId[id]), conceded, challenged,
  })
}

function recordVote(S, book, k, L, v) {
  v = v || {}
  book[k] = book[k] || {}
  if (contending(S, v.ship)) {
    book[k][L] = { ship: v.ship, amendments: (v.amendments || []).slice(0, 8), reason: v.reason || '' }
    if (S.approval) {
      book[k][L].acceptable = uniqueBy((v.acceptable || []).filter(a => a && contending(S, a.seat) && a.seat !== v.ship), a => a.seat)
        .map(a => ({ seat: a.seat, amendments: (a.amendments || []).slice(0, 8) }))
    }
  } else if (isLetter(S, v.ship)) {
    S.notes.push(`${L} voted for ${v.ship} in ${book === S.ballots ? `the ballot after round ${k}` : `round ${k}`}, which is out of contention; the vote was not counted.`)
  }
}

const VERDICT_STATUS = { verified: 'verified', refuted: 'refuted', fabricated: 'fabricated', unverifiable: 'unresolved' }

function applyCheck(S, Y, k, r, items) {
  const p = S.pos[Y]
  if (!r) {
    p.assessment = { round: k, checked: false, measured: false, missingCriteria: S.criteria.map(c => c.id), missingItems: items.map(it => it.c.id) }
    S.notes.push(`The check of ${Y} in ${roundTag(k)} failed; its claims stay unchecked.`)
    return
  }
  // What this check actually established, for the final readiness: a check can come back and
  // still leave the suite unrun, a criterion unjudged or an item without a ruling.
  const ruled = new Set((r.rulings || []).map(rl => idOf(rl.claim)))
  const judged = new Set((r.criteria || []).map(x => x.criterion))
  p.assessment = {
    round: k, checked: true, measured: !!(r.measured && r.suite && r.suite.ran),
    missingCriteria: S.criteria.map(c => c.id).filter(id => !judged.has(id)),
    missingItems: items.map(it => it.c.id).filter(id => !ruled.has(id)),
  }
  if (Number.isInteger(r.postWords) && r.postWords > 0) p.postWords = r.postWords
  if (Number.isInteger(r.postWords) && r.postWords > S.postWords) S.longPosts.push({ turn: `${roundTag(k)}:${Y}`, words: r.postWords })
  if (S.mode === 'implement' && r.measured) {
    p.stats = { files: r.diff.files, added: r.diff.added, removed: r.diff.removed }
    // The snapshot's tree: equal trees are byte-identical versions, whose votes consensus() pools.
    p.tree = /^[0-9a-f]{40,64}$/.test(r.diff.tree || '') ? { hash: r.diff.tree, round: k } : null
    p.diffPath = `${S.run.room}/${roundTag(k)}/${Y}.diff`
    p.statPath = `${S.run.room}/${roundTag(k)}/${Y}.stat`
    const d = r.delta
    const hasDelta = d && sinceTag(S, k) && d.since === sinceTag(S, k)
    p.delta = hasDelta ? { files: d.files, added: d.added, removed: d.removed } : null
    p.deltaPath = hasDelta ? `${S.run.room}/${roundTag(k)}/${Y}.delta.diff` : null
    p.deltaRound = k
    p.snapTag = roundTag(k)
    p.suite = { ran: r.suite.ran, passed: r.suite.passed, tail: r.suite.tail }
    for (const t of r.crossTests || []) {
      const tid = idOf(t.test)
      if (!S.byId[tid]) continue
      S.testResults[tid] = S.testResults[tid] || {}
      S.testResults[tid][Y] = t.outcome
    }
  }
  const asked = new Map(items.map(it => [it.c.id, it]))
  for (const rl of r.rulings || []) {
    const it = asked.get(idOf(rl.claim))
    if (!it) continue
    const c = it.c
    if ((it.validity || it.test) && VERDICT_STATUS[rl.verdict]) {
      c.status = VERDICT_STATUS[rl.verdict]
      c.note = rl.note || ''
      c.ruledBy = 'checker'
    }
    if (it.fixed && c.kind === 'finding') {
      if (rl.fixed === 'yes') { if (!c.fixed) c.fixedIn = k; c.fixed = true }
      else if (rl.fixed === 'no') c.fixed = false
    }
  }
  const crit = (r.criteria || []).filter(x => S.criteria.some(c => c.id === x.criterion))
  if (crit.length) p.criteria = crit
}

function applyPanel(S, ids, results) {
  const members = S.panel.map((m, i) => ({ m, r: results[i] })).filter(x => x.r)
  if (!members.length) { S.notes.push(`The adjudication panel failed on ${ids.join(', ')}; earlier rulings stand.`); return }
  for (const id of ids) {
    const c = S.byId[id]
    const votes = members.map((x, i) => ({ i, v: (x.r.rulings || []).find(r => idOf(r.claim) === id) })).filter(x => x.v)
    if (!votes.length) continue
    const statuses = votes.map(x => VERDICT_STATUS[x.v.verdict] || 'unresolved')
    c.status = statuses.every(s => s === statuses[0]) ? statuses[0] : 'unresolved'
    c.note = votes.map(x => `adjudicator ${x.i + 1}: ${x.v.verdict}, ${oneLine(x.v.note, 200)}`).join(' | ')
    c.ruledBy = votes.length > 1 ? 'panel' : 'panel (one adjudicator)'
    // Only an auditor's judgment finding reaches the panel. Agreed, it becomes a fact: every
    // adjudicator would, or wouldn't, make the change. Split, it stays a judgment call.
    if (c.judgment) {
      if (c.status === 'unresolved') c.status = 'judgment'
      else { c.judgment = false; c.wasJudgment = true }
    }
  }
}

function gate(S, Y, k) {
  const p = S.pos[Y]
  const reasons = []
  if (S.mode === 'implement' && S.baselineOk && p.suite && p.suite.ran && !p.suite.passed) reasons.push('verification command fails')
  const fab = S.ledger.filter(c => c.author === Y && c.round === k && c.kind === 'verification' && c.status === 'fabricated')
  if (fab.length) reasons.push(`fabricated verification claim ${fab.map(c => c.id).join(', ')}`)
  p.gated = reasons.length > 0
  p.gateReasons = reasons
}

function escalation(S, k) {
  const E = escalateAt(S)
  return S.questions.filter(q => !answered(S, q.id, k) && support(S, q) >= E)
}

function knownStanding(S) {
  const m = {}
  for (const s of contenders(S)) {
    m[s.L] = S.ledger.filter(c => isStanding(S, c) && c.target === s.L && c.status === 'verified' &&
      (c.severity === 'blocker' || c.severity === 'major')).map(c => c.id)
  }
  return m
}

function behaviourAfter(S, k, known) {
  for (const s of active(S)) {
    const b = S.behaviour[s.L]
    const t = b.turns.find(x => x.round === k)
    if (!t) continue
    if (t.changed && !t.adopted && (t.basis.length === 0 || t.basis.every(id => isBad(S.byId[id])))) {
      b.capitulations.push({ round: k, note: t.note })
    }
    for (const id of known[s.L] || []) {
      const c = S.byId[id]
      if (!(t.conceded.includes(id) || t.challenged.includes(id) || t.basis.includes(id) || c.fixed)) {
        b.ignored.push({ round: k, finding: id })
      }
    }
  }
}

function tally(S, k, book = S.votes) {
  const counts = {}
  for (const [L, x] of Object.entries(book[k] || {})) {
    if (!isLetter(S, L) || !contending(S, x.ship) || S.pos[x.ship].gated) continue
    ;(counts[x.ship] = counts[x.ship] || []).push(L)
  }
  return counts
}

// Positions in contention whose round-k snapshots have the same tree: byte-identical versions,
// which only implement mode measures. Groups of two or more, each in scorecard order.
function identicalGroups(S, k) {
  const by = {}
  for (const r of rankPositions(S)) {
    const p = S.pos[r.seat]
    if (!contending(S, r.seat) || p.gated || !p.tree || p.tree.round !== k) continue
    ;(by[p.tree.hash] = by[p.tree.hash] || []).push(r.seat)
  }
  return Object.values(by).filter(g => g.length > 1)
}

// K first-choice votes, from two vendors when there are several. Votes for byte-identical
// versions count together, and the pool ships as its member with the most votes, then the highest
// on the scorecard: seats that each vote for their own copy of the same change have agreed. With
// approval on and no such position, a position can carry the round on first-choice plus "also
// acceptable" votes, under the same K and vendor rule, if another seat chose it first and no
// verified blocker or major stands against it; the scorecard order breaks ties.
function consensus(S, k, book = S.votes) {
  const K = consensusAt(S)
  const vendorsOk = voters => !crossVendor(S) || new Set(voters.map(L => seat(S, L).vendor)).size >= 2
  const counts = tally(S, k, book)
  for (const [W, voters] of Object.entries(counts)) {
    if (voters.length >= K && vendorsOk(voters)) return { W, voters, via: 'votes' }
  }
  for (const same of identicalGroups(S, k)) {
    const voters = same.flatMap(X => counts[X] || [])
    if (voters.length < K || !vendorsOk(voters)) continue
    const n = X => (counts[X] || []).length
    const W = same.reduce((a, b) => n(b) > n(a) ? b : a)
    return { W, voters, same, via: 'identical' }
  }
  if (!S.approval) return null
  const votes = Object.entries(book[k] || {}).filter(([L]) => isLetter(S, L))
  const known = knownStanding(S)
  for (const r of rankPositions(S)) {
    const W = r.seat
    if (!contending(S, W) || S.pos[W].gated || (known[W] || []).length) continue
    const first = votes.filter(([, v]) => v.ship === W).map(([L]) => L)
    const also = votes.filter(([, v]) => v.ship !== W && (v.acceptable || []).some(a => a.seat === W)).map(([L]) => L)
    const voters = [...first, ...also]
    if (first.some(L => L !== W) && voters.length >= K && vendorsOk(voters)) return { W, voters, first, via: 'approval' }
  }
  return null
}

// Round 0 ended with every active seat's snapshot the same tree, none disqualified, and the
// verification command passing on it (when there is one): the blind solutions already agree, so
// there is nothing to debate. Returns {W, same}, W the copy highest on the scorecard, or null.
// Every active seat agrees, so the vendor rule (which counts active seats) holds by construction.
function blindAgreement(S) {
  if (S.mode !== 'implement') return null
  const seated = active(S)
  if (seated.length < 2) return null
  if (S.verify && !seated.every(s => S.pos[s.L].suite && S.pos[s.L].suite.ran && S.pos[s.L].suite.passed)) return null
  const same = identicalGroups(S, 0).find(g => g.length === seated.length)
  return same ? { W: same[0], same } : null
}

function stable(S, k) {
  const turns = active(S).map(s => S.behaviour[s.L].turns.find(t => t.round === k)).filter(Boolean)
  if (!turns.length || turns.some(t => t.changed)) return false
  const a = S.votes[k] || {}, b = S.votes[k - 1] || {}
  return Object.keys(a).length > 0 && Object.keys(a).every(L => b[L] && b[L].ship === a[L].ship)
}

// After a debate round without consensus: keep the top two on the scorecard, any position another
// seat voted for, and any whose author has a verified blocker or major finding standing against
// one that stays. The rest leave contention and their authors review from then on. Returns the
// line to log when the field narrowed, null when it didn't.
function narrow(S, k) {
  const field = contenders(S).map(s => s.L)
  if (!S.narrow || field.length <= 2) return null
  const rows = rankPositions(S).filter(r => field.includes(r.seat))
  const keep = new Set(rows.slice(0, 2).map(r => r.seat))
  for (const r of rows) if (r.votesFromOthers > 0) keep.add(r.seat)
  const kept = [...keep]
  for (const r of rows) {
    if (keep.has(r.seat)) continue
    const pressing = S.ledger.some(c => c.author === r.seat && isStanding(S, c) && c.status === 'verified' &&
      kept.includes(c.target) && (c.severity === 'blocker' || c.severity === 'major'))
    if (pressing) keep.add(r.seat)
  }
  const out = rows.filter(r => !keep.has(r.seat))
  if (!out.length) return null
  S.inContention = new Set(field.filter(L => keep.has(L)))
  for (const r of out) S.dropped.push({ seat: r.seat, afterRound: k, rank: rows.indexOf(r) + 1, of: rows.length })
  return `round ${k}: the field narrows to ${[...S.inContention].join(', ')}; ${out.map(r => r.seat).join(', ')} now review`
}

function votesLine(S, k) {
  const v = S.votes[k] || {}
  return active(S).map(s => `${s.L}→${v[s.L] ? v[s.L].ship : '–'}`).join(' ')
}

function claimWeight(c) {
  return c.kind === 'finding' ? (W8[c.severity] || 1) : c.kind === 'verification' ? 3 : c.kind === 'test' ? 2 : 1
}

function seatRows(S) {
  return S.seats.map(s => {
    const L = s.L
    const own = S.ledger.filter(c => c.author === L && (c.kind === 'fact' || c.kind === 'verification'))
    const checked = own.filter(c => ['verified', 'refuted', 'fabricated'].includes(c.status))
    const fabricated = own.filter(c => c.status === 'fabricated').length
    const findings = S.ledger.filter(c => c.author === L && c.kind === 'finding' && !c.judgment)
    const upheld = findings.filter(c => c.status === 'verified')
    const refuted = findings.filter(isBad)
    const chal = uniqueBy(S.challenges.filter(x => x.by === L), x => x.claim)
    const won = chal.filter(x => isBad(S.byId[x.claim]))
    const lost = chal.filter(x => S.byId[x.claim].status === 'verified')
    const score = sum(upheld.map(claimWeight)) + sum(won.map(x => claimWeight(S.byId[x.claim]))) -
      1.5 * (sum(refuted.map(claimWeight)) + sum(lost.map(x => claimWeight(S.byId[x.claim]))))
    const adoptedBy = uniqueBy(S.adoptions.filter(a => a.from === L && a.by !== L), a => `${a.by}|${oneLine(a.idea, 80).toLowerCase()}`)
    const tests = S.ledger.filter(c => c.author === L && c.kind === 'test')
    const b = S.behaviour[L]
    return {
      seat: L, model: s.name, vendor: s.vendor, active: s.active,
      claimsChecked: checked.length, fabricated, refutedClaims: own.filter(c => c.status === 'refuted').length,
      hallucinationRate: checked.length ? Math.round((fabricated / checked.length) * 100) / 100 : 0,
      findingsUpheld: upheld.length, findingsRefuted: refuted.length,
      findingPrecision: upheld.length + refuted.length ? Math.round((upheld.length / (upheld.length + refuted.length)) * 100) / 100 : null,
      challengesWon: won.length, challengesLost: lost.length,
      refutationScore: Math.round(score * 10) / 10,
      ideasAdoptedByOthers: adoptedBy.length,
      ideasInFinal: S.adoptions.filter(a => a.from === L && (a.round === 'F' || a.round === 'G')).length,
      testsPublished: tests.length, testsValid: tests.filter(t => t.status === 'verified').length,
      capitulations: b.capitulations.length, ignoredFindings: b.ignored.length,
    }
  })
}

function lastVoteRound(S) {
  const rs = Object.keys(S.votes).map(Number).filter(n => Object.keys(S.votes[n]).length)
  return rs.length ? Math.max(...rs) : null
}

function positionRows(S) {
  const seats = Object.fromEntries(seatRows(S).map(r => [r.seat, r]))
  const lv = lastVoteRound(S)
  const votes = lv === null ? {} : S.votes[lv]
  return active(S).map(s => {
    const L = s.L, p = S.pos[L]
    const standing = S.ledger.filter(c => isStanding(S, c) && c.target === L)
    const cx = crossFor(S, L)
    const crit = p.criteria || []
    return {
      seat: L, out: contending(S, L) ? 0 : 1, outAfter: droppedInfo(S, L) ? droppedInfo(S, L).afterRound : null,
      gated: p.gated ? 1 : 0, gateReasons: p.gateReasons,
      blockers: standing.filter(c => c.severity === 'blocker').length,
      majors: standing.filter(c => c.severity === 'major').length,
      minors: standing.filter(c => c.severity === 'minor').length,
      crossPass: cx.pass, crossTotal: cx.total, crossRate: cx.total ? cx.pass / cx.total : 1,
      criteriaScore: sum(crit.map(c => c.status === 'met' ? 1 : c.status === 'partial' ? 0.5 : 0)),
      criteriaTotal: S.criteria.length,
      votesFromOthers: Object.entries(votes).filter(([by, v]) => v.ship === L && by !== L).length,
      authorHallucination: seats[L].hallucinationRate,
      size: p.stats ? p.stats.added + p.stats.removed : 0,
    }
  })
}

// Strictly ordered, not a weighted sum: contention and gates, then correctness, then coverage,
// then simplicity. Votes and author credibility only break ties the evidence couldn't separate.
// `why` says how the higher position a beat b on that criterion, for the report.
const RANKING = [
  { key: 'out',                 low: true,  why: (a, b) => `contention (${b.seat} had left it after round ${b.outAfter})` },
  { key: 'gated',               low: true,  why: (a, b) => `the gate (${b.seat} was disqualified: ${b.gateReasons.join('; ')})` },
  { key: 'blockers',            low: true,  why: (a, b) => `standing blocker findings (${a.blockers} vs ${b.blockers})` },
  { key: 'majors',              low: true,  why: (a, b) => `standing major findings (${a.majors} vs ${b.majors})` },
  { key: 'crossRate',           low: false, why: (a, b) => `published tests passed (${a.crossPass}/${a.crossTotal} vs ${b.crossPass}/${b.crossTotal})` },
  { key: 'criteriaScore',       low: false, why: (a, b) => `acceptance criteria met (${a.criteriaScore} vs ${b.criteriaScore} of ${a.criteriaTotal})` },
  { key: 'minors',              low: true,  why: (a, b) => `standing minor findings (${a.minors} vs ${b.minors})` },
  { key: 'votesFromOthers',     low: false, why: (a, b) => `votes from other seats (${a.votesFromOthers} vs ${b.votesFromOthers})` },
  { key: 'authorHallucination', low: true,  why: (a, b) => `its author's fabrication rate (${a.authorHallucination} vs ${b.authorHallucination})` },
  { key: 'size',                low: true,  why: (a, b) => `diff size (${a.size} vs ${b.size} lines)` },
]

function rankPositions(S) {
  return positionRows(S).sort((a, b) => {
    for (const r of RANKING) {
      const d = r.low ? a[r.key] - b[r.key] : b[r.key] - a[r.key]
      if (d) return d
    }
    return a.seat.localeCompare(b.seat)
  })
}

// Why row a ranks above row b: the first criterion in the strict order that separates them.
function separation(a, b) {
  const r = RANKING.find(r => a[r.key] !== b[r.key])
  return r ? `${a.seat} ranked above ${b.seat} on ${r.why(a, b)}` : `${a.seat} and ${b.seat} tied on every criterion; seat order put ${a.seat} first`
}

function positionTable(S) {
  const rows = rankPositions(S)
  const out = [
    '| Rank | Position | Gate | Standing findings (blocker/major/minor) | Published tests | Criteria | Votes from others |' + (S.mode === 'implement' ? ' Diff size |' : ''),
    '|---|---|---|---|---|---|---|' + (S.mode === 'implement' ? '---|' : ''),
  ]
  rows.forEach((r, i) => out.push(
    `| ${i + 1} | ${r.seat} | ${r.out ? `out of contention after round ${r.outAfter}` : r.gated ? `OUT: ${r.gateReasons.join('; ')}` : 'ok'} | ${r.blockers}/${r.majors}/${r.minors} | ` +
    `${r.crossTotal ? `${r.crossPass}/${r.crossTotal}` : '–'} | ${r.criteriaScore}/${r.criteriaTotal} | ${r.votesFromOthers} |` +
    (S.mode === 'implement' ? ` ${r.size} |` : '')))
  return out.join('\n')
}

function seatTable(S) {
  const out = [
    '| Seat | Model | Claims checked | Fabricated | Wrong | Findings upheld/refuted | Challenges won/lost | Refutation score | Ideas adopted (in final) | Capitulations | Ignored findings |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of seatRows(S)) {
    out.push(`| ${r.seat} | ${r.model}${r.active ? '' : ' (dropped)'} | ${r.claimsChecked} | ${r.fabricated} | ${r.refutedClaims} | ` +
      `${r.findingsUpheld}/${r.findingsRefuted} | ${r.challengesWon}/${r.challengesLost} | ${r.refutationScore} | ` +
      `${r.ideasAdoptedByOthers} (${r.ideasInFinal}) | ${r.capitulations} | ${r.ignoredFindings} |`)
  }
  return out.join('\n')
}

// An auditor's review: its findings and tests enter the ledger against the final version W, under
// IDs of the auditor's own (XC1, TXC1), so the checker and the panel rule on them like any other
// claim. Returns what the report keeps of the review itself.
function ingestAudit(S, a, round, W, res) {
  for (const f of (res.findings || []).slice(0, 15)) {
    if (!f || !f.statement) continue
    let n = 1
    while (S.byId[`${a.id}${n}`]) n++
    const c = addClaim(S, {
      id: `${a.id}${n}`, round, author: a.id, kind: 'finding', target: W, severity: W8[f.severity] ? f.severity : 'minor',
      judgment: f.kind === 'judgment', statement: f.statement, evidence: f.evidence,
    })
    // The Architecture tier's reviewers say which milestone a finding is about (0: the whole plan).
    if (Number.isInteger(f.milestone) && f.milestone > 0) c.milestone = f.milestone
  }
  const re = new RegExp(`^T${a.id}\\d+$`)
  for (const t of round === 'H' && S.mode === 'implement' ? (res.tests || []).slice(0, 10) : []) {
    if (!t || !t.id) continue
    if (!re.test(t.id) || S.byId[t.id]) { S.notes.push(`Ignored test '${t.id}' from the ${a.lens} auditor: bad or duplicate ID.`); continue }
    addClaim(S, { id: t.id, round, author: a.id, kind: 'test', target: W, statement: t.purpose, evidence: t.command })
  }
  return { summary: res.summary || '', probes: (res.probes || []).filter(x => x && x.change).slice(0, 5),
    ...(S.tier && S.mode === 'implement' ? { evidenceReview: res.evidenceReview || null } : {}) }
}

// Who rules on an audit round's items: the panel takes the blocker and major findings, judgment
// ones included (the checker can't rule on a trade-off); the checker re-measures the final version
// with the auditors' tests and rules on the minor fact findings. Minor judgment findings are left
// to the author as suggestions.
function auditTriage(S, round) {
  const mine = S.ledger.filter(c => c.round === round && lensOf(c.author) && !c.withdrawn)
  return {
    panel: mine.filter(c => c.kind === 'finding' && W8[c.severity] >= 2).map(c => c.id),
    tests: mine.filter(c => c.kind === 'test').map(c => c.id),
  }
}

// What the audit fix pass is given. It runs only when something is upheld, disputed or failing:
// suggestions alone don't earn a turn.
function auditFixList(S, W) {
  const found = S.ledger.filter(c => c.round === 'H' && c.kind === 'finding' && c.target === W && !c.withdrawn)
  const todo = {
    upheld: found.filter(c => !c.judgment && c.status === 'verified'),
    disputed: found.filter(c => !c.judgment && c.status === 'unresolved'),
    failing: validTests(S).filter(t => S.testResults[t.id] && S.testResults[t.id][W] && S.testResults[t.id][W] !== 'pass'),
    suggestions: found.filter(c => c.judgment),
  }
  // The Simple tier has no debate before its review, and the Feature tier's build none after the
  // plan, so a failing verification command is also the fix pass's to mend.
  const p = S.pos[W]
  todo.suite = (S.tier === 'simple' || S.tier === 'feature') && S.mode === 'implement' && S.baselineOk && p && p.suite && p.suite.ran && !p.suite.passed ? (p.suite.tail || 'no output') : ''
  todo.needed = todo.upheld.length + todo.disputed.length + todo.failing.length > 0 || !!todo.suite
  return todo
}

// ---- The specification review. Its findings are about the criteria, not a position, so they stay
// out of the ledger: S.spec holds them, numbered S1, S2, … across both reviewers.

function ingestSpec(S, r, res) {
  for (const f of (res.findings || []).slice(0, 8)) {
    if (!f || !f.statement) continue
    S.spec.findings.push({
      id: `S${S.spec.findings.length + 1}`, lens: r.lens, severity: W8[f.severity] ? f.severity : 'minor',
      kind: f.kind === 'decision' ? 'decision' : 'fact', criterion: String(f.criterion || '').trim(),
      statement: String(f.statement), evidence: String(f.evidence || ''), change: String(f.change || ''),
      readings: (f.readings || []).filter(x => typeof x === 'string' && x.trim()).slice(0, 4),
      status: 'open', note: '',
    })
  }
  S.spec.reviews[r.lens] = { summary: String(res.summary || '') }
}

// Accepted by every adjudicator: amended. Rejected by every one: dropped. Called a decision by any
// one who didn't reject it outright: a question for the user, or a recorded assumption. Accept
// against reject: disputed, and left as it is: the criteria change only on agreement.
function applySpecPanel(S, results) {
  const members = S.panel.map((m, i) => results[i]).filter(Boolean)
  if (!members.length) {
    S.notes.push('The adjudication panel failed on the spec review\'s findings; the criteria stand as setup wrote them.')
    for (const f of S.spec.findings) f.status = 'unruled'
    return
  }
  for (const f of S.spec.findings) {
    const votes = members.map((r, i) => ({ i, v: (r.rulings || []).find(x => idOf(x.finding) === f.id) })).filter(x => x.v && ['accept', 'decision', 'reject'].includes(x.v.verdict))
    if (!votes.length) { f.status = 'unruled'; continue }
    const vs = votes.map(x => x.v.verdict)
    f.status = vs.every(v => v === 'accept') ? 'accepted' : vs.every(v => v === 'reject') ? 'rejected' : vs.includes('decision') ? 'decision' : 'disputed'
    f.note = votes.map(x => `adjudicator ${x.i + 1}: ${x.v.verdict}, ${oneLine(x.v.note, 200)}`).join(' | ')
  }
}

// What the amendment turn is given, and the decisions still waiting on the user (ask mode stops on those).
function specTodo(S) {
  const todo = S.spec.findings.filter(f => f.status === 'accepted' || f.status === 'decision')
  const open = todo.filter(f => f.status === 'decision' && !S.clarifications.some(c => c.id === f.id))
  return { todo, open }
}

// The amended criteria replace setup's, and a changed verification command brings its new baseline.
// An amendment that returned no criteria at all is ignored rather than leaving the run without any.
function applyAmend(S, res, todo) {
  const criteria = (res.criteria || []).filter(c => c && c.id && c.text).map(c => ({ id: String(c.id), text: String(c.text) }))
  if (!criteria.length) { S.notes.push('The spec amendment returned no criteria; setup\'s criteria stand.'); return false }
  S.spec.before = { criteria: S.criteria, verify: S.verify }
  S.criteria = criteria
  const verify = String(res.verify || '').trim()
  if (verify !== S.verify) {
    S.verify = verify
    S.baselineOk = S.mode !== 'implement' || !verify || !!res.baselinePasses
    S.baselineNote = S.baselineOk ? '' : oneLine(res.baselineNote, 300) || 'no reason given'
  }
  const ids = new Set(todo.map(f => f.id))
  S.spec.applied = (res.applied || []).filter(a => a && ids.has(idOf(a.finding))).map(a => ({ id: idOf(a.finding), change: String(a.change || '') }))
  const answered = new Set(S.clarifications.map(c => c.id))
  S.spec.answered = todo.filter(f => f.status === 'decision' && answered.has(f.id)).map(f => f.id)
  S.spec.assumptions = (res.assumptions || []).filter(a => a && ids.has(idOf(a.finding)) && !answered.has(idOf(a.finding)) && a.chosen)
    .map(a => ({ id: idOf(a.finding), question: String(a.question || S.spec.findings.find(f => f.id === idOf(a.finding)).statement),
      chosen: String(a.chosen), alternative: String(a.alternative || ''), impact: String(a.impact || '') }))
  const unrecorded = todo.filter(f => f.status === 'decision' && !answered.has(f.id) && !S.spec.assumptions.some(a => a.id === f.id))
  if (unrecorded.length) S.notes.push(`The spec amendment recorded no assumption for ${unrecorded.map(f => f.id).join(', ')}.`)
  return true
}
