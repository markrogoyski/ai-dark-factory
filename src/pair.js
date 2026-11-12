async function pairRun() {
  phase('Setup')
  // Native Claude workflows need a native transport for setup and measurements. Prefer one
  // of the two selected participants; CLI seats and all Codex-host turns use their adapters.
  const native = [S.pairOptions.author, S.pairOptions.reviewer].find(s => s.vendor === 'claude')
  const transportModel = native ? native.model : 'haiku'
  const setup = await ask(pairSetupPrompt(S), { label: 'setup', phase: 'Setup', schema: PAIR_SETUP_SCHEMA,
    model: transportModel, effort: 'medium' }, 'setup')
  if (setup?.status === 'needs-plan') return needsPlan(S, setup.planMissing, setup.runDir)
  if (setup?.status === 'preflight') return preflightStop(S, setup.preflight)
  if (setup?.status === 'needs-user') {
    S.pair.stop = setup.error || 'Setup found conflicting requirements.'
    S.pair.questions = setup.questions || []
    return pairResult(S, 'needs-user')
  }
  if (!setup || setup.status === 'error' || !setup.runDir || !setup.runId || !setup.repoRoot || !/^[0-9a-f]{40,64}$/.test(setup.head || '')) {
    S.pair.stop = setup?.error || 'Setup did not return a run.'
    return pairResult(S, 'failed')
  }
  S.run = { runId: setup.runId, runDir: setup.runDir, repoRoot: setup.repoRoot, head: setup.head, room: `${setup.runDir}/room` }
  S.seats = [{ L: 'A', ...S.lineup[0], wt: `${S.run.runDir}/wt/A`, active: true }]
  if (((setup.dirty || []).length && !S.allowDirty) || setup.status === 'dirty') {
    S.pair.stop = 'Tracked working-tree changes are absent from worktrees based on HEAD. Commit or stash them, or explicitly set allowDirty.'
    return pairResult(S)
  }
  S.criteria = setup.criteria || []
  S.repositoryNotes = setup.repositoryNotes || ''
  S.verify = String(setup.verify || '').trim()
  S.baselineOk = !S.verify || !!setup.baselinePasses
  if (!S.baselineOk) S.baselineNote = oneLine(setup.baselineNote, 300) || 'no reason given'
  S.refs = (setup.refs || []).filter(r => r.path?.startsWith(`${S.run.runDir}/refs/`))
  if (!S.criteria.length || new Set(S.criteria.map(c => c.id)).size !== S.criteria.length || S.criteria.some(c => !c.id || !c.text) ||
      S.refs.length !== (setup.refs || []).length || S.refs.length < S.plan.length ||
      (S.raw.verify && S.verify !== String(S.raw.verify).trim())) {
    S.pair.stop = 'Setup omitted criteria, reference snapshots, or the requested verification command.'
    return pairResult(S)
  }
  // A criterion no evidence inside the run can meet would block readiness after all the work, so
  // the user rewrites or drops it before any author turn.
  const unverifiable = (setup.unverifiable || []).filter(u => String(u?.criterion || '').trim())
  if (unverifiable.length) {
    const text = id => S.criteria.find(c => c.id === id)?.text
    S.pair.stop = `Setup found ${unverifiable.length === 1 ? 'a criterion' : 'criteria'} this run cannot verify: ${unverifiable.map(u => u.criterion).join(', ')}.`
    S.pair.questions = unverifiable.map(u => `${u.criterion}${text(u.criterion) ? ` ("${oneLine(text(u.criterion), 200)}")` : ''} cannot be verified inside the run: ${oneLine(u.reason, 300) || 'no reason given'}. Rewrite it so the run can check it, or drop it?`)
    return pairResult(S, 'needs-user')
  }
  const p = S.pair
  log(`pair: ${S.pairOptions.author.name} authors; ${S.pairOptions.reviewer.name} reviews; budget ${S.pairOptions.maxReviews} reviews`)
  while (p.reviews.length < S.pairOptions.maxReviews) {
    let label = `pair-${p.stage}-${p.reviews.length + 1}`
    p.label = label
    phase(p.stage === 'design' ? 'Design' : 'Implement')
    let author = await pairAuthorTurn(label)
    if (p.stage === 'design' && author?.status === 'done') {
      p.author = author
      p.design = author.design
      p.testContract = author.testContract
      const error = !author.design?.trim() ? 'The author returned no design.' : pairContractError(S, p.testContract)
      if (error) {
        S.notes.push(`${label}: ${error} Requested one author correction; no design approval was recorded.`)
        label += '-corrected'
        p.label = label
        author = await pairAuthorTurn(label, error)
      }
    }
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
      p.testContract = author.testContract
      const error = pairContractError(S, p.testContract)
      if (error) { p.stop = error; return pairResult(S, 'blocked') }
    } else {
      p.replayMapping = author.replayMapping || []
      const mappingError = pairMappingError(S)
      if (mappingError) { p.stop = mappingError; return pairResult(S) }
      phase('Verify')
      try {
        p.measurement = hostRuntime ? await hostRuntime.measure({ run: S.run, seat: 'A', label, replay: pairReplayRequest(S) })
          : await ask(pairMeasurePrompt(S, label), { label: `measure ${label}`, phase: 'Verify', schema: PAIR_MEASURE_SCHEMA,
            model: transportModel, effort: 'low' }, 'checker')
      } catch (error) {
        if (fatalTurnError(error)) throw error
        p.measurement = { status: 'error', error: String(error?.message || error) }
      }
      const m = p.measurement
      if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '') ||
          m.snapshot.ref !== `refs/council/${S.run.runId}/A-${label}` || m.snapshot.diff !== `${S.run.room}/${label}/A.diff` ||
          (m.suite?.ran && String(m.suite.command || '').trim() !== S.verify)) {
        p.stop = m?.error || 'Snapshot verification failed to produce evidence.'
        return pairResult(S, 'failed')
      }
    }
    phase(p.stage === 'design' ? 'Review design' : 'Review code')
    let review = await pairReviewTurn(label)
    let error = pairIngestReview(S, review)
    if (error && p.stage === 'design' && review?.complete === true && review.version === pairVersion(S) && pairChallengeError(S, review)) {
      S.notes.push(`review ${label}: ${error} Requested one reviewer correction; the invalid review changed no findings.`)
      review = await pairReviewTurn(`${label}-corrected`, { error, review })
      error = pairIngestReview(S, review)
    }
    if (error) { p.stop = error; return pairResult(S, review ? 'blocked' : 'failed') }
    const ready = pairReadiness(S)
    log(`pair: ${p.stage} review ${p.reviews.length}: ${ready.state}; ${pairOpen(S).length} open finding(s)`)
    if (ready.state === 'ready') {
      if (p.stage === 'code') return pairResult(S, 'done')
      p.approvedDesign = p.design
      p.approvedContract = JSON.parse(JSON.stringify(p.testContract))
      p.stage = 'code'
      p.lastReview = null
      continue
    }
    // A completed review of these bytes is still valid. Missing evidence must not
    // send an already accepted implementation through another author/reviewer cycle.
    if (p.stage === 'code' && p.measurement?.suite?.failureKind === 'infrastructure') {
      p.stop = 'Verification infrastructure failed after bounded recovery. Preserve this snapshot and repair the execution environment before continuing.'
      return pairResult(S)
    }
    if (p.stage === 'code' && ready.state === 'incomplete' && pairReviewClean(S)) {
      p.stop = 'Implementation review passed; verification evidence remains incomplete. Inspect final.readiness and measurement artifacts.'
      return pairResult(S)
    }
    if (pairStalled(S)) {
      p.stop = pairOpen(S).length ? 'Review stalled: the artifact and unresolved findings did not change.'
        : 'Review stalled: the artifact and unmet criteria or verification results did not change.'
      return pairResult(S)
    }
    if (p.stage === 'code' && review.requiresDesignRevision) {
      p.stage = 'design'
      p.approvedDesign = ''
      p.approvedContract = null
      p.lastReview = null
    }
  }
  p.stop = `Review budget exhausted (${S.pairOptions.maxReviews}); work remains unresolved.`
  return pairResult(S)
}

function pairAuthorTurn(label, correction = '') {
  const a = S.seats[0], prompt = pairAuthorPrompt(S, label, correction)
  const ph = S.pair.stage === 'design' ? 'Design' : 'Implement'
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, {
    label, phase: ph, schema: PAIR_AUTHOR_SCHEMA, model: a.model, effort: a.effort,
  }, 'author', a.name)
  return externalTurn({ key: label, threadKey: 'pair-author', fresh: false, vendor: a.vendor,
    model: a.model, effort: a.effort, role: 'author', who: a.name, sandbox: 'workspace-write', cwd: a.wt,
    writable: [S.run.room, `${S.run.runDir}/jobs`, `${S.run.runDir}/logs`], timeoutKind: 'solve',
  }, prompt, PAIR_AUTHOR_SCHEMA, label, ph)
}

function pairReviewTurn(label, correction = null) {
  const a = S.auditors[0]
  const checkout = `${S.run.runDir}/snap/pair-review-${label}`
  const prompt = pairReviewPrompt(S, label, checkout, correction)
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

// The participants are named so the runner's Codex defaults (a Sol author) don't replace the
// Claude Code profile.
function pairCliPrompt() {
  const q = v => "'" + String(v).replace(/'/g, "'\\''") + "'"
  const { explain, ...rest } = S.raw
  const cliArgs = { ...rest, author: S.pairOptions.author.key, reviewer: S.pairOptions.reviewer.key }
  const cmd = `dark-factory-codex --workflow pair --args-file <that-file>${S.raw.repo ? ' --cwd ' + q(S.raw.repo) : ''}${transport.cli.resume ? ' --resume ' + q(transport.cli.resume) : ''}`
  return `Run one Pair workflow on the shipped standalone runtime. You are only its transport: you do not work on the task.

Write this JSON verbatim to a new temporary args file using your file tool:
${JSON.stringify(cliArgs)}

Then run, using Bash with run_in_background=true:
${cmd}

Retain the returned task_id and wait with TaskOutput(block=true, timeout=300000); repeat TaskOutput on that same task until it exits. The run can take longer than Bash's foreground timeout. Do not restart the command while it is running, and do not poll with sleep. Do not read or change the repository, review the work, or interpret the outcome: a blocked or needs-user result is a result, not a failure. Return the exact final stdout JSON as the result string; on transport failure explain the failure in error.`
}

async function pairCliRun() {
  phase('Pair')
  const relay = await agent(pairCliPrompt(), { model: 'sonnet', label: 'pair transport',
    schema: { type: 'object', properties: { result: { type: 'string' }, error: { type: 'string' } }, required: ['result', 'error'], additionalProperties: false } })
  if (!relay?.result) return { status: 'failed', error: relay?.error || 'Pair transport returned no result; rerun with the same arguments and resume: <hostRunDir> to recover.' }
  try { return JSON.parse(relay.result) } catch { return { status: 'failed', error: 'Pair transport returned output that is not the runner JSON.', output: relay.result.slice(0, 2000) } }
}
