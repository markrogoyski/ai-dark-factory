// ---------------------------------------------------------------- the factory

// Intake picks the tier, unless the user pinned one; a pin intake disagrees with is asked about
// once, and so is a task intake would split into separate runs. Then the run is rebuilt for its
// tier: the Simple flow, the Feature flow, the Architecture flow, or the council.
return await controlledRun(factoryRun)

async function factoryRun() {
  phase('Intake')
  const factoryArgs = parseFactory(S.raw)
  S = newState(parseConfig(S.raw, { workflow: 'factory' }))
  const intake = await ask(intakePrompt(S), { label: 'intake', phase: 'Intake', schema: INTAKE_SCHEMA, model: 'opus', effort: 'medium' }, 'intake')
  if (!intake) return failure(S, 'failed', 'the intake agent returned nothing')
  if (intake.status === 'needs-plan') return needsPlan(S, intake.planMissing, null)
  const pieces = splitItems(intake)
  S.factory = { tier: null, asked: factoryArgs.tier, tierConfirmed: factoryArgs.tierConfirmed, chosenBy: 'intake', recommended: intakeTier(intake), intake, escalation: null, args: S.raw,
    split: pieces.length ? { pieces: pieces.length, declined: true } : null }
  if (pieces.length && !factoryArgs.noSplit) return needsSplit(S, pieces, intake)
  const push = tierPushback(S, intake)
  if (push) return needsTier(S, push, intake)
  const tier = factoryArgs.tier || intakeTier(intake)
  S.factory.tier = tier
  S.factory.chosenBy = !factoryArgs.tier ? 'intake' : tier === S.factory.recommended ? 'pinned' : 'overruled'
  S.factory.strategy = factoryStrategy(S, intake)
  log(`factory: tier ${tier} (${S.factory.chosenBy}${S.factory.chosenBy === 'intake' ? '' : `; intake recommends ${S.factory.recommended}`}): ${oneLine(intake.reasons, 200)}`)
  {
    const carried = { factory: S.factory, turnLog: S.turnLog, processNotes: S.processNotes }
    S = newState(parseConfig(tierArgs(S.raw, tier, intake), { workflow: 'factory', tier }))
    Object.assign(S, carried)
  }
  if (S.factory.strategy === 'pair') {
    const carried = { factory: S.factory, turnLog: S.turnLog, processNotes: S.processNotes }
    S = newState(factoryPairConfig(S))
    Object.assign(S, carried, { pair: newPairState() })
    if (S.raw.explain) return explanation(S)
    const result = await pairRun()
    return { ...result, workflow: 'factory', tier, strategy: 'pair', factory: carried.factory }
  }
  if (S.raw.explain) return explanation(S)
  if (tier === 'simple') return await simpleRun()
  return routedResult(S, await tierRun(tier))
}

// The flow of a tier above Simple.
function tierRun(tier) {
  return tier === 'feature' ? featureRun() : tier === 'architecture' ? architectureRun() : councilRun()
}

// Hand the work to a higher tier: from Simple, or from Feature to Architecture. The lower tier's
// run directory stays for inspection; the higher tier starts from a fresh state with the factory
// record, the turn log and the process notes carried over, so its report and retro cover the
// whole run.
async function escalate(handUp) {
  const brief = escalationBrief(S, handUp)
  log(`factory: escalating from ${brief.from} to ${handUp.to} (${handUp.trigger}): ${handUp.why}`)
  const factory = { ...S.factory, tier: handUp.to, escalation: brief }
  const carried = { turnLog: S.turnLog, processNotes: S.processNotes, relayFailures: S.relayFailures, vendorTimes: S.vendorTimes,
    notes: S.notes.map(n => /^\w+ attempt: /.test(n) ? n : `${capital(brief.from)} attempt: ${n}`) }
  // From the user's own args: the lower tier's carry its defaults, such as Feature's two seats.
  S = newState(parseConfig(tierArgs(factory.args, handUp.to, factory.intake), { workflow: S.workflowName, tier: handUp.to, escalation: brief }))
  Object.assign(S, carried, { factory })
  return escalatedResult(S, await tierRun(handUp.to))
}
