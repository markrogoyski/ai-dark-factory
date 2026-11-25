// ---------------------------------------------------------------- the factory's routing

// Intake picks the tier, unless the user pinned one; a pin intake disagrees with is asked about
// once, and so is a task intake would split into separate runs. A stop before routing is the run's
// result; once routed, routeTier, which each Factory entry defines, takes the tier from there.
async function factoryRun() {
  const raw = S.raw
  const factoryArgs = parseFactory(raw)
  S.factory = {}
  const stopped = await settleGoal()
  if (stopped) return stopped
  phase('Intake')
  const { intake, error } = await factoryIntake()
  if (error) return error
  if (!intake) return failure(S, 'failed', 'the intake agent returned nothing')
  if (intake.status === 'needs-plan') return needsPlan(S, intake.planMissing, null)
  const pieces = splitItems(intake)
  S.factory = { ...S.factory, tier: null, asked: factoryArgs.tier, tierConfirmed: factoryArgs.tierConfirmed, chosenBy: 'intake', recommended: intakeTier(intake), intake, escalation: null, args: S.raw,
    split: pieces.length ? { pieces: pieces.length, declined: true } : null }
  if (pieces.length && !factoryArgs.noSplit) return needsSplit(S, pieces, intake)
  const push = tierPushback(S, intake)
  if (push) return needsTier(S, push, intake)
  const tier = factoryArgs.tier || intakeTier(intake)
  S.factory.tier = tier
  S.factory.chosenBy = !factoryArgs.tier ? 'intake' : tier === S.factory.recommended ? 'pinned' : 'overruled'
  S.factory.strategy = factoryStrategy(S, intake)
  log(`factory: tier ${tier} (${S.factory.chosenBy}${S.factory.chosenBy === 'intake' ? '' : `; intake recommends ${S.factory.recommended}`}): ${oneLine(intake.reasons, 200)}`)
  return await routeTier(tier, intake)
}
