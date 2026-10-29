// Run state, and the small queries every other module is built from. Everything here takes the
// state object `S` (see newState) as its first argument and touches nothing else, so a test can
// build a state and call any of it directly.

// The state of one run: the config (parseConfig) plus everything that changes as the run goes.
// Created once at boot; the functions below and in the other lib/ files read and update it.
function newState(config) {
  return {
    ...config,
    postWords: WORDS_BY_MODE[config.mode],          // soft limit, flagged when exceeded; follows the mode
    run: null,                // {runId, runDir, repoRoot, room}
    seats: [],                // {L, key, vendor, model, name, effort, wt, active}
    criteria: [],
    verify: '',
    refs: [],                 // {source, path, inWorktrees}: snapshots of the plan and other documents the work follows
    baselineOk: true,
    baselineNote: '',         // why the verification command fails at baseline, when it does
    ledger: [],               // claims, findings and tests
    byId: {},
    challenges: [],           // {round, by, claim, reason, evidence}
    adoptions: [],            // {round, by, from, idea}
    votes: {},                // round -> {L: {ship, amendments, reason, acceptable?}}
    ballots: {},              // round -> {L: vote}: the re-vote after that round's checks (ballot: true)
    questions: [],            // {id, text, raisedBy, seconds, assumptions, round}
    pendingQ: [],             // raw questions awaiting clustering
    pos: {},                  // L -> current position
    behaviour: {},            // L -> {turns, capitulations, ignored}
    testResults: {},          // testId -> {L: outcome}, latest measurement
    notes: [],                // things dropped or degraded, reported at the end
    seatNotes: {},            // L -> {round, text}: a Claude seat's private notes from its last turn
    processNotes: [],         // {turn, role, who, text}: agents' notes on the process, for the retro
    turnLog: [],              // {turn, role, vendor, ok}: every agent, Codex and Gemini turn, for the retro's facts
    relayFailures: [],        // {turn, model, status, error}: relay attempts that didn't return a result
    longPosts: [],            // {turn, words}: posts over the length limit
    inContention: null,       // letters whose positions can still ship; null until the field first narrows
    dropped: [],              // {seat, afterRound, rank, of}: positions that left contention
    declined: [],             // {round, ref, why}: findings and amendments the final author declined
    lastRound: 0,
    blocked: {},              // vendor -> true once its CLI is known to be stuck inside the sandbox
    vendorTimes: [],          // {turn, vendor, seconds}: how long each Codex and Gemini turn took, for the retro
    // The specification review: each finding {id, lens, severity, kind, criterion, statement, evidence,
    // change, readings, status, note}; status is the panel's: accepted, rejected, decision, disputed or unruled.
    spec: { ran: false, reviews: {}, findings: [], applied: [], assumptions: [], answered: [], before: null },
    auditedTag: null,         // the final version's snapshot tag ('final' or 'final2') when the audit starts
    factory: null,            // a factory run: {tier, asked, tierConfirmed, chosenBy, recommended, intake, escalation, args: the user's own}
    build: null,              // the Feature tier's build, once its plan is chosen: {listed, increments: [{n, title, delivers, ...}]}
    milestones: null,         // the Architecture tier's milestone plan: [{n, title, task, criteria, after, tier, working}]
  }
}

// Vendors whose CLIs this run depends on: the seats', the panel's, the spec reviewers' and the auditors'.
function externalVendors(S) {
  return [...new Set([...S.lineup, ...S.panel, ...S.specReviewers, ...S.auditors,
    ...(S.host === 'codex' ? Object.values(S.roles).map(s => hostSeat(S.host, s)) : [])].filter(external).map(s => s.vendor))]
}

// The runner owns a unique prefix. A separate suffix per tier keeps even immediate escalations
// in new worktrees, without relying on the helper's second-resolution timestamp default.
function setupRunId(S) {
  if (S.host !== 'codex' || S.raw.hostRunId === undefined || S.raw.hostRunId === null) return null
  const prefix = S.raw.hostRunId
  const id = `${prefix}-${S.tier || S.workflowName}`
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('factory: hostRunId must contain only letters, digits, dots, underscores and hyphens, starting with a letter or digit.')
  }
  return id
}

function auditor(S, id) {
  return S.auditors.find(a => a.id === id)
}

function seat(S, L) {
  return S.seats.find(s => s.L === L)
}

function active(S) {
  return S.seats.filter(s => s.active)
}

function isLetter(S, L) {
  return S.seats.some(s => s.L === L && s.active)
}

const isBad = c => !!c && (c.status === 'refuted' || c.status === 'fabricated')

function contending(S, L) {
  return isLetter(S, L) && (!S.inContention || S.inContention.has(L))
}

function contenders(S) {
  return active(S).filter(s => contending(S, s.L))
}

function droppedInfo(S, L) {
  return S.dropped.find(d => d.seat === L)
}

const W8 = { blocker: 3, major: 2, minor: 1 }

function quorum(S, override) {
  const n = active(S).length || S.seats.length
  const v = Number(override)
  return v ? Math.max(1, Math.min(n, v)) : Math.max(2, Math.ceil((2 * n) / 3))
}

function consensusAt(S) {
  return quorum(S, S.raw.consensusAt)
}

function escalateAt(S) {
  return quorum(S, S.raw.escalateAt)
}

function crossVendor(S) {
  return new Set(active(S).map(s => s.vendor)).size > 1
}

function crossVendorText(S) {
  return new Set(active(S).map(s => s.vendor)).size > 2 ? 'at least two vendors' : 'both vendors'
}

// Round tags: 0..3 are rounds; 'F' the final version; 'G' the fix pass; 'ratify' the reviews;
// 'H' the audit, 'I' the audit fix pass, 'J' the auditors' re-review of that fix; and in the
// factory's Feature tier, 'K1', 'K2', … the build's increments.
const AUDIT_TAGS = { H: 'audit', I: 'final3', J: 'reaudit' }
const roundTag = r => typeof r === 'number' ? `r${r}` : r === 'F' ? 'final' : r === 'G' ? 'final2' : AUDIT_TAGS[r] || (buildStep(r) ? `inc${buildStep(r)}` : r)

const ballotOf = r => { const m = typeof r === 'string' && r.match(/^b(\d+)$/); return m ? Number(m[1]) : null }
const roundNum = r => typeof r === 'number' ? r : ballotOf(r) !== null ? ballotOf(r) : 99
const phaseOf = r => r === 0 ? 'Solve' : typeof r === 'number' ? `Round ${r}` : ballotOf(r) !== null ? `Round ${ballotOf(r)}` : r === 'ratify' ? 'Ratify' : AUDIT_TAGS[r] ? 'Audit' : buildStep(r) ? 'Build' : 'Synthesize'

function postPath(S, L, r) {
  return `${S.run.room}/${roundTag(r)}/${L}.md`
}

function addClaim(S, c) {
  const prefix = typeof c.round === 'number' ? String(c.round) : c.round
  let id = c.id
  if (!id) {
    let n = 1
    while (S.byId[`${prefix}${c.author}${n}`]) n++
    id = `${prefix}${c.author}${n}`
  }
  const rec = {
    id, round: c.round, author: c.author, kind: c.kind, target: c.target,
    severity: c.severity || null, judgment: !!c.judgment,
    statement: String(c.statement || ''), evidence: String(c.evidence || ''), criterion: c.criterion || '',
    status: c.judgment ? 'judgment' : 'open', fixed: false, conceded: false, withdrawn: false, note: '', ruledBy: '',
  }
  S.ledger.push(rec)
  S.byId[id] = rec
  return rec
}

const loadBearing = c => c.kind === 'verification' || c.kind === 'test' ||
  (c.kind === 'finding' && (c.severity === 'blocker' || c.severity === 'major'))

function isStanding(S, c) {
  return c.kind === 'finding' && !c.judgment && !c.fixed && !c.withdrawn &&
    (c.status === 'verified' || c.status === 'unresolved') && isLetter(S, c.target)
}

function validTests(S) {
  return S.ledger.filter(c => c.kind === 'test' && !c.withdrawn && !isBad(c))
}

function crossFor(S, L) {
  let pass = 0, total = 0
  for (const t of validTests(S)) {
    const o = S.testResults[t.id] && S.testResults[t.id][L]
    if (!o || o === 'conflict') continue
    total++
    if (o === 'pass') pass++
  }
  return { pass, total }
}

// The lens behind an auditor's ID prefix (XC, XD), from the ledger alone.
const lensOf = id => (Object.entries({ ...AUDIT_LENSES, ...FEATURE_LENS, ...SIMPLE_LENS, ...ARCH_LENSES }).find(([, d]) => d.id === id) || [])[0]

function describe(S, c) {
  const lens = lensOf(c.author)
  if (lens && c.kind === 'finding' && S.tier === 'architecture') {
    return `${c.round === 'J' ? 're-review' : 'review'} finding by the ${lens} reviewer against ${c.target}'s ${c.round === 'J' ? 'revised ' : ''}milestone plan, severity ${c.severity}${c.judgment ? ', judgment' : ''}`
  }
  if (lens && c.kind === 'finding') {
    return `${c.round === 'J' ? 're-review' : 'audit'} finding by the ${lens} auditor against ${c.target}'s ${c.round === 'J' ? 'fixed ' : ''}final version, severity ${c.severity}${c.judgment ? ', judgment' : ''}`
  }
  if (lens) return `test published by the ${lens} auditor`
  if (c.kind === 'finding') {
    return c.round === 'F'
      ? `objection by ${c.author} to ${c.target}'s final version, severity ${c.severity}`
      : `finding by ${c.author} against ${c.target}'s round-${c.round - 1} version, severity ${c.severity}`
  }
  if (c.kind === 'test') return `test published by ${c.author} in round ${c.round}`
  return `${c.kind} claim by ${c.author} about its ${typeof c.round === 'number' ? `round-${c.round}` : buildStep(c.round) ? `build increment ${buildStep(c.round)}` : 'final'} version`
}

// An answer counts only from the round after it arrived. Rebuilding an earlier round's prompts
// with it would change them, and a resumed run would then re-run that round instead of replaying it.
function answered(S, id, upto = Infinity) {
  return S.clarifications.some(c => c.id === id && !(Number(c.afterRound) > upto))
}

function support(S, q) {
  return new Set([...q.raisedBy, ...q.seconds].filter(L => isLetter(S, L))).size
}
