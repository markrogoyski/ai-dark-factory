// Bounded repairs use fresh reviews of each measured revision. Legacy council calls retain
// their original prompts unless the caller selects the repair policy.
async function boundedReview(a, W, round, tag) {
  const checkout = auditCheckout(S, a, round)
  const prompt = repairReviewPrompt(S, a, W, round, tag, checkout)
  const schema = S.tier === 'architecture' ? PLAN_REVIEW_SCHEMA : historyCheck(S) ? FACTORY_AUDIT_SCHEMA : AUDIT_SCHEMA
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, { label: `${round} ${a.lens}: ${a.key}`, phase: 'Audit', schema, model: a.model, effort: a.effort }, 'auditor', a.name)
  return externalTurn({ key: `${round}-${a.lens}`, threadKey: `audit-${round}-${a.lens}`, fresh: true,
    vendor: a.vendor, model: a.model, effort: a.effort, role: 'auditor', who: a.name,
    sandbox: S.mode === 'implement' ? 'workspace-write' : 'read-only', cwd: S.mode === 'implement' ? checkout : S.run.repoRoot,
    writable: S.mode === 'implement' ? [`${S.run.room}/tests`, `${S.run.room}/${round}`, `${S.run.runDir}/jobs`, `${S.run.runDir}/logs`] : [],
    ...(S.mode === 'implement' ? { checkout: `${W.L}-${tag}` } : {}), timeoutKind: 'audit',
  }, prompt, schema, `${round} ${a.lens}: ${a.key}`, 'Audit')
}

async function boundedAudit(W, o) {
  const policy = S.controls.repair || { maxPasses: 1, minor: 'block' }
  const audit = { ran: false, checked: false, reviews: {}, testsAtAudit: {}, fixPass: false, addressed: [], rereviews: {}, gaps: [], fixResult: null,
    cycles: [], repairPolicy: policy, stopReason: '', finalTag: S.auditedTag, lastCheck: S.pos[W.L]?.assessment?.round ?? null }
  if (!S.auditors.length || (S.mode !== 'implement' && S.tier !== 'architecture')) return audit
  audit.ran = true
  if (S.mode !== 'implement' && !S.pos[W.L]?.artifactHash) { audit.gaps.push('No content hash for the reviewed design.'); return audit }
  let previous = null
  for (let pass = 0; pass <= policy.maxPasses; pass++) {
    phase('Audit')
    const round = `review${pass}`, before = S.ledger.length
    const reviewedTree = S.pos[W.L].tree?.hash
    S.reviewedSnapshot = audit.finalTag
    const reviews = await parallel(S.auditors.map(a => () => boundedReview(a, W, round, audit.finalTag)))
    const current = {}
    S.auditors.forEach((a, i) => {
      if (reviews[i]) current[a.lens] = ingestAudit(S, a, round, W.L, reviews[i])
      else audit.gaps.push(`no ${round} review from the ${a.lens} auditor`)
    })
    if (pass === 0) audit.reviews = current
    else audit.rereviews = current
    if (historyCheck(S)) {
      audit.gaps = audit.gaps.filter(g => !g.startsWith('historical evidence review incomplete:'))
      const owner = evidenceOwner(S)
      if (current[owner.lens]?.evidenceReview?.status !== 'complete') audit.gaps.push(`historical evidence review incomplete: ${owner.lens}`)
    }
    // New findings and reproductions must be adjudicated against the same measured revision.
    if (S.ledger.length > before || audit.lastCheck === null) {
      await runChecks(round, W.L, auditTriage(S, round))
      // No author changed the artifact during this review. An upheld new defect cannot
      // simultaneously be fixed on these same bytes, even if a checker claims it is.
      for (const c of S.ledger.slice(before)) if (c.kind === 'finding' && c.status === 'verified') c.fixed = false
      audit.checked = true; audit.lastCheck = round; audit.finalTag = round
      if (reviewedTree && S.pos[W.L].tree?.hash !== reviewedTree) audit.gaps.push('The measured snapshot changed during independent review.')
    }
    const todo = repairTodo(S, W.L)
    const signature = repairSignature(S, W.L)
    audit.cycles.push({ review: round, snapshot: audit.finalTag, findings: S.ledger.slice(before).map(c => c.id), needed: todo.needed })
    // A Simple approach defect still escalates before spending a repair turn.
    if (pass === 0 && o.beforeFix) {
      const escalation = o.beforeFix()
      if (escalation) { audit.escalate = escalation; return audit }
    }
    if (audit.gaps.length || !todo.needed) return audit
    if (signature === previous || pass === policy.maxPasses) {
      audit.stopReason = signature === previous ? 'Repair stalled: the measured artifact and unresolved findings did not change.' : `Repair budget exhausted (${policy.maxPasses} passes).`
      audit.gaps.push(audit.stopReason)
      return audit
    }
    previous = signature
    const tag = `repair${pass + 1}`
    const fix = await seatTurn(W, tag, boundedRepairPrompt(S, W, todo, tag, pass + 1, policy.maxPasses), o.fixSchema || SYNTH_SCHEMA)
    audit.fixPass = true; audit.fixResult = fix
    if (!fix) { audit.gaps.push('The repair turn failed.'); return audit }
    S.pos[W.L] = { ...S.pos[W.L], summary: fix.summary || S.pos[W.L].summary, post: postPath(S, W.L, tag) }
    keepNotes(S, W, tag, fix); ingestClaims(S, W.L, tag, fix.claims); keepDeclined(S, tag, fix)
    audit.addressed.push(...(fix.addressed || []).filter(x => x?.ref))
    await runChecks(tag, W.L)
    audit.lastCheck = tag; audit.finalTag = tag
  }
  return audit
}
