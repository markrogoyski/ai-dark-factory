// Factory's intake, after the goal stage (src/goal.js) and before routing (src/route.js).
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

async function factoryIntake() {
  let prompt = intakePrompt(S), schema = INTAKE_SCHEMA
  // A supplied brief the goal stage did not already load (or re-check) is loaded here, natively.
  const nativeLoad = typeof S.raw.brief === 'string' && !hostRuntime && !goalDoc(S)
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

