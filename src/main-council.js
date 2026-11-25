if (delegated) return await delegatedTierRun()
// A standalone council settles its goal brief first (src/goal.js); Factory's children carry Factory's.
return withGoalBrief(S, await controlledRun(async () => S.raw.explain ? explanation(S, pastRuns()) : (await settleGoal()) || councilRun()))
