// ---------------------------------------------------------------- the Architecture tier

// A design, then the milestones to build it in. The seats (Opus, Astra and Sonnet unless the user
// named others) each design the work blind and debate the designs, and the author of the chosen
// one writes the final design with its milestone plan, merging in the best of the others.
// Reviewers who never saw the debate check the plan through three lenses (grounding, sequencing,
// risk), and one revision mends what they uphold. Nothing is built: each milestone carries its
// task, draft criteria, dependencies and tier, so it can be a factory run of its own. As in the
// Feature tier, there is no ratification: the review checks the plan itself.
async function architectureRun() {
  const stop = await councilSetup()
  if (stop) return stop
  const debated = await debateStage()
  if (debated.stop) return debated.stop
  const { outcome, decisionRows, decisionTable } = debated

  phase('Synthesize')
  const W = seat(S, outcome.W)
  const plan = await synthesize(W, outcome, ARCH_SYNTH_SCHEMA)
  if (!plan) return failure(S, 'failed', `${W.L}, the author of the chosen design, wrote no milestone plan`, { seats: reveal(S), design: S.pos[W.L].post })
  S.milestones = planMilestones(plan.milestones)
  log(`architecture: ${W.L}'s design, in ${plural(S.milestones.length, 'milestone')}: ${S.milestones.map(m => `${m.n} ${m.tier}`).join(', ') || 'none'}`)

  // ---- The review of the plan, and one revision

  S.auditedTag = 'final'
  const audit = await runAudit(W, { fixSchema: ARCH_SYNTH_SCHEMA })
  if (audit.fixResult) {
    const revised = planMilestones(audit.fixResult.milestones)
    if (revised.length) S.milestones = revised
    else S.notes.push(`${W.L}'s revision listed no milestones; the plan keeps the ones it had.`)
  }

  const lastCheck = audit.lastCheck || (audit.fixPass ? 'I' : audit.checked ? 'H' : 'F')
  const ready = readiness(S, W.L, lastCheck, [], [], [...audit.gaps, ...(S.milestones.length ? [] : ['the plan lists no milestones'])])
  const report = architectureReport(S, { outcome, W, rows: decisionRows, ready, audit })
  if (S.retro) phase('Retro')
  const retro = await runRetro({ outcome, W, endorsements: [], fixPass: false, ready, audit, reportMd: report.markdown })
  return architectureResult(S, { outcome, W, rows: decisionRows, table: decisionTable, ready, audit, report, retro })
}
