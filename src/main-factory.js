// ---------------------------------------------------------------- the factory

// factoryRun (src/route.js) shapes the brief, runs intake and routes; routeTier then rebuilds the
// run for its tier: the Simple flow, the Feature flow, the Architecture flow, or the council.
const result = await controlledRun(factoryRun)
return withGoalBrief(S, result)

// The routed run, rebuilt for its tier.
async function routeTier(tier, intake) {
  {
    const carried = { ...carriedState(S), factory: S.factory }
    S = newState(parseConfig(tierArgs(S.raw, tier, intake), { workflow: 'factory', tier }))
    Object.assign(S, carried)
  }
  if (S.factory.strategy === 'pair') {
    const carried = { ...carriedState(S), factory: S.factory }
    S = newState(factoryPairConfig(S))
    Object.assign(S, carried, { pair: newPairState() })
    if (S.raw.explain) return explanation(S, pastRuns())
    const result = await pairRetro(await pairRun())
    return { ...result, workflow: 'factory', tier, strategy: 'pair', factory: carried.factory, retro: result.retro || null }
  }
  if (S.raw.explain) return explanation(S, pastRuns())
  if (tier === 'simple') return await simpleRun()
  return routedResult(S, await tierRun(tier))
}

// The flow of a tier above Simple.
function tierRun(tier) {
  return tier === 'feature' ? featureRun() : tier === 'architecture' ? architectureRun() : councilRun()
}

// Hand the work to a higher tier: from Simple, or from Feature to Architecture. The lower tier's
// run directory stays for inspection; the higher tier starts from a fresh state with the factory
// record and the run's diagnostic history (carriedState) carried over, so its report and retro
// cover the whole run.
async function escalate(handUp) {
  const brief = escalationBrief(S, handUp)
  log(`factory: escalating from ${brief.from} to ${handUp.to} (${handUp.trigger}): ${handUp.why}`)
  const factory = { ...S.factory, tier: handUp.to, escalation: brief }
  const carried = { ...carriedState(S),
    notes: S.notes.map(n => /^\w+ attempt: /.test(n) ? n : `${capital(brief.from)} attempt: ${n}`) }
  // From the user's own args: the lower tier's carry its defaults, such as Feature's two seats.
  S = newState(parseConfig(tierArgs(factory.args, handUp.to, factory.intake), { workflow: S.workflowName, tier: handUp.to, escalation: brief }))
  Object.assign(S, carried, { factory })
  return escalatedResult(S, await tierRun(handUp.to))
}
