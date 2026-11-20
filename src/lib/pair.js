function newPairState() {
  return { stage: 'design', design: '', approvedDesign: '', testContract: null, approvedContract: null,
    replayMapping: [], findings: [], readings: [], liveChecks: [], reviews: [], author: null, measurement: null, label: null, lastReview: null, signatures: [], stop: '', questions: [],
    // Every question the run asked (Q1, Q2, … across all its stops), the user's answers it took,
    // and how this stop can continue. See pairAsk and pairTakeAnswers.
    asked: [], decisions: [], resumable: false, skipRetro: false, fallback: false, setupAttempt: 0,
    // The author's reply to each finding it answered (pairIngestReplies).
    replies: [],
    // One entry per design review: new findings, design findings left open, and the design's size.
    designRounds: [] }
}

// Pair decisions are shared by both hosts. Only the reviewer can close findings.
// A string task may also start with --no-design or --no-retro, among the other flags.
const PAIR_SWITCHES = { 'no-design': ['design', false], 'no-retro': ['retro', false] }
function parsePairArgs(args) {
  return parseArgs(args, PAIR_SWITCHES)
}

// design: false skips the design stage, for a task whose deliverable is itself a document or a
// plan: there the approved design is the deliverable, and writing and reviewing it twice paid for
// it twice. The first author turn then writes the deliverable and its test contract, and review
// starts at the measured snapshot. Factory never sets it.
function pairDesigned(S) {
  return S.pairOptions?.design !== false
}

function parsePairConfig(args) {
  const raw = parsePairArgs(args)
  for (const key of ['tier', 'seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence']) {
    if (raw[key] !== undefined) throw new Error(`pair: ${key} is not a pair option; use author, reviewer, and maxReviews.`)
  }
  if (raw.mode && raw.mode !== 'implement') throw new Error('pair: this workflow delivers an implementation.')
  const author = parseSeat(raw.author || (raw.host === 'codex' ? 'astra' : 'opus'), raw.effort)
  const reviewer = parseSeat(raw.reviewer || (author.vendor === 'claude' ? 'astra' : 'opus'), raw.effort)
  const maxReviews = raw.maxReviews === undefined ? 8 : Number(raw.maxReviews)
  if (!Number.isSafeInteger(maxReviews) || maxReviews < 2 || maxReviews > 100) throw new Error('pair: maxReviews must be an integer from 2 to 100.')
  if (raw.design !== undefined && typeof raw.design !== 'boolean') throw new Error('pair: design must be true or false (--no-design in a string task).')
  const design = raw.design !== false
  // The design's share of the budget: it may use up to maxReviews - 1, leaving at least one code
  // review; by default 3, or fewer when the budget is small, leaving two (a finding and its check).
  const designCap = Math.max(1, maxReviews - 1), designDefault = Math.min(3, Math.max(1, maxReviews - 2))
  const maxDesignReviews = raw.maxDesignReviews === undefined ? designDefault : Number(raw.maxDesignReviews)
  if (!Number.isSafeInteger(maxDesignReviews) || maxDesignReviews < 1 || maxDesignReviews > designCap)
    throw new Error(`pair: maxDesignReviews must be an integer from 1 to maxReviews - 1 (${designCap}).`)
  // The process retro is on unless retro: false (--no-retro in a string task), as in the other workflows.
  const config = parseConfig({ ...raw, mode: 'implement',
    simple: { implementer: author.key, reviewer: reviewer.key } }, { workflow: 'pair', tier: 'simple' })
  // Setup writes the criteria and the gate, and the run inherits their quality: Sonnet setup dropped
  // a stated criterion and stopped on a guess where Opus setup did neither. So setup runs on Opus,
  // except that a Codex (or Gemini) author on the standalone runtime sets up as itself. Effort is the
  // shared setup default unless the user chose one; then setup runs at the author's effort. Native
  // setup reads only the model and always runs at medium.
  const setupKey = config.host === 'codex' && author.vendor !== 'claude' ? author.key : 'opus'
  const setup = raw.effort === undefined ? parseSeat(setupKey, ROLE_EFFORT.setup) : setupKey === author.key ? author : parseSeat(setupKey, author.effort)
  // The Codex host's retro role, unless the run uses no CLI of its vendor: then Sonnet if a Claude
  // participant is there, else the author's model, so the retro adds no CLI the pair doesn't need.
  const used = [author.vendor, reviewer.vendor, setup.vendor]
  const retro = !config.roles.retro ? null : used.includes(config.roles.retro.vendor) ? config.roles.retro
    : parseSeat(used.includes('claude') ? 'sonnet' : author.key, ROLE_EFFORT.retro)
  // Reuse setup, transport and the retro, without acquiring council roles or Simple escalation rules.
  return { ...config, raw, tier: 'pair', simple: null, panel: [], specReviewers: [],
    roles: { ...(retro ? { retro } : {}), setup }, lineup: [hostSeat(config.host, author)],
    auditors: [{ ...hostSeat(config.host, reviewer), lens: 'review', id: 'PR' }],
    pairOptions: { author, reviewer, maxReviews, maxDesignReviews, design, answers: pairAnswersOf(raw.clarifications) } }
}

// Without a design stage the contract is the author's to revise with the code, so it is part of
// the reviewed version: a contract change on the same tree is a new version, not a stall.
// With the user's decisions in the prompts, the version carries them too, so a review from before
// an answer never counts for the version after it.
function pairVersion(S) {
  const decided = S.pair.decisions?.length ? `:u${promptHash(JSON.stringify(S.pair.decisions))}` : ''
  return (S.pair.stage === 'design' ? `design:${promptHash(JSON.stringify([S.pair.design, S.pair.testContract]))}:${S.pair.measurement?.snapshot?.tree || 'base'}`
    : `code:${S.pair.measurement?.snapshot?.tree || 'unmeasured'}${pairDesigned(S) ? '' : `:${promptHash(JSON.stringify(S.pair.approvedContract))}`}`) + decided
}

function pairReviewTag(S) {
  return S.pair.measurement?.snapshot?.ref?.slice(`refs/council/${S.run.runId}/A-`.length) || 'base'
}

// The measurement as the engine and the prompts read it: the helper's result cut to `schema`
// (PAIR_MEASURE_SCHEMA), a missing value taking its type's empty value, exactly as
// `dark-factory measure --brief` prints it for a native transport to copy. The Codex runtime returns
// the full result, so both hosts pass through here and hand the engine the same shape.
function pairMeasurementView(S, m, schema) {
  if (!m) return null
  const pick = (v, s) => s.type === 'object'
    ? Object.fromEntries(Object.entries(s.properties).map(([k, x]) => [k, pick(v && typeof v === 'object' && !Array.isArray(v) ? v[k] : undefined, x)]))
    : s.type === 'array' ? (Array.isArray(v) ? v.map(x => pick(x, s.items)) : [])
    : v ?? (s.type === 'string' ? '' : s.type === 'boolean' ? false : 0)
  const view = { ...pick(m, schema), status: m.status === 'done' ? 'done' : 'error' }
  // The full record keeps verification.json's explicit env as an object; the brief lists it sorted
  // by name (a strict schema cannot hold a free-form object). The base environment is never shown.
  const env = m.verification?.env
  if (view.suite && 'overrides' in view.suite && env && typeof env === 'object' && !Array.isArray(env))
    view.suite.overrides = Object.keys(env).sort().map(name => ({ name, value: String(env[name]) }))
  return view
}

// The baseline note on the standalone runtime: the reason and the end of the failing output on one
// line of at most 300 characters. A reason is capped at 120 characters when a tail follows it, so
// the tail keeps at least its last 164 characters, where a test runner prints its summary.
function pairBaselineNote(reason, tail) {
  const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim()
  const head = (s, n) => s.length <= n ? s : `${s.slice(0, n - 1)}…`
  const end = (s, n) => s.length <= n ? s : `…${s.slice(s.length - n + 1)}`
  const r = flat(reason), t = flat(tail)
  if (!t) return head(r, 300)
  const h = head(r, 120)
  return `${h}; failing tail: ${end(t, 300 - h.length - 16)}`
}

// The baseline from the runner's own measurement of the base revision (the full helper record, or
// {status: 'error'} when the request threw). It replaces what setup reported, because setup on the
// standalone runtime is a sandboxed model turn where a refused socket bind or network call fails a
// gate that passes outside it.
function pairBaselineResult(S, m) {
  if (!S.verify) { S.baselineOk = true; S.baselineNote = ''; return true }
  const suite = m?.suite
  const reason = !m ? 'the baseline measurement returned nothing'
    : m.status !== 'done' ? `the baseline measurement failed: ${m.error || m.status || 'no reason given'}`
    : !suite?.ran ? `the verification command did not run (${suite?.failureKind || 'no reason recorded'})`
    : String(suite.command || '').trim() !== S.verify ? `the baseline ran ${suite.command}, not the verification command`
    : suite.timedOut ? 'the verification command timed out'
    : !suite.passed ? `the verification command exited ${suite.exitCode ?? 'without an exit code'}`
    : ''
  S.baselineOk = !reason
  S.baselineNote = reason ? pairBaselineNote(reason, suite?.tail) : ''
  return S.baselineOk
}

// The helper's full record of the current measurement: the view above plus what each execution
// printed (its tail), checkout paths and log digests.
function pairMeasurementRecord(S) {
  const tag = pairReviewTag(S)
  return tag === 'base' ? '' : `${S.run.runDir}/jobs/measure-A-${tag}/status.json`
}

function pairOpen(S) {
  return S.pair.findings.filter(f => f.status === 'open')
}

function pairRelativePath(S, path) {
  return typeof path === 'string' && !!path && !path.includes('\\') && !path.includes('\0') &&
    !/^[A-Za-z]:/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..')
}

function pairContractError(S, contract) {
  if (!contract || !Array.isArray(contract.testRoots) || !Array.isArray(contract.checks) || !contract.checks.length) return 'A concrete test contract is required.'
  const roots = contract.testRoots.map(r => r.path)
  if (new Set(roots).size !== roots.length || contract.testRoots.some(r => !pairRelativePath(S, r.path) || !String(r.evidence || '').trim())) return 'Test roots need distinct relative directories and repository evidence.'
  const inside = path => pairRelativePath(S, path) && roots.some(root => path.startsWith(root + '/'))
  const ids = new Set()
  for (const c of contract.checks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.id || '') || ids.has(c.id) ||
        !Array.isArray(c.criteria) || !c.criteria.length || new Set(c.criteria).size !== c.criteria.length || c.criteria.some(id => !S.criteria.some(x => x.id === id)) ||
        !String(c.scenario || '').trim() || !String(c.expected || '').trim() || !String(c.boundaries || '').trim()) return 'Contract checks need unique IDs, valid criteria, concrete scenarios, expected outcomes, and boundaries.'
    ids.add(c.id)
    if (c.kind === 'test') {
      if (!['changed', 'preserved'].includes(c.purpose) || !inside(c.file) || !String(c.command || '').trim() ||
          !Array.isArray(c.fixtures) || c.fixtures.some(f => !inside(f))) return `Executable check ${c.id} needs a purpose, test file, command, and fixtures under accepted test roots.`
    } else if (c.kind === 'gate') {
      if (c.purpose !== 'preserved' || !S.verify || c.command !== S.verify || c.file !== '' || !Array.isArray(c.fixtures) || c.fixtures.length) return `Gate check ${c.id} must preserve behavior using the exact designated gate, with no file or fixtures.`
    } else if (c.kind !== 'inspection' || !String(c.inspection || '').trim() || !String(c.reason || '').trim()) return `Check ${c.id} needs a concrete alternative inspection and reason.`
  }
  if (S.criteria.some(c => !contract.checks.some(check => check.criteria.includes(c.id)))) return 'The contract must cover every acceptance criterion.'
  return null
}

// A reviewer sometimes names a criterion by its ID and text ("C1: The parser rejects ..."), which
// Gemini did in a live code review. Where the text starts with exactly one known ID followed by a
// non-word character, keep only the ID, so the assessment is not silently lost to readiness.
// Rewrites the review in place; anything else is left for pairCriteriaError to reject.
function pairNormalizeReview(S, review) {
  const ids = S.criteria.map(c => c.id)
  const bare = value => {
    if (typeof value !== 'string' || ids.includes(value.trim())) return typeof value === 'string' ? value.trim() : value
    const hits = ids.filter(id => value.trim().startsWith(id) && /^\W/.test(value.trim().slice(id.length)))
    return hits.length === 1 ? hits[0] : value
  }
  for (const list of [review?.criteria, review?.challenges]) {
    if (Array.isArray(list)) for (const item of list) if (item && typeof item === 'object') item.criterion = bare(item.criterion)
  }
  return review
}

// Every acceptance criterion needs exactly one assessment, under its ID.
function pairCriteriaError(S, review) {
  const ids = S.criteria.map(c => c.id)
  const given = Array.isArray(review?.criteria) ? review.criteria.map(a => a?.criterion) : []
  const missing = ids.filter(id => !given.includes(id))
  const unknown = given.filter(id => !ids.includes(id))
  const repeated = given.filter((id, i) => ids.includes(id) && given.indexOf(id) !== i)
  if (!missing.length && !unknown.length && !repeated.length) return null
  return `The review needs exactly one criteria assessment for each acceptance criterion, under its bare ID (${ids.join(', ')}).` +
    `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}` +
    `${unknown.length ? ` Not a criterion ID: ${unknown.map(id => JSON.stringify(oneLine(String(id), 80))).join(', ')}.` : ''}` +
    `${repeated.length ? ` Repeated: ${[...new Set(repeated)].join(', ')}.` : ''}`
}

// A review whose structured fields can be fixed without changing its judgement: one correction.
function pairCorrectableError(S, review) {
  return ((S.pair.stage === 'design' || pairChallengesDue(S)) && pairChallengeError(S, review)) || pairCriteriaError(S, review) || pairRulingsError(S, review) || pairQuestionsError(S, review)
}

// An author reads a requirement other than literally only through the readings ledger, R1, R2, …,
// which the next review rules on by ID. A reading already in the ledger, word for word, is not
// added again. Returns the IDs added.
function pairIngestReadings(S, author) {
  const p = S.pair, text = v => String(v ?? '').trim(), same = v => text(v).replace(/\s+/g, ' ')
  const added = []
  for (const r of Array.isArray(author?.readings) ? author.readings : []) {
    if (!text(r?.requirement) || !text(r?.reading)) continue
    if (p.readings.some(old => same(old.requirement) === same(r.requirement) && same(old.reading) === same(r.reading))) continue
    const id = `R${p.readings.length + 1}`
    p.readings.push({ id, stage: p.stage, turn: p.label, requirement: text(r.requirement), literal: text(r.literal), reading: text(r.reading), reason: text(r.reason),
      status: 'proposed', evidence: '', finding: '', history: [] })
    added.push(id)
  }
  return added
}

// The criteria the run checks only against a stand-in for something outside it (a network service,
// credentials, a certificate store), with how the user checks each against the real thing: setup's
// list, then each author turn's new entries, in order. An entry already listed, word for word, is
// not added again. They never change readiness state; the result lists them for the user to run
// before delivery. Returns the entries added.
function pairIngestLiveChecks(S, list, source) {
  const p = S.pair, text = v => String(v ?? '').trim(), same = v => text(v).replace(/\s+/g, ' ')
  p.liveChecks ||= []
  const added = []
  for (const c of Array.isArray(list) ? list : []) {
    if (!text(c?.criterion) || !text(c?.check)) continue
    if (p.liveChecks.some(old => ['criterion', 'check', 'reason'].every(k => same(old[k]) === same(c[k])))) continue
    const entry = { criterion: text(c.criterion), check: text(c.check), reason: text(c.reason), source }
    p.liveChecks.push(entry)
    added.push(entry)
  }
  return added
}

// Every reading still proposed needs exactly one ruling, with evidence, under its ID. needs-user
// is a ruling only beside a question that cites the reading.
function pairRulingsError(S, review) {
  const ids = S.pair.readings.filter(r => r.status === 'proposed').map(r => r.id)
  const rulings = Array.isArray(review?.rulings) ? review.rulings : []
  const given = rulings.map(r => r?.id)
  const missing = ids.filter(id => !given.includes(id))
  const unknown = given.filter(id => !ids.includes(id))
  const repeated = given.filter((id, i) => ids.includes(id) && given.indexOf(id) !== i)
  const invalid = rulings.filter(r => ids.includes(r?.id) && (!['accepted', 'rejected', 'needs-user'].includes(r.ruling) || !String(r.evidence || '').trim())).map(r => r.id)
  const unasked = rulings.filter(r => ids.includes(r?.id) && r.ruling === 'needs-user' && !pairQuestionCites(S, review, r.id)).map(r => r.id)
  if (!missing.length && !unknown.length && !repeated.length && !invalid.length && !unasked.length) return null
  return `The review needs exactly one ruling, accepted or rejected with evidence, for each proposed reading (${ids.join(', ') || 'none is proposed, so rulings=[]'}).` +
    `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}` +
    `${unknown.length ? ` Not a proposed reading: ${unknown.map(id => JSON.stringify(oneLine(String(id), 80))).join(', ')}.` : ''}` +
    `${repeated.length ? ` Repeated: ${[...new Set(repeated)].join(', ')}.` : ''}` +
    `${invalid.length ? ` Without a valid ruling or evidence: ${[...new Set(invalid)].join(', ')}.` : ''}` +
    `${unasked.length ? ` Ruled needs-user with no question citing it: ${[...new Set(unasked)].join(', ')}; ask the question, or accept or reject the reading.` : ''}`
}

// Whether one of the review's questions names a finding or reading ID, in its text or its quotes.
function pairQuestionCites(S, review, id) {
  const cited = new RegExp(`\\b${id}\\b`)
  return (Array.isArray(review?.questions) ? review.questions : []).some(q => cited.test(String(q?.question || '')) ||
    (Array.isArray(q?.quoted) && q.quoted.some(w => cited.test(String(w || '')))))
}

// A reviewer's question goes to the user as it stands, so it needs the question and the exact
// words of every requirement involved.
function pairQuestionsError(S, review) {
  const questions = Array.isArray(review?.questions) ? review.questions : []
  const bad = questions.map((q, i) => !String(q?.question || '').trim() || !Array.isArray(q?.quoted) || !q.quoted.some(w => String(w || '').trim()) ? i + 1 : 0).filter(Boolean)
  return bad.length ? `Each question needs its text and, in quoted, the exact words of every requirement involved. ${bad.length === 1 ? 'Question' : 'Questions'} ${bad.join(', ')} ${bad.length === 1 ? 'lacks' : 'lack'} one or the other.` : null
}

// The reviewer's questions as the user reads them, with the requirements they quote.
function pairReviewQuestions(S, review) {
  return (Array.isArray(review?.questions) ? review.questions : []).map(q =>
    `${String(q.question).trim()} Requirements as written: ${q.quoted.map(w => String(w || '').trim()).filter(Boolean).join('; ')}`)
}

// Questions for the user, and the answers a continued run takes. A stop's questions get IDs that
// are unique across the run, Q1, Q2, …, a later stop continuing the numbering; about names the
// finding, criterion or reading a question is about, or none. Returns the stop's questions.
function pairAsk(S, kind, items, label) {
  const p = S.pair
  const exists = id => p.findings.some(f => f.id === id) || (S.criteria || []).some(c => c.id === id) || p.readings.some(r => r.id === id)
  p.questions = []
  for (const item of Array.isArray(items) ? items : []) {
    const given = item && typeof item === 'object'
    const question = String((given ? item.question : item) ?? '').replace(/\s+/g, ' ').trim()
    if (!question) continue
    const about = given && item.about ? String(item.about) : kind === 'setup' ? 'none'
      : (question.match(/\b[PCR]\d+\b/g) || []).find(exists) || 'none'
    const q = { id: `Q${p.asked.length + 1}`, about, kind, question }
    p.asked.push({ ...q, label })
    p.questions.push(q)
  }
  return p.questions
}

// The clarification entries as given: a criterion answer keeps criterion and drop, which the
// council's parser leaves out. An entry that is not an object is kept as one with no id.
function pairAnswersOf(list) {
  return (Array.isArray(list) ? list : []).map(c => c && typeof c === 'object' && !Array.isArray(c)
    ? { id: c.id, answer: c.answer, ...(c.criterion !== undefined ? { criterion: c.criterion } : {}), ...(c.drop !== undefined ? { drop: c.drop } : {}),
      ...(c.implement !== undefined ? { implement: c.implement } : {}) }
    : { id: undefined, answer: undefined })
}

const pairAnswerName = id => typeof id === 'string' && /^Q[1-9][0-9]*$/.test(id) ? id
  : id === undefined || id === null || id === '' ? '(no id)' : JSON.stringify(oneLine(String(id), 80))

function pairAnswerProblem(a, q) {
  // A field given as null is given: it is checked, not taken as absent.
  const has = key => a[key] !== undefined
  if (typeof a.answer !== 'string' || !a.answer.trim()) return 'no answer'
  if ((has('criterion') || has('drop')) && q.kind !== 'criterion') return 'criterion and drop answer only a question about a criterion'
  if (has('criterion') && has('drop')) return 'both criterion and drop'
  if (has('criterion') && (typeof a.criterion !== 'string' || !a.criterion.trim())) return 'criterion is not text'
  if (has('drop') && typeof a.drop !== 'boolean') return 'drop is not true or false'
  if (has('implement') && q.kind !== 'design') return 'implement answers only a question about the design review allowance'
  if (has('implement') && typeof a.implement !== 'boolean') return 'implement is not true or false'
  return ''
}

// Sorts the answers against the run's questions: knownIds are every question the run has asked,
// current the stop's. Answers to earlier stops are skipped. unknown: a malformed or repeated ID, or
// one the run never asked; with hold, an ID numbered above every known one is held for a later
// stop instead (a native run can't tell a replayed stop from a live one). invalid: an answer to a
// current question the run cannot apply. missing: a current question without a valid answer.
function pairAnswerCheck(answers, knownIds, current, hold) {
  const known = new Set(knownIds), top = Math.max(0, ...knownIds.map(id => Number(String(id).slice(1)) || 0))
  const seen = new Set(), answered = [], unknown = [], invalid = [], held = []
  for (const a of Array.isArray(answers) ? answers : []) {
    const id = a && typeof a === 'object' ? a.id : undefined
    if (typeof id !== 'string' || !/^Q[1-9][0-9]*$/.test(id)) { unknown.push(pairAnswerName(id)); continue }
    if (seen.has(id)) { unknown.push(`${id} (repeated)`); continue }
    seen.add(id)
    if (!known.has(id)) { (hold && Number(id.slice(1)) > top ? held : unknown).push(id); continue }
    const q = current.find(x => x.id === id)
    if (!q) continue
    const why = pairAnswerProblem(a, q)
    if (why) { invalid.push(`${id} (${why})`); continue }
    answered.push({ id, answer: a.answer.trim(), ...(typeof a.criterion === 'string' ? { criterion: a.criterion.trim() } : {}), ...(a.drop === true ? { drop: true } : {}),
      ...(a.implement === true ? { implement: true } : {}) })
  }
  return { answered, missing: current.map(q => q.id).filter(id => !answered.some(a => a.id === id)), unknown, invalid, held }
}

function pairAnswerMessage(check, current) {
  const part = (name, xs) => xs.length ? ` ${name}: ${xs.join(', ')}.` : ''
  return `The answers do not settle this stop (${current.map(q => q.id).join(', ')}).${part('Missing', check.missing)}${part('Unknown', check.unknown)}${part('Invalid', check.invalid)} ` +
    'Answer every question at this stop under its ID, and only questions this run asked.'
}

// The standalone runner's check of a resume's answers against the stopped run's result. The run's
// history says which questions exist: those earlier stops took (decisions) and the stop being
// resumed (questions), never the clarifications saved with it. Nothing is held: the runner knows
// the stop.
function pairResumeAnswerCheck(prior, clarifications) {
  const current = (Array.isArray(prior?.questions) ? prior.questions : []).filter(q => q && typeof q.id === 'string')
  const known = [...(Array.isArray(prior?.decisions) ? prior.decisions : []).map(d => d?.id), ...current.map(q => q.id)].filter(id => typeof id === 'string')
  const check = pairAnswerCheck(pairAnswersOf(clarifications), known, current, false)
  const settled = !check.missing.length && !check.unknown.length && !check.invalid.length
  return { ...check, settled, message: settled ? '' : pairAnswerMessage(check, current) }
}

// The engine's check at a stop. answered: every question at it has a valid answer; incomplete: an
// unknown or invalid ID, or some of the questions answered; unanswered: nothing for this stop.
function pairTakeAnswers(S) {
  const p = S.pair
  const check = pairAnswerCheck(S.pairOptions.answers || [], p.asked.map(q => q.id), p.questions, true)
  const state = check.unknown.length || check.invalid.length || (check.answered.length && check.missing.length) ? 'incomplete'
    : check.answered.length ? 'answered' : 'unanswered'
  return { ...check, state }
}

// The identity of a stop's answers, which the native resume check records: continuing one stop
// twice with different answers is refused. implement is added only when given, so an answer
// without it keeps the hash it had before the field existed.
function pairAnswersHash(S, answered) {
  return promptHash(JSON.stringify(answered.map(a => [a.id, a.answer, a.criterion ?? null, a.drop ?? null, ...(a.implement ? [true] : [])])))
}

// The answers become decisions: in every later prompt, the result and the review version. A
// criterion answer rewrites or drops that criterion (IDs are never renumbered). A reading ruled
// needs-user that an answered question cites goes back to proposed, for the next review to rule on.
function pairApplyDecisions(S, answered) {
  const p = S.pair
  for (const a of answered) {
    const q = p.asked.find(x => x.id === a.id)
    p.decisions.push({ id: q.id, about: q.about, kind: q.kind, question: q.question, answer: a.answer, label: q.label,
      ...(a.criterion !== undefined ? { criterion: a.criterion } : {}), ...(a.drop ? { drop: true } : {}), ...(a.implement ? { implement: true } : {}) })
    if (q.kind === 'criterion' && a.criterion !== undefined) S.criteria = S.criteria.map(c => c.id === q.about ? { ...c, text: a.criterion } : c)
    if (q.kind === 'criterion' && a.drop) S.criteria = S.criteria.filter(c => c.id !== q.about)
    const cited = new Set(q.question.match(/\bR\d+\b/g) || [])
    for (const r of p.readings.filter(r => r.status === 'needs-user' && cited.has(r.id))) {
      r.status = 'proposed'
      r.history.push({ decision: q.id, status: 'proposed', evidence: `The user answered ${q.id}; the next review rules on the reading again.` })
    }
  }
  p.questions = []
  p.stop = ''
}

// Answers no stop took: held for a stop the run never reached, or unknown.
function pairUnusedAnswers(S) {
  const p = S.pair, taken = new Set([...p.decisions.map(d => d.id), ...p.questions.map(q => q.id)])
  return [...new Set((S.pairOptions.answers || []).map(a => pairAnswerName(a?.id)).filter(id => !taken.has(id)))]
}

function pairNewRun(S, post = S.pair.label && S.run ? `${S.run.room}/${S.pair.label}/A.md` : null) {
  return `start a new run with the same task and the user's answers in context${post ? `, passing the last handoff (${post}) in plan` : ''}`
}

// How to continue a resumable needs-user stop, by host: native (the same Claude Code session only),
// codex (the standalone runner's checkpoint) or cli (runtime: "cli" from Claude Code, which reads
// the questions and the last handoff from the runner's result).
function pairResumeSteps(S, via, hostRunDir, questions = S.pair.questions, post = undefined) {
  const name = S.factory ? 'factory' : 'pair', slash = `/${name}`
  const ids = questions.map(q => q.id).join(', ')
  const entries = '[<any earlier clarifications, unchanged>, {id, answer}, …]'
  const how = via === 'native'
    ? `To continue this ${slash} run, in this same Claude Code session only, call Workflow({name: "${workflowCall(name)}", resumeFromRunId: <this run's id>, args: <the same args as before, as an object (if you passed a plain string, use {task: <that string>}), plus clarifications: ${entries}>}). The turns before this stop replay from the session's cache; another session has no such cache.`
    : via === 'codex'
      ? `To continue this ${S.factory ? `${slash} ` : ''}run, write a JSON file holding {"clarifications": ${entries}} and run dark-factory-codex --resume ${shp(hostRunDir)} --args-file <that file>. The runner checks every answer before any turn and replays the turns before this stop from its checkpoint.`
      : `To continue this run, call ${slash} again with the same args plus runtime: "cli", resume: "${hostRunDir}" and clarifications: ${entries}. The runner checks every answer before any turn and replays the turns before this stop from its checkpoint.`
  return `This run stopped for the user's answers. Show questions[] to the user, each under its ID with what it is about, and ask for an answer to every one (${ids}). ` +
    'An answer is {id, answer}; one to a question of kind criterion may also give criterion (the criterion\'s new text) or drop: true (to remove it). ' +
    (questions.some(q => q.kind === 'design') ? 'One to a question of kind design continues the design with the answer as a scope decision, or, with implement: true, starts the implementation with the open design findings carried into code review; to stop, don\'t continue the run. ' : '') +
    `${how} Don't run dark-factory cleanup on the stopped run, and don't change its worktree or the checkout: continuing needs them as they are. ` +
    `If the run cannot continue (a refused check${via === 'native' ? ', or a new session' : ''}), ${pairNewRun(S, post)}.`
}

// A challenge may cite, beside checks that cover its criterion, a check that covers only another
// criterion or none in the contract. The covering checks already carry the challenge, so the
// stray IDs are dropped rather than costing a correction turn. Returns what was dropped.
function pairTrimChallenges(S, review) {
  const checks = S.pair.testContract?.checks
  if (!Array.isArray(checks) || !Array.isArray(review?.challenges)) return []
  const dropped = []
  for (const c of review.challenges) {
    if (!Array.isArray(c?.rejectingCheckIds)) continue
    const covering = c.rejectingCheckIds.filter(id => checks.some(check => check.id === id && Array.isArray(check.criteria) && check.criteria.includes(c.criterion)))
    if (!covering.length || covering.length === c.rejectingCheckIds.length) continue
    dropped.push(`${c.criterion}: ${[...new Set(c.rejectingCheckIds.filter(id => !covering.includes(id)))].join(', ')}`)
    c.rejectingCheckIds = covering
  }
  return dropped
}

// Without a design stage no design review challenged the contract, so a code review does: the
// first one, and any after the contract changed since a review last passed the challenge check.
function pairChallengesDue(S) {
  const p = S.pair
  return !pairDesigned(S) && p.stage === 'code' && !!p.approvedContract && p.challengedContract !== promptHash(JSON.stringify(p.approvedContract))
}

function pairChallengeError(S, review) {
  const contract = S.pair.testContract, error = pairContractError(S, contract)
  if (error) return error
  const challenges = review.challenges
  if (!Array.isArray(challenges) || challenges.length !== S.criteria.length ||
      new Set(challenges.map(c => c.criterion)).size !== S.criteria.length) {
    const given = Array.isArray(challenges) ? challenges.map(c => c?.criterion) : []
    const missing = S.criteria.map(c => c.id).filter(id => !given.includes(id))
    const repeated = given.filter((id, i) => given.indexOf(id) !== i)
    return `${S.pair.stage === 'code' ? 'This code review' : 'Design review'} needs exactly one challenge for each acceptance criterion (${S.criteria.map(c => c.id).join(', ')}).` +
      `${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${repeated.length ? ` Repeated: ${[...new Set(repeated)].join(', ')}.` : ''}`
  }
  // A minor design finding does not hold the design (pairReadiness), so at design it cannot stand
  // in for the missing rejecting check either.
  const rejecting = S.pair.stage === 'design' ? ['blocker', 'major'] : ['blocker', 'major', 'minor']
  for (const c of challenges) {
    const rejectsDesign = review.requiresDesignRevision === true ||
      (review.findings || []).some(f => String(f.statement || '').trim() && String(f.evidence || '').trim() && rejecting.includes(f.severity)) ||
      (review.criteria || []).some(a => a.criterion === c.criterion && ['partial', 'unmet'].includes(a.status) && String(a.note || '').trim())
    const covers = id => contract.checks.some(check => check.id === id && check.criteria.includes(c.criterion))
    if (!S.criteria.some(x => x.id === c.criterion)) return `Challenge ${c.criterion} names no acceptance criterion.`
    if (!String(c.wrongImplementation || '').trim()) return `Challenge ${c.criterion} needs a plausible wrong implementation.`
    if (!Array.isArray(c.rejectingCheckIds) || new Set(c.rejectingCheckIds).size !== c.rejectingCheckIds.length) return `Challenge ${c.criterion} needs distinct rejectingCheckIds.`
    if (!c.rejectingCheckIds.length && !rejectsDesign) return `Challenge ${c.criterion} cites no rejecting check. Cite a contract check whose criteria include ${c.criterion}, or, if none rejects the wrong implementation, raise an evidenced ${S.pair.stage === 'design' ? 'blocker or major ' : ''}finding or assess ${c.criterion} partial or unmet.`
    const stray = c.rejectingCheckIds.filter(id => !covers(id))
    if (stray.length) {
      const owner = id => contract.checks.find(check => check.id === id)
      return `Challenge ${c.criterion} cites ${stray.map(id => owner(id) ? `${id}, which covers ${owner(id).criteria.join(', ')}` : `${id}, which is not in the contract`).join('; ')}. ` +
        `Cite only checks whose criteria include ${c.criterion}: ${contract.checks.filter(check => check.criteria.includes(c.criterion)).map(check => check.id).join(', ') || 'none'}.`
    }
  }
  return null
}

function pairReplayRequest(S) {
  return { testRoots: (S.pair.approvedContract?.testRoots || []).map(r => r.path), mapping: S.pair.replayMapping }
}

function pairMappingError(S) {
  const checks = S.pair.approvedContract?.checks || []
  const roots = (S.pair.approvedContract?.testRoots || []).map(r => r.path)
  const inside = path => pairRelativePath(S, path) && roots.some(root => path.startsWith(root + '/'))
  for (const e of S.pair.replayMapping) {
    if (!inside(e.file) || !String(e.command || '').trim() || !Array.isArray(e.fixtures) || e.fixtures.some(f => !inside(f)) ||
        !Array.isArray(e.checkIds) || !e.checkIds.length || new Set(e.checkIds).size !== e.checkIds.length ||
        e.checkIds.some(id => !checks.some(c => c.id === id && c.kind === 'test'))) return 'Replay mappings require test files and fixtures under accepted roots, focused commands, and executable check IDs. Whole-suite obligations use kind=gate, never a directory mapping.'
  }
  const missing = checks.filter(c => c.kind === 'test' && !S.pair.replayMapping.some(e => e.checkIds.includes(c.id)))
  return missing.length ? `No replay mapping for ${missing.map(c => c.id).join(', ')}.` : null
}

// Without a design stage the author's contract is the obligation from this turn on. An empty one
// after the first keeps the contract already in force. Returns why it can't be accepted, or null.
function pairAdoptContract(S, author) {
  const p = S.pair, given = author.testContract
  const contract = p.approvedContract && !given?.testRoots?.length && !given?.checks?.length ? p.approvedContract : given
  const error = pairContractError(S, contract)
  if (error) return error
  p.testContract = contract
  p.approvedContract = JSON.parse(JSON.stringify(contract))
  p.replayMapping = author.replayMapping || []
  return pairMappingError(S)
}

function pairReplayReadiness(S, blocked, incomplete) {
  const p = S.pair, replay = p.measurement?.replay, request = pairReplayRequest(S)
  const mappingIdentity = entries => JSON.stringify(entries?.map(e => [e.file, e.command, e.checkIds, e.fixtures]))
  if (!replay || replay.snapshotTree !== p.measurement?.snapshot?.tree || !/^[0-9a-f]{40,64}$/.test(S.run?.head || '') || replay.base !== S.run.head ||
      !/^[0-9a-f]{40,64}$/.test(replay.snapshot || '') || JSON.stringify(replay.testRoots) !== JSON.stringify(request.testRoots) ||
      mappingIdentity(replay.mapping) !== mappingIdentity(request.mapping)) {
    incomplete.push('No compatible replay evidence for the measured snapshot and current mapping.')
    return
  }
  const checks = p.approvedContract?.checks || []
  for (const check of checks.filter(c => c.kind === 'gate')) {
    if (check.command !== S.verify || p.measurement?.suite?.command !== check.command || !p.measurement.suite.ran) incomplete.push(`No designated gate execution for ${check.id}.`)
    else if (!p.measurement.suite.passed) blocked.push(`Designated gate check ${check.id} failed.`)
  }
  for (const entry of p.replayMapping) {
    if (!Array.isArray(entry.checkIds) || !entry.checkIds.length || entry.checkIds.some(id => !checks.some(c => c.id === id && c.kind === 'test'))) incomplete.push('Replay mapping contains unknown or non-executable check IDs.')
  }
  for (const check of checks.filter(c => c.kind === 'test')) {
    const mappings = p.replayMapping.filter(e => e.checkIds?.includes(check.id))
    if (!mappings.length) { incomplete.push(`No replay mapping for ${check.id}.`); continue }
    for (const entry of mappings) {
      const records = side => (replay.records || []).filter(r => r.side === side && r.file === entry.file && r.command === entry.command &&
        r.checkIds?.includes(check.id) && r.attempted === true && r.revision === (side === 'base' ? replay.base : replay.snapshot) &&
        ((r.ran === true && r.hasExitCode === true && Number.isInteger(r.exitCode)) || String(r.launchError || '').trim()) &&
        (side === 'base' || r.tree === replay.snapshotTree))
      if (check.purpose === 'changed' && !records('base').length) incomplete.push(`No base execution result for ${check.id} (${entry.file}).`)
      const final = records('final')
      if (!final.length) incomplete.push(`No final execution result for ${check.id} (${entry.file}).`)
      else if (final.some(r => !r.ran || !r.hasExitCode || r.exitCode !== 0 || r.signal || r.timedOut || r.launchError || r.mutated?.length || r.passed !== true)) blocked.push(`Final executable check ${check.id} failed (${entry.file}).`)
    }
  }
}

function pairIngestReview(S, review) {
  const p = S.pair, before = p.findings.length
  if (!review || review.version !== pairVersion(S) || review.complete !== true) return 'The reviewer did not complete a review of the current version.'
  const challenged = pairChallengesDue(S)
  if (p.stage === 'design' || challenged) {
    const error = pairChallengeError(S, review)
    if (error) return error
  }
  const criteriaError = pairCriteriaError(S, review)
  if (criteriaError) return criteriaError
  const rulingsError = pairRulingsError(S, review)
  if (rulingsError) return rulingsError
  const questionsError = pairQuestionsError(S, review)
  if (questionsError) return questionsError
  const resolutions = review.resolutions || []
  const seen = new Set()
  for (const r of resolutions) {
    if (!p.findings.some(f => f.id === r.id) || seen.has(r.id) || !['open', 'fixed', 'refuted'].includes(r.status) || !String(r.evidence || '').trim()) {
      return 'The reviewer returned an invalid or unsupported finding resolution.'
    }
    if (p.stage === 'design' && r.status === 'fixed' && p.findings.find(f => f.id === r.id).stage === 'code') {
      return 'Implementation findings must be verified against code, not closed by a revised design.'
    }
    seen.add(r.id)
  }
  for (const f of review.findings || []) {
    if (!String(f.statement || '').trim() || !String(f.evidence || '').trim() || !['blocker', 'major', 'minor'].includes(f.severity)) {
      return 'The reviewer returned a finding without a statement, severity, or evidence.'
    }
  }
  for (const r of resolutions) {
    const f = p.findings.find(f => f.id === r.id)
    f.status = r.status
    f.resolution = r.evidence
    f.history.push({ review: p.reviews.length + 1, ...r })
  }
  for (const f of review.findings || []) {
    // Suppress literal repeats only. Reworded issues retain identity through resolutions,
    // never by fuzzy matching that could merge distinct defects.
    const same = p.findings.find(old => old.stage === p.stage && old.status === 'open' && old.statement.trim().replace(/\s+/g, ' ') === f.statement.trim().replace(/\s+/g, ' '))
    if (same) { same.history.push({ review: p.reviews.length + 1, status: 'open', evidence: f.evidence }); continue }
    p.findings.push({ ...f, id: `P${p.findings.length + 1}`, stage: p.stage, status: 'open', resolution: '', history: [] })
  }
  // A rejected reading comes back to the author as an ordinary open finding, which only the
  // reviewer can close.
  for (const ruling of review.rulings || []) {
    const r = p.readings.find(r => r.id === ruling.id)
    r.status = ruling.ruling
    r.evidence = ruling.evidence
    r.history.push({ review: p.reviews.length + 1, status: ruling.ruling, evidence: ruling.evidence })
    if (ruling.ruling !== 'rejected') continue
    r.finding = `P${p.findings.length + 1}`
    p.findings.push({ severity: 'major', statement: `Reading ${r.id} was rejected: meet ${r.requirement} as written, not as "${oneLine(r.reading, 300).replace(/\.$/, '')}". ${oneLine(ruling.evidence, 600)}`,
      evidence: ruling.evidence, id: r.finding, stage: p.stage, status: 'open', resolution: '', history: [], reading: r.id })
  }
  if (challenged) p.challengedContract = promptHash(JSON.stringify(p.approvedContract))
  // The process note is for the retro (S.processNotes), not for the author's next turn.
  const { process: note, ...kept } = review
  p.lastReview = kept
  p.reviews.push({ stage: p.stage, label: p.label, ...kept })
  if (p.stage === 'design') {
    ;(p.designRounds ||= []).push({ review: p.reviews.length, label: p.label, fresh: p.findings.length - before,
      ...pairSeverityCounts(pairOpen(S).filter(f => f.stage === 'design')), words: String(p.design || '').split(/\s+/).filter(Boolean).length })
  }
  return null
}

// Whether the helper's measurement failed for reasons outside the snapshot: its disposable
// checkout could not be made, or the gate's environment failed after bounded recovery.
function pairInfrastructure(S) {
  const m = S.pair.stage === 'code' ? S.pair.measurement : null
  if (!m) return []
  const out = []
  if (String(m.scratchError || '').trim()) out.push(`The verification checkout failed: ${oneLine(m.scratchError, 400)}`)
  else if (m.suite?.failureKind === 'infrastructure') out.push(`The verification environment failed after bounded recovery${m.suite.log ? `; see ${m.suite.log}` : ''}.`)
  return out
}

function pairReadiness(S) {
  const p = S.pair, r = p.lastReview
  const blocked = [], incomplete = [], infrastructure = pairInfrastructure(S)
  if (p.stop) incomplete.push(p.stop)
  if (!r || r.version !== pairVersion(S) || !r.complete) incomplete.push('The current version has no completed review.')
  // At the design stage a minor design finding does not hold the design: it stays open into the
  // code stage, where every open finding blocks.
  for (const f of pairOpen(S).filter(f => p.stage === 'code' || (f.stage === 'design' && f.severity !== 'minor'))) blocked.push(`${f.id} (${f.severity}): ${f.statement}`)
  for (const r of p.readings.filter(r => r.status === 'proposed')) incomplete.push(`Reading ${r.id} has no ruling.`)
  for (const r of p.readings.filter(r => r.status === 'needs-user')) incomplete.push(`Reading ${r.id} needs a user decision.`)
  if (!S.criteria.length) incomplete.push('No acceptance criteria were established.')
  for (const c of S.criteria) {
    const assessments = (r?.criteria || []).filter(x => x.criterion === c.id)
    if (assessments.length !== 1 || !String(assessments[0].note || '').trim()) incomplete.push(`No single evidenced assessment of ${c.id}.`)
    // With no measurement to read, a reviewer can't call a criterion that needs one met: partial
    // then reports missing evidence, not a defect.
    else if (assessments[0].status === 'partial' && infrastructure.length) incomplete.push(`Criterion ${c.id} is partial: ${oneLine(assessments[0].note, 300)}`)
    else if (assessments[0].status !== 'met') blocked.push(`Criterion ${c.id} is ${assessments[0].status}.`)
  }
  if (p.stage === 'code') {
    if (!p.approvedDesign && pairDesigned(S)) incomplete.push('The design has not passed review.')
    if (!p.approvedContract) incomplete.push('The test contract has not passed review.')
    const m = p.measurement
    if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '')) incomplete.push('No measured snapshot of the current implementation.')
    if (S.verify && !m?.suite?.ran) incomplete.push('Required verification did not run.')
    else if (S.verify && !m.suite.passed) blocked.push('Required verification failed on the reviewed snapshot.')
    pairReplayReadiness(S, blocked, incomplete)
  }
  if (r?.requiresDesignRevision) blocked.push('The reviewer requires a revised design.')
  // unverified: nothing the review found is open, but the run could not measure the snapshot.
  // liveChecks: what the user runs against the real thing before delivery; it never sets the state.
  return { state: blocked.length ? 'blocked' : infrastructure.length ? 'unverified' : incomplete.length ? 'incomplete' : 'ready', blocked, incomplete, infrastructure,
    liveChecks: (p.liveChecks || []).map(c => ({ ...c })) }
}

function pairStalled(S) {
  const p = S.pair
  if (pairReadiness(S).state === 'ready') return false
  // Criterion statuses are left out: a reviewer can move one between partial and met on the same
  // bytes, and that noise must not hide an author who changed nothing.
  const signature = JSON.stringify([pairVersion(S), pairOpen(S).map(f => [f.id, f.statement]),
    p.lastReview?.requiresDesignRevision,
    p.measurement?.suite?.ran, p.measurement?.suite?.passed, pairReplayRequest(S),
    p.measurement?.replay?.exclusions, p.measurement?.replay?.records?.map(r => [r.side, r.file, r.command, r.checkIds, r.attempted, r.ran, r.hasExitCode, r.exitCode, r.signal, r.timedOut, r.launchError, r.passed, r.mutated])])
  p.signatures.push(signature)
  return p.signatures.length >= 2 && p.signatures.at(-2) === signature
}

function pairReviewClean(S) {
  const r = S.pair.lastReview
  return r?.complete && r.version === pairVersion(S) && !r.requiresDesignRevision && !pairOpen(S).length &&
    S.criteria.every(c => r.criteria.filter(a => a.criterion === c.id).length === 1 && r.criteria.some(a => a.criterion === c.id && a.status === 'met' && a.note?.trim()))
}

// The design reviews the run may spend before it stops for the user: maxDesignReviews, and as many
// again for every answer that continued the design. Counted over the whole run, a return to
// design from the code stage included; the total budget bounds it as always.
function pairDesignAllowance(S) {
  const continued = (S.pair.decisions || []).filter(d => d.kind === 'design' && !d.implement).length
  return S.pairOptions.maxDesignReviews * (1 + continued)
}

// After a design review that did not approve the design: whether the design has spent its
// allowance, with budget left for the user's choice to buy anything.
function pairDesignCapped(S) {
  const p = S.pair
  return pairDesigned(S) && p.stage === 'design' && p.reviews.length < S.pairOptions.maxReviews &&
    p.reviews.filter(r => r.stage === 'design').length >= pairDesignAllowance(S)
}

// Open findings by severity, as counts ({blocker, major, minor}), in words: "1 major, 2 minor".
const pairSeverityCounts = fs => Object.fromEntries(['blocker', 'major', 'minor'].map(s => [s, fs.filter(f => f.severity === s).length]))
const pairSeverities = counts => ['blocker', 'major', 'minor'].filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(', ')

// The stop's reason, and its one question: how the design rounds went, what is open, the choices.
function pairDesignStopReason(S) {
  const p = S.pair, open = pairOpen(S).filter(f => f.stage === 'design')
  const used = p.reviews.filter(r => r.stage === 'design').length
  return `The design used its review allowance (${used} of ${pairDesignAllowance(S)} design reviews) without approval` +
    `${open.length ? `, with ${plural(open.length, 'design finding')} open (${pairSeverities(pairSeverityCounts(open))})` : ''}.`
}

function pairDesignQuestion(S) {
  const p = S.pair, o = S.pairOptions, open = pairOpen(S).filter(f => f.stage === 'design')
  const rounds = (p.designRounds || []).map(r => `review ${r.review}: ${plural(r.fresh, 'new finding')}; open ${pairSeverities(r) || 'none'}; design ${r.words} words`).join('. ')
  const left = o.maxReviews - p.reviews.length
  return `${pairDesignStopReason(S)} Design rounds: ${rounds}. ` +
    `Open design findings: ${open.map(f => `${f.id} (${f.severity}) ${pairBrief(f.statement, 160)}`).join('; ') || 'none'}${open.length ? '.' : ''} ` +
    `${plural(left, 'review')} of ${o.maxReviews} remain. Choose one. (a) Continue the design: answer with a scope decision the author and reviewer then follow, ` +
    `for example narrow the scope, or accept named findings as documented residuals; the design gets up to ${plural(o.maxDesignReviews, 'more review')}. ` +
    '(b) Start the implementation now: answer with implement: true; the open design findings carry into code review as open items, and each still blocks readiness until the reviewer closes it. ' +
    '(c) Stop: don\'t continue this run.'
}

// The choice the user made at a design stop (question `id`): implement, or continue the design.
function pairDesignChoice(S, id) {
  return (S.pair.decisions || []).some(d => d.id === id && d.kind === 'design' && d.implement) ? 'implement' : 'continue'
}

// The story lines of a pair run (tellStory): setup, each author pass, each review, each stop.
// Words for a story line: no trailing period, so a line can end with its own.
const pairBrief = (s, n) => oneLine(s, n).replace(/[.\s]+$/, '')

function pairSetupLine(S) {
  const ids = S.criteria.map(c => c.id)
  const gate = !S.verify ? 'no automated gate' : `gate \`${oneLine(S.verify, 160)}\` ${S.baselineOk === false ? `already failing at base (${pairBrief(S.baselineNote, 200)})` : 'passing at base'}`
  return `Setup: ${ids.length} acceptance ${ids.length === 1 ? 'criterion' : 'criteria'} (${ids.join(', ')}); ${gate}.`
}

// The author's reply to each open finding, changed or disputed, from its last turn of a pass. Only
// the reviewer closes a finding; a reply records what the author did about it.
function pairIngestReplies(S, author) {
  const p = S.pair, seen = new Set()
  for (const a of Array.isArray(author?.addressed) ? author.addressed : []) {
    const id = (String(a?.id || '').match(/\bP\d+\b/) || [])[0]
    const f = p.findings.find(f => f.id === id)
    if (!f || f.status !== 'open' || seen.has(id)) continue
    seen.add(id)
    p.replies.push({ id, turn: p.label, stage: p.stage, action: a.action === 'disputed' ? 'disputed' : 'changed', response: String(a.response || '').trim() })
  }
}

function pairGateLine(S) {
  const m = S.pair.measurement
  if (!S.verify || S.pair.stage !== 'code') return ''
  if (pairInfrastructure(S).length) return 'The gate could not run: the verification environment failed.'
  if (!m?.suite?.ran) return 'The gate did not run.'
  return m.suite.passed ? 'The gate passed on its snapshot.' : 'The gate failed on its snapshot.'
}

// After the author's pass and, for code, its measurement.
function pairAuthorLine(S) {
  const p = S.pair
  const did = p.stage === 'design' ? (p.reviews.some(r => r.stage === 'design') ? 'revised the design' : 'drafted the design')
    : p.reviews.some(r => r.stage === 'code') ? 'revised the implementation' : pairDesigned(S) ? 'implemented the approved design' : 'implemented the task'
  const mine = p.replies.filter(r => r.turn === p.label)
  const out = [`${S.pairOptions.author.name} ${did}.`]
  const changed = mine.filter(r => r.action === 'changed').map(r => r.id)
  if (changed.length) out.push(`Changed ${changed.join(', ')}.`)
  for (const r of mine.filter(r => r.action === 'disputed')) out.push(`Disputed ${r.id}: ${sentence(pairBrief(r.response, 200) || 'no reason given')}`)
  const silent = pairOpen(S).filter(f => !mine.some(r => r.id === f.id)).map(f => f.id)
  if (silent.length) out.push(`No reply to ${silent.join(', ')}.`)
  for (const r of p.readings.filter(r => r.turn === p.label)) out.push(`Proposed reading ${r.id} of ${pairBrief(r.requirement, 60)}: ${sentence(pairBrief(r.reading, 160))}`)
  const gate = pairGateLine(S)
  if (gate) out.push(gate)
  return out.join(' ')
}

// After a review is recorded; `before` is how many findings there were before it.
function pairReviewLine(S, review, before) {
  const p = S.pair, ready = pairReadiness(S)
  const verdict = ready.state === 'ready' ? 'approved' : ready.state === 'blocked' ? 'changes requested'
    : ready.state === 'unverified' ? 'nothing open, but the snapshot could not be measured'
    : `incomplete (${pairBrief(ready.incomplete[0] || 'no reason recorded', 160)})`
  const out = [`${p.stage === 'design' ? 'Design' : 'Code'} review ${p.reviews.length}/${S.pairOptions.maxReviews} by ${S.pairOptions.reviewer.name}: ${verdict}.`]
  for (const [status, word] of [['fixed', 'Fixed'], ['refuted', 'Refuted']]) {
    const ids = (review.resolutions || []).filter(r => r.status === status).map(r => r.id)
    if (ids.length) out.push(`${word} ${ids.join(', ')}.`)
  }
  const open = p.findings.slice(0, before).filter(f => f.status === 'open').map(f => f.id)
  if (open.length) out.push(`Still open: ${open.join(', ')}.`)
  const fresh = p.findings.slice(before).filter(f => !f.reading)
  if (fresh.length) out.push(`New: ${fresh.map(f => `${f.id} (${f.severity}) ${pairBrief(f.statement, 140)}`).join('; ')}.`)
  for (const r of review.rulings || []) {
    const reading = p.readings.find(x => x.id === r.id)
    out.push(r.ruling === 'accepted' ? `Accepted reading ${r.id}.` : r.ruling === 'rejected' ? `Rejected reading ${r.id}, filed as ${reading?.finding || 'a finding'}.` : `Reading ${r.id} goes to the user.`)
  }
  const short = (review.criteria || []).filter(c => c.status !== 'met').map(c => `${c.criterion} ${c.status}`)
  out.push(short.length ? `Criteria: ${short.join(', ')}.` : 'Criteria all met.')
  const carried = p.stage === 'design' && ready.state === 'ready' ? pairOpen(S).filter(f => f.stage === 'design').map(f => f.id) : []
  if (carried.length) out.push(`Minor ${carried.length === 1 ? 'finding' : 'findings'} ${carried.join(', ')} ${carried.length === 1 ? 'stays' : 'stay'} open for code review.`)
  if (p.stage === 'code' && review.requiresDesignRevision && pairDesigned(S)) out.push('Requires a revised design.')
  return out.join(' ')
}

function pairQuestionsLine(S, kind, questions) {
  if (kind === 'design') return `${pairDesignStopReason(S)} The run asked the user ${questions.map(q => q.id).join(', ')}: continue the design with a scope decision, start the implementation with the open design findings, or stop.`
  const who = kind === 'reviewer' ? S.pairOptions.reviewer.name : kind === 'author' ? S.pairOptions.author.name : 'Setup'
  return `${who} asked the user ${questions.length === 1 ? 'a question' : `${questions.length} questions`}: ${questions.map(q => `${q.id}${q.about !== 'none' ? ` (about ${q.about})` : ''} ${pairBrief(q.question.split(' Requirements as written:')[0], 200)}`).join('; ')}`.replace(/[^.!?…]$/, '$&.')
}

function pairEndLine(S, status, ready) {
  const p = S.pair, reviews = `${plural(p.reviews.length, 'review')} of ${S.pairOptions.maxReviews}`
  if (status === 'done' && ready.state === 'ready') return `Ready after ${reviews}.`
  if (status === 'needs-user') return `Stopped after ${reviews} for the user's answers.`
  return `Stopped after ${reviews} (${status}, readiness ${ready.state}): ${sentence(pairBrief(p.stop, 300) || 'no reason recorded')}`
}

// What a reader of the report would want pointed out: the author's disputes and how they ended,
// findings that took more than one revision, blockers, readings ruled on, and designs sent back.
function pairHighlights(S) {
  const p = S.pair, A = S.pairOptions.author.name, R = S.pairOptions.reviewer.name, out = [], told = new Set()
  const fate = f => f.status === 'refuted' ? `${R} accepted that and refuted it` : f.status === 'fixed' ? 'it was later fixed' : 'it is still open'
  const disputes = [...new Map(p.replies.filter(r => r.action === 'disputed').map(r => [r.id, r])).values()]
  for (const r of disputes) {
    const f = p.findings.find(f => f.id === r.id)
    told.add(f.id)
    out.push(`${A} disputed ${f.id} (${f.severity}, ${f.stage}), "${pairBrief(f.statement, 160)}": ${sentence(pairBrief(r.response, 240) || 'no reason given')} ${fate(f)[0].toUpperCase()}${fate(f).slice(1)}.`)
  }
  for (const f of p.findings.filter(f => !told.has(f.id) && !f.reading)) {
    const kept = new Set(f.history.filter(h => h.status === 'open').map(h => h.review)).size
    if (!kept && f.severity !== 'blocker') continue
    told.add(f.id)
    const how = !kept ? `${f.status === 'open' ? 'is still open' : `was ${f.status}`}` : f.status === 'open' ? `is still open after ${plural(kept + 1, 'revision')}` : `took ${plural(kept + 1, 'revision')} before it was ${f.status}`
    out.push(`${f.id} (${f.severity}, ${f.stage}) ${how}: ${sentence(pairBrief(f.statement, 200))}`)
  }
  for (const r of p.readings.filter(r => r.status === 'accepted' || r.status === 'rejected')) {
    const f = r.finding && p.findings.find(f => f.id === r.finding)
    out.push(r.status === 'accepted' ? `${R} accepted ${A}'s reading ${r.id} of ${pairBrief(r.requirement, 80)}: ${sentence(pairBrief(r.reading, 200))}`
      : `${R} rejected ${A}'s reading ${r.id} of ${pairBrief(r.requirement, 80)} ("${pairBrief(r.reading, 160)}"); it was filed as ${r.finding}, now ${f ? f.status : 'open'}.`)
  }
  p.reviews.forEach((r, i) => {
    if (r.stage === 'code' && r.requiresDesignRevision && pairDesigned(S)) out.push(`Code review ${i + 1} sent the work back to design: ${sentence(pairBrief(r.summary, 240) || 'no summary given')}`)
  })
  for (const q of p.asked.filter(q => q.kind === 'design')) {
    const d = p.decisions.find(d => d.id === q.id)
    out.push(`The design reached its review allowance in ${q.label}; ${!d ? `the run stopped for the user (${q.id})`
      : d.implement ? `the user chose to start the implementation with the open design findings carried into code review (${q.id})`
      : `the user continued the design (${q.id}): ${pairBrief(d.answer, 200) || 'no answer given'}`}.`)
  }
  return out
}

// The explicit env overrides from verification.json the measured gate ran with, by name; {} when
// there are none or nothing was measured. They are reported, and never change readiness.
function pairOverrides(S, m) {
  return Object.fromEntries((Array.isArray(m?.suite?.overrides) ? m.suite.overrides : []).map(o => [o.name, o.value]))
}

function pairResult(S, status = 'blocked') {
  const p = S.pair, m = p.stage === 'code' ? p.measurement : null
  const ready = pairReadiness(S), overrides = pairOverrides(S, m)
  if (p.stage !== 'code' && ready.state === 'ready') {
    ready.state = 'incomplete'; ready.incomplete.push('Implementation has not been reviewed.')
  }
  // A stop's questions, from setup, the author or the reviewer, are what the user is asked. Only a
  // needs-user stop that can continue carries resume steps; every other result carries none.
  const questions = p.questions || [], unused = pairUnusedAnswers(S)
  const resumable = status === 'needs-user' && p.resumable && questions.length > 0
  const hostRunDir = S.host === 'codex' && S.raw.repo && S.raw.hostRunId ? `${S.raw.repo}/.council/${S.raw.hostRunId}` : '<hostRunDir>'
  const resumeSteps = resumable ? pairResumeSteps(S, S.host === 'codex' ? 'codex' : 'native', hostRunDir) : ''
  const live = ready.liveChecks, pending = [...new Set(live.map(c => c.criterion))]
  const highlights = pairHighlights(S)
  const report = [`Pair: ${S.pairOptions.author.name} authors; ${S.pairOptions.reviewer.name} reviews.`,
    `Readiness: ${ready.state}${pending.length ? `; live checks pending: ${pending.join(', ')}` : ''}. Reviews: ${p.reviews.length}/${S.pairOptions.maxReviews}.`,
    ...live.map(c => `Live check for ${c.criterion}: ${c.check}${c.reason ? ` (${c.reason})` : ''}`),
    `Verification: ${!S.verify ? 'no automated gate configured; no test pass claimed' : !m?.suite?.ran ? 'not run on a final snapshot' : m.suite.passed ? 'passed on the reviewed snapshot' : 'failed on the reviewed snapshot'}.`,
    ...(Object.keys(overrides).length ? [`Verification overrides: the gate ran with explicit environment overrides from verification.json: ${Object.keys(overrides).sort().join(', ')}.`] : []),
    `Replay: ${m?.replay?.records?.length || 0} file/command records; ${m?.replay?.exclusions?.length || 0} overlay exclusions. Base outcomes require reviewer interpretation.`,
    ...ready.infrastructure, ...ready.blocked, ...ready.incomplete,
    `How the run went:\n\n${[...(S.story || []), pairEndLine(S, status, ready)].map((line, i) => `${i + 1}. ${line}`).join('\n')}`,
    ...(highlights.length ? [`Points of interest:\n\n${highlights.map(h => `- ${h}`).join('\n')}`] : []),
    ...(questions.length ? [`Questions for the user (answer each under its ID):\n\n${questions.map(q => `- ${q.id} (about ${q.about}): ${q.question}`).join('\n')}`] : []),
    ...(p.decisions.length ? [`User decisions:\n\n${p.decisions.map(d => `- ${d.id} (about ${d.about}; asked in ${d.label}): ${d.question} Answer: ${d.answer}` +
      `${typeof d.criterion === 'string' ? ` ${d.about} now reads: ${d.criterion}` : d.drop ? ` ${d.about} was dropped.` : d.implement ? ' The implementation started with the open design findings carried into code review.' : ''}`).join('\n')}`] : []),
    ...(unused.length ? [`Unused answers: ${unused.join(', ')}.`] : []),
    ...p.findings.map(f => `${f.id}: ${f.status} — ${f.statement}${f.resolution ? ` (${f.resolution})` : ''}`),
    ...p.readings.map(r => `${r.id}: reading ${r.status} — ${r.requirement} read as: ${r.reading}${r.evidence ? ` (${r.evidence})` : ''}${r.finding ? `; finding ${r.finding}` : ''}`)].join('\n\n')
  return {
    forTheOrchestrator: 'Read final.readiness first. Report unresolved findings or missing evidence before any success summary. ' +
      (p.readings.some(r => r.status === 'accepted') ? 'Report the accepted readings (readings with status accepted): requirements the reviewer agreed the work may read other than literally. ' : '') +
      (live.length ? 'Before delivery, run each live check (final.readiness.liveChecks) against the real service or resource it names and report its outcome: a ready run with live checks pending is not done until they pass. ' : '') +
      'Spot-check the reviewed snapshot. Show the "How the run went" and "Points of interest" lists from report.markdown as they are: they give the design and implementation reviews in order, from the run\'s record. The change stays in final.worktree. ' +
      'Readiness unverified means no review finding is open but the run could not measure the snapshot (final.readiness.infrastructure says why): run the gate on the delivered bytes before calling it done. ' +
      'Deliver only within the user\'s authorization, preserving unrelated edits. With HEAD at the original base, nothing staged, and no local edits other than those recorded at setup (run.json deliveryBaseline: unstaged tracked edits and untracked files, none on a path the reviewed change touches), ' +
      `dark-factory apply --run-dir ${S.run?.runDir ? shq(S.run.runDir) : '<runDir>'} --result <file> stages the reviewed snapshot and checks its tree hash, leaving those recorded edits in place; it refuses any other checkout. ` +
      'Then run dark-factory verify-delivery with the same --run-dir and --result: files copied by hand are not delivered until it reports delivered. ' +
      'For --result, pass the workflow task\'s output file as it stands (the helper reads the result inside it), or omit --result when the run directory holds result.json. ' +
      `Once the delivery is verified, dark-factory cleanup --run-dir ${S.run?.runDir ? shq(S.run.runDir) : '<runDir>'} removes the run's worktrees and refs/council refs (add --all to remove the run directory too). ` +
      'Do not start a council automatically.' +
      (resumeSteps ? ` ${resumeSteps}` : p.fallback ? ` This stop cannot continue in place: show questions[] to the user, then ${pairNewRun(S)}.` : ''),
    status, workflow: 'pair', mode: 'implement', task: S.task, runDir: S.run?.runDir || null,
    repositoryNotes: S.repositoryNotes || '',
    room: S.run?.room || null, refs: S.refs, stage: p.stage, stopReason: p.stop,
    design: p.design, testContract: p.approvedContract || p.testContract, replayMapping: p.replayMapping,
    author: S.pairOptions.author.name, reviewer: S.pairOptions.reviewer.name,
    reviews: p.reviews, findings: p.findings, readings: p.readings, liveChecks: live, questions, decisions: p.decisions, unusedAnswers: unused,
    ...(resumable ? { resumable: true, resumeSteps } : {}), notes: S.notes,
    report: { markdown: report },
    final: { author: 'A', model: S.pairOptions.author.name, summary: p.author?.summary || '',
      worktree: S.seats[0]?.wt || null, post: p.label && S.run ? `${S.run.room}/${p.label}/A.md` : null,
      snapshotRef: m?.snapshot?.ref || null, snapshotTree: m?.snapshot?.tree || null, diff: m?.snapshot?.diff || null,
      suite: m?.suite ? { ...m.suite, overrides: pairOverrides(S, m) } : null, replay: m?.replay || null, criteria: p.lastReview?.criteria || [], readiness: ready },
    delivery: { status: status === 'done' && ready.state === 'ready' ? 'pending' : 'not-ready' } }
}

