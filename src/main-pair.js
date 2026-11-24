if (delegated) {
  // Factory's Pair, run from its handoff: explanations go back as they are, a Pair run with
  // Factory's wrapper, as inline Factory gives it. A guard stop is not wrapped.
  const res = await guardedRun(async () => {
    if (S.raw.explain) return explanation(S, pastRuns())
    const result = await pairRetro(await pairRun())
    return { ...result, workflow: 'factory', tier: S.factory.tier, strategy: 'pair', factory: S.factory, retro: result.retro || null }
  })
  // Read before finishRun: Factory appends its usage section only to a result that had a report.
  const usage = hasReport(res)
  return childFinal(withGoalBrief(S, finishRun(res)), usage)
}
// runtime: "cli" (Claude Code only): one transport agent runs the whole Pair on the standalone
// runner, which resumes the author's CLI session and records exact elapsed time.
if (!S.raw.explain && transport.cli) return await pairCliRun()
return await controlledRun(async () => S.raw.explain ? explanation(S, pastRuns()) : pairRetro(await pairRun()))
