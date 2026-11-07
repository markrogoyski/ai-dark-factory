return await controlledRun(async () => S.raw.explain ? explanation(S) : ensembleRun())

async function ensembleRun() {
  const stop = await councilSetup()
  if (stop) return stop
  for (const seat of S.seats) ingestSolve(S, seat, { summary: 'Candidate pending.', claims: [], tests: [], questions: [] })
  const candidates = await parallel(S.seats.map((s, i) => async () => {
    const stance = S.ensemble.stances[i]
    const solution = await seatTurn(s, 0, ensembleSolvePrompt(S, s, stance), ENSEMBLE_SOLUTION_SCHEMA)
    if (!solution) return { candidate: i + 1, stance: stance.key, solution: null, reviews: [], final: { readiness: { state: 'incomplete', blocked: [], incomplete: ['The solver failed.'] } } }
    ingestSolve(S, s, { summary: solution.approach || solution.answer, claims: [], tests: [], questions: [] })
    await runChecks(0, s.L)
    const reviews = await parallel(S.ensemble.lenses.map(a => () => ensembleReview(s, a, solution, i)))
    const missing = reviews.flatMap((r, j) => !r || r.complete !== true || r.snapshotTree !== (S.pos[s.L].tree?.hash || '')
      ? [`Missing or stale ${S.ensemble.lenses[j].lens} review.`] : [])
    if (S.mode === 'implement' && !S.pos[s.L].tree) missing.push('No measured snapshot tree.')
    const ready = readiness(S, s.L, 0, [], [], missing)
    for (const r of reviews.filter(Boolean)) {
      if (r.verdict !== 'sound' || (r.defects || []).some(d => ['blocker', 'major'].includes(d.severity))) ready.blocked.push('An independent reviewer found an unresolved defect.')
      for (const c of S.criteria) {
        const entries = (r.criteria || []).filter(x => x.criterion === c.id)
        if (entries.length !== 1 || !entries[0].note) ready.incomplete.push(`Review did not evidence criterion ${c.id}.`)
        else if (entries[0].status !== 'met') ready.blocked.push(`Review did not confirm criterion ${c.id}.`)
      }
    }
    ready.state = ready.blocked.length ? 'blocked' : ready.incomplete.length ? 'incomplete' : 'ready'
    return { candidate: i + 1, stance: stance.key, solution, reviews: reviews.map((r, j) => ({ lens: S.ensemble.lenses[j].lens, ...(r || { missing: true }) })),
      runDir: S.run.runDir, mode: S.mode, task: S.task,
      final: { author: s.L, model: s.name, worktree: s.wt, post: postPath(S, s.L, 0),
        snapshotRef: S.mode === 'implement' ? `refs/council/${S.run.runId}/${s.L}-r0` : null,
        snapshotTree: S.pos[s.L].tree?.hash || null, diff: S.mode === 'implement' ? `${S.run.room}/r0/${s.L}.diff` : null,
        suite: S.pos[s.L].suite, criteria: S.pos[s.L].criteria, readiness: ready },
      delivery: { status: ready.state === 'ready' && S.mode === 'implement' ? 'pending' : 'not-ready' } }
  }))
  const alive = candidates.filter(c => c.solution)
  const a = S.ensemble.compare
  const prompt = `${taskBlock(S, 99)}\nCompare these independent candidates and reviews. Your ranking is advisory: do not apply or merge code. Missing reviews and failed verification remain gaps. Prefer evidenced correctness, then simplicity; state disagreements and a concrete merge plan. Never describe a blocked candidate as ready.\n${JSON.stringify(candidates)}`
  const advisor = !alive.length ? null : a.vendor === 'claude' && !hostRuntime
    ? await ask(prompt, { label: 'compare', phase: 'Compare', schema: ENSEMBLE_COMPARE_SCHEMA, model: a.model, effort: a.effort }, 'compare', a.name)
    : await externalTurn({ key: 'compare', threadKey: 'compare', fresh: true, vendor: a.vendor, model: a.model, effort: a.effort, role: 'compare', who: a.name,
      sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'audit' }, prompt, ENSEMBLE_COMPARE_SCHEMA, 'compare', 'Compare')
  return { status: alive.length ? 'advisory' : 'failed', workflow: 'ensemble', mode: S.mode, task: S.task, runDir: S.run.runDir, candidates, advisor, notes: S.notes,
    final: { readiness: { state: 'incomplete', blocked: [], incomplete: ['No candidate selected; ranking is advisory.', ...(!advisor ? ['Comparison unavailable.'] : [])] } },
    delivery: { status: 'pending-selection' },
    forTheOrchestrator: 'Read every candidate readiness and the reviews before selecting or merging. A merge needs fresh verification and review. For an unchanged ready candidate, save that candidate object as the delivery result, apply its reviewed snapshot within authorization, and use verify-delivery. Never treat the advisory ranking as readiness.' }
}

function ensembleReview(s, a, solution, i) {
  const key = `ensemble-${s.L}-${a.lens}`, checkout = `${S.run.runDir}/snap/${key}`
  const prompt = ensembleReviewPrompt(S, s, a, solution, checkout)
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, { label: key, phase: 'Review', schema: ENSEMBLE_REVIEW_SCHEMA, model: a.model, effort: a.effort }, 'reviewer', a.name)
  return externalTurn({ key, threadKey: key, fresh: true, vendor: a.vendor, model: a.model, effort: a.effort, role: 'reviewer', who: a.name,
    sandbox: S.mode === 'implement' ? 'workspace-write' : 'read-only', cwd: S.mode === 'implement' ? checkout : S.run.repoRoot,
    writable: [], ...(S.mode === 'implement' ? { checkout: `${s.L}-r0` } : {}), timeoutKind: 'audit' }, prompt, ENSEMBLE_REVIEW_SCHEMA, key, 'Review')
}
