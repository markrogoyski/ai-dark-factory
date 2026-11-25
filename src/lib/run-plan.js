// Run-plan policy. Persistence, processes, Git, and verification live in the runtime adapter.
function runPlanDefinition(S) {
  const fail = message => { throw new Error(`run-plan: ${message}`) }
  const object = x => x && typeof x === 'object' && !Array.isArray(x)
  const text = x => typeof x === 'string' && x.trim()
  const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)
  const criteria = x => Array.isArray(x) && x.length > 0 && x.every(text)
  if (!object(S) || S.version !== 1 || !id(S.id)) fail('version 1 and a stable id are required')
  for (const key of Object.keys(S)) if (!['version', 'id', 'tasks', 'decisions', 'acceptance', 'limits', 'defaults', 'progress', 'groom'].includes(key)) fail(`unknown plan field: ${key}`)
  if (S.groom !== undefined && typeof S.groom !== 'boolean') fail('groom must be true or false')
  if (!Array.isArray(S.tasks) || !S.tasks.length) fail('tasks must be a nonempty array')
  const allowed = new Set(['tier', 'strategy', 'pair', 'author', 'reviewer', 'maxReviews', 'maxDesignReviews', 'seats', 'simple', 'roles', 'panel', 'spec', 'audit', 'repair', 'effort', 'context', 'plan', 'verify', 'rounds', 'retro', 'evidence'])
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
  // groom: false only when set: the default leaves the definition (and its fingerprint) as before.
  return { version: 1, id: S.id, tasks, defaults: options(S.defaults), decisions, limits,
    acceptance: { criteria: S.acceptance.criteria, verify: S.acceptance.verify, args: options(S.acceptance.args) }, ...(S.groom === false ? { groom: false } : {}) }
}

// The grooming pre-pass: one dark-factory:brief pass per plan task at the plan's starting revision,
// before any task runs, so questions about what each task should deliver are asked in one batch.
// It decides nothing from the repository for later tasks: a ready task's ticket is its task text,
// and its own run re-checks it at its execution revision. S.groom.tasks[id]: status pending (to
// pass), open (questions; answers in answers), ready (ticket) or skipped (runs as written, note).
// interrupted counts passes lost to an interruption; each keeps its reserved charge.
function runPlanGroomPrepare(S) {
  let changed = false
  if (!S.groom) {
    const attempted = Object.values(S.tasks).some(t => t.attempts > 0)
    S.groom = S.plan.groom === false ? { enabled: false, reason: 'The plan sets groom: false.' }
      : attempted ? { enabled: false, reason: 'The plan run predates the grooming pass.' }
      : { enabled: true, revision: S.head, tasks: Object.fromEntries(S.plan.tasks.map(t => [t.id, { status: 'pending', passes: 0, interrupted: 0 }])) }
    changed = true
  }
  if (!S.groom.enabled) return changed
  for (const [id, entry] of Object.entries(S.groom.tasks)) {
    if (['pending', 'open'].includes(entry.status) && entry.interrupted >= S.plan.limits.maxAttempts) {
      Object.assign(entry, { status: 'skipped', verdict: 'failed', note: `The grooming pass was interrupted ${entry.interrupted} times; ${id} runs as written.` })
      changed = true
    }
  }
  return changed
}

function runPlanGroomNext(S) {
  if (S.active) throw new Error('run-plan: recover the active attempt before scheduling')
  if (!S.groom?.enabled || S.turns >= S.plan.limits.maxTurns || S.elapsedMs >= S.plan.limits.maxRunMin * 60000) return null
  for (const t of S.plan.tasks) {
    const entry = S.groom.tasks[t.id]
    if (entry.status === 'pending') return { id: t.id, title: t.title, groom: true, resume: false }
    if (entry.status === 'open' && entry.questions.every(q => Object.hasOwn(entry.answers, q.id))) return { id: t.id, title: t.title, groom: true, resume: true }
  }
  return null
}

// A fresh pass reads what the task's own run would bear on its goal: the task text, its criteria,
// and the context and documents of its defaults and args. A resume settles the answered questions.
// The child host counts turns and time across its resumes, so its caps include what it spent.
function runPlanGroomArgs(S, item) {
  const a = S.active, entry = S.groom.tasks[item.id]
  const caps = { maxTurns: (a.priorTurns || 0) + a.turns, maxRunMin: Math.max(1, Math.ceil(((a.priorMs || 0) + a.milliseconds) / 60000)) }
  if (item.resume) return { clarifications: Object.entries(entry.answers).map(([id, answer]) => ({ id, answer })), ...caps }
  const task = S.plan.tasks.find(t => t.id === item.id)
  const options = { ...S.plan.defaults, ...task.args }
  const refs = Array.isArray(options.plan) ? options.plan : options.plan ? [options.plan] : []
  // The pass runs on roles.intake from the defaults or the task's args, else the host's intake.
  const intake = options.roles && typeof options.roles === 'object' ? options.roles.intake : undefined
  return { task: task.task, criteria: task.criteria, ...(options.context ? { context: options.context } : {}), ...(refs.length ? { plan: refs } : {}),
    ...(intake ? { roles: { intake } } : {}), ...(S.repo ? { repo: S.repo } : {}), ...caps }
}

function runPlanGroomOutcome(S, item, result) {
  const entry = S.groom.tasks[item.id]
  const oneLine = x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (result?.hostRunDir) entry.hostRunDir = result.hostRunDir
  entry.verdict = typeof result?.verdict === 'string' ? result.verdict : 'failed'
  const questions = Array.isArray(result?.questions) ? result.questions.filter(q => q && typeof q.id === 'string' && typeof q.question === 'string') : []
  if (result?.status === 'done' && result.verdict === 'ready' && typeof result.ticket === 'string' && result.ticket.trim()) {
    Object.assign(entry, { status: 'ready', ticket: result.ticket })
  } else if (result?.status === 'needs-user' && result.verdict === 'needs-answers' && questions.length && entry.hostRunDir) {
    const fields = ['id', 'question', 'wording', 'outcomeA', 'outcomeB', 'evidence', 'recommendation', 'changes']
    Object.assign(entry, { status: 'open', questions: questions.map(q => Object.fromEntries(fields.filter(k => typeof q[k] === 'string').map(k => [k, q[k]]))), answers: entry.answers || {} })
  } else {
    const split = Array.isArray(result?.split) ? result.split.map(p => p?.title).filter(Boolean) : []
    const why = entry.verdict === 'needs-split' ? `it bundles ${split.length || 'several'} pieces of work${split.length ? ` (${split.join('; ')})` : ''}`
      : entry.verdict === 'not-actionable' ? `no deliverable outcome was found${result?.reason ? `: ${oneLine(result.reason)}` : ''}`
      : `the pass did not finish${result?.error || result?.stopReason ? `: ${oneLine(result.error || result.stopReason)}` : ''}`
    if (entry.verdict !== 'needs-split' && entry.verdict !== 'not-actionable') entry.verdict = 'failed'
    Object.assign(entry, { status: 'skipped', note: `Grooming: ${why}. ${item.id} runs as written; its own goal stage judges it.` })
  }
}

// Execution waits until every task's pass has settled: an open question, or a pass the budget
// has not yet reached, stops the plan before any task runs.
function runPlanGroomWaiting(S) {
  return !!S.groom?.enabled && S.plan.tasks.some(t => !['ready', 'skipped'].includes(S.groom.tasks[t.id].status))
}

function runPlanGroomQuestions(S) {
  if (!S.groom?.enabled) return []
  return S.plan.tasks.flatMap(t => {
    const entry = S.groom.tasks[t.id]
    return entry.status === 'open' ? entry.questions.filter(q => !Object.hasOwn(entry.answers, q.id)).map(q => ({ task: t.id, ...q })) : []
  })
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
    for (const key of ['author', 'reviewer', 'maxReviews', 'maxDesignReviews']) delete options[key]
  }
  const refs = Array.isArray(options.plan) ? options.plan : options.plan ? [options.plan] : []
  // A groomed ticket is the task text; the task's run re-checks it at its own revision.
  const groomed = task.id !== 'acceptance' && S.groom?.enabled && S.groom.tasks?.[task.id]?.status === 'ready' ? S.groom.tasks[task.id].ticket : null
  return { ...options, task: groomed || task.task, context, criteria: task.criteria, plan: [...refs, S.active.decisionsFile],
    ...(task.workflow !== 'pair' ? { spec, ...(answer.tier ? { tier: answer.tier, tierConfirmed: true } : {}), ...(answer.noSplit ? { noSplit: true } : {}) } : {}),
    // The runner writes the acceptance task and its criteria: no user wording to shape into a goal.
    ...(task.id === 'acceptance' ? { mode: 'investigate', verify: S.plan.acceptance.verify, brief: false } : {}),
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

// A ready Pair task can rest on a stand-in for something outside its run (a network service,
// credentials): its result lists the live checks the user runs against the real thing. The task
// keeps its latest attempt's list, and the plan's report gathers those of committed tasks. They
// change neither commit nor park.
function runPlanLiveChecks(S, task, result) {
  const checks = result?.final?.readiness?.liveChecks
  if (Array.isArray(checks) && checks.length) S.tasks[task.id].liveChecks = checks
  else delete S.tasks[task.id].liveChecks
}

function runPlanAnswer(S, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('run-plan: answers must be an object keyed by task ID')
  for (const [id, raw] of Object.entries(answers)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'decisions')) { runPlanGroomAnswer(S, id, raw); continue }
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

// Answers to grooming questions, keyed by task and question ID. An answer is kept as given: the
// same one again changes nothing, a different one is refused. A task resumes its pass only once
// every one of its questions has an answer.
function runPlanGroomAnswer(S, id, raw) {
  const decisions = raw.decisions
  if (Object.keys(raw).length !== 1 || !decisions || typeof decisions !== 'object' || Array.isArray(decisions) || !Object.keys(decisions).length ||
      Object.values(decisions).some(v => typeof v !== 'string' || !v.trim())) throw new Error(`run-plan: invalid grooming answers for ${id}; use {decisions: {G1: "answer"}}`)
  const entry = S.groom?.enabled ? S.groom.tasks?.[id] : null
  if (!entry) throw new Error(`run-plan: ${id} has no grooming questions`)
  const given = entry.answers || {}
  const fresh = Object.entries(decisions).filter(([qid, text]) => {
    if (!Object.hasOwn(given, qid)) return true
    if (given[qid] !== text.trim()) throw new Error(`run-plan: the answer to ${id} ${qid} was already given and cannot change`)
    return false
  })
  if (!fresh.length) return
  if (entry.status !== 'open') throw new Error(`run-plan: ${id} is not waiting on grooming answers`)
  for (const [qid] of fresh) if (!entry.questions.some(q => q.id === qid)) throw new Error(`run-plan: ${id} has no open grooming question ${qid}`)
  entry.answers = { ...given, ...Object.fromEntries(fresh.map(([qid, text]) => [qid, text.trim()])) }
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

// How the plan went, task by task. Each task's result file holds its own report, with how its run went.
function runPlanStory(S) {
  const gist = q => String(typeof q === 'string' ? q : Array.isArray(q) ? q.map(x => typeof x === 'string' ? x : x?.question || x?.text || '').filter(Boolean).join('; ') : q?.error || q?.incomplete?.[0] || q?.blocked?.[0] || '')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
  const groom = S.groom?.enabled ? S.groom.tasks : null
  const line = (id, title, r, after = []) => {
    const waiting = after.filter(d => S.tasks[d].status !== 'done')
    const unanswered = groom?.[id]?.status === 'open' ? groom[id].questions.filter(q => !Object.hasOwn(groom[id].answers, q.id)).map(q => q.id) : []
    const tries = r.attempts ? ` after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}` : ''
    const how = r.status === 'done' ? `done${tries}${r.commit ? `, committed ${r.commit.slice(0, 12)}` : ''}`
      : r.status === 'parked' ? `parked${tries}${gist(r.question) ? `: ${gist(r.question)}` : ''}`
      : r.status === 'pending' && r.attempts ? `pending${tries}` : r.status === 'pending' ? (unanswered.length ? `waiting on answers to ${unanswered.join(', ')}` : waiting.length ? `waiting on ${waiting.join(', ')}` : 'not started') : r.status
    return `- ${id} (${title}): ${how}${r.result ? `. Report: ${r.result}` : ''}`
  }
  const limits = S.plan.limits
  let grooming = ''
  if (groom) {
    const by = status => S.plan.tasks.filter(t => groom[t.id].status === status).map(t => t.id)
    const parts = [by('ready').length ? `groomed tickets for ${by('ready').join(', ')}` : '', by('open').length ? `questions for ${by('open').join(', ')}` : '',
      by('pending').length ? `not yet groomed: ${by('pending').join(', ')}` : ''].filter(Boolean)
    const notes = S.plan.tasks.filter(t => groom[t.id].status === 'skipped').map(t => `- ${t.id}: ${groom[t.id].note}`)
    const questions = runPlanGroomQuestions(S).map(q => `- ${q.task} ${q.id}: ${q.question}${q.outcomeA ? ` A: ${q.outcomeA}` : ''}${q.outcomeB ? ` B: ${q.outcomeB}` : ''}${q.recommendation ? ` Recommended: ${q.recommendation}` : ''}${q.changes ? ` Changes: ${q.changes}` : ''}`)
    grooming = `Grooming at ${String(S.groom.revision || '').slice(0, 12)}: ${parts.join('; ') || 'no task groomed'}.\n` + (notes.length ? notes.join('\n') + '\n' : '') +
      (questions.length ? `\nOpen grooming questions. No task runs until every one is answered: rerun with answers {task: {decisions: {ID: "answer"}}}.\n${questions.join('\n')}\n` : '') + '\n'
  }
  return `### How the plan went\n\n${[...S.plan.tasks.map(t => line(t.id, t.title, S.tasks[t.id], t.after)), line('acceptance', 'final acceptance', S.tasks.acceptance)].join('\n')}\n\n` +
    grooming + `Budget used: ${S.turns} of ${limits.maxTurns} turns, ${Math.round(S.elapsedMs / 60000)} of ${limits.maxRunMin} minutes.`
}

function runPlanReport(S) {
  const ready = S.tasks.acceptance.status === 'done' && S.plan.tasks.every(t => S.tasks[t.id].status === 'done')
  const liveChecks = S.plan.tasks.filter(t => S.tasks[t.id].status === 'done').flatMap(t => (S.tasks[t.id].liveChecks || []).map(c => ({ task: t.id, ...c })))
  const questions = runPlanGroomQuestions(S)
  const asking = [...new Set(questions.map(q => q.task))]
  return { status: ready ? 'done' : 'blocked', workflow: 'run-plan', planId: S.plan.id, head: S.head, report: { markdown: runPlanStory(S) },
    stopReason: ready ? null : questions.length ? `Grooming raised ${questions.length} question${questions.length === 1 ? '' : 's'} for ${asking.join(', ')}; no task has run. Answer every one in one answers object keyed by task and question ID ({task: {decisions: {G1: "answer"}}}) and rerun the same plan.`
      : S.turns >= S.plan.limits.maxTurns ? 'Run-plan turn budget exhausted.' : S.elapsedMs >= S.plan.limits.maxRunMin * 60000 ? 'Run-plan time budget exhausted.' : 'No eligible tasks; inspect parked work and dependencies.',
    ...(questions.length ? { questions } : {}), ...(S.groom ? { groom: S.groom } : {}),
    final: { readiness: { state: ready ? 'ready' : 'incomplete', blocked: [], incomplete: ready ? [] : ['Required run-plan work remains; inspect tasks, parked questions, and budgets.'], liveChecks } },
    liveChecks,
    tasks: S.tasks, decisions: S.decisions, limitChanges: S.limitChanges || [], parked: Object.entries(S.tasks).filter(([,t]) => t.status === 'parked').map(([id,t]) => ({ id, question: t.question, result: t.result })),
    budget: { turns: S.turns, elapsedMs: S.elapsedMs, remainingTurns: Math.max(0, S.plan.limits.maxTurns - S.turns), remainingMs: Math.max(0, S.plan.limits.maxRunMin * 60000 - S.elapsedMs), limits: S.plan.limits } }
}
