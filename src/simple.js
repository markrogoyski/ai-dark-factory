// ---------------------------------------------------------------- the Simple tier

// One implementer, the neutral check, one reviewer from another vendor, at most one fix pass. At
// each point where the evidence can show the task isn't simple, simpleTrigger decides, and the work
// goes to a higher tier: a fresh state, its own setup and run directory, and the council flow.
async function simpleRun() {
  phase('Setup')
  const setup = await ask(setupPrompt(S), { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA, model: 'opus', effort: 'medium' }, 'setup')
  if (setup && setup.status === 'needs-plan') return needsPlan(S, setup.planMissing, setup.runDir)
  if (setup && setup.status === 'preflight') {
    const bad = (setup.preflight || []).filter(p => p && !p.ok)
    return preflightStop(S, bad.length ? bad : [{ vendor: '?', ok: false, error: setup.error || 'the preflight check did not pass' }])
  }
  if (!setup || setup.status === 'error' || !setup.runDir) {
    return failure(S, 'failed', setup ? (setup.error || 'setup returned no run directory') : 'the setup agent failed')
  }
  S.run = { runId: setup.runId, runDir: setup.runDir, repoRoot: setup.repoRoot, room: `${setup.runDir}/room` }
  if (setup.status === 'dirty') {
    return failure(S, 'blocked', `the working tree has uncommitted changes to tracked files (${setup.dirty.slice(0, 10).join(', ')}). ` +
      'The implementer works from HEAD and would not see them. Commit or stash first, or rerun with allowDirty: true', { dirty: setup.dirty })
  }
  S.criteria = (setup.criteria || []).filter(c => c && c.id && c.text)
  S.refs = (setup.refs || []).filter(r => r && typeof r.path === 'string' && r.path.startsWith(`${S.run.runDir}/refs/`))
    .map(r => ({ source: String(r.source || ''), path: r.path, inWorktrees: !!r.inWorktrees }))
  S.verify = String(setup.verify || '').trim()
  S.baselineOk = !S.verify || setup.baselinePasses
  if (!S.baselineOk) S.baselineNote = oneLine(setup.baselineNote, 300) || 'no reason given'
  S.seats = [{ L: S.letters[0], ...S.lineup[0], wt: `${S.run.runDir}/wt/${S.letters[0]}`, active: true }]
  const W = S.seats[0]
  S.behaviour[W.L] = { turns: [], capitulations: [], ignored: [] }
  log(`factory: simple, ${W.name} implements, ${S.auditors.map(a => a.name).join(', ')} reviews · criteria: ${S.criteria.map(c => c.id).join(', ') || 'none'} · verify: ${S.verify || 'none'}`)

  phase('Solve')
  const res = await seatTurn(W, 0, simpleSolvePrompt(S, W), SIMPLE_SOLVE_SCHEMA)
  if (!res) return failure(S, 'failed', 'the implementer returned nothing')
  ingestSolve(S, W, res)
  const tooBig = res.tooBig && res.tooBig.tier ? res.tooBig : null
  if (!tooBig) {
    await runChecks(0, W.L)
  }
  let handUp = simpleTrigger(S, 'solve', { tooBig })
  if (handUp) return escalate(handUp)

  S.auditedTag = roundTag(0)
  const audit = await runAudit(W, { rereview: false, beforeFix: () => simpleTrigger(S, 'review') })
  if (audit.escalate) return escalate(audit.escalate)

  const lastCheck = audit.fixPass ? 'I' : audit.checked ? 'H' : 0
  const ready = readiness(S, W.L, lastCheck, [], [], audit.gaps)
  handUp = simpleTrigger(S, 'final', { ready })
  if (handUp) return escalate(handUp)

  const report = simpleReport(S, { W, ready, audit })
  phase(retroWanted(S, { ready }) ? 'Retro' : 'Record')
  const retro = await runRetro({ outcome: null, W, endorsements: [], fixPass: false, ready, audit, reportMd: report.markdown })
  return simpleResult(S, { W, ready, audit, report, retro })
}
