// Run-plan policy. Persistence, processes, Git, and verification live in the runtime adapter.
function runPlanDefinition(S) {
  const fail = message => { throw new Error(`run-plan: ${message}`) }
  const object = x => x && typeof x === 'object' && !Array.isArray(x)
  const text = x => typeof x === 'string' && x.trim()
  const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)
  const criteria = x => Array.isArray(x) && x.length > 0 && x.every(text)
  if (!object(S) || S.version !== 1 || !id(S.id)) fail('version 1 and a stable id are required')
  for (const key of Object.keys(S)) if (!['version', 'id', 'tasks', 'decisions', 'acceptance', 'limits', 'defaults', 'progress'].includes(key)) fail(`unknown plan field: ${key}`)
  if (!Array.isArray(S.tasks) || !S.tasks.length) fail('tasks must be a nonempty array')
  const allowed = new Set(['tier', 'strategy', 'pair', 'author', 'reviewer', 'maxReviews', 'seats', 'simple', 'roles', 'panel', 'spec', 'audit', 'repair', 'effort', 'context', 'plan', 'verify', 'rounds', 'retro', 'evidence'])
  const options = value => {
    if (value === undefined) return {}
    if (!object(value)) fail('task options must be an object')
    for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`unsupported task option: ${key}`)
    return value
  }
  const seen = new Set()
  const tasks = S.tasks.map(t => {
    if (!object(t) || !id(t.id) || t.id === 'acceptance' || seen.has(t.id)) fail('task IDs must be unique; acceptance is reserved')
    for (const key of Object.keys(t)) if (!['id', 'task', 'title', 'criteria', 'after', 'workflow', 'args'].includes(key)) fail(`unknown task field: ${key}`)
    seen.add(t.id)
    if (!text(t.task) || !criteria(t.criteria)) fail(`${t.id} needs a task and nonempty acceptance criteria`)
    if (t.workflow !== undefined && !['factory', 'pair'].includes(t.workflow)) fail(`${t.id}: workflow must be factory or pair`)
    if (t.after !== undefined && (!Array.isArray(t.after) || !t.after.every(id))) fail(`${t.id}: invalid dependencies`)
    return { id: t.id, task: t.task.trim(), title: text(t.title) ? t.title.trim() : t.task.trim().split('\n')[0].slice(0,100),
      criteria: t.criteria, after: [...new Set(t.after || [])], workflow: t.workflow || 'factory', args: options(t.args) }
  })
  const visiting = new Set(), visited = new Set()
  const visit = task => {
    if (visiting.has(task.id)) fail('dependency cycle')
    if (visited.has(task.id)) return
    visiting.add(task.id)
    for (const dep of task.after) {
      if (!seen.has(dep)) fail(`${task.id}: unknown dependency ${dep}`)
      visit(tasks.find(t => t.id === dep))
    }
    visiting.delete(task.id); visited.add(task.id)
  }
  tasks.forEach(visit)
  if (!object(S.acceptance) || !criteria(S.acceptance.criteria) || !text(S.acceptance.verify)) fail('acceptance requires criteria and a verification command')
  for (const key of Object.keys(S.acceptance)) if (!['criteria', 'verify', 'args'].includes(key)) fail(`unknown acceptance field: ${key}`)
  if (S.limits !== undefined && !object(S.limits)) fail('limits must be an object')
  const limits = { maxTurns: 200, maxRunMin: 120, maxAttempts: 2, taskMaxTurns: 50, taskMaxRunMin: 30, ...S.limits }
  for (const [key, value] of Object.entries(limits)) {
    if (!['maxTurns', 'maxRunMin', 'maxAttempts', 'taskMaxTurns', 'taskMaxRunMin'].includes(key) || !Number.isSafeInteger(value) || value < 1) fail(`invalid limit: ${key}`)
  }
  if (limits.taskMaxTurns > 10000 || limits.taskMaxRunMin > 10080 || limits.maxRunMin > 10080) fail('taskMaxTurns is at most 10000; runtime limits are at most 10080 minutes')
  const decisions = S.decisions || []
  if (!Array.isArray(decisions) || !decisions.every(text)) fail('decisions must be an array of strings')
  return { version: 1, id: S.id, tasks, defaults: options(S.defaults), decisions, limits,
    acceptance: { criteria: S.acceptance.criteria, verify: S.acceptance.verify, args: options(S.acceptance.args) } }
}

function runPlanNext(S) {
  if (S.active) throw new Error('run-plan: recover the active attempt before scheduling')
  if (S.turns >= S.plan.limits.maxTurns || S.elapsedMs >= S.plan.limits.maxRunMin * 60000) return null
  for (const t of S.plan.tasks) {
    const state = S.tasks[t.id]
    if (state.status === 'pending' && state.attempts < S.plan.limits.maxAttempts && t.after.every(id => S.tasks[id].status === 'done')) return t
  }
  if (S.plan.tasks.every(t => S.tasks[t.id].status === 'done') && S.tasks.acceptance.status === 'pending' && S.tasks.acceptance.attempts < S.plan.limits.maxAttempts) {
    return { id: 'acceptance', workflow: 'council', task: 'Independently verify that the complete run-plan is implemented on the current repository revision. Inspect the code and evidence for every criterion. Report defects and unmet requirements; do not implement changes. Criteria describe the implemented repository: mark affected criteria unmet when defects remain. A complete investigation that finds defects is not successful acceptance.',
      criteria: [...S.plan.acceptance.criteria, ...S.plan.tasks.flatMap(t => t.criteria.map(c => `${t.id}: ${c}`))], args: S.plan.acceptance.args }
  }
  return null
}

function runPlanBrief(S, task) {
  const options = { ...S.plan.defaults, ...task.args }
  const answers = S.decisions.filter(d => d.task === task.id)
  const context = [options.context || '',
    'Run-plan policy: make routine reversible implementation choices within the stated requirements. Do not expand scope, weaken criteria, or settle conflicting requirements by assumption. Raise unresolved decisions as questions. Do not edit the execution plan or commit to the main checkout.',
    `Run-plan ${S.plan.id}; task ${task.id}. ${task.id === 'acceptance' ? 'Verify the integrated plan without changing code.' : 'Implement only this task.'}`,
    `Read the settled decisions and accepted task evidence in ${S.active.decisionsFile}. Preserve global decisions and inspect relevant prior task artifacts before reopening an approach. Record new implementation decisions and their reasons in your final post.`,
    'Completed dependencies:', ...(task.after || []).map(id => `${id}: ${S.tasks[id].commit || S.head}`),
    'Task answers:', ...answers.map(d => d.answer)].filter(Boolean).join('\n')
  const spec = task.id === 'acceptance' ? false : options.spec && typeof options.spec === 'object' ? { ...options.spec, ask: true } : 'ask'
  const answer = answers.at(-1) || {}
  if (task.workflow === 'pair') {
    for (const key of ['tier', 'strategy', 'pair', 'seats', 'simple', 'roles', 'panel', 'spec', 'audit', 'repair', 'rounds', 'retro', 'evidence']) delete options[key]
  } else {
    for (const key of ['author', 'reviewer', 'maxReviews']) delete options[key]
  }
  const refs = Array.isArray(options.plan) ? options.plan : options.plan ? [options.plan] : []
  return { ...options, task: task.task, context, criteria: task.criteria, plan: [...refs, S.active.decisionsFile],
    ...(task.workflow !== 'pair' ? { spec, ...(answer.tier ? { tier: answer.tier, tierConfirmed: true } : {}), ...(answer.noSplit ? { noSplit: true } : {}) } : {}),
    ...(task.id === 'acceptance' ? { mode: 'investigate', verify: S.plan.acceptance.verify } : {}),
    maxTurns: S.active.turns, maxRunMin: Math.max(1, Math.ceil(S.active.milliseconds / 60000)), allowDirty: false }
}

function runPlanReady(S, result) {
  const ready = result?.final?.readiness
  return ['done', 'converged', 'scorecard'].includes(result?.status) && ready?.state === 'ready' && !ready.blocked?.length && !ready.incomplete?.length
}

function runPlanOutcome(S, task, result) {
  const accepted = task.id === 'acceptance' && result?.mode === 'investigate' && task.criteria.every((_, i) =>
    result.final?.criteria?.filter(c => c.criterion === `C${i + 1}`).length === 1 && result.final.criteria.find(c => c.criterion === `C${i + 1}`).status === 'met')
  if (runPlanReady(S, result) && (task.id === 'acceptance' ? accepted : (result.final.snapshotRef && result.final.snapshotTree && result.delivery?.status === 'pending'))) return 'ready'
  return ['failed', 'error', 'preflight'].includes(result?.status) && S.tasks[task.id].attempts < S.plan.limits.maxAttempts ? 'pending' : 'parked'
}

function runPlanAnswer(S, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('run-plan: answers must be an object keyed by task ID')
  for (const [id, raw] of Object.entries(answers)) {
    const answer = typeof raw === 'string' ? { answer: raw } : raw
    if (!answer || typeof answer.answer !== 'string' || !answer.answer.trim() || Object.keys(answer).some(k => !['answer', 'tier', 'noSplit'].includes(k))) throw new Error(`run-plan: invalid answer for ${id}`)
    if (answer.tier !== undefined && !['simple', 'fix', 'feature'].includes(answer.tier)) throw new Error('run-plan: invalid answer tier')
    if (answer.noSplit !== undefined && typeof answer.noSplit !== 'boolean') throw new Error('run-plan: noSplit must be boolean')
    const previous = S.decisions.filter(d => d.task === id).at(-1)
    if (previous && previous.answer === answer.answer.trim() && previous.tier === answer.tier && previous.noSplit === answer.noSplit) continue
    const state = S.tasks[id]
    if (!state || state.status !== 'parked') throw new Error(`run-plan: ${id} is not parked`)
    if (state.attempts >= S.plan.limits.maxAttempts) throw new Error(`run-plan: ${id} exhausted its ${S.plan.limits.maxAttempts} attempts; use a new plan for further work`)
    S.decisions.push({ task: id, ...answer, answer: answer.answer.trim() })
    // Answers never reset attempts or budgets.
    state.status = 'pending'
  }
}

function runPlanExtendLimits(S, extension) {
  if (!extension || typeof extension !== 'object' || typeof extension.reason !== 'string' || !extension.reason.trim() ||
      !extension.limits || typeof extension.limits !== 'object' || Array.isArray(extension.limits) || !Object.keys(extension.limits).length ||
      Object.keys(extension).some(k => !['reason', 'limits'].includes(k))) throw new Error('run-plan: extendLimits requires a reason and nonempty limits object')
  const limits = runPlanDefinition({ ...S.plan, limits: { ...S.plan.limits, ...extension.limits } }).limits
  for (const key of Object.keys(limits)) if (limits[key] < S.plan.limits[key]) throw new Error(`run-plan: limit ${key} may only increase`)
  if (JSON.stringify(limits) === JSON.stringify(S.plan.limits)) return
  S.limitChanges ||= []
  S.limitChanges.push({ reason: extension.reason.trim(), before: S.plan.limits, after: limits, spentTurns: S.turns, spentMs: S.elapsedMs })
  S.plan = { ...S.plan, limits }
}

function runPlanReport(S) {
  const ready = S.tasks.acceptance.status === 'done' && S.plan.tasks.every(t => S.tasks[t.id].status === 'done')
  return { status: ready ? 'done' : 'blocked', workflow: 'run-plan', planId: S.plan.id, head: S.head,
    stopReason: ready ? null : S.turns >= S.plan.limits.maxTurns ? 'Run-plan turn budget exhausted.' : S.elapsedMs >= S.plan.limits.maxRunMin * 60000 ? 'Run-plan time budget exhausted.' : 'No eligible tasks; inspect parked work and dependencies.',
    final: { readiness: { state: ready ? 'ready' : 'incomplete', blocked: [], incomplete: ready ? [] : ['Required run-plan work remains; inspect tasks, parked questions, and budgets.'] } },
    tasks: S.tasks, decisions: S.decisions, limitChanges: S.limitChanges || [], parked: Object.entries(S.tasks).filter(([,t]) => t.status === 'parked').map(([id,t]) => ({ id, question: t.question, result: t.result })),
    budget: { turns: S.turns, elapsedMs: S.elapsedMs, remainingTurns: Math.max(0, S.plan.limits.maxTurns - S.turns), remainingMs: Math.max(0, S.plan.limits.maxRunMin * 60000 - S.elapsedMs), limits: S.plan.limits } }
}
