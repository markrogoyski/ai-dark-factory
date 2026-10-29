export const meta = {
  name: 'ensemble',
  description: 'Solve one task N independent ways, cross-review every candidate, return them ranked for you to pick or merge',
  whenToUse: 'Use for a task worth more than one attempt: a subtle bug, a design with real trade-offs, or an investigation where the obvious answer may be wrong. Runs N independent solvers with distinct stances, reviews each through several lenses, and hands the ranked candidates back to the main agent to pick or merge. Not for mechanical or already-understood work.',
  phases: [
    { title: 'Solve', detail: 'N independent attempts, each with a different stance', model: 'sonnet' },
    { title: 'Review', detail: 'each candidate judged through several blind lenses; judgement lenses on Opus, checking lenses on Sonnet' },
    { title: 'Compare', detail: 'head-to-head ranking and merge plan (advisory)', model: 'opus' },
  ],
}

// ensemble — solve one task N independent ways, cross-review, rank for the orchestrator.
//
//   /ensemble <task>                          4 solvers x 2 lenses + 1 judge = 13 agents
//   args: {task, mode, candidates, reviewers, models, context}
//   mode: 'implement' (worktree-isolated, from HEAD) | 'investigate' (read-only); auto-detected
//   models: {solve: 'sonnet', review: null, compare: 'opus'} — review null = per-lens defaults
//
// Structure: pipeline(Solve -> Review) with a single barrier before Compare.
// See ~/.claude/CLAUDE.md for usage notes.

// ---------------------------------------------------------------- args

const raw = typeof args === 'string' ? { task: args } : (args || {})
const TASK = String(raw.task || raw.prompt || raw.question || '').trim()
if (!TASK) {
  throw new Error(
    'ensemble: no task given. Pass args as a string, or {task, mode?, candidates?, reviewers?}.'
  )
}

const IMPLEMENT_RE =
  /\b(implement|fix|add|writ(e|ing)|build|refactor|migrat\w*|port|rename|remove|delete|optimi[sz]\w*|patch|introduce|support)\b/i

const MODE = raw.mode === 'implement' || raw.mode === 'investigate'
  ? raw.mode
  : (IMPLEMENT_RE.test(TASK) ? 'implement' : 'investigate')

const N       = Math.max(2, Math.min(6, Number(raw.candidates) || 4))
const K       = Math.max(1, Math.min(4, Number(raw.reviewers)  || 2))
const CONTEXT = String(raw.context || '').trim()

// ---------------------------------------------------------------- models
// Cheap breadth, expensive judgement: the fan-out runs on Sonnet, the
// cross-item comparison on Opus. Review sits in between and is resolved
// per lens below — checking work goes to Sonnet, reasoning work to Opus.
// Any of the three can be overridden: {models: {solve, review, compare}}.
// Setting `review` pins every lens to one model, ignoring the per-lens default.

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'fable']
const rawModels = raw.models || {}

function pickModel(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const m = String(value).toLowerCase()
  if (!VALID_MODELS.includes(m)) {
    throw new Error(`ensemble: unknown model '${value}'. Valid: ${VALID_MODELS.join(', ')}.`)
  }
  return m
}

const MODELS = {
  solve:   pickModel(rawModels.solve   !== undefined ? rawModels.solve   : raw.solveModel,   'sonnet'),
  review:  pickModel(rawModels.review  !== undefined ? rawModels.review  : raw.reviewModel,  null),
  compare: pickModel(rawModels.compare !== undefined ? rawModels.compare : raw.compareModel, 'opus'),
}

// ---------------------------------------------------------------- stances
// Independent attempts only beat one attempt if they are actually independent.
// Same model + same prompt => correlated answers, so each solver gets a
// distinct stance that changes what it looks at, not just how it phrases things.

const STANCES = MODE === 'implement' ? [
  { key: 'minimal',    brief: 'Smallest change that fully solves the problem. Touch as few files and lines as possible. No refactors, no renames, no drive-by cleanups. If a one-line fix is correct, that is the answer.' },
  { key: 'root-cause', brief: 'Do not fix the symptom. Trace back to the underlying cause and fix that, even if it means touching more code. Explicitly state what the tempting surface-level fix would be and why it is wrong or incomplete.' },
  { key: 'edge-cases', brief: 'Solve it with adversarial attention to edge cases: boundary values, empty/zero/negative/overflow inputs, error paths, concurrent or repeated invocation. Add tests that would fail on a naive fix.' },
  { key: 'idiomatic',  brief: 'Before writing anything, grep for how this codebase already solves the nearest analogous problem, and mirror it exactly — naming, structure, error handling, docs, test layout. Match the house style over your own preference.' },
  { key: 'contrarian', brief: 'Assume the framing of the request is subtly wrong. Solve the problem the user actually has, and say plainly where you deviated from what was literally asked and why.' },
  { key: 'test-first', brief: 'Write the failing test first from the specification or the cited reference, watch it fail, then write the minimum code that makes it pass. Report both runs.' },
] : [
  { key: 'trace-code',  brief: 'Answer by tracing the actual implementation path end to end in the source. Every claim must carry a file:line. Do not reason from names or from what the code probably does.' },
  { key: 'history',     brief: 'Answer from history: git log, git blame, prior commits, tests, CHANGELOG, issue and PR references. What did the authors intend, what changed, and when did the behaviour you are asked about appear?' },
  { key: 'falsify',     brief: 'Assume the obvious answer is wrong. Actively hunt for counterexamples, contradicting code paths, and cases the obvious answer fails to explain. Report the obvious answer only if you genuinely could not break it.' },
  { key: 'empirical',   brief: 'Do not reason about behaviour — observe it. Run the tests, write a scratch script, add temporary instrumentation, execute the real code, and report actual observed output as your primary evidence.' },
  { key: 'outside-in',  brief: 'Start from the public surface and the docs, not the internals: what does this promise callers, and where does the implementation fail to keep that promise?' },
  { key: 'analogy',     brief: 'Find how comparable systems, libraries, or other parts of this same repo handle this, and answer by contrast — what is standard here, and where does this code depart from it?' },
]

// ---------------------------------------------------------------- lenses
// Ordered most-signal first; `reviewers` takes a prefix of this list.

const LENSES = MODE === 'implement' ? [
  { key: 'correctness',  model: 'opus',   brief: 'Hunt for a concrete input or state on which this change produces a wrong result, throws, or silently corrupts data. A defect without a triggering scenario is not a defect — state inputs and the resulting wrong output.' },
  { key: 'verification', model: 'sonnet', brief: 'Do not take the claimed verification on trust. Go to the worktree path yourself, re-run the build and the test suite, and report the real command and its real output. If the candidate claims tests pass and they do not, that is a blocker.' },
  { key: 'fit',          model: 'sonnet', brief: 'Judge it against the surrounding codebase: conventions, naming, error handling, docs, test placement, project instructions (CLAUDE.md and skills). Flag scope creep — anything changed that the task did not require.' },
  { key: 'simplicity',   model: 'opus',   brief: 'Ask what could be deleted. Is there existing code that already does this? Is there a materially simpler formulation with the same behaviour? Unnecessary abstraction and indirection are defects.' },
] : [
  { key: 'evidence',     model: 'sonnet', brief: 'Check the receipts. For each cited file:line or command output, open it and confirm it says what the candidate claims. Any claim you cannot confirm is a defect, and a fabricated citation is a blocker.' },
  { key: 'refute',       model: 'opus',   brief: 'Try to prove the conclusion false. Look for the code path, input, or commit that contradicts it. Default to refuted when you are genuinely uncertain — a confidently wrong answer is worse than an unresolved one.' },
  { key: 'completeness', model: 'opus',   brief: 'Ask what is missing: an unexplored code path, an unasked question, a case the answer does not cover, an alternative explanation never considered.' },
]

const PICKED_STANCES = STANCES.slice(0, N)
const PICKED_LENSES  = LENSES.slice(0, K)

// Requested counts are clamped by how many distinct stances/lenses actually exist,
// so everything downstream reports the real numbers, not the requested ones.
const NC = PICKED_STANCES.length
const NL = PICKED_LENSES.length

// ---------------------------------------------------------------- helpers

const CLIP = 20000

function clip(s, n) {
  const str = String(s ?? '')
  return str.length <= n ? str : str.slice(0, n) + `\n\n[... clipped, ${str.length - n} more chars — read the full version at the worktree path above]`
}

// ---------------------------------------------------------------- schemas

const SOLUTION_SCHEMA = MODE === 'implement' ? {
  type: 'object',
  properties: {
    approach:      { type: 'string', description: 'What you did and why, 2-4 sentences.' },
    worktreePath:  { type: 'string', description: 'Output of `git rev-parse --show-toplevel` in your worktree.' },
    filesChanged:  { type: 'array', items: { type: 'string' } },
    diff:          { type: 'string', description: 'Full unified diff of your change (git diff).' },
    verification:  { type: 'string', description: 'The exact commands you ran and the real tail of their output. Say plainly if you did not run them.' },
    risks:         { type: 'array', items: { type: 'string' }, description: 'What you are least sure about.' },
    confidence:    { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['approach', 'worktreePath', 'diff', 'verification', 'confidence'],
} : {
  type: 'object',
  properties: {
    answer:        { type: 'string', description: 'Your conclusion, stated directly.' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim:  { type: 'string' },
          source: { type: 'string', description: 'file:line, a git ref, or the command whose output supports it.' },
        },
        required: ['claim', 'source'],
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    confidence:    { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['answer', 'evidence', 'confidence'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['sound', 'flawed-but-fixable', 'broken'] },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity:    { type: 'string', enum: ['blocker', 'major', 'minor'] },
          description: { type: 'string' },
          evidence:    { type: 'string', description: 'Triggering input, command output, or file:line. No evidence, no defect.' },
        },
        required: ['severity', 'description'],
      },
    },
    bestIdea: { type: 'string', description: 'The single thing from this candidate worth keeping even if the candidate loses.' },
    score:    { type: 'integer', minimum: 0, maximum: 10 },
  },
  required: ['verdict', 'defects', 'score'],
}

const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate: { type: 'integer' },
          rank:      { type: 'integer' },
          why:       { type: 'string' },
        },
        required: ['candidate', 'rank', 'why'],
      },
    },
    recommendation: { type: 'string', enum: ['adopt-one', 'merge', 'none-adequate'] },
    mergePlan:      { type: 'string', description: 'Concretely: take X from candidate i, Y from candidate j, and why.' },
    disagreements:  { type: 'array', items: { type: 'string' }, description: 'Where reviewers contradicted each other — the main agent should adjudicate these itself.' },
    openQuestions:  { type: 'array', items: { type: 'string' } },
  },
  required: ['ranking', 'recommendation', 'mergePlan'],
}

// ---------------------------------------------------------------- prompts

const SHARED = `# Task\n\n${TASK}\n` + (CONTEXT ? `\n# Additional context from the user\n\n${CONTEXT}\n` : '')

function solvePrompt(stance, i) {
  return MODE === 'implement'
    ? `${SHARED}
# Your stance — candidate ${i + 1} of ${NC}

${stance.brief}

You are one of ${NC} agents solving this task independently and in parallel. You cannot see the
others and must not try to. Commit fully to the stance above: a distinctive, well-argued attempt
is far more useful to the orchestrator than a hedged average of every approach.

# Rules

- You are in your own git worktree. Edit files freely; you cannot disturb anyone else's work.
  Note that it was created from HEAD, so uncommitted changes in the user's main tree are absent.
- Read CLAUDE.md and any applicable project skills, and follow them.
- Actually run the build and the test suite. Report the real commands and the real output tail.
  Reporting a passing suite you did not run is the single worst thing you can do here.
- Do not commit, push, or touch git history. Leave the change in the working tree.
- Report your diff with \`git --no-pager diff\` and your worktree with \`git rev-parse --show-toplevel\`.
- Be honest in \`risks\` and \`confidence\`. An accurate low confidence is more valuable than a
  fake high one; the orchestrator is weighing you against ${NC - 1} alternatives and needs the truth.`
    : `${SHARED}
# Your stance — candidate ${i + 1} of ${NC}

${stance.brief}

You are one of ${NC} agents investigating this independently and in parallel. You cannot see the
others and must not try to. Commit fully to the stance above — the orchestrator is comparing
genuinely different angles, so a distinctive investigation beats a safe generic one.

# Rules

- Ground every claim in something checkable: a file:line, a git ref, or the output of a command
  you actually ran. Never cite a file or line you did not open.
- This is read-only. Do not modify the repository; scratch files go in a temp directory.
- Say what you could not determine. Listing a real uncertainty is worth more than papering over it.`
}

function reviewPrompt(lens, sol, i) {
  const body = MODE === 'implement'
    ? `## Stated approach\n${sol.approach}\n\n## Worktree\n${sol.worktreePath || '(not reported)'}\n\n## Claimed verification\n${clip(sol.verification, 4000)}\n\n## Self-reported risks\n${(sol.risks || []).map(r => `- ${r}`).join('\n') || '(none)'}\n\n## Diff\n\`\`\`diff\n${clip(sol.diff, CLIP)}\n\`\`\``
    : `## Answer\n${sol.answer}\n\n## Evidence\n${(sol.evidence || []).map(e => `- ${e.claim}\n  source: ${e.source}`).join('\n') || '(none given)'}\n\n## Stated uncertainties\n${(sol.uncertainties || []).map(u => `- ${u}`).join('\n') || '(none)'}`

  return `${SHARED}
# Your job

Review candidate ${i + 1} below against the task above, through one specific lens.

## Your lens: ${lens.key}

${lens.brief}

# Rules

- You did not write this and you do not know who did. Judge only what is in front of you.
- Verify independently against the real repository. Do not accept the candidate's own claims —
  especially claims about tests passing — without checking them yourself.
- Report defects that are real and triggerable. Speculative concerns and style preferences with
  no consequence are noise; a review that invents defects is worse than no review.
- \`bestIdea\` matters even when you rate the candidate badly: the orchestrator may merge one
  good idea out of a losing candidate, so name the part worth salvaging.
- Score 0-10 on this lens alone. Do not try to judge the candidate overall.

# Candidate ${i + 1}

${body}`
}

// ---------------------------------------------------------------- run

log(`ensemble: mode=${MODE}, ${NC} candidates x ${NL} review lenses`)
log(`stances: ${PICKED_STANCES.map(s => s.key).join(', ')}`)
log(`lenses:  ${PICKED_LENSES.map(l => `${l.key} (${MODELS.review || l.model})`).join(', ')}`)
log(`models:  solve=${MODELS.solve}, compare=${MODELS.compare}${MODELS.review ? `, review=${MODELS.review} (all lenses)` : ', review=per-lens'}`)
if (NC < STANCES.length) log(`note: ${STANCES.length - NC} further stances available but not run (${STANCES.slice(NC).map(s => s.key).join(', ')})`)
if (Number(raw.reviewers) > NL) log(`note: reviewers capped at ${NL} — that is every distinct lens defined for ${MODE} mode`)

// Pipeline, not a barrier: candidate 1 is already being reviewed while
// candidate 3 is still solving. Wall-clock is the slowest single chain.
const results = await pipeline(
  PICKED_STANCES,

  (stance, _same, i) =>
    agent(solvePrompt(stance, i), {
      label: `solve:${stance.key}`,
      phase: 'Solve',
      schema: SOLUTION_SCHEMA,
      model: MODELS.solve,
      ...(MODE === 'implement' ? { isolation: 'worktree' } : {}),
    }),

  (sol, stance, i) => {
    if (!sol) return Promise.resolve({ candidate: i + 1, stance: stance.key, solution: null, reviews: [] })
    return parallel(
      PICKED_LENSES.map(lens => () =>
        agent(reviewPrompt(lens, sol, i), {
          label: `review:${lens.key}#${i + 1}`,
          phase: 'Review',
          schema: REVIEW_SCHEMA,
          model: MODELS.review || lens.model,
        }).then(r => (r ? { lens: lens.key, ...r } : null))
      )
    ).then(rs => ({
      candidate: i + 1,
      stance: stance.key,
      solution: sol,
      reviews: rs.filter(Boolean),
    }))
  }
)

const alive = results.filter(Boolean).filter(r => r.solution)

if (alive.length === 0) {
  log('ensemble: every candidate failed — nothing to compare')
  return { mode: MODE, task: TASK, candidates: [], advisor: null, note: 'All candidates failed or were skipped.' }
}
if (alive.length < NC) log(`note: ${NC - alive.length} of ${NC} candidates failed and are excluded`)

// Barrier is correct here and only here: the comparison is inherently cross-item.
phase('Compare')

const digest = alive.map(r => {
  const s = r.solution
  const head = MODE === 'implement'
    ? `### Approach\n${s.approach}\n\n### Files\n${(s.filesChanged || []).join(', ') || '(not reported)'}\n\n### Worktree\n${s.worktreePath}\n\n### Verification\n${clip(s.verification, 2500)}\n\n### Diff\n\`\`\`diff\n${clip(s.diff, 12000)}\n\`\`\``
    : `### Answer\n${s.answer}\n\n### Evidence\n${(s.evidence || []).map(e => `- ${e.claim} — ${e.source}`).join('\n')}\n\n### Uncertainties\n${(s.uncertainties || []).join('; ') || '(none)'}`
  const revs = r.reviews.map(v =>
    `- [${v.lens}] ${v.verdict}, ${v.score}/10\n` +
    (v.defects || []).map(d => `    ${d.severity}: ${d.description}${d.evidence ? ` (${d.evidence})` : ''}`).join('\n') +
    (v.bestIdea ? `\n    worth keeping: ${v.bestIdea}` : '')
  ).join('\n') || '  (no reviews returned)'
  return `## Candidate ${r.candidate}  [self-confidence ${s.confidence}/5]\n\n${head}\n\n### Reviews\n${revs}`
}).join('\n\n---\n\n')

const advisor = await agent(
  `${SHARED}
# Your job

${alive.length} agents attempted this task independently, and each attempt was reviewed through
${NL} lenses. Compare them head to head and produce a ranking and a merge plan.

You are an advisor, not the decider — the orchestrating agent will read your ranking alongside
the raw candidates and may overrule you. So make your reasoning inspectable, and be specific
about *why* one beats another rather than just asserting it.

# What to weigh

- A reviewer's verified defect outranks a candidate's own confidence.
- Reviewers only saw one candidate each. You see all of them: a defect one reviewer flagged may
  be present in candidates their reviewer missed. Check across.
- Judge the work, not the volume of it. The smallest correct answer wins.
- \`disagreements\`: where reviewers contradict each other, or where you disagree with a reviewer,
  say so explicitly instead of silently averaging. The orchestrator will adjudicate those itself.
- \`mergePlan\`: name concrete parts — "take the guard from candidate 2, the tests from candidate 4" —
  not a vague blend. If one candidate is simply best as-is, say \`adopt-one\` and say so.
- If none is adequate, say \`none-adequate\` and explain what a correct attempt would need to do.

${digest}`,
  { label: 'compare:bake-off', phase: 'Compare', schema: COMPARE_SCHEMA, model: MODELS.compare, effort: 'high' }
)

return {
  mode: MODE,
  task: TASK,
  stances: PICKED_STANCES.map(s => s.key),
  lenses: PICKED_LENSES.map(l => ({ lens: l.key, model: MODELS.review || l.model })),
  models: { solve: MODELS.solve, compare: MODELS.compare, review: MODELS.review || 'per-lens' },
  candidates: alive,
  advisor,
  forTheOrchestrator:
    'You decide, not the advisor. Read the candidates and reviews yourself before accepting the ' +
    'ranking; the advisor is a second opinion to cross-check, not a verdict to relay. Adjudicate ' +
    'anything in advisor.disagreements. ' +
    (MODE === 'implement'
      ? 'Nothing has been applied to the user\'s working tree — every candidate lives in its own ' +
        'worktree (see candidates[].solution.worktreePath). Present the trade-off, then apply the ' +
        'chosen or merged change to the main tree yourself.'
      : 'Spot-check at least the load-bearing citations before repeating a conclusion as fact.'),
}
