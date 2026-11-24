// Factory's pre-intake turns. Decisions stay in the workflow. The file helper
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

// The factory's intake.
const INTAKE_SCHEMA = strict({ type: 'object', properties: {
  strategy: { type: 'string', enum: ['independent', 'pair'], description: 'Pair for scoped implementation with one clear approach and iterative review; independent for competing hypotheses or plans. Architecture and investigations require independent.' },
  status:      { type: 'string', enum: ['ok', 'needs-plan', 'needs-split'] },
  tier:        { type: 'string', enum: TIERS },
  mode:        { type: 'string', enum: MODES },
  reasons:     { type: 'string', description: 'Up to three sentences: what in the task or the code decided the tier.' },
  planMissing: { type: 'string', description: 'With status "needs-plan": the document the task depends on that you could not find. Otherwise "".' },
  signals: { type: 'object', properties: {
    kind:        { type: 'string', enum: ['bug', 'feature', 'change', 'question', 'design'] },
    files:       { type: 'integer', description: 'Your estimate of the files the change touches; 0 for an investigation or a design.' },
    publicApi:   { type: 'boolean', description: 'Does it change a public API or schema?' },
    crossModule: { type: 'boolean' },
    testsCover:  { type: 'string', enum: ['yes', 'no', 'unknown'] },
    ambiguous:   { type: 'boolean' },
    planGiven:   { type: 'boolean' },
  } },
  split: { type: 'array', description: 'With status "needs-split": the separate pieces of work, in the order to do them. Otherwise [].', items: { type: 'object', properties: {
    title: { type: 'string', description: 'A few words naming the piece.' },
    task:  { type: 'string', description: 'The piece as a task of its own, complete for someone who has not seen this request.' },
    tier:  { type: 'string', enum: TIERS, description: 'Your estimate for this piece alone.' },
    after: { type: 'array', items: { type: 'integer' }, description: 'The numbers (from 1) of earlier pieces this one builds on; [] if none.' },
  } } },
} })

function briefTurn(label, instruction, properties) {
  return ask(instruction + '\n\n' + briefInputs(S), { label, phase: 'Brief', model: 'opus', effort: 'medium',
    schema: strict({ type: 'object', properties }) }, 'intake')
}

function nativeBriefSave(decisions, challenged = false) {
  if (hostRuntime) return 'Return briefFile as an empty string. The runner saves the file.'
  const state = challenged ? 'STATE' : 'settled'
  return `Write the object you return in brief as UTF-8 JSON to a temporary file with the file tool. Save it by running this helper, substituting the quoted temporary file path for FILE${challenged ? ' and provisional for STATE if questions survive, otherwise settled' : ''}:\n` +
    `${S.cli} brief --repo ${S.raw.repo ? shq(S.raw.repo) : '"$PWD"'} --content FILE --state ${state} --decisions ${shq(JSON.stringify(decisions))}\n` +
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
  S.factory.brief = { ...doc, brief: { ...doc.brief, delegated: delegatedWithPolicy(doc.brief.delegated) } }
  S.factory.briefFile = saved.briefFile
  return null
}

// Delegating testing, implementation and internal design is the factory's policy, not something
// a model must recite: an entry that opens with one ("testing — write the regression first")
// counts, and a missing one is added rather than failing the run.
function delegatedWithPolicy(list) {
  const missing = BRIEF_DELEGATED.filter(d => !list.some(item => item.trim().toLowerCase().startsWith(d)))
  return [...list, ...missing]
}

async function shapeBrief() {
  phase('Brief')
  const draft = await briefTurn('brief shape', 'Shape the requested goal into a short brief. State the user-visible outcome and its purpose, scope and non-goals, concrete acceptance examples and the observable evidence that would verify delivery. Delegate testing, implementation and internal design explicitly. Do not ask the user questions or decide a tier.', BRIEF_FIELDS)
  if (draft?.planMissing) return needsPlan(S, draft.planMissing, null)
  if (!validBriefContent(draft?.brief)) return failure(S, 'failed', 'The shaper returned no usable goal brief.')
  const reviewed = await briefTurn('brief challenge',
    `Independently challenge the draft against the original wording. Try to show two plausible outcomes the wording permits that the user would judge differently. Quote the wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each difference from repository evidence: read the relevant code, docs, git log, retros and available issues. Correct the draft where evidence settles it. An unavailable source is not itself a reason to ask.
Return all and only unresolved what/why differences in questions. For each, give the competing outcomes, evidence considered, a recommended answer and what the answer changes. Write the question, both outcomes, the recommendation and what changes for the user who asked, in their terms: what they would see, receive or be able to do. Name internal components, roles or mechanisms only where the user's own wording does. Do not ask about testing, implementation, internal design, preferences or speculative cases. There is no completeness checklist. Return [] on a clear goal, including a clear one-line goal. No criteria or harness review.
Draft: ${JSON.stringify(draft.brief)}
${nativeBriefSave([], true)}`, { ...BRIEF_FIELDS, questions: { type: 'array', items: BRIEF_CHALLENGE }, briefFile: BRIEF_TEXT })
  if (reviewed?.planMissing) return needsPlan(S, reviewed.planMissing, null)
  if (!validBriefContent(reviewed?.brief) || !Array.isArray(reviewed.questions) ||
      !reviewed.questions.every(q => q && Object.keys(BRIEF_CHALLENGE.properties).every(k => nonemptyBriefText(q[k])) && q.outcomeA.trim() !== q.outcomeB.trim())) {
    return failure(S, 'failed', 'The brief challenger returned no usable verdict.')
  }
  const questions = reviewed.questions.map((q, i) => ({ ...q, id: `B${i + 1}`, kind: 'brief' }))
  const failed = await keepBrief(reviewed.brief, questions.length ? 'provisional' : 'settled', [], reviewed.briefFile)
  if (failed || !questions.length) return failed
  const decisions = [], open = []
  for (const q of questions) {
    const matches = S.clarifications.filter(a => a.id === q.id)
    if (matches.length !== 1 || !matches[0].answer.trim()) open.push(q)
    else decisions.push({ id: q.id, question: q.question, answer: matches[0].answer })
  }
  if (open.length) {
    const how = hostRuntime ? 'Resume the saved hostRunDir with --resume and an args file' :
      'Resume this dark-factory:factory workflow in the same session using resumeFromRunId and the original arguments'
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
  }
  return error
}

async function factoryIntake() {
  let prompt = intakePrompt(S), schema = INTAKE_SCHEMA
  const nativeLoad = typeof S.raw.brief === 'string' && !hostRuntime
  if (nativeLoad) {
    prompt = `Before choosing a tier, load the supplied settled brief. Run this exact command:\n${S.cli} brief --repo ${S.raw.repo ? shq(S.raw.repo) : '"$PWD"'} --reuse ${shq(S.raw.brief)}\nUse its document with the original task. Copy its document and briefFile into your result. On failure leave briefFile empty.\n\n${prompt}`
    schema = strict({ type: 'object', properties: { ...schema.properties, document: BRIEF_DOCUMENT, briefFile: BRIEF_TEXT } })
  }
  const intake = await ask(prompt, { label: 'intake', phase: 'Intake', schema, model: 'opus', effort: 'medium' }, 'intake')
  if (nativeLoad) {
    const error = acceptBrief(intake, 'settled')
    if (error) return { error }
    const { document, briefFile, ...routing } = intake
    return { intake: routing }
  }
  return { intake }
}

