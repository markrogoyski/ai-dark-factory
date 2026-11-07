// Evidence about process value, not a model's opinion of its own quality.
function evaluationFacts(S, result, elapsedMs, turns) {
  const byStage = {}
  for (const f of S.spec.findings) {
    const row = byStage.specification || (byStage.specification = { found: 0, upheld: 0, refuted: 0, amended: 0 })
    row.found++; if (f.status === 'accepted') row.upheld++; if (f.status === 'rejected') row.refuted++
    if (S.spec.applied.some(a => a.id === f.id)) row.amended++
  }
  for (const c of S.ledger.filter(c => c.kind === 'finding')) {
    const stage = lensOf(c.author) ? 'audit' : typeof c.round === 'number' ? 'debate' : 'ratification'
    const row = byStage[stage] || (byStage[stage] = { found: 0, upheld: 0, refuted: 0, fixed: 0 })
    row.found++; if (c.status === 'verified') row.upheld++; if (c.status === 'refuted') row.refuted++; if (c.fixed) row.fixed++
  }
  for (const f of S.pair?.findings || []) {
    const row = byStage[f.stage] || (byStage[f.stage] = { found: 0, upheld: 0, refuted: 0, fixed: 0 })
    row.found++; if (f.status === 'fixed') { row.fixed++; row.upheld++ }; if (f.status === 'refuted') row.refuted++
  }
  const candidates = result.candidates
  if (candidates) byStage.ensembleReview = { found: candidates.reduce((n, c) => n + c.reviews.reduce((n, r) => n + (r.defects?.length || 0), 0), 0) }
  return { version: 1, taskId: S.raw.evaluation?.taskId || null, variant: S.raw.evaluation?.variant || null,
    repetition: S.raw.evaluation?.repetition || null, workflow: S.factory ? 'factory' : S.workflowName,
    tier: S.factory?.tier || S.tier, strategy: S.factory?.strategy || (S.pair ? 'pair' : 'independent'), host: S.host,
    elapsedMs, turns, turnsByRole: S.turnLog.reduce((m, t) => ({ ...m, [t.role]: (m[t.role] || 0) + 1 }), {}),
    failedTurns: S.turnLog.filter(t => !t.ok).length, findingsByStage: byStage,
    ...(candidates ? { candidates: { total: candidates.length, ready: candidates.filter(c => c.final.readiness.state === 'ready').length } } : {}),
    readiness: result.final?.readiness?.state || null, delivery: result.delivery?.status || 'not-recorded',
    escalated: !!S.factory?.escalation, requestedImplementation: S.factory?.intake?.mode === 'implement' || S.mode === 'implement',
    deliveredImplementation: false, tokens: null, cost: null,
    limits: { maxTurns: S.controls.maxTurns, maxRunMin: S.controls.maxRunMin } }
}
