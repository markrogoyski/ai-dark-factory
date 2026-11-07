// Independent candidates share the snapshot and host machinery, but ranking stays advisory.
function parseEnsembleConfig(args) {
  const raw = parseArgs(args)
  const mode = raw.mode || (IMPLEMENT_RE.test(raw.task || '') ? 'implement' : 'investigate')
  if (!['implement', 'investigate'].includes(mode)) throw new Error('ensemble mode must be implement or investigate.')
  const models = raw.models || {}, codex = raw.host === 'codex'
  const named = seatList(raw.seats)
  const count = boundedInteger(raw.candidates, named.length || 4, 'candidates', 6)
  if (count < 2 || (named.length && named.length !== count)) throw new Error('ensemble needs 2–6 candidates, matching seats when supplied.')
  const solve = models.solve || raw.solveModel || (codex ? 'sol' : 'sonnet')
  const config = parseConfig({ ...raw, mode, seats: named.length ? named : Array(count).fill(solve), spec: false, audit: false }, { workflow: 'ensemble', tier: 'ensemble' })
  const { stances, lenses } = ensembleChoices(config)
  const review = models.review || raw.reviewModel
  const picked = lenses.slice(0, boundedInteger(raw.reviewers, 2, 'reviewers', 4)).map(l => ({ ...l, ...hostSeat(config.host, parseSeat(review || (codex ? (l.model === 'opus' ? 'astra' : 'sol') : l.model), raw.effort)), lens: l.key }))
  return { ...config, raw, panel: [], specReviewers: [], auditors: picked,
    ensemble: { stances: stances.slice(0, count), lenses: picked, compare: hostSeat(config.host, parseSeat(models.compare || raw.compareModel || (codex ? 'astra' : 'opus'), raw.effort)) } }
}

function ensembleChoices(S) {
  const MODE = S.mode
  const stances = MODE === 'implement' ? [
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

  const lenses = MODE === 'implement' ? [
    { key: 'correctness',  model: 'opus',   brief: 'Hunt for a concrete input or state on which this change produces a wrong result, throws, or silently corrupts data. A defect without a triggering scenario is not a defect — state inputs and the resulting wrong output.' },
    { key: 'verification', model: 'sonnet', brief: 'Do not take the claimed verification on trust. Go to the worktree path yourself, re-run the build and the test suite, and report the real command and its real output. If the candidate claims tests pass and they do not, that is a blocker.' },
    { key: 'fit',          model: 'sonnet', brief: 'Judge it against the surrounding codebase: conventions, naming, error handling, docs, test placement, project instructions (CLAUDE.md and skills). Flag scope creep — anything changed that the task did not require.' },
    { key: 'simplicity',   model: 'opus',   brief: 'Ask what could be deleted. Is there existing code that already does this? Is there a materially simpler formulation with the same behaviour? Unnecessary abstraction and indirection are defects.' },
  ] : [
    { key: 'evidence',     model: 'sonnet', brief: 'Check the receipts. For each cited file:line or command output, open it and confirm it says what the candidate claims. Any claim you cannot confirm is a defect, and a fabricated citation is a blocker.' },
    { key: 'refute',       model: 'opus',   brief: 'Try to prove the conclusion false. Look for the code path, input, or commit that contradicts it. Default to refuted when you are genuinely uncertain — a confidently wrong answer is worse than an unresolved one.' },
    { key: 'completeness', model: 'opus',   brief: 'Ask what is missing: an unexplored code path, an unasked question, a case the answer does not cover, an alternative explanation never considered.' },
  ]

  return { stances, lenses }
}

function ensembleSolvePrompt(S, s, stance) {
  return `${taskBlock(S, 0)}
Your independent stance: ${stance.key}. ${stance.brief}
${workspaceBlock(S, s, 0)}
Read repository instructions. Do not inspect other candidates or their posts. ${S.mode === 'implement' ? 'Implement the task and run the verification gate in your worktree.' : 'Investigate read-only; scratch files belong in a temporary directory. Ground every claim in checkable evidence.'}
Write your complete result to ${postPath(S, s.L, 0)}. Return actual verification commands and output; never claim a check you did not run.`
}

function ensembleReviewPrompt(S, s, a, solution, checkout) {
  return `${taskBlock(S, 0)}
You are a fresh independent reviewer. Lens: ${a.lens}. ${a.brief}
Candidate: ${postPath(S, s.L, 0)}
${S.mode === 'implement' ? `Review snapshot refs/council/${S.run.runId}/${s.L}-r0, tree ${S.pos[s.L].tree?.hash || '(unmeasured)'}. Return that exact tree as snapshotTree. Your disposable checkout is ${checkout}; create if absent with ${S.cli} materialize --run-dir ${shq(S.run.runDir)} --seat ${s.L} --label r0 --name ensemble-${s.L}-${a.lens}. Never write the author's worktree. Re-run checks here.` : `Inspect the repository read-only and validate the cited evidence. Return snapshotTree as an empty string.`}
Inspect every acceptance criterion and return its evidenced assessment. Return complete=true only after the full review. Defects must have concrete triggers and evidence. Do not read other candidates or reviews.
${S.mode === 'implement' ? reviewScope() : 'Review the answer against the task. Blockers invalidate its conclusion; major defects leave material claims unsupported or required questions unanswered; minor defects are localized corrections.'}
${a.vendor === 'gemini' ? GEMINI_REVIEWER : ''}
Candidate's report (verify it yourself): ${JSON.stringify(solution)}`
}
