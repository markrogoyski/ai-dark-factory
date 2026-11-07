// ---------------------------------------------------------------- the Feature tier

// Plans first. The seats (Opus and Astra unless the user named others) each plan the change blind
// and debate the plans on the ledger, and the author of the chosen plan writes the final one,
// merging in the best of the others. That author then builds it, one increment a turn, with the
// neutral check after each. Auditors who never saw the planning review the change through three
// lenses (correctness, design, tests), and one fix pass mends what they uphold. There is no
// ratification: the audit reviews the change itself, which a vote on the plan could not. A final
// plan with more increments than one build makes goes to the Architecture tier before any is built.
async function featureRun() {
  const stop = await councilSetup()
  if (stop) return stop

  // ---- Plans: round 0 and the debate, in plan mode

  S.mode = 'plan'
  S.postWords = WORDS_BY_MODE.plan
  const debated = await debateStage()
  if (debated.stop) return debated.stop
  const { outcome, decisionRows, decisionTable } = debated

  phase('Synthesize')
  const W = seat(S, outcome.W)
  const plan = await synthesize(W, outcome, PLAN_SYNTH_SCHEMA)
  S.build = { plan: S.pos[W.L].post, ...planIncrements(plan && plan.increments) }
  const handUp = featureTrigger(S, W.L)
  if (handUp) return escalate(handUp)

  // ---- Build: one increment a turn, each checked

  S.mode = 'implement'
  S.postWords = WORDS_BY_MODE.implement
  phase('Build')
  const incs = S.build.increments
  log(`feature: ${W.L} builds the plan in ${plural(incs.length, 'increment')}`)
  for (const inc of incs) {
    const k = `K${inc.n}`
    const res = await seatTurn(W, k, buildPrompt(S, W, k), BUILD_SCHEMA)
    if (res) {
      Object.assign(inc, { reported: true, summary: res.summary || '', deviations: (res.deviations || []).filter(d => typeof d === 'string' && d.trim()).slice(0, 8) })
      S.pos[W.L] = { ...S.pos[W.L], post: postPath(S, W.L, k) }
      keepNotes(S, W, k, res)
      ingestClaims(S, W.L, k, res.claims)
    } else {
      S.notes.push(`${W.L}'s build turn for increment ${inc.n} returned nothing.`)
    }
    await runChecks(k, W.L)
    const p = S.pos[W.L]
    inc.check = p.snapTag === roundTag(k) ? { suite: p.suite, stats: p.stats } : null
    log(`build ${roundTag(k)}: ${inc.reported ? 'built' : 'no report'}; ${inc.check ? `${suiteWord(inc.check.suite)}, +${inc.check.stats.added}/−${inc.check.stats.removed} in ${plural(inc.check.stats.files, 'file')}` : 'not measured'}`)
  }
  if (!incs.some(x => x.reported)) return failure(S, 'failed', `no build turn of ${W.L}'s plan returned anything`, { seats: reveal(S) })

  // ---- Audit, report

  const lastK = `K${incs.length}`
  S.auditedTag = roundTag(lastK)
  const audit = await runAudit(W)
  const lastCheck = audit.lastCheck || (audit.fixPass ? 'I' : audit.checked ? 'H' : lastK)
  const ready = readiness(S, W.L, lastCheck, [], [], audit.gaps)
  const report = featureReport(S, { outcome, W, rows: decisionRows, ready, audit })
  if (S.retro) phase('Retro')
  const retro = await runRetro({ outcome, W, endorsements: [], fixPass: false, ready, audit, reportMd: report.markdown })
  return featureResult(S, { outcome, W, rows: decisionRows, table: decisionTable, ready, audit, report, retro })
}
