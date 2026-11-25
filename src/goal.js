// The goal stage, before intake or setup: Factory, a standalone Pair or council run, and the Brief
// workflow settle the run's goal brief here. Decisions stay in the workflow. The file helper
// snapshots the document before any implementation worktree exists.
const BRIEF_TEXT = { type: 'string' }
const BRIEF_DELEGATED = ['testing', 'implementation', 'internal design']
const BRIEF_CONTENT = { type: 'object', properties: {
  outcome: BRIEF_TEXT, purpose: BRIEF_TEXT, scope: BRIEF_TEXT, nonGoals: BRIEF_TEXT,
  acceptanceExamples: { type: 'array', items: BRIEF_TEXT }, verification: BRIEF_TEXT,
  delegated: { type: 'array', items: BRIEF_TEXT },
} }
const BRIEF_FIELDS = { brief: BRIEF_CONTENT, planMissing: BRIEF_TEXT }
const BRIEF_DECISION = { type: 'object', properties: { id: BRIEF_TEXT, question: BRIEF_TEXT, answer: BRIEF_TEXT } }
const BRIEF_DOCUMENT = { type: 'object', properties: {
  version: { type: 'integer' }, state: BRIEF_TEXT, brief: BRIEF_CONTENT, decisions: { type: 'array', items: BRIEF_DECISION },
} }
const BRIEF_CHALLENGE = { type: 'object', properties: {
  question: BRIEF_TEXT, wording: BRIEF_TEXT, outcomeA: BRIEF_TEXT, outcomeB: BRIEF_TEXT,
  evidence: BRIEF_TEXT, recommendation: BRIEF_TEXT, changes: BRIEF_TEXT,
} }
const BRIEF_REVIEW = { type: 'object', properties: {
  id: BRIEF_TEXT, status: { type: 'string', enum: DECISION_STATUSES }, reason: BRIEF_TEXT,
} }
// The Brief workflow's extra verdicts: a ticket with no findable outcome, and one bundling work
// that should be separate tickets. Factory, Pair and council runs never ask for them.
const BRIEF_SPLIT = { type: 'array', items: { type: 'object', properties: { title: BRIEF_TEXT, task: BRIEF_TEXT } } }

// What every challenge asks of each question it returns; shared by the first challenge and the
// re-check of a settled brief.
const BRIEF_QUESTION_RULES = 'For each, give the competing outcomes, evidence considered, a recommended answer and what the answer changes. Write the question, both outcomes, the recommendation and what changes for the user who asked, in their terms: what they would see, receive or be able to do. Name internal components, roles or mechanisms only where the user\'s own wording does. Do not ask about testing, implementation, internal design, preferences or speculative cases. There is no completeness checklist.'

function grooming() {
  return S.workflowName === 'brief'
}

// A standalone Pair runs its goal turns as its setup role (the Codex host gives it no intake role).
function briefRole() {
  return S.roles?.intake || !S.roles?.setup ? 'intake' : 'setup'
}

function briefTurn(label, instruction, properties) {
  return ask(instruction + '\n\n' + briefInputs(S), { label, phase: 'Brief', model: 'opus', effort: 'medium',
    schema: strict({ type: 'object', properties }) }, briefRole())
}

// decisions: the list to save, or the string 'held' when the turn itself decides which carried
// decisions still hold.
function nativeBriefSave(decisions, challenged = false) {
  if (hostRuntime) return 'Return briefFile as an empty string. The runner saves the file.'
  const state = challenged ? 'STATE' : 'settled'
  const held = decisions === 'held'
  return `Write the object you return in brief as UTF-8 JSON to a temporary file with the file tool. Save it by running this helper, substituting the quoted temporary file path for FILE${challenged ? ' and provisional for STATE if questions survive, otherwise settled' : ''}${held ? ', and for DECISIONS the quoted JSON array of the carried decisions you mark holds, unchanged and in their order' : ''}:\n` +
    `${S.cli} brief --repo ${S.raw.repo ? shq(S.raw.repo) : '"$PWD"'} --content FILE --state ${state} --decisions ${held ? 'DECISIONS' : shq(JSON.stringify(decisions))}\n` +
    'Copy the printed briefFile and document.brief exactly. On helper failure leave briefFile empty.'
}

async function keepBrief(content, state, decisions, nativePath) {
  const document = { version: 1, state, brief: content, decisions }
  const saved = hostRuntime ? await hostRuntime.brief({ document }) : { document, briefFile: nativePath }
  return acceptBrief(saved, state)
}

function acceptBrief(saved, state) {
  const doc = saved?.document
  const filename = state === 'settled' ? '/BRIEF.json' : '/BRIEF.provisional.json'
  if (typeof saved?.briefFile !== 'string' || !saved.briefFile.startsWith('/') || !saved.briefFile.endsWith(filename) ||
      !validBriefDocument(doc, state)) return failure(S, 'failed', saved?.error || 'Factory could not read or save a valid goal brief.')
  const holder = goalHolder(S)
  holder.brief = { ...doc, brief: { ...doc.brief, delegated: delegatedWithPolicy(doc.brief.delegated) } }
  holder.briefFile = saved.briefFile
  return null
}

// Delegating testing, implementation and internal design is the factory's policy, not something
// a model must recite: an entry that opens with one ("testing — write the regression first")
// counts, and a missing one is added rather than failing the run.
function delegatedWithPolicy(list) {
  const missing = BRIEF_DELEGATED.filter(d => !list.some(item => item.trim().toLowerCase().startsWith(d)))
  return [...list, ...missing]
}

function validChallenge(reviewed) {
  return validBriefContent(reviewed?.brief) && Array.isArray(reviewed.questions) &&
    reviewed.questions.every(q => q && Object.keys(BRIEF_CHALLENGE.properties).every(k => nonemptyBriefText(q[k])) && q.outcomeA.trim() !== q.outcomeB.trim())
}

// Explicit inputs besides the task that bear on the goal: a settled brief does not cover them.
function goalInputsGiven(S) {
  const criteria = S.raw.criteria
  return !!S.context || S.plan.length > 0 || MODES.includes(S.raw.mode) ||
    (Array.isArray(criteria) ? criteria.length > 0 : !!String(criteria || '').trim())
}

// The run's goal, as the table in docs/groom.md gives it: a supplied brief file, a groomed ticket
// re-checked, or the task shaped and challenged. A stop is the run's result; null carries on.
async function settleGoal() {
  const raw = S.raw
  if (!goalHolder(S)) S.goal = {}
  if (raw.brief === false) return null
  if (raw.brief !== undefined) {
    if (typeof raw.brief !== 'string' || !raw.brief.startsWith('/')) return failure(S, 'failed', 'brief must be false or an absolute path to a settled brief.')
    // Factory's intake turn loads a brief natively, so a brief no other input bears on costs no turn.
    if (S.factory && !goalInputsGiven(S)) {
      if (hostRuntime) return acceptBrief(await hostRuntime.brief({ source: raw.brief }), 'settled')
      return null
    }
    if (hostRuntime) {
      const loaded = await hostRuntime.brief({ source: raw.brief })
      const failed = acceptBrief(loaded, 'settled')
      if (failed) return failed
      return await recheckBrief(goalDoc(S), '', '')
    }
    return await recheckBrief(null, raw.brief, '')
  }
  const ticket = parseGroomedTicket(S.task)
  if (ticket) {
    // A ticket pasted from Jira's description field has no title line: its first line is a heading.
    const title = ticket.title || oneLine(ticket.brief.outcome, 100)
    goalHolder(S).ticketTitle = title
    return await recheckBrief({ version: 1, state: 'settled', brief: ticket.brief, decisions: ticket.decisions }, '', title)
  }
  return await shapeBrief()
}

async function shapeBrief() {
  phase('Brief')
  const groom = grooming()
  const draft = await briefTurn('brief shape', 'Shape the requested goal into a short brief. State the user-visible outcome and its purpose, scope and non-goals, concrete acceptance examples and the observable evidence that would verify delivery. Delegate testing, implementation and internal design explicitly. Do not ask the user questions or decide a tier.' +
    (groom ? ' Give the ticket a short title in title. If the text names no outcome anyone could deliver, say why in notActionable and return your best draft; otherwise return notActionable as "".' : ''),
    groom ? { ...BRIEF_FIELDS, title: BRIEF_TEXT, notActionable: BRIEF_TEXT } : BRIEF_FIELDS)
  if (draft?.planMissing) return needsPlan(S, draft.planMissing, null)
  if (groom && nonemptyBriefText(draft?.notActionable)) return groomNotActionable(draft.notActionable)
  if (!validBriefContent(draft?.brief)) return failure(S, 'failed', 'The shaper returned no usable goal brief.')
  if (groom) goalHolder(S).ticketTitle = nonemptyBriefText(draft.title) ? oneLine(draft.title, 100) : ticketTitleOf(S.task)
  const reviewed = await briefTurn('brief challenge',
    `Independently challenge the draft against the original wording. Try to show two plausible outcomes the wording permits that the user would judge differently. Quote the wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each difference from repository evidence: read the relevant code, docs, git log, retros and available issues. Correct the draft where evidence settles it. An unavailable source is not itself a reason to ask.
Return all and only unresolved what/why differences in questions. ${BRIEF_QUESTION_RULES} Return [] on a clear goal, including a clear one-line goal. No criteria or harness review.${groom ? `\n${GROOM_SPLIT_RULE}` : ''}
Draft: ${JSON.stringify(draft.brief)}
${nativeBriefSave([], true)}`, { ...BRIEF_FIELDS, questions: { type: 'array', items: BRIEF_CHALLENGE }, briefFile: BRIEF_TEXT, ...(groom ? { split: BRIEF_SPLIT } : {}) })
  if (reviewed?.planMissing) return needsPlan(S, reviewed.planMissing, null)
  if (!validChallenge(reviewed)) return failure(S, 'failed', 'The brief challenger returned no usable verdict.')
  return await answerBrief(reviewed, [], [], reviewed.questions, reviewed.briefFile)
}

const GROOM_SPLIT_RULE = 'If the text bundles standalone pieces of work that should be separate tickets (fixes with separate causes, unrelated features, one change per item of a list), list each in split with a short title and the piece as a task complete for someone who has not seen this text; otherwise return []. A goal with several acceptance examples is one ticket.'

// A brief settled earlier (a groomed ticket, or a saved brief file the run's other inputs bear on),
// checked again against the task and every explicit input. One turn, never the shaper. doc is
// null when the turn itself loads the file (load: its path), natively.
async function recheckBrief(doc, load, title) {
  phase('Brief')
  const groom = grooming()
  const source = load ? `Load the settled brief first. Run this exact command:\n${S.cli} brief --repo ${S.raw.repo ? shq(S.raw.repo) : '"$PWD"'} --reuse ${shq(load)}\nIts document.brief is the brief to check and its document.decisions the carried decisions. Copy that document into document.`
    : `Brief: ${JSON.stringify(doc.brief)}\nCarried decisions: ${JSON.stringify(doc.decisions)}`
  const reviewed = await briefTurn('brief recheck',
    `Independently re-check a goal brief settled earlier${title ? ' from a groomed ticket' : ''} against the original task and every explicit input below. Try to show two plausible outcomes that the task, its context, its documents or its explicit constraints now permit and the user would judge differently: wording the brief no longer matches, an input that conflicts with it, or a question an edit opened. Quote the wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each difference from repository evidence: read the relevant code, docs, git log, retros and available issues. Correct the brief where evidence settles it. An unavailable source is not itself a reason to ask.
Give a verdict on every carried decision in decisionReview, with its id: holds when it still applies as answered; superseded when one of your questions replaces it (name that question in reason); obsolete when the task no longer contains what it was about. Keep the decisions that hold; never ask again what one of them settles.
Return all and only unresolved what/why differences in questions. ${BRIEF_QUESTION_RULES} Return [] when the brief still captures the goal. No criteria or harness review.${groom ? `\n${GROOM_SPLIT_RULE}` : ''}
${source}
${nativeBriefSave('held', true)}${hostRuntime ? '' : '\nCopy the printed document.decisions into savedDecisions.'}`,
    { ...BRIEF_FIELDS, questions: { type: 'array', items: BRIEF_CHALLENGE }, decisionReview: { type: 'array', items: BRIEF_REVIEW }, briefFile: BRIEF_TEXT,
      ...(load ? { document: BRIEF_DOCUMENT } : {}), ...(hostRuntime ? {} : { savedDecisions: { type: 'array', items: BRIEF_DECISION } }), ...(groom ? { split: BRIEF_SPLIT } : {}) })
  if (reviewed?.planMissing) return needsPlan(S, reviewed.planMissing, null)
  const carriedDoc = load ? reviewed?.document : doc
  if (load && !validBriefDocument(carriedDoc, 'settled')) return failure(S, 'failed', 'Factory could not read or save a valid goal brief.')
  const carried = carriedDoc.decisions
  const held = validChallenge(reviewed) ? heldDecisions(carried, reviewed.decisionReview) : null
  if (!held) return failure(S, 'failed', 'The brief re-check returned no usable verdict.')
  const holder = goalHolder(S)
  holder.droppedDecisions = reviewed.decisionReview.filter(r => r.status !== 'holds')
  return await answerBrief(reviewed, carried, held, reviewed.questions, reviewed.briefFile)
}

// After a challenge: save the brief, provisional while questions are open, and stop for them; once
// every question has an answer, revise the brief to follow the answers. carried: the decisions the
// brief came with (new IDs are numbered after all of them), held: those that still apply.
async function answerBrief(reviewed, carried, held, raised, briefFile) {
  const prefix = grooming() ? 'G' : 'B'
  const ids = nextDecisionIds(carried, prefix, raised.length)
  const questions = raised.map((q, i) => ({ ...q, id: ids[i], kind: 'brief' }))
  if (grooming()) goalHolder(S).split = Array.isArray(reviewed.split) ? reviewed.split.filter(p => p && nonemptyBriefText(p.title) && nonemptyBriefText(p.task)) : []
  const failed = await keepBrief(reviewed.brief, questions.length ? 'provisional' : 'settled', held, briefFile)
  if (failed) return failed
  // Natively the re-check turn wrote the file and chose which carried decisions to keep in it.
  const same = list => JSON.stringify((Array.isArray(list) ? list : []).map(d => [d?.id, d?.question, d?.answer]))
  if (!hostRuntime && reviewed.savedDecisions !== undefined && same(reviewed.savedDecisions) !== same(held)) return failure(S, 'failed', 'The saved goal brief does not keep exactly the carried decisions that hold.')
  if (!questions.length) return null
  const decisions = [...held], open = []
  for (const q of questions) {
    const matches = S.clarifications.filter(a => a.id === q.id)
    if (matches.length !== 1 || !matches[0].answer.trim()) open.push(q)
    else decisions.push({ id: q.id, question: q.question, answer: matches[0].answer })
  }
  if (open.length) {
    const how = hostRuntime ? 'Resume the saved hostRunDir with --resume and an args file' :
      `Resume this dark-factory:${S.workflowName} workflow in the same session using resumeFromRunId and the original arguments`
    const resumeSteps = `${how}, appending {id, answer} entries to clarifications. Keep earlier answers unchanged.`
    return { status: 'needs-user', task: S.task, questions: open, decisions, resumable: true, resumeSteps,
      forTheOrchestrator: 'Ask all questions together. Show both outcomes, the recommendation and what the answer changes. ' + resumeSteps }
  }
  const revised = await briefTurn('brief answered',
    `Revise the brief so its outcome, scope and acceptance examples follow the user's answers. The answers settle the challenge.\nBrief: ${JSON.stringify(reviewed.brief)}\nQuestions: ${JSON.stringify(questions)}\nUser decisions: ${JSON.stringify(decisions)}\n${nativeBriefSave(decisions)}`,
    { brief: BRIEF_CONTENT, briefFile: BRIEF_TEXT })
  if (!validBriefContent(revised?.brief)) return failure(S, 'failed', 'The shaper returned no usable answered brief.')
  const error = await keepBrief(revised.brief, 'settled', decisions, revised.briefFile)
  if (!error) {
    const taken = new Set(decisions.map(d => d.id))
    S.raw = { ...S.raw, clarifications: S.raw.clarifications.filter(a => !taken.has(a?.id)) }
    S.clarifications = S.clarifications.filter(a => !taken.has(a.id))
    // Pair reads its answers from its own list, and would call a brief ID unknown.
    if (S.pairOptions) S.pairOptions = { ...S.pairOptions, answers: S.pairOptions.answers.filter(a => !taken.has(a?.id)) }
  }
  return error
}

// The Brief workflow's stop for a text that names no outcome: nothing to groom yet.
function groomNotActionable(why) {
  return { status: 'not-actionable', task: S.task, reason: oneLine(why, 600),
    forTheOrchestrator: `The text names no outcome anyone could deliver: ${oneLine(why, 600)} Tell the writer what is missing and groom again once the ticket says what it should achieve.` }
}
