// The request-control core every workflow shares: milestones and the token meter, the turn and
// time budget and the run's end, and the one path every agent turn takes. Uses the runtime's
// agent() and log(), the state object `S` and `requestControl` from boot, and lib/ functions only.

// While the workflow is being tuned, every agent can say what in its turn got in the way. Notes
// are collected as they happen, not asked for at the end: Claude seats are fresh agents each turn
// and wouldn't remember. The retro agent turns them into suggested changes. A pair run, standalone
// or the factory's pair strategy, names the process it is in.
const processProp = name => ({ type: 'string', description:
  `Feedback on the ${name} process, not on the task: at most two sentences on anything in this turn's instructions, inputs or tools that got in your way, ` +
  'such as an unclear or conflicting instruction, missing context, wasted effort, a limit that cut you short, or a command that failed. ' +
  'Name the instruction or input. "" if nothing did; don\'t invent feedback.' })
const PROCESS_PROP = processProp('council'), PAIR_PROCESS_PROP = processProp('pair')

function withProcess(schema) {
  if (!S.retro || !schema) return schema
  return { ...schema, properties: { ...schema.properties, process: S.pair ? PAIR_PROCESS_PROP : PROCESS_PROP }, required: [...(schema.required || []), 'process'] }
}

// A milestone of the run: logged now, for the live progress view, and kept for the report. The
// logged line also carries the running token total; the story (which prompts quote) does not.
function milestone(line, prefix = '') {
  const cost = S.workflowName === 'council' ? '' : usageLine(S, runUsage())
  log(`${prefix}${tellStory(S, line)}${cost ? ` · ${cost}` : ''}`)
}

// Claude Code's budget meter when the workflow started: its output tokens spent this turn.
const meterStart = budgetSpent()
function budgetSpent() {
  try { return typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null } catch { return null }
}

// The token use so far: the standalone runner's running total, or Claude Code's budget meter
// (output only). Null when the runtime offers neither.
function runUsage() {
  if (hostRuntime?.usage) { try { return hostRuntime.usage() } catch { return null } }
  const spent = budgetSpent()
  return spent === null || meterStart === null ? null : { meter: Math.max(0, spent - meterStart) }
}

// The past runs --explain compares with, from the runtime; null where none can be read.
function pastRuns() {
  if (!hostRuntime?.history) return null
  try { return hostRuntime.history() } catch { return null }
}

function requestClock() {
  if (S.controls.maxRunMin && !hostRuntime?.now) throw new Error('maxRunMin requires the standalone dark-factory-codex runner; the native workflow runtime has no replay-safe clock. Use maxTurns for native runs.')
  return hostRuntime?.now ? hostRuntime.now() - (hostRuntime.elapsedBefore || 0) : null
}

function fatalTurnError(error) {
  return error?.code === 'CHECKPOINT_MISMATCH' || error?.code === 'RUN_LIMIT' || error?.code === 'ENGINE_DRIFT'
}

function reserveTurn() {
  const c = requestControl
  if ((c.maxTurns && c.turns >= c.maxTurns) || (c.maxRunMin && hostRuntime.now() - c.started >= c.maxRunMin * 60000)) {
    const error = new Error(c.maxTurns && c.turns >= c.maxTurns ? `Run turn budget exhausted (${c.maxTurns}).` : `Run time budget exhausted (${c.maxRunMin} minutes).`)
    c.stop = error.message
    error.code = 'RUN_LIMIT'
    throw error
  }
  c.turns++
}

// A run's work, with a turn or time budget stop turned into a blocked result.
async function guardedRun(work) {
  try { return await work() } catch (error) {
    if (error.code !== 'RUN_LIMIT') throw error
    return { status: 'blocked', stopReason: error.message, task: S.task, runDir: S.run?.runDir || null,
      final: { readiness: { state: 'incomplete', blocked: [], incomplete: [error.message] } } }
  }
}

// What every run's result gets at its end: the budget stop, the plan, the metrics, the token use
// and the summary.
function finishRun(result) {
  if (requestControl.stop && result.final?.readiness?.state !== 'ready') {
    result.status = 'blocked'
    result.stopReason = requestControl.stop
    result.final = { ...result.final, readiness: { state: 'incomplete', blocked: result.final?.readiness?.blocked || [], incomplete: [...(result.final?.readiness?.incomplete || []), requestControl.stop] } }
  }
  // Whether a stop can continue is decided after that override: a budget stop cannot.
  withdrawResume(result)
  result.plan = result.plan || executionPlan(S)
  result.metrics = evaluationFacts(S, result, requestControl.started !== null ? hostRuntime.now() - requestControl.started : null, requestControl.turns)
  // The run's token use by model, at its end (retro included), in the report; not for the council.
  if (S.workflowName !== 'council' && result.report && typeof result.report.markdown === 'string') {
    const section = usageSection(S, runUsage())
    if (section) result.report = { ...result.report, markdown: `${result.report.markdown}${section}` }
  }
  if ((S.factory || S.pairOptions) && result.runDir) {
    result.artifactType = 'dark-factory-result'
    result.artifactVersion = 1
    // The summary goes first: a reader that sees only the start of a long result still gets the
    // status, readiness, open findings, snapshot and gate.
    const { summary, ...rest } = result
    return { summary: compactResult(S, result), ...rest }
  }
  return result
}

async function controlledRun(work) {
  return finishRun(await guardedRun(work))
}

function keepProcess(turn, role, who, res) {
  const text = res && typeof res.process === 'string' ? oneLine(res.process, 400) : ''
  if (S.retro && text && !/^(none|n\/a|nothing)\.?$/i.test(text)) S.processNotes.push({ turn, role, who, text })
}

function keepHostDiagnostics(label, result) {
  const denied = result && result.permissionDenials
  if (denied) S.notes.push(`${label}: ${denied.count} tool permission denial(s) (${denied.tools.join(', ')}). ` +
    `${result.status === 'done' ? 'The completed submission was accepted for verification and review' : 'The submission was not accepted'}. ` +
    `Denied checks are not evidence of passing; details: ${denied.source}`)
}

// Every agent call goes through here except the retro's own, so each can leave a process note.
async function ask(prompt, opts, role, who) {
  reserveTurn()
  const selected = roleAgent(S, role, opts)
  // copies marks a transport told to return a printed result exactly, so it gets no process field
  // to add. measures is a host-runner capability; the native runtime gets only the options it knows.
  const { copies, ...rest } = opts
  const { measures, ...nativeOpts } = rest
  const schema = copies ? opts.schema : withProcess(opts.schema)
  const res = hostRuntime
    ? await hostAgent(prompt, { ...rest, schema }, role, who)
    : await agent(prompt, { ...nativeOpts, schema })
  S.turnLog.push({ turn: opts.label, role, vendor: hostRuntime ? selected.vendor : 'claude', ok: !!res })
  keepProcess(opts.label, role, who || (hostRuntime ? selected.name : opts.model), res)
  return res
}

// Orchestration turns are fresh, including neutral checks. Seat and auditor continuations use
// externalTurn below, which carries their separate thread keys and worktree permissions.
async function hostAgent(prompt, opts, role, who, extra = {}) {
  const selected = roleAgent(S, role, opts)
  try {
    return await hostRuntime.agent({ ...opts, prompt, vendor: selected.vendor, model: selected.model,
      effort: selected.effort, role, who: who || selected.name, run: S.run, fresh: true,
      onResult: result => {
        keepHostDiagnostics(opts.label, result)
        if (result.status !== 'done') S.notes.push(`${role} turn ${opts.label} failed: ${oneLine(result.error || result.status, 300)}`)
      },
      timeoutMin: timeoutFor(role), ...(role === 'setup' ? { preflightVendors: preflightTargets(S), setupRunId: setupRunId(S) } : {}), ...extra })
  } catch (e) {
    if (fatalTurnError(e)) throw e
    S.notes.push(`${role} turn ${opts.label} failed: ${oneLine(e && e.message || e, 300)}`)
    return null
  }
}

// Per-phase deadline for a Codex or Gemini turn, in minutes: `timeoutMin` is one number, or
// {spec, solve, debate, final, ratify, panel, ballot, audit}. Unset, bin/dark-factory's default (90) applies.
function timeoutFor(kind) {
  const t = S.raw.timeoutMin
  const v = t && typeof t === 'object' ? t[kind] : t
  const n = Math.round(Number(v))
  return n > 0 ? n : null
}
