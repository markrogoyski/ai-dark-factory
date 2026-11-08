// The shared scheduler has no conversation history. Each runtime task executes a fresh engine.
async function runPlanWorkflow(input, runtime) {
  const S = await runtime.open(input, runPlanDefinition)
  await runtime.recover(S)
  if (input.answers) { runPlanAnswer(S, input.answers); await runtime.save(S) }
  let task
  while ((task = runPlanNext(S))) {
    await runtime.reserve(S, task)
    const result = await runtime.execute(S, task, runPlanBrief(S, task))
    const outcome = runPlanOutcome(S, task, result)
    if (outcome === 'ready' && task.id !== 'acceptance') await runtime.deliver(S, task, result)
    else await runtime.finish(S, task, result, outcome === 'ready' ? 'done' : outcome)
  }
  return { ...runPlanReport(S), ...await runtime.location(S) }
}

if (typeof factoryRuntime !== 'undefined' && factoryRuntime.runPlan) return await runPlanWorkflow(args, factoryRuntime.runPlan)

// Claude's workflow runtime has no filesystem/process API. A transport turn invokes the same
// packaged controller; it does not make scheduling, integration, or readiness decisions.
const input = typeof args === 'string' ? { planFile: args.trim() } : args
if (!input || typeof input.planFile !== 'string') throw new Error('Pass {planFile: "/absolute/path/plan.json", repo: "/absolute/path/repo"}')
phase('Run-plan')
const relay = await agent(`Execute the authorized plan using the shipped CLI. Write this JSON verbatim to a temporary args file using your file tool:\n${JSON.stringify(input)}\nRun dark-factory-codex --workflow run-plan --args-file <that-file>${input.repo ? ' --cwd ' + "'" + input.repo.replace(/'/g, "'\\''") + "'" : ''}. Keep the foreground process alive and poll its active shell session until it exits. Do not use sleep polling. The runner commits verified tasks locally, retains budgets, and parks questions. Do not schedule tasks yourself, reset files, or interpret blocked as success. Return the exact final stdout JSON as the result string; on transport failure explain the failure in error.`, {
  model: 'sonnet', label: 'run-plan transport', schema: { type: 'object', properties: { result: { type: 'string' }, error: { type: 'string' } }, required: ['result', 'error'], additionalProperties: false },
})
if (!relay?.result) return { status: 'failed', error: relay?.error || 'Run-plan transport returned no result; rerun with the same plan to recover.' }
return JSON.parse(relay.result)
