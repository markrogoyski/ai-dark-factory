// ---------------------------------------------------------------- a tier Factory delegated

// The tier Factory routed to, run from its handoff. Factory logged the routing line, spent the
// pre-route turns and keeps the usage section; this child runs the tier and returns what it did:
// its final result, or a hand-up for Factory to send to the next tier. Explanations and Simple's
// own results go back as they are; only a higher tier's result gets the routed or escalated
// wrapper, as inline Factory gives it.
async function delegatedTierRun() {
  const res = await guardedRun(async () => {
    if (S.raw.explain) return explanation(S, pastRuns())
    const tier = S.factory.tier
    if (tier === 'simple') return await simpleRun()
    const out = await tierRun(tier)
    if (out?.factoryChild) return out
    return S.factory.escalation ? escalatedResult(S, out) : routedResult(S, out)
  })
  if (res?.factoryChild) return res
  // Read before finishRun: Factory appends its usage section only to a result that had a report.
  const usage = hasReport(res)
  return childFinal(withGoalBrief(S, finishRun(res)), usage)
}

// The flow of a tier above Simple.
function tierRun(tier) {
  return tier === 'feature' ? featureRun() : tier === 'architecture' ? architectureRun() : councilRun()
}

// A tier that finds the work needs a higher one hands it back to Factory, which logs the
// escalation and starts the next child; nothing more runs here.
async function escalate(handUp) {
  return childHandUp(S, handUp, requestControl.turns)
}
