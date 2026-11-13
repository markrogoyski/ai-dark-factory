// Everything that talks to the runtime: agent turns and their relays, the neutral checks and the
// panel, question clustering, the ballot and the retro agent. These use the runtime's agent(),
// parallel() and log(), and the state object `S` from boot; the decisions they act on are computed
// in lib/.

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

async function controlledRun(work) {
  let result
  try { result = await work() } catch (error) {
    if (error.code !== 'RUN_LIMIT') throw error
    result = { status: 'blocked', stopReason: error.message, task: S.task, runDir: S.run?.runDir || null,
      final: { readiness: { state: 'incomplete', blocked: [], incomplete: [error.message] } } }
  }
  if (requestControl.stop && result.final?.readiness?.state !== 'ready') {
    result.status = 'blocked'
    result.stopReason = requestControl.stop
    result.final = { ...result.final, readiness: { state: 'incomplete', blocked: result.final?.readiness?.blocked || [], incomplete: [...(result.final?.readiness?.incomplete || []), requestControl.stop] } }
  }
  result.plan = result.plan || executionPlan(S)
  result.metrics = evaluationFacts(S, result, requestControl.started !== null ? hostRuntime.now() - requestControl.started : null, requestControl.turns)
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
  const res = hostRuntime
    ? await hostAgent(prompt, { ...opts, schema: withProcess(opts.schema) }, role, who)
    : await agent(prompt, { ...opts, schema: withProcess(opts.schema) })
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
      timeoutMin: timeoutFor(role), ...(role === 'setup' ? { preflightVendors: externalVendors(S), setupRunId: setupRunId(S) } : {}), ...extra })
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

async function externalTurn(o, prompt, schema, label, ph) {
  reserveTurn()
  const V = VENDOR_NAME[o.vendor]
  if (S.blocked[o.vendor]) { S.notes.push(`${V} turn ${o.key} skipped: the ${VENDOR_CLI[o.vendor]} can't run in this session's sandbox.`); return null }
  const tag = `${o.key}-${promptHash(prompt).split('-')[1]}`        // bound to this exact request
  const full = withTurn(withProcess(schema), tag)
  const payload = `${prompt}\n\nSet \`turn\` in your output to exactly "${tag}".\n\n<<<OUTPUT_SCHEMA\n${JSON.stringify(full)}\nOUTPUT_SCHEMA>>>\n`
  const hash = promptHash(payload)
  const minutes = timeoutFor(o.timeoutKind)
  const fail = why => {
    S.notes.push(`${V} turn ${o.key} failed${why ? `: ${why}` : '.'}`)
    S.turnLog.push({ turn: label, role: o.role, vendor: o.vendor, ok: false })
    return null
  }
  if (hostRuntime) {
    let r
    try {
      r = await hostRuntime.turn({ ...o, prompt: payload, schema: full, label, phase: ph,
        run: S.run, expect: hash, timeoutMin: minutes })
      if (o.recoveryPost && r && r.status === 'error' && r.recoverySession &&
          !['auth', 'quota', 'cancelled', 'sandboxed'].includes(r.errorClass)) {
        keepHostDiagnostics(label, { ...r, status: 'error' })
        S.notes.push(`${V} turn ${o.key} failed: ${oneLine(r.error || r.status, 300)}. ` +
          'Its post exists; requesting structured output once from the same session.')
        const recovery = `${recoverSeatPrompt(S, o.recoveryPost)}\n\nSet \`turn\` in your output to exactly "${tag}".\n\n<<<OUTPUT_SCHEMA\n${JSON.stringify(full)}\nOUTPUT_SCHEMA>>>\n`
        reserveTurn()
        r = await hostRuntime.turn({ ...o, key: `${o.key}-recover`, recoveryPost: undefined,
          resumeSession: r.recoverySession, fresh: false, sandbox: 'read-only', writable: [], effort: 'low',
          prompt: recovery, schema: full, label: `${label} (recover output)`, phase: ph,
          run: S.run, expect: promptHash(recovery), timeoutMin: Math.min(minutes || 3, 3) })
        if (r && r.status === 'done' && r.result && r.result.turn === tag) {
          S.notes.push(`${V} turn ${o.key}: recovered structured output from the existing session; verification and review still apply.`)
        }
      }
    } catch (e) {
      if (fatalTurnError(e)) throw e
      return fail(oneLine(e && e.message || e, 300))
    }
    if (r && r.status === 'done' && r.result && r.result.turn === tag) {
      keepHostDiagnostics(label, r)
      const { turn, ...result } = r.result
      S.turnLog.push({ turn: label, role: o.role, vendor: o.vendor, ok: true })
      const seconds = Number(r.seconds ?? r.elapsedSec)
      if (seconds > 0) S.vendorTimes.push({ turn: o.key, vendor: o.vendor, seconds })
      keepProcess(label, o.role, o.who, result)
      return result
    }
    keepHostDiagnostics(label, r && { ...r, status: 'error' })
    if (r && r.status === 'sandboxed') S.blocked[o.vendor] = true
    return fail(r && r.status === 'done'
      ? `the result's turn tag ${r.result ? JSON.stringify(r.result.turn) : '(no result)'} is not ${tag}: an answer to an earlier turn`
      : r ? `${oneLine(r.error || r.status, 300)}${r.errorClass ? ` [${r.errorClass}]` : ''}` : 'the runtime returned no result')
  }
  for (const relayModel of ['haiku', 'sonnet']) {
    const file = `${S.run.runDir}/jobs/${o.key}.${relayModel}.prompt.md`
    const cmd = [S.cli, 'seat-run', '--run-dir', shq(S.run.runDir), '--vendor', o.vendor, '--seat', shq(o.threadKey), '--job', shq(o.key),
      '--model', shq(o.model), '--effort', o.effort, '--sandbox', o.sandbox, '--cwd', shq(o.cwd),
      ...o.writable.flatMap(w => ['--writable', shq(w)]),
      '--prompt-file', shq(file), '--expect', hash, ...(o.fresh ? ['--fresh'] : []), ...(minutes ? ['--timeout-min', minutes] : []),
      ...(o.checkout ? ['--checkout', shq(o.checkout)] : [])].join(' ')
    const r = await ask(relayPrompt(S, o.vendor, file, cmd, o.key, payload, hash), {
      label: `${label} (relay${relayModel === 'haiku' ? '' : ': sonnet'})`, phase: ph,
      schema: relaySchema(full), model: relayModel, effort: 'low',
    }, 'relay')
    if (r && r.status === 'done' && r.result && r.result.turn === tag) {
      const { turn, ...result } = r.result
      S.turnLog.push({ turn: label, role: o.role, vendor: o.vendor, ok: true })
      if (Number(r.seconds) > 0) S.vendorTimes.push({ turn: o.key, vendor: o.vendor, seconds: Number(r.seconds) })
      keepProcess(label, o.role, o.who, result)
      return result
    }
    // No result at all means the relay agent itself was ended, before or while it ran the CLI: by
    // Claude Code (the auto-mode classifier blocks some relays) or by a terminal API error.
    const status = !r ? 'relay ended' : r.status === 'done' ? 'stale' : r.status
    const error = !r ? `the relay agent returned nothing: Claude Code blocked it, as the auto-mode classifier does to some relays, or it hit a terminal API error. If ${S.run.runDir}/jobs/${o.key} is absent, the ${VENDOR_CLI[o.vendor]} never ran` : r.status === 'done'
      ? `the result's turn tag ${r.result ? JSON.stringify(r.result.turn) : '(no result)'} is not ${tag}: an answer to an earlier turn`
      : oneLine(r.error, 200)
    S.relayFailures.push({ turn: o.key, model: relayModel, status, error, errorClass: (r && r.errorClass) || '' })
    log(`relay ${o.key} via ${relayModel}: ${status}${error ? ` (${error})` : ''}`)
    if (status === 'sandboxed') {
      S.blocked[o.vendor] = true
      S.notes.push(`The ${VENDOR_CLI[o.vendor]} can't run inside Claude Code's sandbox, and running it outside was not permitted. ` +
        `Allow it in ~/.claude/settings.json: "permissions": {"allow": ["Bash(${S.cli}:*)"]}.`)
      break
    }
    if (status === 'stale') return fail(error)
    // A copy that wouldn't hash, or a Bash call the tool rejected, is the relay's own failure: a
    // stronger relay may manage. Anything else came from the vendor's CLI, which already retried.
    if (status === 'error' && !/^(relay:|hash mismatch)/i.test(r.error || '')) {
      return fail(`${oneLine(r.error, 300)}${r.errorClass ? ` [${r.errorClass}]` : ''}`)
    }
  }
  return fail(S.relayFailures.slice(-2).every(f => f.turn === o.key && f.status === 'relay ended')
    ? `Claude Code ended both relay agents (a block or an API error), so the ${V} turn may never have run` : '')
}

const timeoutKindOf = r => r === 0 ? 'solve' : typeof r === 'number' ? 'debate' : r === 'ratify' ? 'ratify' : /^b\d/.test(r) ? 'ballot' : 'final'

// An auditor's turn: a Claude agent, or a Codex or Gemini CLI run in a checkout of the version under
// review, which seat-run creates first (--checkout). The external thread starts fresh at the audit
// and is resumed for the re-review. The Architecture tier's reviewers have no change to check out:
// they read the plan and the repository, read-only, like the spec reviewers.
function auditTurn(a, W, round) {
  const prompt = auditPrompt(S, a, W, round)
  const label = `${roundTag(round)} ${a.lens}: ${a.key}`
  const schema = S.tier === 'architecture' ? PLAN_REVIEW_SCHEMA : historyCheck(S) ? FACTORY_AUDIT_SCHEMA : AUDIT_SCHEMA
  if (a.vendor === 'claude' && !hostRuntime) return ask(prompt, { label, phase: 'Audit', schema, model: a.model, effort: a.effort }, 'auditor', a.name)
  if (S.tier === 'architecture') {
    return externalTurn({
      key: `${roundTag(round)}-${a.lens}`, threadKey: `audit-${a.lens}`, fresh: round === 'H', vendor: a.vendor, model: a.model, effort: a.effort,
      role: 'auditor', who: a.name, sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'audit',
    }, prompt, schema, label, 'Audit')
  }
  return externalTurn({
    key: `${roundTag(round)}-${a.lens}`, threadKey: `audit-${a.lens}`, fresh: round === 'H', vendor: a.vendor, model: a.model, effort: a.effort,
    role: 'auditor', who: a.name, sandbox: 'workspace-write', cwd: auditCheckout(S, a, round),
    writable: [`${S.run.room}/tests`, `${S.run.room}/${roundTag(round)}`,
      ...(S.tier ? [`${S.run.runDir}/jobs`, `${S.run.runDir}/logs`] : [])], timeoutKind: 'audit',
    checkout: `${W.L}-${round === 'H' ? S.auditedTag : roundTag('I')}`,
  }, prompt, schema, label, 'Audit')
}

function seatTurn(s, round, prompt, schema) {
  const tag = roundTag(round)
  const label = `${tag}:${s.L} ${s.key}`
  const ph = phaseOf(round)
  if (s.vendor === 'claude' && !hostRuntime) {
    return ask(prompt, { label, phase: ph, schema: NOTE_SCHEMAS.get(schema) || schema, model: s.model, effort: s.effort }, 'seat', s.name)
  }
  return externalTurn({
    key: `${s.L}-${tag}`, threadKey: s.L, fresh: false, vendor: s.vendor, model: s.model, effort: s.effort, role: 'seat', who: s.name,
    sandbox: 'workspace-write', cwd: s.wt, writable: [S.run.room,
      ...(S.tier ? [`${S.run.runDir}/jobs`, `${S.run.runDir}/logs`] : [])], timeoutKind: timeoutKindOf(round),
    ...(hostRuntime && typeof round === 'number' ? { recoveryPost: postPath(S, s.L, round) } : {}),
  }, prompt, schema, label, ph)
}

function panelRun(k, ids) {
  const prompt = panelPrompt(S, k, ids.map(id => S.byId[id]))
  const tag = roundTag(k)
  return parallel(S.panel.map(m => () => m.vendor === 'claude' && !hostRuntime
    ? ask(prompt, { label: `panel ${tag}: ${m.key}`, phase: phaseOf(k), schema: PANEL_SCHEMA, model: m.model, effort: m.effort }, 'panel', m.name)
    : externalTurn({
        key: `panel-${m.key}-${tag}`, threadKey: `panel-${m.key}-${tag}`, fresh: true, vendor: m.vendor, model: m.model, effort: m.effort, role: 'panel', who: m.name,
        sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'panel',
      }, prompt, PANEL_SCHEMA, `panel ${tag}: ${m.key}`, phaseOf(k))))
}

function checkerRun(Y, k, items, retry = false) {
  return ask(checkerPrompt(S, Y, k, items), {
    label: `check ${roundTag(k)}:${Y}${retry ? ' (retry)' : ''}`, phase: phaseOf(k), schema: CHECK_SCHEMA, model: S.checkModel, effort: 'medium',
  }, 'checker')
}

// Every position is checked after every round, and disputed load-bearing claims go to the
// two-vendor panel in parallel. Panel rulings are applied last, so they override checkers.
// Only positions in contention are measured. Reviewers' tests, and challenges to claims about a
// reviewer's position, go to the checker of the leading contender. `extra` ({panel, tests}: IDs)
// adds the audit's items: findings for the panel, and tests for the checker to rule on and run.
async function runChecks(k, only, extra = {}) {
  const roundCh = S.challenges.filter(x => x.round === k)
  const panelIds = [...new Set([...roundCh.filter(x => loadBearing(S.byId[x.claim])).map(x => x.claim), ...(extra.panel || [])])]
  const routed = [...new Set([...roundCh.filter(x => !loadBearing(S.byId[x.claim])).map(x => x.claim), ...(extra.tests || [])])]
  const targets = only ? [only] : contenders(S).map(s => s.L)
  const leader = (rankPositions(S).find(r => targets.includes(r.seat)) || { seat: targets[0] }).seat
  const subject = c => targets.includes(c.target) ? c.target : leader
  const strays = only ? [] : S.ledger.filter(c => c.kind === 'test' && c.round === k && !c.withdrawn && !targets.includes(c.author)).map(c => c.id)
  const plan = targets.map(Y => ({ Y, items: checkerItems(S, Y, k, [
    ...routed.filter(id => subject(S.byId[id]) === Y),
    ...(Y === leader ? strays.filter(id => !routed.includes(id)) : []),
  ]) }))
  const jobs = plan.map(p => () => checkerRun(p.Y, k, p.items))
  if (panelIds.length) jobs.push(() => panelRun(k, panelIds))
  if (panelIds.length) log(`${roundTag(k)}: ${panelIds.length} disputed load-bearing claim(s) to the panel: ${panelIds.join(', ')}`)
  const results = await parallel(jobs)
  // A checker that returned nothing leaves a position unassessed for the whole round; one retry is
  // cheaper than carrying that into the vote and the scorecard.
  const missed = plan.map((p, i) => i).filter(i => !results[i])
  if (missed.length) {
    const again = await parallel(missed.map(i => () => checkerRun(plan[i].Y, k, plan[i].items, true)))
    missed.forEach((i, j) => {
      if (again[j]) { results[i] = again[j]; S.notes.push(`The check of ${plan[i].Y} in ${roundTag(k)} failed once; a second checker completed it.`) }
    })
  }
  plan.forEach((p, i) => applyCheck(S, p.Y, k, results[i], p.items))
  if (panelIds.length) applyPanel(S, panelIds, results[plan.length] || [])
  for (const Y of targets) gate(S, Y, k)
}

async function clusterQuestions(k) {
  const fresh = S.pendingQ.splice(0)
  if (!fresh.length) return
  let res = null
  if (fresh.length === 1 && !S.questions.length) {
    res = { assignments: [{ index: 0, matches: 'new-1' }], newQuestions: [{ label: 'new-1', text: fresh[0].question }] }
  } else {
    res = await ask(clusterPrompt(S, fresh), { label: `questions ${roundTag(k)}`, phase: phaseOf(k), schema: CLUSTER_SCHEMA, model: 'sonnet', effort: 'low' }, 'questions')
  }
  if (!res) {
    res = { assignments: fresh.map((_, i) => ({ index: i, matches: `new-${i + 1}` })),
            newQuestions: fresh.map((q, i) => ({ label: `new-${i + 1}`, text: q.question })) }
  }
  const before = S.questions.length
  const byLabel = {}
  const make = text => { const q = { id: `Q${S.questions.length + 1}`, text, raisedBy: [], seconds: [], assumptions: {}, round: k }; S.questions.push(q); return q }
  for (const nq of res.newQuestions || []) if (nq && nq.label && !byLabel[nq.label]) byLabel[nq.label] = make(nq.text || '')
  const done = new Set()
  for (const a of res.assignments || []) {
    const raw0 = fresh[a && a.index]
    if (!raw0 || done.has(a.index)) continue
    done.add(a.index)
    let q = byLabel[a.matches] || S.questions.find(x => x.id === idOf(a.matches))
    if (!q) q = make(raw0.question)
    if (!q.text) q.text = raw0.question
    if (!q.raisedBy.includes(raw0.L)) q.raisedBy.push(raw0.L)
    q.seconds = q.seconds.filter(x => x !== raw0.L)
    q.assumptions[raw0.L] = raw0.assumption
  }
  fresh.forEach((raw0, i) => {
    if (done.has(i)) return
    const q = make(raw0.question)
    q.raisedBy.push(raw0.L)
    q.assumptions[raw0.L] = raw0.assumption
  })
  // Drop labels the clusterer invented but assigned nobody to, and renumber what this round added.
  const added = S.questions.splice(before).filter(q => q.raisedBy.length)
  added.forEach((q, i) => { q.id = `Q${before + i + 1}`; S.questions.push(q) })
}

// The spec review (off with spec: false). Two reviewers who see only the task, the code and the
// setup's criteria look for what the criteria miss or leave open; the panel rules on each finding;
// one turn amends the criteria. A question only the user can answer becomes a recorded assumption
// on the most conservative reading, or, with spec: 'ask', stops the run before any seat starts.
// Returns the questions to stop on, or null to go on.
function specTurn(r) {
  const prompt = specReviewPrompt(S, r)
  const label = `spec ${r.lens}: ${r.key}`
  if (r.vendor === 'claude' && !hostRuntime) return ask(prompt, { label, phase: 'Spec', schema: SPEC_SCHEMA, model: r.model, effort: r.effort }, 'spec', r.name)
  return externalTurn({
    key: `spec-${r.lens}`, threadKey: `spec-${r.lens}`, fresh: true, vendor: r.vendor, model: r.model, effort: r.effort, role: 'spec', who: r.name,
    sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'spec',
  }, prompt, SPEC_SCHEMA, label, 'Spec')
}

async function runSpecReview() {
  if (!S.specReviewers.length) return null
  phase('Spec')
  S.spec.ran = true
  const res = await parallel(S.specReviewers.map(r => () => specTurn(r)))
  S.specReviewers.forEach((r, i) => {
    if (res[i]) ingestSpec(S, r, res[i])
    else S.notes.push(`The spec review's ${r.lens} reviewer (${r.name}) returned nothing.`)
  })
  log(`spec: ${S.specReviewers.map(r => `${r.lens} ${S.spec.reviews[r.lens] ? plural(S.spec.findings.filter(f => f.lens === r.lens).length, 'finding') : 'failed'}`).join(', ')}`)
  if (!S.spec.findings.length) return null

  const prompt = specPanelPrompt(S, S.spec.findings)
  applySpecPanel(S, await parallel(S.panel.map(m => () => m.vendor === 'claude' && !hostRuntime
    ? ask(prompt, { label: `panel spec: ${m.key}`, phase: 'Spec', schema: SPEC_PANEL_SCHEMA, model: m.model, effort: m.effort }, 'panel', m.name)
    : externalTurn({
        key: `panel-${m.key}-spec`, threadKey: `panel-${m.key}-spec`, fresh: true, vendor: m.vendor, model: m.model, effort: m.effort, role: 'panel', who: m.name,
        sandbox: 'read-only', cwd: S.run.repoRoot, writable: [], timeoutKind: 'panel',
      }, prompt, SPEC_PANEL_SCHEMA, `panel spec: ${m.key}`, 'Spec'))))
  const { todo, open } = specTodo(S)
  log(`spec: ${S.spec.findings.map(f => `${f.id} ${f.status}`).join(', ')}`)
  if (S.specAsk && open.length) return open
  if (!todo.length) return null
  const amend = await ask(specAmendPrompt(S, todo), { label: 'spec amend', phase: 'Spec', schema: SPEC_AMEND_SCHEMA, model: 'opus', effort: 'medium' }, 'spec')
  if (!amend) { S.notes.push('The spec amendment failed; the criteria stand as setup wrote them.'); return null }
  if (applyAmend(S, amend, todo)) {
    log(`spec: criteria now ${S.criteria.map(c => c.id).join(', ')}${S.spec.assumptions.length ? `; assumed ${S.spec.assumptions.map(a => a.id).join(', ')}` : ''}`)
  }
  return null
}

// The independent audit (implement mode; off with audit: false). Auditors who never saw the debate
// review the final version W, one lens each. Their items are triaged like any claim: the checker
// re-measures the final version with their tests and rules on minor fact findings, and the panel
// on blocker and major ones. What is upheld, disputed or failing gets one fix pass; then the
// auditors review that fix's delta only, and what they find there is adjudicated and reported,
// never fixed: one cycle, so the loop ends.
// The Simple tier reuses it as its review, with o = {rereview: false, beforeFix}: beforeFix runs
// once the review's items are ruled on and may return an escalation, which ends the review there.
// The Architecture tier reuses it as the review of its milestone plan, with o = {fixSchema}: the
// revision returns the milestones again, and audit.fixResult keeps what it returned.
async function runAudit(W, o = {}) {
  if (S.controls.repair || S.tier === 'simple') return boundedAudit(W, o)
  const audit = { ran: false, checked: false, reviews: {}, testsAtAudit: {}, fixPass: false, addressed: [], rereviews: {}, gaps: [], fixResult: null }
  if (!S.auditors.length || (S.mode !== 'implement' && S.tier !== 'architecture')) return audit
  phase('Audit')
  audit.ran = true
  const reviews = await parallel(S.auditors.map(a => () => auditTurn(a, W, 'H')))
  S.auditors.forEach((a, i) => {
    if (reviews[i]) audit.reviews[a.lens] = ingestAudit(S, a, 'H', W.L, reviews[i])
    else { audit.gaps.push(`no review from the ${a.lens} auditor`); S.notes.push(`The ${a.lens} auditor (${a.name}) returned no review.`) }
  })
  const historyGap = () => {
    if (!historyCheck(S)) return
    audit.gaps = audit.gaps.filter(g => !g.startsWith('historical evidence review incomplete:'))
    const owner = evidenceOwner(S)
    const review = audit.rereviews[owner.lens] || audit.reviews[owner.lens]
    if (!review || !review.evidenceReview || review.evidenceReview.status !== 'complete') {
      audit.gaps.push(`historical evidence review incomplete: ${owner.lens}${review && review.evidenceReview && review.evidenceReview.note ? ` (${oneLine(review.evidenceReview.note, 400)})` : ''}`)
    }
  }
  historyGap()
  const triage = auditTriage(S, 'H')
  log(`audit: ${S.auditors.map(a => `${a.lens} ${audit.reviews[a.lens] ? plural(S.ledger.filter(c => c.author === a.id).length, 'item') : 'failed'}`).join(', ')}` +
    `${triage.panel.length ? `; to the panel: ${triage.panel.join(', ')}` : ''}`)
  // A clean audit filed nothing to rule on, and the final version is already checked: no re-measure.
  if (!S.ledger.some(c => c.round === 'H')) {
    if (!auditFixList(S, W.L).suite) return audit
  } else {
    audit.checked = true
    await runChecks('H', W.L, triage)
    audit.testsAtAudit = Object.fromEntries(triage.tests.map(id => [id, (S.testResults[id] || {})[W.L] || null]))
  }
  const handUp = o.beforeFix ? o.beforeFix() : null
  if (handUp) { audit.escalate = handUp; return audit }

  const todo = auditFixList(S, W.L)
  if (!todo.needed) return audit
  audit.fixPass = true
  log(`audit: ${W.L} gets one fix pass (${[[todo.upheld, 'upheld'], [todo.disputed, 'disputed'], [todo.failing, 'failing tests'], [todo.suite ? [{ id: 'verify' }] : [], 'failing']]
    .filter(([xs]) => xs.length).map(([xs, what]) => `${what}: ${xs.map(c => c.id).join(', ')}`).join('; ')})`)
  const fix = await seatTurn(W, 'I', auditFixPrompt(S, W, todo), o.fixSchema || SYNTH_SCHEMA)
  audit.fixResult = fix
  if (fix) {
    S.pos[W.L] = { ...S.pos[W.L], summary: fix.summary || S.pos[W.L].summary, post: postPath(S, W.L, 'I') }
    keepNotes(S, W, 'I', fix)
    ingestClaims(S, W.L, 'I', fix.claims)
    keepDeclined(S, 'I', fix)
    audit.addressed = (fix.addressed || []).filter(x => x && x.ref)
  } else {
    S.notes.push(`${W.L}'s audit fix pass failed; the audit's findings stand.`)
  }
  await runChecks('I', W.L)
  const p = S.pos[W.L]
  if (!fix) return audit
  // With rereview: false (Simple), only the evidence owner returns, with an evidence-only prompt.
  const reviewCode = o.rereview !== false && !(p.delta && p.deltaRound === 'I' && !p.delta.files)
  const historyOwner = historyCheck(S) ? evidenceOwner(S) : null
  if (!reviewCode && !historyOwner) return audit

  const lookers = S.auditors.filter(a => audit.reviews[a.lens] && (reviewCode || a.id === historyOwner?.id))
  const again = await parallel(lookers.map(a => () => auditTurn(a, W, 'J')))
  lookers.forEach((a, i) => {
    if (again[i]) audit.rereviews[a.lens] = ingestAudit(S, a, 'J', W.L, again[i])
    else audit.gaps.push(`no re-review of the fix from the ${a.lens} auditor`)
  })
  historyGap()
  const late = S.ledger.filter(c => c.round === 'J' && c.kind === 'finding' && !c.judgment && W8[c.severity] >= 2).map(c => c.id)
  if (late.length) {
    log(`audit: the re-review raised ${late.join(', ')}; to the panel`)
    applyPanel(S, late, await panelRun('J', late))
  }
  return audit
}

// The ballot (ballot: true): votes are cast in the same turn as the findings, before that round's
// checks run, so a split can be waiting on evidence the next round would only re-read. When a
// position missed consensus by one vote, every seat votes again with the rulings in view. It needs
// complete checks and another round left to fall back on; missing ballots abstain.
async function runBallot(k) {
  const K = consensusAt(S)
  const near = Object.values(tally(S, k)).some(v => v.length >= K - 1) ||
    (S.approval && contenders(S).some(s => Object.values(S.votes[k] || {}).filter(v => v.ship === s.L || (v.acceptable || []).some(a => a.seat === s.L)).length >= K - 1))
  const complete = contenders(S).every(s => S.pos[s.L].assessment && S.pos[s.L].assessment.round === k && S.pos[s.L].assessment.checked)
  if (!near || !complete) {
    log(`round ${k}: no ballot (${!near ? 'no position was one vote short' : 'not every position was checked'})`)
    return null
  }
  const seated = active(S)
  const res = await parallel(seated.map(s => () => seatTurn(s, `b${k}`, ballotPrompt(S, s, k), BALLOT_SCHEMA)))
  seated.forEach((s, i) => {
    if (res[i]) recordVote(S, S.ballots, k, s.L, res[i].vote)
    else S.notes.push(`Seat ${s.L} returned no ballot after round ${k}; it abstains.`)
  })
  const c = consensus(S, k, S.ballots)
  const line = Object.entries(S.ballots[k] || {}).map(([L, v]) => `${L}→${v.ship}`).join(' ')
  log(`ballot after round ${k}: ${line || 'no votes'}${c ? ` → consensus on ${c.W} (${c.voters.join(', ')})` : ' → no consensus'}`)
  return c
}

// Never costs the council its result: a failed retro is reported, not thrown. A factory run always
// records its facts; it gets the model retro only when something in it is worth learning from.
async function runRetro(o) {
  const data = S.factory ? runFacts(S, o) : null
  if (data && !retroWanted(S, o)) return recordFacts(retroPayload(S, retroFacts(S, o), data))
  if (!S.retro) return null
  const payload = retroPayload(S, retroFacts(S, o), data)
  const hash = promptHash(payload)
  let r = null
  try {
    reserveTurn()
    const prompt = retroPrompt(S, o.reportMd, payload, hash)
    const opts = { label: 'retro', phase: 'Retro', schema: RETRO_SCHEMA, model: 'sonnet', effort: 'medium' }
    r = hostRuntime ? await hostAgent(prompt, opts, 'retro', null, { payload, payloadFile: `${S.run.runDir}/retro-data.md` }) : await agent(prompt, opts)
  } catch (e) {
    if (e?.code === 'CHECKPOINT_MISMATCH') throw e
    r = null
  }
  if (hostRuntime) S.turnLog.push({ turn: 'retro', role: 'retro', vendor: S.roles.retro.vendor, ok: !!r })
  if (!r) {
    return { worked: [], changes: [], saved: '', error: 'the retro agent failed', notes: S.processNotes,
      markdown: `### Process retro\n\nThe retro agent failed. ${plural(S.processNotes.length, 'process note')} from the run ${S.processNotes.length === 1 ? 'is' : 'are'} in retro.notes.` }
  }
  return { worked: r.worked || [], changes: r.changes || [], saved: r.saved || '', error: r.error || '', notes: S.processNotes, markdown: retroMarkdown(r) }
}

async function recordFacts(payload) {
  const hash = promptHash(payload)
  let r = null
  try {
    reserveTurn()
    const prompt = recordPrompt(S, payload, hash)
    const opts = { label: 'record', phase: 'Record', schema: RECORD_SCHEMA, model: 'haiku', effort: 'low' }
    r = hostRuntime ? await hostAgent(prompt, opts, 'record', null, { payload, payloadFile: `${S.run.runDir}/retro-data.md` }) : await agent(prompt, opts)
  } catch (e) {
    if (e?.code === 'CHECKPOINT_MISMATCH') throw e
    r = null
  }
  S.turnLog.push({ turn: 'record', role: 'record', vendor: hostRuntime ? S.roles.record.vendor : 'claude', ok: !!r })
  return { recorded: true, saved: (r && r.saved) || '', error: r ? r.error || '' : 'the record agent failed', notes: S.processNotes, markdown: '' }
}
