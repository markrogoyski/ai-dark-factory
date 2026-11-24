// ---------------------------------------------------------------- the factory, delegating

// Factory shapes the brief, runs intake and routes (src/route.js) under the run-limit guard; a stop
// before routing is finished here, as inline. A routed run goes to the child workflow its strategy
// names, and each hand-up to the next tier's child, one after another.
const routed = await guardedRun(factoryRun)
if (!routed?.handoff) return withGoalBrief(S, finishRun(routed))
return await runTiers(routed.handoff)

// Routing hands the tier over: the envelope carries Factory's record, the history so far, and its
// request control, with the budget meter's baseline natively (the runner's usage is shared).
async function routeTier() {
  return { handoff: factoryHandoff(S, factoryControl(requestControl, hostRuntime ? null : meterStart)) }
}

// Only Factory calls workflow(); each child gets its own wire copy of the envelope (src/lib/handoff.js).
async function runTiers(h) {
  // The token section inline Factory appends at the run's end, from Factory's own meter, which saw
  // the whole run; it names the helper and the run directory of the child that wrote the report.
  const withUsage = final => {
    const section = usageSection({ cli: handoffCli(h), run: final.runDir ? { runDir: final.runDir } : undefined }, runUsage())
    return section ? { ...final, report: { ...final.report, markdown: `${final.report.markdown}${section}` } } : final
  }
  for (;;) {
    const out = childOutcome(h, await workflow(childWorkflow(h), { factoryHandoff: handoffWire(h) }))
    if (out.final) return out.usage ? withUsage(out.final) : out.final
    const up = out.handUp
    log(`factory: escalating from ${up.escalation.from} to ${up.to} (${up.trigger}): ${up.why}`)
    h = nextHandoff(h, up)
  }
}
