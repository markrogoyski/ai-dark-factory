async function pairRun() {
  // Without a design stage the run starts, and stays, at the code stage.
  if (!pairDesigned(S)) S.pair.stage = 'code'
  // On the standalone runtime setup is a sandboxed model turn, so the runner measures the baseline
  // itself after setup returns; the flag tells setup not to (and is set on no other flow).
  S.runnerBaseline = !!hostRuntime
  // Native Claude workflows need a native transport for measurements. Prefer one of the two
  // selected participants; CLI seats and all Codex-host turns use their adapters. Setup is not a
  // transport: it runs on its role's model (Opus natively), since the run inherits its criteria.
  const native = [S.pairOptions.author, S.pairOptions.reviewer].find(s => s.vendor === 'claude')
  const transportModel = native ? native.model : 'haiku'
  // Setup, then the spec review of its criteria. A spec stop the user answered runs setup again
  // with the decisions, so the role that owns the criteria rewrites them, and the spec review
  // reads the new ones.
  for (;;) {
    const stopped = await pairSetup()
    if (stopped) return stopped
    const spec = await pairSpecReview()
    if (spec === null) break
    if (spec !== true) return spec
  }
  const p = S.pair
  log(`pair: ${S.pairOptions.author.name} authors; ${S.pairOptions.reviewer.name} reviews; budget ${S.pairOptions.maxReviews} reviews${pairDesigned(S) ? `, the design asking the user after ${S.pairOptions.maxDesignReviews}` : '; no design stage'}`)
  while (p.reviews.length < S.pairOptions.maxReviews) {
    let label = `pair-${p.stage}-${p.reviews.length + 1}`
    p.label = label
    phase(p.stage === 'design' ? 'Design' : 'Implement')
    let author = await pairAuthorTurn(label)
    for (;;) {
      if (!pairDesigned(S) && author?.status === 'done') {
        // The author writes the contract with the deliverable; a malformed one, or a mapping that
        // doesn't fit it, gets the same single correction a malformed design contract gets.
        const error = pairAdoptContract(S, author) || pairSpecReadingsError(S, author)
        if (error) {
          p.author = author
          S.notes.push(`${label}: ${error} Requested one author correction.`)
          label += '-corrected'
          p.label = label
          author = await pairAuthorTurn(label, error)
        }
      } else if (p.stage === 'design' && author?.status === 'done') {
        p.author = author
        p.design = author.design
        p.testContract = author.testContract
        const error = !author.design?.trim() ? 'The author returned no design.' : pairContractError(S, p.testContract) || pairSpecReadingsError(S, author)
        if (error) {
          S.notes.push(`${label}: ${error} Requested one author correction; no design approval was recorded.`)
          label += '-corrected'
          p.label = label
          author = await pairAuthorTurn(label, error)
        }
      }
      if (!author) { p.stop = 'The author turn failed.'; return pairResult(S, 'failed') }
      p.author = author
      pairIngestReadings(S, author)
      pairIngestLiveChecks(S, author.liveChecks, label)
      if (author.status === 'done') break
      p.stop = author.summary || 'The author could not continue.'
      if (author.status !== 'needs-user') { pairAsk(S, 'author', author.questions, label); return pairResult(S, 'blocked') }
      // Answered, the stop continues with a fresh author turn that reads the decisions.
      const stopped = await pairStop('author', author.questions, label)
      if (stopped) return stopped
      label += '-answered'
      p.label = label
      author = await pairAuthorTurn(label)
    }
    pairIngestReplies(S, author)
    if (p.stage === 'design') {
      if (!author.design?.trim()) { p.stop = 'The author returned no design.'; return pairResult(S, 'failed') }
      p.design = author.design
      p.testContract = author.testContract
      const error = pairContractError(S, p.testContract)
      if (error) { p.stop = error; return pairResult(S, 'blocked') }
      pairMilestone(pairAuthorLine(S))
    } else {
      if (!pairDesigned(S)) {
        const error = pairAdoptContract(S, author)
        if (error) { p.stop = error; return pairResult(S, 'blocked') }
      }
      p.replayMapping = author.replayMapping || []
      const mappingError = pairMappingError(S)
      if (mappingError) { p.stop = mappingError; return pairResult(S) }
      const measureError = await pairMeasure(label, transportModel)
      if (measureError) { p.stop = measureError; return pairResult(S, 'failed') }
      pairMilestone(pairAuthorLine(S))
    }
    phase(p.stage === 'design' ? 'Review design' : 'Review code')
    const before = p.findings.length
    const { review, error } = await pairReview(label)
    if (error) { p.stop = error; return pairResult(S, review ? 'blocked' : 'failed') }
    pairMilestone(pairReviewLine(S, review, before))
    // A conflict only the user can settle stops the run now, as an author's needs-user does: the
    // review still counts, and its findings and rulings are recorded.
    // Answered, the rest of this pass runs as usual; the decisions change the version, so the
    // review cannot count as ready or stalled, and the next author turn reads them.
    const asked = pairReviewQuestions(S, review)
    if (asked.length) {
      p.stop = String(review.summary || '').trim() || 'The reviewer found a conflict only the user can settle.'
      const stopped = await pairStop('reviewer', asked, `review ${label}`)
      if (stopped) return stopped
    }
    const ready = pairReadiness(S)
    if (ready.state === 'ready') {
      if (p.stage === 'code') return pairPolishDue(S) ? pairPolish(transportModel) : pairResult(S, 'done')
      p.approvedDesign = p.design
      p.approvedContract = JSON.parse(JSON.stringify(p.testContract))
      p.stage = 'code'
      p.lastReview = null
      continue
    }
    // A completed review of these bytes is still valid. Missing evidence must not
    // send an already accepted implementation through another author/reviewer cycle.
    if (p.stage === 'code' && pairInfrastructure(S).length) {
      p.stop = 'Verification infrastructure failed, so another review of these bytes cannot add evidence. Preserve this snapshot, repair the execution environment, and run the gate on it.'
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
    // A design still not approved after its allowance stops for the user, who continues it with a
    // scope decision, starts the implementation with the open design findings carried into code
    // review (implement: true), or stops. The run never moves on past them without that answer.
    if (pairDesignCapped(S)) {
      p.stop = pairDesignStopReason(S)
      const id = `Q${p.asked.length + 1}`
      const stopped = await pairStop('design', [{ about: 'none', question: pairDesignQuestion(S) }], `review ${label}`)
      if (stopped) return stopped
      if (pairDesignChoice(S, id) === 'implement') {
        const open = pairOpen(S).filter(f => f.stage === 'design').map(f => f.id)
        pairMilestone(`The implementation starts on the user's answer${open.length ? `, with ${open.join(', ')} open for code review` : ''}.`)
        p.approvedDesign = p.design
        p.approvedContract = JSON.parse(JSON.stringify(p.testContract))
        p.stage = 'code'
        p.lastReview = null
        continue
      }
    }
    // Without a design stage there is none to return to: the flag blocks readiness like a finding,
    // and the author reworks the approach in the next implementation turn.
    if (p.stage === 'code' && review.requiresDesignRevision && pairDesigned(S)) {
      p.stage = 'design'
      p.approvedDesign = ''
      p.approvedContract = null
      p.lastReview = null
    }
  }
  p.stop = `Review budget exhausted (${S.pairOptions.maxReviews}); work remains unresolved.`
  return pairResult(S)
}

// Measures the author's snapshot at `label` with the neutral helper: the runner's own measurement,
// or a native transport copying it. Returns why it produced no usable evidence, or null.
async function pairMeasure(label, transportModel) {
  const p = S.pair
  phase('Verify')
  try {
    p.measurement = pairMeasurementView(S, hostRuntime ? await hostRuntime.measure({ run: S.run, seat: 'A', label, replay: pairReplayRequest(S) })
      : await ask(pairMeasurePrompt(S, label), { label: `measure ${label}`, phase: 'Verify', schema: PAIR_MEASURE_SCHEMA,
        model: transportModel, effort: 'low', copies: true }, 'checker'), PAIR_MEASURE_SCHEMA)
  } catch (error) {
    if (fatalTurnError(error)) throw error
    p.measurement = { status: 'error', error: String(error?.message || error) }
  }
  const m = p.measurement
  if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '') ||
      m.snapshot.ref !== `refs/council/${S.run.runId}/A-${label}` || m.snapshot.diff !== `${S.run.room}/${label}/A.diff` ||
      (m.suite?.ran && String(m.suite.command || '').trim() !== S.verify)) return m?.error || 'Snapshot verification failed to produce evidence.'
  return null
}

// One review of the current version, with one correction for a review whose structured fields
// can be fixed without changing its judgement. Returns the review and why it can't count, if so.
async function pairReview(label) {
  const p = S.pair
  const trim = (review, at) => {
    pairNormalizeReview(S, review)
    const dropped = p.stage === 'design' || pairChallengesDue(S) ? pairTrimChallenges(S, review) : []
    if (dropped.length) S.notes.push(`review ${at}: dropped rejecting checks that do not cover the challenged criterion (${dropped.join('; ')}).`)
    return review
  }
  let review = trim(await pairReviewTurn(label), label)
  let error = pairIngestReview(S, review)
  if (error && review?.complete === true && review.version === pairVersion(S) && pairCorrectableError(S, review)) {
    S.notes.push(`review ${label}: ${error} Requested one reviewer correction; the invalid review changed no findings.`)
    review = trim(await pairReviewTurn(`${label}-corrected`, { error, review }), `${label}-corrected`)
    error = pairIngestReview(S, review)
  }
  return { review, error }
}

// The polish pass (pairPolishDue): the code review left only minor findings open, with the work
// otherwise ready. The author gets one turn to fix or decline them, the helper measures it, and a
// short check confirms it. Anything short of a confirmed, ready snapshot sets the polish aside, and
// the run delivers the snapshot reviewed before it, which was ready. Spends none of the budget.
async function pairPolish(transportModel) {
  const p = S.pair, label = 'pair-polish'
  pairPolishStart(S)
  pairMilestone(`Only minor findings are open (${p.polish.minors.join(', ')}), so ${S.pairOptions.author.name} gets one polish pass.`)
  const end = reason => {
    pairPolishEnd(S, reason)
    if (reason) pairMilestone(`The polish pass was set aside (${pairBrief(reason, 240)}); the result is the snapshot reviewed in ${p.polish.from.label}.`)
    return pairResult(S, 'done')
  }
  p.label = label
  phase('Polish')
  const author = await pairAuthorTurn(label)
  if (!author) return end('the author turn failed')
  if (author.status !== 'done') return end(`the author returned ${author.status}: ${oneLine(author.summary, 200) || 'no reason given'}`)
  p.author = author
  pairIngestReplies(S, author)
  const measureError = await pairMeasure(label, transportModel)
  if (measureError) return end(`its measurement failed: ${oneLine(measureError, 200)}`)
  pairMilestone(pairPolishAuthorLine(S))
  phase('Review code')
  const before = p.findings.length
  const { review, error } = await pairReview(label)
  if (error) return end(`its check did not count: ${oneLine(error, 200)}`)
  pairMilestone(pairPolishReviewLine(S, review, before))
  const ready = pairReadiness(S)
  return end(ready.state === 'ready' ? '' : oneLine([...ready.blocked, ...ready.incomplete, ...ready.infrastructure][0] || `readiness ${ready.state}`, 240))
}

// The spec review of setup's criteria (off with spec: false): one fresh reviewer, before any author
// turn. A failed turn changes nothing but the notes. Findings a reading settles go to the author's
// readings ledger; a conflict only the user can settle stops the run. Returns null to go on to
// the author, true when the user answered the stop (setup runs again), or the stop's result.
async function pairSpecReview() {
  const r = S.specReviewers[0], p = S.pair
  if (!r) return null
  phase('Spec')
  const label = p.spec.passes.length ? `spec-${p.spec.passes.length + 1}` : 'spec'
  const prompt = pairSpecPrompt(S)
  const res = r.vendor === 'claude' && !hostRuntime
    ? await ask(prompt, { label, phase: 'Spec', schema: PAIR_SPEC_SCHEMA, model: r.model, effort: r.effort }, 'spec', r.name)
    : await externalTurn({ key: label, threadKey: label, configKey: 'pair-spec', fresh: true, vendor: r.vendor, model: r.model, effort: r.effort,
        role: 'spec', who: r.name, sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'spec' }, prompt, PAIR_SPEC_SCHEMA, label, 'Spec')
  const pass = pairIngestSpec(S, res, label)
  if (!res) S.notes.push(`The spec review (${label}, ${r.name}) returned nothing; the criteria stand as setup wrote them.`)
  pairMilestone(pairSpecLine(S, pass))
  const asked = p.spec.findings.filter(f => f.pass === label && f.to === 'user')
  if (!asked.length) return null
  pass.stopped = true
  asked.forEach((f, i) => { f.asked = `Q${p.asked.length + i + 1}` })
  p.stop = `The spec review found ${asked.length === 1 ? 'a conflict' : 'conflicts'} in the criteria that only the user can settle.`
  const stopped = await pairStop('spec', asked.map(f => ({ about: pairSpecAbout(S, f), question: pairSpecQuestion(f) })), label)
  if (stopped) return stopped
  // Setup runs again in a run of its own; the stopped run's worktree stays until cleanup.
  S.notes.push(`${label}: setup runs again with the user's answers, in a new run; remove ${S.run.runDir} with dark-factory cleanup --run-dir ${shq(S.run.runDir)} --all once this run is delivered.`)
  p.setupAttempt++
  return true
}

// Setup: the run, the criteria, the gate and its baseline, with setup's own stops. Returns the
// stop's result, or null to go on. Run again after an answered spec stop, it replaces them all.
async function pairSetup() {
  phase('Setup')
  let setup
  for (;;) {
    // A conflict the user answered runs setup again, with the decisions, as a run of its own.
    const label = !S.pair.setupAttempt ? 'setup' : `setup-answered${S.pair.setupAttempt > 1 ? `-${S.pair.setupAttempt}` : ''}`
    setup = await ask(pairSetupPrompt(S), { label, phase: 'Setup', schema: PAIR_SETUP_SCHEMA,
      model: S.roles.setup.model, effort: 'medium' }, 'setup')
    if (setup?.status === 'needs-plan') return needsPlan(S, setup.planMissing, setup.runDir)
    if (setup?.status === 'preflight') return preflightStop(S, setup.preflight)
    if (setup?.status === 'needs-commit') { S.pair.stop = pairNeedsCommit(setup.error); return pairResult(S) }
    if (setup?.status !== 'needs-user') break
    S.pair.stop = setup.error || 'Setup found conflicting requirements.'
    const stopped = await pairStop('setup', setup.questions, label)
    if (stopped) return stopped
    S.pair.setupAttempt++
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
  if (!hostRuntime) {
    S.baselineOk = !S.verify || !!setup.baselinePasses
    S.baselineNote = S.baselineOk ? '' : oneLine(setup.baselineNote, 300) || 'no reason given'
  }
  S.refs = (setup.refs || []).filter(r => r.path?.startsWith(`${S.run.runDir}/refs/`))
  const lost = setupLosses(S, S.criteria, S.verify)
  if (!S.criteria.length || new Set(S.criteria.map(c => c.id)).size !== S.criteria.length || S.criteria.some(c => !c.id || !c.text) ||
      S.refs.length !== (setup.refs || []).length || planReferenceCount(S) < S.plan.length || lost.length) {
    S.pair.stop = `Setup omitted criteria, reference snapshots, or the requested verification command${lost.length ? `: it dropped ${lost.join('; ')}` : ''}.`
    return pairResult(S)
  }
  // Checked in the run against a stand-in, and by the user against the real thing before delivery.
  S.pair.liveChecks = []
  pairIngestLiveChecks(S, setup.liveChecks, 'setup')
  // A supplied criterion no evidence inside the run can meet would block readiness after all the
  // work, so the user rewrites or drops it before any author turn. Setup owns the criteria it
  // wrote: one it still lists goes to the author and reviewer to check by inspection, not to the user.
  const unverifiable = (setup.unverifiable || []).filter(u => String(u?.criterion || '').trim())
  const supplied = unverifiable.filter(u => u.origin !== 'written')
  for (const u of unverifiable.filter(u => u.origin === 'written'))
    S.repositoryNotes = `${S.repositoryNotes ? `${S.repositoryNotes}\n` : ''}Setup could not find a run-time check for ${u.criterion}, which it wrote: ${oneLine(u.reason, 300) || 'no reason given'}. Check it by inspecting the code and the plan, and say so in the ${pairDesigned(S) ? 'design' : 'handoff'}.`
  if (supplied.length) {
    const text = id => S.criteria.find(c => c.id === id)?.text
    S.pair.stop = `Setup found ${supplied.length === 1 ? 'a criterion' : 'criteria'} this run cannot verify: ${supplied.map(u => `${u.criterion} (${oneLine(u.reason, 300) || 'no reason given'})`).join('; ')}.`
    for (const u of supplied) S.notes.push(`Setup found ${u.criterion} unverifiable inside the run: ${oneLine(u.reason, 300) || 'no reason given'}.`)
    const stopped = await pairStop('criterion', supplied.map(u => ({ about: u.criterion,
      question: `${u.criterion}${text(u.criterion) ? ` ("${oneLine(text(u.criterion), 200)}")` : ''} cannot be verified inside the run: ${oneLine(u.reason, 300) || 'no reason given'}. Rewrite it so the run can check it, or drop it?` })), 'setup')
    if (stopped) return stopped
    if (!S.criteria.length) { S.pair.stop = 'The user dropped every acceptance criterion, so the run has nothing to check.'; return pairResult(S) }
  }
  if (hostRuntime) {
    // Measured by the runner process, outside any model's sandbox, with no model turn. Setup's
    // baselinePasses and baselineNote are not used. The record stays out of S.pair.measurement, so
    // the review tag and version remain at base until the first code measurement.
    let base = null
    if (S.verify) {
      try {
        base = await hostRuntime.measure({ run: S.run, seat: 'A', label: 'base' })
      } catch (error) {
        if (fatalTurnError(error)) throw error
        base = { status: 'error', error: String(error?.message || error) }
      }
    }
    pairBaselineResult(S, base)
  }
  pairMilestone(pairSetupLine(S))
  return null
}

// Every stop that asks the user. Returns the stop's result, or null once the answers in
// clarifications settle every question at it and the run continues. Natively the stop is recorded
// first (worktree, snapshot ref), and a continuation is checked against that record just before
// it: a resume replays every turn before it from the session's cache, including this record. The
// runner's checkpoint validation does both jobs there.
async function pairStop(kind, items, label) {
  const p = S.pair
  const questions = pairAsk(S, kind, items, label)
  if (!questions.length) return pairResult(S, 'needs-user')
  pairMilestone(pairQuestionsLine(S, kind, questions))
  const key = questions[0].id, tag = S.run ? pairReviewTag(S) : 'base', native = !hostRuntime && !!S.run
  const check = (prompt, turn) => ask(prompt, { label: `${turn} ${key}`, phase: 'Stop', schema: PAIR_RESUME_SCHEMA, model: 'haiku', effort: 'low', copies: true }, 'checker')
  if (native) {
    const record = await check(pairStopRecordPrompt(S, key, tag), 'stop')
    if (record?.status !== 'ok') {
      S.notes.push(`stop ${key}: the stop was not recorded (${oneLine(record?.reason || 'the transport returned nothing', 300)}), so it cannot continue in place.`)
      p.fallback = true
      return pairResult(S, 'needs-user')
    }
  }
  const taken = pairTakeAnswers(S)
  p.resumable = true
  if (taken.state === 'unanswered') return pairResult(S, 'needs-user')
  if (taken.state === 'incomplete') {
    // Stops again at once: no further turn, and no retro or record turn for this attempt.
    p.stop = pairAnswerMessage(taken, p.questions)
    p.skipRetro = true
    return pairResult(S, 'needs-user')
  }
  p.resumable = false
  if (native) {
    const verdict = await check(pairResumeCheckPrompt(S, key, tag, pairAnswersHash(S, taken.answered)), 'resume-check')
    if (verdict?.status !== 'ok') {
      p.stop = `The run cannot continue past ${key}: ${oneLine(verdict?.reason || 'the resume check returned nothing', 400)}`
      p.fallback = true
      return pairResult(S, 'blocked')
    }
  }
  pairApplyDecisions(S, taken.answered)
  pairMilestone(`The user answered ${questions.map(q => q.id).join(', ')}; the run continues.`)
  return null
}

function pairMilestone(line) { milestone(line, 'pair: ') }

// The process retro after a Pair run, standalone or as the factory's pair strategy, once setup has
// made a run. A factory run always records its facts; it gets the model retro only when retroWanted.
async function pairRetro(result) {
  if (!S.run || (!S.factory && !S.retro) || S.pair.skipRetro) return result
  const ready = result.final.readiness
  phase(retroWanted(S, { ready }) ? 'Retro' : 'Record')
  const retro = await runRetro({ outcome: null, W: null, endorsements: [], fixPass: false, ready, audit: null, reportMd: result.report.markdown })
  return { ...result, retro,
    forTheOrchestrator: result.forTheOrchestrator + (retro && retro.markdown ? ' Last, show retro.markdown as it is: notes on the workflow, not the user\'s project.' : '') }
}

function pairAuthorTurn(label, correction = '') {
  const a = S.seats[0], prompt = pairAuthorPrompt(S, label, correction)
  const ph = S.pair.stage === 'design' ? 'Design' : 'Implement'
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, {
    label, phase: ph, schema: PAIR_AUTHOR_SCHEMA, model: a.model, effort: a.effort,
  }, 'author', a.name)
  return externalTurn({ key: label, threadKey: 'pair-author', configKey: 'pair-author', fresh: false, vendor: a.vendor,
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
  return externalTurn({ key: `review-${label}`, threadKey: `review-${label}`, configKey: 'pair-reviewer', fresh: true,
    vendor: a.vendor, model: a.model, effort: a.effort, role: 'reviewer', who: a.name,
    sandbox: 'workspace-write', cwd: checkout, writable: [`${S.run.room}/review-${label}`, `${S.run.runDir}/jobs`, `${S.run.runDir}/logs`],
    timeoutKind: 'audit', checkout: `A-${pairReviewTag(S)}`,
  }, prompt, PAIR_REVIEW_SCHEMA, `review ${label}`, ph)
}

// The participants are named so the runner's Codex defaults (an Astra author) don't replace the
// Claude Code profile.
function pairCliPrompt() {
  const q = v => "'" + String(v).replace(/'/g, "'\\''") + "'"
  const { explain, ...rest } = S.raw
  const cliArgs = { ...rest, author: S.pairOptions.author.key, reviewer: S.pairOptions.reviewer.key }
  const cmd = `rm -f ARGS.out ARGS.log ARGS.exit; dark-factory-codex --workflow pair --brief --args-file ARGS${S.raw.repo ? ' --cwd ' + q(S.raw.repo) : ''}${transport.cli.resume ? ' --resume ' + q(transport.cli.resume) : ''} < /dev/null > ARGS.out 2> ARGS.log; echo $? > ARGS.exit`
  return `Run one Pair workflow on the shipped standalone runtime. You are only its transport: you do not work on the task.

Step 1. Write this JSON verbatim to a temporary file using your file tool. Below, ARGS stands for that file's absolute path. An earlier transport may have left ARGS.exit beside a file of the same name; the commands below ignore it:
${JSON.stringify(cliArgs)}

Step 2. Make one Bash call with run_in_background: true and dangerouslyDisableSandbox: true (the runner starts Claude and Codex CLIs, which can't run inside the Bash tool's sandbox), with ARGS replaced by the path:
${cmd}

Step 3. Wait for ARGS.exit to exist. Make one Bash call with timeout: 600000 and dangerouslyDisableSandbox: true:
for i in $(seq 1 110); do [ -s ARGS.exit ] && [ ARGS.exit -nt ARGS ] && break; sleep 5; done; cat ARGS.exit 2>/dev/null || echo running
If it prints "running", make the same call again; repeat until it prints an exit code. The run usually takes 15-60 minutes. Don't start the command again, don't use pgrep or other process checks, and don't wait any other way.

Step 4. Make one Bash call: cat ARGS.out
It prints one line of JSON. Return that line exactly as the result string: don't shorten, reformat or summarize it. If ARGS.out is empty or isn't JSON, set result to "" and put the exit code and the last 20 lines of ARGS.log in error.

Do not read or change the repository, review the work, or interpret the outcome: a blocked or needs-user result is a result, not a failure.`
}

async function pairCliRun() {
  phase('Pair')
  const relay = await agent(pairCliPrompt(), { model: 'sonnet', label: 'pair transport',
    schema: { type: 'object', properties: { result: { type: 'string' }, error: { type: 'string' } }, required: ['result', 'error'], additionalProperties: false } })
  if (!relay?.result) return { status: 'failed', error: relay?.error || 'Pair transport returned no result.' }
  let result
  try { result = JSON.parse(relay.result) } catch { return { status: 'failed', error: 'Pair transport returned output that is not the runner JSON.', output: relay.result.slice(0, 2000) } }
  // The runner's steps name its own --resume; from Claude Code the run continues through runtime "cli".
  if (result?.resumable === true && typeof result.resumeSteps === 'string' && result.hostRunDir) {
    const steps = pairResumeSteps(S, 'cli', result.hostRunDir, Array.isArray(result.questions) ? result.questions : [], result.final?.post || null)
    const guidance = typeof result.forTheOrchestrator === 'string' ? result.forTheOrchestrator : ''
    result.forTheOrchestrator = guidance.includes(result.resumeSteps) ? guidance.split(result.resumeSteps).join(steps) : `${steps} ${guidance}`.trim()
    result.resumeSteps = steps
  }
  return result
}
