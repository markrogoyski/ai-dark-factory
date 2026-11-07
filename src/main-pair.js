// A single author, with separate fresh review contexts and deterministic stopping rules.
return await pairRun()

async function pairRun() {
  phase('Setup')
  // Native Claude workflows need a native transport for setup and measurements. Prefer one
  // of the two selected participants; CLI seats and all Codex-host turns use their adapters.
  const native = [S.pairOptions.author, S.pairOptions.reviewer].find(s => s.vendor === 'claude')
  const transportModel = native ? native.model : 'haiku'
  const setup = await ask(setupPrompt(S), { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA,
    model: transportModel, effort: 'medium' }, 'setup')
  if (setup?.status === 'needs-plan') return needsPlan(S, setup.planMissing, setup.runDir)
  if (setup?.status === 'preflight') return preflightStop(S, setup.preflight)
  if (!setup || setup.status === 'error' || !setup.runDir || !setup.runId || !setup.repoRoot) {
    S.pair.stop = setup?.error || 'Setup did not return a run.'
    return pairResult(S, 'failed')
  }
  S.run = { runId: setup.runId, runDir: setup.runDir, repoRoot: setup.repoRoot, room: `${setup.runDir}/room` }
  S.seats = [{ L: 'A', ...S.lineup[0], wt: `${S.run.runDir}/wt/A`, active: true }]
  if (((setup.dirty || []).length && !S.allowDirty) || setup.status === 'dirty') {
    S.pair.stop = 'Tracked working-tree changes are absent from worktrees based on HEAD. Commit or stash them, or explicitly set allowDirty.'
    return pairResult(S)
  }
  S.criteria = setup.criteria || []
  S.verify = String(setup.verify || '').trim()
  S.refs = (setup.refs || []).filter(r => r.path?.startsWith(`${S.run.runDir}/refs/`))
  if (!S.criteria.length || new Set(S.criteria.map(c => c.id)).size !== S.criteria.length || S.criteria.some(c => !c.id || !c.text) ||
      S.refs.length !== (setup.refs || []).length || S.refs.length < S.plan.length ||
      (S.raw.verify && S.verify !== String(S.raw.verify).trim())) {
    S.pair.stop = 'Setup omitted criteria, reference snapshots, or the requested verification command.'
    return pairResult(S)
  }
  const p = S.pair
  log(`pair: ${S.pairOptions.author.name} authors; ${S.pairOptions.reviewer.name} reviews; budget ${S.pairOptions.maxReviews} reviews`)
  while (p.reviews.length < S.pairOptions.maxReviews) {
    const label = `pair-${p.stage}-${p.reviews.length + 1}`
    p.label = label
    phase(p.stage === 'design' ? 'Design' : 'Implement')
    const author = await pairAuthorTurn(label)
    if (!author) { p.stop = 'The author turn failed.'; return pairResult(S, 'failed') }
    p.author = author
    if (author.status !== 'done') {
      p.stop = author.summary || 'The author could not continue.'
      p.questions = author.questions || []
      return pairResult(S, author.status === 'needs-user' ? 'needs-user' : 'blocked')
    }
    if (p.stage === 'design') {
      if (!author.design?.trim()) { p.stop = 'The author returned no design.'; return pairResult(S, 'failed') }
      p.design = author.design
    } else {
      phase('Verify')
      try {
        p.measurement = hostRuntime ? await hostRuntime.measure({ run: S.run, seat: 'A', label })
          : await ask(pairMeasurePrompt(S, label), { label: `measure ${label}`, phase: 'Verify', schema: PAIR_MEASURE_SCHEMA,
            model: transportModel, effort: 'low' }, 'checker')
      } catch (error) { p.measurement = { status: 'error', error: String(error?.message || error) } }
      const m = p.measurement
      if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '') ||
          m.snapshot.ref !== `refs/council/${S.run.runId}/A-${label}` || m.snapshot.diff !== `${S.run.room}/${label}/A.diff` ||
          (m.suite?.ran && String(m.suite.command || '').trim() !== S.verify)) {
        p.stop = m?.error || 'Snapshot verification failed to produce evidence.'
        return pairResult(S, 'failed')
      }
    }
    phase(p.stage === 'design' ? 'Review design' : 'Review code')
    const review = await pairReviewTurn(label)
    const error = pairIngestReview(S, review)
    if (error) { p.stop = error; return pairResult(S, review ? 'blocked' : 'failed') }
    const ready = pairReadiness(S)
    log(`pair: ${p.stage} review ${p.reviews.length}: ${ready.state}; ${pairOpen(S).length} open finding(s)`)
    if (ready.state === 'ready') {
      if (p.stage === 'code') return pairResult(S, 'done')
      p.approvedDesign = p.design
      p.stage = 'code'
      p.lastReview = null
      continue
    }
    if (pairStalled(S)) { p.stop = 'Review stalled: the artifact and unresolved findings did not change.'; return pairResult(S) }
    if (p.stage === 'code' && review.requiresDesignRevision) {
      p.stage = 'design'
      p.approvedDesign = ''
      p.lastReview = null
    }
  }
  p.stop = `Review budget exhausted (${S.pairOptions.maxReviews}); work remains unresolved.`
  return pairResult(S)
}

function pairAuthorTurn(label) {
  const a = S.seats[0], prompt = pairAuthorPrompt(S, label)
  const ph = S.pair.stage === 'design' ? 'Design' : 'Implement'
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, {
    label, phase: ph, schema: PAIR_AUTHOR_SCHEMA, model: a.model, effort: a.effort,
  }, 'author', a.name)
  return externalTurn({ key: label, threadKey: 'pair-author', fresh: false, vendor: a.vendor,
    model: a.model, effort: a.effort, role: 'author', who: a.name, sandbox: 'workspace-write', cwd: a.wt,
    writable: [S.run.room, `${S.run.runDir}/jobs`, `${S.run.runDir}/logs`], timeoutKind: 'solve',
  }, prompt, PAIR_AUTHOR_SCHEMA, label, ph)
}

function pairReviewTurn(label) {
  const a = S.auditors[0]
  const checkout = `${S.run.runDir}/snap/pair-review-${label}`
  const prompt = pairReviewPrompt(S, label, checkout)
  const ph = S.pair.stage === 'design' ? 'Review design' : 'Review code'
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, {
    label: `review ${label}`, phase: ph, schema: PAIR_REVIEW_SCHEMA, model: a.model, effort: a.effort,
  }, 'reviewer', a.name)
  return externalTurn({ key: `review-${label}`, threadKey: `review-${label}`, fresh: true,
    vendor: a.vendor, model: a.model, effort: a.effort, role: 'reviewer', who: a.name,
    sandbox: 'workspace-write', cwd: checkout, writable: [`${S.run.runDir}/jobs`, `${S.run.runDir}/logs`],
    timeoutKind: 'audit', checkout: `A-${pairReviewTag(S)}`,
  }, prompt, PAIR_REVIEW_SCHEMA, `review ${label}`, ph)
}
