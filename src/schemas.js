// Output schemas for every agent turn. Built from the config, so they sit after boot.

const SEVERITY = { type: 'string', enum: ['blocker', 'major', 'minor'] }

const CLAIM = { type: 'object', properties: {
  kind:      { type: 'string', enum: ['fact', 'verification'], description: '"verification": what you ran and what it showed (tests, builds, scripts). "fact": any other checkable claim.' },
  statement: { type: 'string' },
  evidence:  { type: 'string', description: 'file:line, a command plus the real tail of its output, or a test ID. Must be checkable.' },
  criterion: { type: 'string', description: 'The acceptance criterion the claim bears on, e.g. "C2". "" only for a verification claim that bears on none.' },
} }

const TEST = { type: 'object', properties: {
  id:      { type: 'string', description: 'The ID you used for its directory, e.g. T1B1.' },
  purpose: { type: 'string', description: 'The behaviour it pins down.' },
  command: { type: 'string', description: 'The same command as in its test.json.' },
} }

const QUESTION = { type: 'object', properties: {
  question:   { type: 'string' },
  assumption: { type: 'string', description: 'The reading you are proceeding on meanwhile.' },
} }

const IDEA = { type: 'object', properties: { from: { type: 'string', description: 'Seat letter.' }, idea: { type: 'string' } } }

const VOTE = { type: 'object', properties: {
  ship:       { type: 'string', description: 'Seat letter of the position that should ship: yours or another.' },
  amendments: { type: 'array', items: { type: 'string' }, description: 'Changes it needs before shipping; may cite ledger IDs.' },
  reason:     { type: 'string' },
  ...(S.approval ? { acceptable: { type: 'array', description: 'Other positions you could also accept shipping, each with the amendments it would need. [] if none.', items: {
    type: 'object', properties: { seat: { type: 'string' }, amendments: { type: 'array', items: { type: 'string' } } },
  } } } : {}),
} }

const SOLVE_SCHEMA = strict({ type: 'object', properties: {
  summary:    { type: 'string', description: 'Your position in 2-4 sentences.' },
  claims:     { type: 'array', items: CLAIM, description: 'At most 12: every verification claim, plus the load-bearing facts that bear on an acceptance criterion.' },
  tests:      { type: 'array', items: TEST, description: 'Tests you published. Empty unless this is an implement task.' },
  questions:  { type: 'array', items: QUESTION, description: 'Only genuine ambiguities in the request itself. Usually empty.' },
  confidence: { type: 'integer', description: '1-5. An honest low beats a fake high.' },
} })

const DEBATE_SCHEMA = strict({ type: 'object', properties: {
  summary:     { type: 'string', description: 'Your current position after this round, 2-4 sentences.' },
  changed:     { type: 'boolean', description: 'Did your position change materially this round?' },
  changeBasis: { type: 'array', items: { type: 'string' }, description: 'Ledger IDs that justified the change. Empty if unchanged.' },
  changeNote:  { type: 'string', description: 'What changed and why, or "" if nothing did.' },
  findings: { type: 'array', items: { type: 'object', properties: {
    target:    { type: 'string', description: 'Seat letter whose position this is about.' },
    severity:  SEVERITY,
    kind:      { type: 'string', enum: ['fact', 'judgment'], description: '"fact": a checkable defect. "judgment": a trade-off or taste argument; argued, not adjudicated.' },
    statement: { type: 'string' },
    evidence:  { type: 'string' },
  } } },
  challenges: { type: 'array', items: { type: 'object', properties: {
    claim:    { type: 'string', description: 'The ledger ID you dispute.' },
    reason:   { type: 'string' },
    evidence: { type: 'string' },
  } } },
  concessions: { type: 'array', items: { type: 'string' }, description: 'IDs of findings against you that you accept.' },
  withdrawals: { type: 'array', items: { type: 'string' }, description: 'IDs of your own earlier claims or tests that you retract.' },
  adopted:     { type: 'array', items: IDEA },
  claims:      { type: 'array', items: CLAIM, description: 'At most 12 new claims about your revised position: verification claims, and facts that bear on an acceptance criterion.' },
  tests:       { type: 'array', items: TEST },
  vote: VOTE,
  questions: { type: 'array', items: QUESTION },
  seconds:   { type: 'array', items: { type: 'string' }, description: 'IDs of open user questions (Q1, Q2, …) that you agree genuinely block the work.' },
} })

// Claude seats are fresh agents every turn; these notes are their memory between turns.
const NOTES_PROP = { type: 'string', description: 'Private notes for your next turn, under about 400 words. Nobody else sees them.' }

function withNotes(schema) {
  return { ...schema, properties: { ...schema.properties, notes: NOTES_PROP }, required: [...schema.required, 'notes'] }
}

const VERDICT = { type: 'string', enum: ['verified', 'refuted', 'fabricated', 'unverifiable', 'n/a'] }

const CHECK_SCHEMA = strict({ type: 'object', properties: {
  measured: { type: 'boolean', description: 'Did the measure command complete?' },
  diff:     { type: 'object', properties: { files: { type: 'integer' }, added: { type: 'integer' }, removed: { type: 'integer' },
    tree: { type: 'string', description: 'snapshot.tree from the measure output, exactly; "" if there is none.' } } },
  delta:    { type: 'object', description: 'From snapshot.delta in the measure output. If it is null or absent: since "", and zeros.', properties: {
    since: { type: 'string' }, files: { type: 'integer' }, added: { type: 'integer' }, removed: { type: 'integer' },
  } },
  postWords: { type: 'integer', description: 'Word count of the post being checked; 0 if it does not exist.' },
  suite:    { type: 'object', properties: { ran: { type: 'boolean' }, passed: { type: 'boolean' }, tail: { type: 'string' } } },
  crossTests: { type: 'array', items: { type: 'object', properties: {
    test: { type: 'string', description: 'The test ID only, e.g. T0A1.' }, outcome: { type: 'string', enum: ['pass', 'fail', 'error', 'conflict'] }, note: { type: 'string' },
  } } },
  rulings: { type: 'array', items: { type: 'object', properties: {
    claim:   { type: 'string', description: 'The item ID only, exactly as shown in brackets (e.g. 1B3). No other text.' },
    verdict: VERDICT,
    fixed:   { type: 'string', enum: ['yes', 'no', 'n/a'] },
    note:    { type: 'string', description: 'One or two sentences: what you checked and what you found.' },
  } } },
  criteria: { type: 'array', items: { type: 'object', properties: {
    criterion: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'unmet'] }, note: { type: 'string' },
  } } },
} })

const PANEL_SCHEMA = strict({ type: 'object', properties: {
  rulings: { type: 'array', items: { type: 'object', properties: {
    claim:   { type: 'string', description: 'The claim ID only, exactly as shown in brackets (e.g. 1B3). No other text.' },
    verdict: { type: 'string', enum: ['verified', 'refuted', 'fabricated', 'unverifiable'] },
    note:    { type: 'string' },
  } } },
} })

const CLUSTER_SCHEMA = strict({ type: 'object', properties: {
  assignments: { type: 'array', items: { type: 'object', properties: {
    index:   { type: 'integer' },
    matches: { type: 'string', description: 'An existing question ID (Q1, …), or a label new-1, new-2, … shared by new questions that ask the same thing.' },
  } } },
  newQuestions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } } } },
} })

const SYNTH_SCHEMA = strict({ type: 'object', properties: {
  summary:   { type: 'string' },
  addressed: { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, how: { type: 'string' } } } },
  declined:  { type: 'array', items: { type: 'object', properties: { ref: { type: 'string' }, why: { type: 'string' } } } },
  adopted:   { type: 'array', items: IDEA },
  claims:    { type: 'array', items: CLAIM },
} })

const BALLOT_SCHEMA = strict({ type: 'object', properties: { vote: VOTE } })

const RATIFY_SCHEMA = strict({ type: 'object', properties: {
  endorse: { type: 'boolean' },
  objections: { type: 'array', items: { type: 'object', properties: {
    severity: SEVERITY, kind: { type: 'string', enum: ['fact', 'judgment'] }, statement: { type: 'string' }, evidence: { type: 'string' },
  } } },
  note: { type: 'string' },
} })

const AUDIT_SCHEMA = strict({ type: 'object', properties: {
  summary:  { type: 'string', description: 'Your verdict on the change, in 2-4 sentences.' },
  findings: { type: 'array', items: { type: 'object', properties: {
    severity:  SEVERITY,
    kind:      { type: 'string', enum: ['fact', 'judgment'], description: '"fact": checkable. "judgment": a trade-off.' },
    statement: { type: 'string', description: 'What is wrong, and the change you would make.' },
    evidence:  { type: 'string', description: 'A published test ID, a file:line, or a command plus the real tail of its output.' },
  } } },
  tests:  { type: 'array', items: TEST, description: 'Tests you published, IDs as instructed. Empty if none.' },
  probes: { type: 'array', description: 'Design lens: the next changes you traced. Empty otherwise.', items: { type: 'object', properties: {
    change:  { type: 'string', description: 'A plausible next change to this code.' },
    touches: { type: 'string', description: 'The files and functions it would have to touch in this version.' },
    verdict: { type: 'string', enum: ['easy', 'awkward', 'hard'] },
  } } },
} })

const FACTORY_AUDIT_SCHEMA = strict({ type: 'object', properties: {
  ...AUDIT_SCHEMA.properties,
  evidenceReview: { type: 'object', properties: {
    status: { type: 'string', enum: ['complete', 'incomplete', 'not-assigned'] },
    note: { type: 'string', description: 'Historical criteria checked and evidence used, or what remains missing.' },
  } },
} })

const SPEC_SCHEMA = strict({ type: 'object', properties: {
  summary:  { type: 'string', description: 'Your verdict on the specification, in 1-3 sentences.' },
  findings: { type: 'array', items: { type: 'object', properties: {
    severity:  SEVERITY,
    kind:      { type: 'string', enum: ['fact', 'decision'], description: '"fact": the code, documents or task settle it. "decision": only the user can.' },
    criterion: { type: 'string', description: 'The criterion ID it is about, e.g. C2; "" if no criterion covers it.' },
    statement: { type: 'string', description: 'What is wrong with the criteria, or for a decision, the question.' },
    evidence:  { type: 'string', description: 'A file:line, a quote from the task or a document, or a command plus the real tail of its output.' },
    change:    { type: 'string', description: 'The amendment you would make: the new or reworded criterion, or the change to the verification command.' },
    readings:  { type: 'array', items: { type: 'string' }, description: 'For a decision, the reasonable readings, the most conservative first. Empty for a fact.' },
  } } },
} })

const SPEC_PANEL_SCHEMA = strict({ type: 'object', properties: {
  rulings: { type: 'array', items: { type: 'object', properties: {
    finding: { type: 'string', description: 'The finding ID only, exactly as shown in brackets (e.g. S2). No other text.' },
    verdict: { type: 'string', enum: ['accept', 'decision', 'reject'] },
    note:    { type: 'string' },
  } } },
} })

const SPEC_AMEND_SCHEMA = strict({ type: 'object', properties: {
  criteria:       { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
  verify:         { type: 'string', description: 'The verification command as it now is in verify.sh, or "".' },
  baselinePasses: { type: 'boolean' },
  baselineNote:   { type: 'string' },
  applied:        { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, change: { type: 'string' } } } },
  assumptions:    { type: 'array', description: 'One per decision the user did not answer.', items: { type: 'object', properties: {
    finding:     { type: 'string', description: 'The decision\'s ID, e.g. S3.' },
    question:    { type: 'string' },
    chosen:      { type: 'string', description: 'The reading the criteria now follow.' },
    alternative: { type: 'string' },
    impact:      { type: 'string', description: 'What would be built differently under the alternative.' },
  } } },
} })

const SETUP_SCHEMA = strict({ type: 'object', properties: {
  status:         { type: 'string', enum: ['ok', 'dirty', 'needs-plan', 'preflight', 'error'] },
  error:          { type: 'string' },
  mode:           { type: 'string', enum: MODES },
  runId:          { type: 'string' },
  runDir:         { type: 'string' },
  repoRoot:       { type: 'string' },
  dirty:          { type: 'array', items: { type: 'string' } },
  verify:         { type: 'string', description: 'The command written to verify.sh, or "".' },
  baselinePasses: { type: 'boolean' },
  baselineNote:   { type: 'string' },
  criteria:       { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
  refs:           { type: 'array', description: 'From the "refs" in the init output, as printed.', items: { type: 'object', properties: {
    source: { type: 'string' }, path: { type: 'string' }, inWorktrees: { type: 'boolean' },
  } } },
  planMissing:    { type: 'string', description: 'With status "needs-plan": the document the task depends on that you could not find. Otherwise "".' },
  preflight:      { type: 'array', description: 'From the "vendors" in the preflight output: one entry per vendor checked; [] if there was no preflight step.', items: { type: 'object', properties: {
    vendor: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string', description: 'Its "error", or "".' },
  } } },
} })

// The factory's intake, and the Simple tier's one implementer, who can say the task isn't simple.
const INTAKE_SCHEMA = strict({ type: 'object', properties: {
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

const SIMPLE_SOLVE_SCHEMA = strict({ type: 'object', properties: {
  ...SOLVE_SCHEMA.properties,
  tooBig: { type: 'object', description: 'Set tier when the task is not a simple change; otherwise tier and reason are "".', properties: {
    tier:   { type: 'string', enum: ['', 'fix', 'feature'] },
    reason: { type: 'string' },
  } },
} })

// The Feature tier: the final plan lists the increments its author then builds, one turn each.
const PLAN_SYNTH_SCHEMA = strict({ type: 'object', properties: {
  ...SYNTH_SCHEMA.properties,
  increments: { type: 'array', description: 'The plan\'s increments, in the order you will build them.', items: { type: 'object', properties: {
    title:    { type: 'string', description: 'A few words naming it.' },
    delivers: { type: 'string', description: 'What it delivers, and how it is checked.' },
  } } },
} })

// The Architecture tier: the final design lists its milestones, each a later factory run of its own;
// the revision after the review lists them again, complete.
const ARCH_SYNTH_SCHEMA = strict({ type: 'object', properties: {
  ...SYNTH_SCHEMA.properties,
  milestones: { type: 'array', description: 'The milestone plan, in the order to build it.', items: { type: 'object', properties: {
    title:    { type: 'string', description: 'A few words naming it.' },
    task:     { type: 'string', description: 'The milestone as a task of its own, complete for a model that has seen none of this run.' },
    criteria: { type: 'array', items: { type: 'string' }, description: 'Its draft acceptance criteria, each checkable from a worktree.' },
    after:    { type: 'array', items: { type: 'integer' }, description: 'The numbers (from 1) of earlier milestones it builds on; [] if none.' },
    tier:     { type: 'string', enum: ['simple', 'feature'] },
    working:  { type: 'string', description: 'What works once it lands.' },
  } } },
} })

// A reviewer of the Architecture tier's milestone plan reads and writes nothing: the review is its output.
const PLAN_REVIEW_SCHEMA = strict({ type: 'object', properties: {
  summary:  { type: 'string', description: 'Your verdict on the plan, in 2-4 sentences.' },
  findings: { type: 'array', items: { type: 'object', properties: {
    severity:  SEVERITY,
    kind:      { type: 'string', enum: ['fact', 'judgment'], description: '"fact": checkable. "judgment": a trade-off.' },
    statement: { type: 'string', description: 'What is wrong, and the change you would make.' },
    evidence:  { type: 'string', description: 'A file:line, or a command plus the real tail of its output; for a judgment, the reasoning.' },
    milestone: { type: 'integer', description: 'The number of the milestone it is about; 0 for the plan as a whole.' },
  } } },
} })

const BUILD_SCHEMA = strict({ type: 'object', properties: {
  summary:    { type: 'string', description: 'What this increment did, in 1-3 sentences.' },
  deviations: { type: 'array', items: { type: 'string' }, description: 'Each departure from the plan, and why. Empty if none.' },
  claims:     { type: 'array', items: CLAIM },
} })

const RECORD_SCHEMA = strict({ type: 'object', properties: {
  saved: { type: 'string', description: 'The "path" printed by council retro, or "".' },
  error: { type: 'string', description: 'What went wrong, or "".' },
} })

const NOTE_SCHEMAS = new Map([SOLVE_SCHEMA, DEBATE_SCHEMA, SYNTH_SCHEMA, SIMPLE_SOLVE_SCHEMA, PLAN_SYNTH_SCHEMA, ARCH_SYNTH_SCHEMA, BUILD_SCHEMA].map(x => [x, withNotes(x)]))

// While the workflow is being tuned, every agent can say what in its turn got in the way. Notes
// are collected as they happen, not asked for at the end: Claude seats are fresh agents each turn
// and wouldn't remember. The retro agent turns them into suggested changes.
const PROCESS_PROP = { type: 'string', description:
  'Feedback on the council process, not on the task: at most two sentences on anything in this turn\'s instructions, inputs or tools that got in your way, ' +
  'such as an unclear or conflicting instruction, missing context, wasted effort, a limit that cut you short, or a command that failed. ' +
  'Name the instruction or input. "" if nothing did; don\'t invent feedback.' }

function withProcess(schema) {
  if (!S.retro || !schema) return schema
  return { ...schema, properties: { ...schema.properties, process: PROCESS_PROP }, required: [...(schema.required || []), 'process'] }
}

const RETRO_SCHEMA = strict({ type: 'object', properties: {
  worked: { type: 'array', description: 'Up to 3 things in the process that worked and should be kept.', items: { type: 'object', properties: {
    what: { type: 'string' }, evidence: { type: 'string' },
  } } },
  changes: { type: 'array', description: '3 to 5 changes to the workflow, most valuable first; fewer if the run gave little evidence.', items: { type: 'object', properties: {
    change:   { type: 'string', description: 'One change, concrete enough to make: a specific prompt, limit, step or command.' },
    why:      { type: 'string' },
    evidence: { type: 'string', description: 'What in this run shows the problem: turn labels such as r1:A, file paths, run facts.' },
    where:    { type: 'string', description: 'Where it would change, e.g. "the debate prompt", "POST_WORDS in council.js", "bin/dark-factory seat-run"; "" if unsure.' },
  } } },
  saved: { type: 'string', description: 'The "path" printed by council retro, or "" if it wasn\'t saved.' },
  error: { type: 'string', description: 'What went wrong saving the retro, or "".' },
} })

// The relay reports the CLI's outcome in fields, never as free text the workflow has to interpret:
// a relay once wrote "sandboxed: …" over a Gemini error, and the workflow, matching on that text,
// blocked a working vendor for the rest of the run.
function relaySchema(inner) {
  return { type: 'object', properties: {
    status:     { type: 'string', enum: ['done', 'error', 'sandboxed'] },
    error:      { type: 'string', description: 'The printed "error" text, copied as it is. "" when status is done.' },
    errorClass: { type: 'string', description: 'The printed "errorClass", if there is one; otherwise "".' },
    seconds:    { type: 'number', description: 'The printed "elapsedSec" when status is done; otherwise 0.' },
    result: inner,
  }, required: ['status'] }
}

// Codex and Gemini seats answer in a schema that repeats across turns, so a stale answer from an
// earlier turn can have the right shape. Each external turn pins a tag as a one-value enum: Codex's
// strict output and agy's check in bin/dark-factory enforce it, and externalTurn checks it again.
function withTurn(schema, tag) {
  return { ...schema,
    properties: { ...schema.properties, turn: { type: 'string', enum: [tag], description: `Exactly "${tag}".` } },
    required: [...(schema.required || []), 'turn'] }
}
