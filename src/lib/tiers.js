// The factory's tiers: which one a run starts at, when the Simple tier hands the work up, and the
// facts each run records so the router can be tuned. Pure, like the rest of lib/.
//
//   simple        one implementer, checks, one reviewer from another vendor, at most one fix
//   fix           a subtle bug: two blind attempts (Opus, Astra) through the council
//   feature       two blind plans (Opus, Astra), debated and merged; the winner builds it in checked
//                 increments; then a three-lens audit (correctness, design, tests) and one fix pass
//   architecture  three blind designs (Opus, Astra, Sonnet), debated; the winner writes a milestone
//                 plan, reviewed through three lenses (grounding, sequencing, risk) and revised once;
//                 nothing is built: each milestone becomes a factory run of its own

const TIERS = ['simple', 'fix', 'feature', 'architecture']
// Design is where a third seat has paid off: the one design run's finalists were Sonnet's and Astra's.
const TIER_SEATS = { fix: ['opus', 'astra'], feature: ['opus', 'astra'], architecture: ['opus', 'astra', 'sonnet'] }
const CODEX_TIER_SEATS = { fix: ['opus', 'astra', 'sol'], feature: ['opus', 'astra', 'sol'], architecture: ['opus', 'astra', 'sol'] }
const SIMPLE = { implementer: 'sonnet', reviewer: 'astra', maxLines: 200, maxFiles: 8 }
const CODEX_SIMPLE = { ...SIMPLE, implementer: 'astra' }
const SMALL_DIFF = 50          // changed lines: below this, a clean fix or feature run hints the tier was too high

// What the factory reads from its args, on top of what the council reads.
function parseFactory(raw) {
  const tier = raw.tier === undefined || raw.tier === null || raw.tier === '' ? null : String(raw.tier).toLowerCase()
  if (tier && !TIERS.includes(tier)) throw new Error(`factory: unknown tier '${raw.tier}'. Known: ${TIERS.join(', ')}.`)
  const s = raw.simple && typeof raw.simple === 'object' ? raw.simple : {}
  const defaults = raw.host === 'codex' ? CODEX_SIMPLE : SIMPLE
  const n = (v, d) => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d
  return {
    tier, tierConfirmed: raw.tierConfirmed === true, noSplit: raw.noSplit === true,
    simple: {
      implementer: String(s.implementer || defaults.implementer), reviewer: String(s.reviewer || defaults.reviewer),
      maxLines: n(s.maxLines, SIMPLE.maxLines), maxFiles: n(s.maxFiles, SIMPLE.maxFiles),
    },
  }
}

// The council's args for a tier. The user's own args win, except that a tier's seats apply only
// when the user named none, architecture is always a design, and simple and feature build a change.
function tierArgs(raw, tier, intake) {
  const a = { ...raw }
  delete a.tier; delete a.tierConfirmed; delete a.noSplit; delete a.simple
  // Preserve the Codex caller's Simple limits and models when intake rebuilds its state.
  // Other tiers still get their own defaults, including after an escalation.
  if (raw.host === 'codex' && tier === 'simple' && raw.simple) a.simple = raw.simple
  if (!a.mode && intake && MODES.includes(intake.mode)) a.mode = intake.mode
  if (tier === 'architecture') a.mode = 'design'
  if (tier === 'simple' || tier === 'feature') a.mode = 'implement'
  const defaults = raw.host === 'codex' ? CODEX_TIER_SEATS : TIER_SEATS
  if (defaults[tier] && !seatList(a.seats).length) a.seats = defaults[tier]
  return a
}

// The tier intake picked, made safe: Simple and Feature build changes, so an investigation or a
// design it put there goes to the tier that delivers one: fix or architecture.
function intakeTier(intake) {
  const t = intake && TIERS.includes(intake.tier) ? intake.tier : 'feature'
  if ((t === 'simple' || t === 'feature') && intake && intake.mode && intake.mode !== 'implement') return intake.mode === 'design' ? 'architecture' : 'fix'
  return t
}

// The increments the Feature tier's build runs, from the final plan's list, one turn each. A plan
// that lists more than FEATURE_INCREMENTS hands the work up before anything is built
// (featureTrigger); one without a usable list is built in one turn.
function planIncrements(list) {
  const items = (Array.isArray(list) ? list : []).filter(x => x && String(x.title || x.delivers || '').trim())
    .map(x => ({ title: oneLine(x.title || x.delivers, 120), delivers: oneLine(x.delivers || x.title, 1200) }))
  const fresh = (x, n) => ({ n, ...x, reported: false, summary: '', deviations: [], check: null })
  if (!items.length) return { listed: 0, increments: [fresh({ title: 'The whole plan', delivers: 'Everything in the final plan.' }, 1)] }
  return { listed: items.length, increments: items.map((x, i) => fresh(x, i + 1)) }
}

// Whether the Feature tier should hand the work up before it builds: a final plan that needs more
// increments than one build makes is work for milestones. L is the plan's author. null to go on.
function featureTrigger(S, L) {
  const listed = S.build ? S.build.listed : 0
  if (listed <= FEATURE_INCREMENTS) return null
  return { trigger: 'too-many-increments', to: 'architecture', L, why: `the chosen plan lists ${listed} increments, more than one feature build makes (${FEATURE_INCREMENTS})` }
}

// The pieces intake split the task into, made safe; [] runs it as one. One piece is not a split,
// and a piece can only build on the pieces before it.
function splitItems(intake) {
  const raw = intake && intake.status === 'needs-split' && Array.isArray(intake.split) ? intake.split.filter(i => i && String(i.task || '').trim()) : []
  if (raw.length < 2) return []
  return raw.map((i, k) => ({
    n: k + 1, title: oneLine(i.title, 120) || `Piece ${k + 1}`, task: String(i.task).trim(), tier: TIERS.includes(i.tier) ? i.tier : 'feature',
    after: [...new Set((Array.isArray(i.after) ? i.after : []).filter(m => Number.isInteger(m) && m >= 1 && m <= k))],
  }))
}

// When the user pinned a tier that intake would not pick, the run asks once before spending
// anything. Either direction counts. A confirmed pin stands.
function tierPushback(S, intake) {
  const f = S.factory
  if (!f.asked || f.tierConfirmed) return null
  const recommended = intakeTier(intake)
  return recommended === f.asked ? null : { asked: f.asked, recommended }
}

// Whether the Simple tier should hand the work up, at each point it can tell. Deterministic, from
// the ledger and the checks; null to go on. Failures of the machinery (an agent that returned
// nothing) are not evidence about the task, so they never escalate.
function simpleTrigger(S, stage, o = {}) {
  const L = S.letters[0]
  const p = S.pos[L]
  if (stage === 'solve') {
    const big = o.tooBig
    if (big && ['fix', 'feature', 'architecture'].includes(big.tier)) {
      return { trigger: 'too-big', to: big.tier === 'fix' ? 'fix' : 'feature', why: `the implementer judged it bigger than a simple change: ${oneLine(big.reason, 300) || 'no reason given'}` }
    }
    const st = p && p.stats
    const lines = st ? st.added + st.removed : 0
    if (st && (lines > S.simple.maxLines || st.files > S.simple.maxFiles)) {
      return { trigger: 'over-budget', to: 'feature', why: `the change is ${lines} changed lines in ${plural(st.files, 'file')}, over the Simple budget of ${S.simple.maxLines} lines or ${S.simple.maxFiles} files` }
    }
    return null
  }
  if (stage === 'review') {
    // A judgment finding the panel agreed on has become a fact (applyPanel), and is still about the approach.
    const design = S.ledger.filter(c => (c.round === 'H' || /^review\d+$/.test(c.round)) && c.kind === 'finding' && c.wasJudgment && W8[c.severity] >= 2 && c.status === 'verified' && !c.withdrawn && !c.fixed)
    if (design.length) {
      return { trigger: 'design-finding', to: 'feature', why: `the panel upheld ${design.map(c => `${c.severity} ${c.id}`).join(', ')} against the approach itself`, findings: design.map(c => c.id) }
    }
    return null
  }
  if (stage === 'final') {
    const failing = S.mode === 'implement' && S.baselineOk && p && p.suite && p.suite.ran && !p.suite.passed
    if (failing) return { trigger: 'verify-failed', to: 'fix', why: 'the verification command still fails after the fix pass' }
    if (o.ready && o.ready.state === 'blocked') return { trigger: 'blocked', to: 'fix', why: `the final version is blocked: ${o.ready.blocked.join('; ')}` }
    return null
  }
  return null
}

// What the higher tier is told about the attempt that came before. Never the diff or the plan:
// round 0 stays blind, so the seats don't anchor on an approach that already fell short. An attempt
// that was itself handed up keeps the brief before it in `earlier`.
function escalationBrief(S, esc) {
  const L = esc.L || S.letters[0]
  const p = S.pos[L] || {}
  const upheld = S.ledger.filter(c => (c.round === 'H' || /^review\d+$/.test(c.round)) && c.kind === 'finding' && !c.withdrawn && !c.fixed && (c.status === 'verified' || (esc.findings || []).includes(c.id)))
  const failing = validTests(S).filter(t => S.testResults[t.id] && S.testResults[t.id][L] && S.testResults[t.id][L] !== 'pass')
  return {
    from: S.tier || 'simple', to: esc.to, trigger: esc.trigger, why: esc.why, runDir: S.run ? S.run.runDir : '',
    earlier: (S.factory && S.factory.escalation) || null,
    criteria: S.criteria.map(c => `${c.id}: ${c.text}`),
    findings: upheld.map(c => `${c.severity}${c.judgment ? ', judgment' : ''}: ${oneLine(c.statement, 300)}${c.evidence ? ` (evidence: ${oneLine(c.evidence, 200)})` : ''}`),
    tests: failing.map(t => `${S.run.room}/tests/${t.id}/ (${oneLine(t.statement, 160)})`),
    suiteTail: p.suite && p.suite.ran && !p.suite.passed ? oneLine(p.suite.tail, 600) : '',
  }
}

function escalationBlock(S) {
  const e = S.escalation
  if (!e) return ''
  if (e.from === 'feature') {
    return `\n# An earlier attempt\n\nThis task was first planned as one feature, and was handed up because ${e.why}. ` +
      'You are not shown that plan, on purpose: work out your own design. Its size is evidence about the task: the work needs milestones, each small enough to build at once.\n'
  }
  return `\n# An earlier attempt\n\nThis task was first tried as a simple change, by one implementer with one reviewer, and was handed up because ${e.why}. ` +
    'You are not shown that attempt\'s change, on purpose: work out your own. What it ran into is evidence about the task:\n' +
    [...e.findings.map(f => `- Upheld finding: ${f}`), ...e.tests.map(t => `- A test it failed, which you may read: ${t}`),
      e.suiteTail ? `- The verification command's failing tail: ${e.suiteTail}` : ''].filter(Boolean).join('\n') + '\n'
}

// Hints that a fix or feature run cost more than the task needed, for the router's tally.
function overTierHints(S, o) {
  const hints = []
  if (!S.factory || S.factory.tier === 'simple') return hints
  if (o.outcome && o.outcome.via === 'blind') hints.push('every seat wrote the same change in round 0')
  const p = o.W ? S.pos[o.W.L] : null
  const lines = p && p.stats ? p.stats.added + p.stats.removed : null
  const audit = o.audit
  if (audit && audit.ran && !audit.fixPass && !S.ledger.some(c => lensOf(c.author) && c.kind === 'finding') && lines !== null && lines < SMALL_DIFF) {
    hints.push(`a clean audit on a ${lines}-line change`)
  }
  return hints
}

// The facts the router is tuned from, one JSON object per run, saved next to the retro.
function runFacts(S, o) {
  const f = S.factory || {}
  const claude = S.turnLog.filter(t => t.vendor === 'claude')
  const findings = S.ledger.filter(c => lensOf(c.author) && c.kind === 'finding')
  const count = (xs, key) => xs.reduce((m, x) => { const k = key(x); m[k] = (m[k] || 0) + 1; return m }, {})
  return {
    metrics: { ...evaluationFacts(S, { final: { readiness: o.ready } }, null, S.turnLog.length), scope: 'before-retrospective' },
    runId: S.run ? S.run.runId : '', repo: S.run ? S.run.repoRoot : '', workflow: S.workflowName,
    tier: f.tier || null, chosenBy: f.chosenBy || null, asked: f.asked || null, recommended: f.recommended || null,
    signals: f.intake ? f.intake.signals : null,
    escalation: f.escalation ? escalationFacts(f.escalation) : null,
    split: f.split || null,
    mode: S.mode, readiness: o.ready ? o.ready.state : null,
    turns: { claude: claude.length, byRole: count(S.host === 'codex' ? S.turnLog : claude, t => t.role), external: S.turnLog.filter(t => t.vendor !== 'claude').length,
      ...(S.host === 'codex' ? { byVendor: count(S.turnLog, t => t.vendor) } : {}) },
    reviewFindings: count(findings, c => c.severity),
    fabricated: S.ledger.filter(c => c.status === 'fabricated').length,
    relayFailures: S.relayFailures.length,
    overTierHints: overTierHints(S, o),
    ...(S.tier === 'architecture' ? { milestones: (S.milestones || []).length } : {}),
  }
}

// The escalations that led to this run, first to last: Simple to Feature, then Feature to Architecture.
function escalationChain(e) {
  const chain = []
  for (let x = e; x; x = x.earlier) chain.unshift(x)
  return chain
}

// The facts tally a run by the tier it started at, so a chain records its first `from`.
function escalationFacts(e) {
  const chain = escalationChain(e)
  return { from: chain[0].from, to: e.to, trigger: e.trigger,
    ...(chain.length > 1 ? { steps: chain.map(x => ({ from: x.from, to: x.to, trigger: x.trigger })) } : {}) }
}

// The model retro costs a Sonnet turn, a fifth of a clean Simple run, and on a clean Simple run
// there is usually nothing to learn. Facts are recorded either way.
function retroWanted(S, o) {
  if (S.raw.retro === true) return true
  if (!S.retro) return false
  const f = S.factory || {}
  return f.tier !== 'simple' || !!f.escalation || f.chosenBy === 'overruled' || !!f.split || !o.ready || o.ready.state !== 'ready' ||
    S.ledger.some(c => c.status === 'fabricated') || S.relayFailures.length > 0
}

// The factory's lines in the retro's run facts.
function factoryFacts(S) {
  const f = S.factory
  if (!f) return ''
  const how = { intake: 'chosen by intake', pinned: 'pinned by the user, and intake agreed', overruled: `pinned by the user over intake's ${f.recommended}` }[f.chosenBy] || ''
  const sig = f.intake && f.intake.signals
  const chain = escalationChain(f.escalation)
  return [
    `- Factory tier: ${chain.length ? `started ${chain[0].from}, ${chain.map(e => `escalated to ${e.to} (${e.trigger}: ${oneLine(e.why, 300)})`).join(', then ')}` : f.tier}${how ? `, ${how}` : ''}.`,
    f.intake ? `- Intake: ${f.intake.tier}, ${f.intake.mode}; ${oneLine(f.intake.reasons, 400)}${sig ? ` Signals: ${Object.entries(sig).map(([k, v]) => `${k}=${v}`).join(', ')}.` : ''}` : '',
    f.split ? `- Intake proposed ${plural(f.split.pieces, 'separate run')} for this task; the user ran it as one.` : '',
    ...chain.filter(e => e.runDir).map(e => `- The ${capital(e.from)} attempt: ${e.runDir}. Turn counts below include its turns.`),
  ].filter(Boolean).join('\n')
}

// A Simple run's report, and the opening of an escalated one.
function escalatedSection(S) {
  return escalationChain(S.factory && S.factory.escalation).map(e => e.from === 'feature'
    ? `### Escalated from Feature\n\nThe factory first planned this as one feature and handed it to the ${e.to} tier, before building anything, because ${e.why}. ` +
      `The designs below started fresh: blind, without that plan. The Feature attempt is in ${e.runDir}.\n\n`
    : `### Escalated from Simple\n\nThe factory first tried this as a simple change (one implementer, one reviewer) and handed it to the ${e.to} tier because ${e.why}. ` +
      `The council below started fresh: blind, without that attempt's change. The Simple attempt is in ${e.runDir}.\n\n`).join('')
}

function simpleReport(S, o) {
  const { W, ready, audit } = o
  const p = S.pos[W.L]
  const assumed = S.pendingQ.filter(q => q && q.question)
  const lines = [
    `- **Readiness:** ${readinessText(ready)}.`,
    `- **Change:** ${p.stats ? `${plural(p.stats.files, 'file')}, +${p.stats.added}/−${p.stats.removed}` : 'not measured'}; ${oneLine(p.summary, 400)}`,
    `- **Neutral check:** ${finalSummary(S, W.L)}`,
    S.baselineOk ? '' : `- **Baseline:** the verification command already failed before the change (${oneLine(S.baselineNote, 200)}).`,
  ].filter(Boolean)
  return {
    markdown: (assumed.length ? `### Assumptions to check\n\n${assumed.map(q => `- ${sentence(oneLine(q.question, 300))}${q.assumption ? ` Assumed: ${sentence(oneLine(q.assumption, 300))}` : ''}`).join('\n')}\n\n` : '') +
      `### Simple change, by ${W.name}\n\nThe factory routed this as a simple change: one implementer, the neutral check, and ${S.host === 'codex' ? 'one independent reviewer' : 'one reviewer from another vendor'}.\n\n${lines.join('\n')}` +
      auditSection(S, W, audit) + problemsSection(S),
  }
}

// The user pinned a tier that intake would not pick: stop before anything is created, and ask.
function needsTier(S, push, intake) {
  return {
    status: 'needs-tier', task: S.task, asked: push.asked, recommended: push.recommended,
    reasons: intake.reasons || '', signals: intake.signals || null, notes: S.notes,
    forTheOrchestrator:
      `The factory stopped before creating anything: the user asked for the ${push.asked} tier, and intake recommends ${push.recommended} (${oneLine(intake.reasons, 400) || 'no reason given'}). ` +
      `Ask the user in one short message whether to keep ${push.asked} or switch to ${push.recommended}, with intake's reason. ` +
      (S.host === 'codex'
        ? `Rerun the runner with the original args file and tierConfirmed: true to keep it, or tier: "${push.recommended}" to switch. This starts a new run. `
        : `To keep it: Workflow({name: "factory", resumeFromRunId: <this run's id>, args: <exactly the args you launched with, as an object>, plus tierConfirmed: true}). ` +
          `To switch: the same call with tier: "${push.recommended}" instead. Intake replays from cache either way. `) +
      'A kept tier is only where the run starts: if the evidence shows it is too low, the run still hands the work up.',
  }
}

// Intake found separate pieces of work in the task: stop before anything is created, and ask
// whether to run them one at a time. Each piece gets its own intake, so its tier is only an estimate.
function needsSplit(S, items, intake) {
  const tier = intakeTier(intake)
  const pinned = S.factory && S.factory.asked
  return {
    status: 'needs-split', task: S.task, items, tier, reasons: intake.reasons || '', signals: intake.signals || null, notes: S.notes,
    forTheOrchestrator:
      `The factory stopped before creating anything: intake found ${items.length} separate pieces of work in this task (${oneLine(intake.reasons, 400) || 'no reason given'}). ` +
      'One run would debate and review them all together, at the cost of the hardest piece. ' +
      `Show the user the pieces (items[]: title, estimated tier, and the earlier pieces each builds on) and ask in one short message: run them one at a time (recommended), or the whole task as one ${pinned || tier} run. ` +
      (S.host === 'codex'
        ? 'One at a time: rerun the runner for each piece in order, preserving the original args and replacing task with that piece\'s task, so plan, context and the rest carry over. '
        : 'One at a time: for each piece in order, Workflow({name: "factory", args: <the args you launched with>, with task replaced by the piece\'s task}), so plan, context and the rest carry over. ') +
      'Each run starts from HEAD and stops on a dirty tree, so present each result as usual and wait for the user to commit it before the next piece starts. ' +
      `Don't pin the estimated tiers: each run's intake picks its own${pinned ? `. The user pinned ${pinned} for the whole task; ask whether it applies to each piece` : ''}. ` +
      (S.host === 'codex'
        ? 'As one: rerun the runner with the original args and noSplit: true. This starts a new run.'
        : 'As one: Workflow({name: "factory", resumeFromRunId: <this run\'s id>, args: <exactly the args you launched with, as an object>, plus noSplit: true}). Intake replays from cache.'),
  }
}

// On a run that needs no model retro, a small agent saves the facts: workflow scripts have no shell.
function recordPrompt(S, payload, hash) {
  if (S.host === 'codex') return `Save this run's facts. Run this with the shell tool, exactly as written:
${S.cli} retro --facts-only --run-dir ${shq(S.run.runDir)} --payload-file ${shq(`${S.run.runDir}/retro-data.md`)} --expect ${hash}
The runtime wrote the exact payload to that file. Do not rewrite it. The last line printed is JSON. For status "ok", set saved to its "path" and error to ""; otherwise set saved to "" and error to what it printed. Do nothing else.`
  return `Save this run's facts. Run this with the Bash tool, exactly as written:
${S.cli} retro --facts-only --run-dir ${shq(S.run.runDir)} --expect ${hash}
The last line it prints is JSON. "ok": set saved to its "path". "sandboxed": run the same command again with the sandbox disabled (dangerouslyDisableSandbox: true). "error", or "sandboxed" again: set saved to "" and error to what it printed. Do nothing else.

=====BEGIN PAYLOAD ${hash}=====
${payload}
=====END PAYLOAD ${hash}=====`
}

// A Simple run that finished without handing the work up.
function simpleResult(S, o) {
  const { W, ready, audit, report, retro } = o
  const tag = audit.finalTag || (audit.fixPass ? roundTag('I') : S.auditedTag)
  const f = S.factory
  return {
    status: 'done', tier: 'simple', mode: S.mode, task: S.task, runDir: S.run.runDir, room: S.run.room, refs: S.refs,
    report,
    factory: { tier: 'simple', chosenBy: f.chosenBy, asked: f.asked, recommended: f.recommended, reasons: f.intake ? f.intake.reasons : '' },
    final: {
      author: W.L, model: W.name, summary: S.pos[W.L].summary, post: S.pos[W.L].post,
      diff: `${S.run.room}/${tag}/${W.L}.diff`, snapshotRef: `refs/council/${S.run.runId}/${W.L}-${tag}`, worktree: W.wt,
      snapshotTree: S.pos[W.L].tree?.hash || null,
      check: finalSummary(S, W.L), readiness: ready, suite: S.pos[W.L].suite, criteria: S.pos[W.L].criteria, fixPass: audit.fixPass,
    },
    audit: auditResult(S, audit),
    review: audit.ran ? {
      reviewer: S.auditors.map(a => a.name).join(', '), summary: ((audit.reviews.review) || {}).summary || '',
      items: S.ledger.filter(c => lensOf(c.author)).map(c => ({ id: c.id, kind: c.kind, severity: c.severity, judgment: c.judgment,
        status: c.fixed ? 'fixed' : c.status, statement: c.statement, evidence: c.evidence, note: c.note })),
    } : null,
    assumptions: S.pendingQ.filter(q => q && q.question).map(q => ({ question: q.question, assumption: q.assumption })),
    notes: S.notes, retro,
    forTheOrchestrator:
      `${ready.state === 'ready' ? '' : `The change is ${ready.state.toUpperCase()} (final.readiness: ${[...ready.blocked, ...ready.incomplete].join('; ')}). Say so first. `}` +
      `The factory ran this as a simple change${f.chosenBy === 'overruled' ? ` (the user's choice, over intake's ${f.recommended})` : ''}: one implementer, a neutral check and one reviewer. ` +
      'You present this; you do not re-decide it. Read the diff and the post yourself and spot-check their load-bearing claims. ' +
      'Then give the user: (1) two or three sentences on what changed and how the review went; (2) report.markdown; (3) what your spot-check found; ' +
      '(4) a suggested commit message, in a code block, written from the diff after a look at `git log --oneline -15` for the repository\'s style: one imperative subject line, ' +
      'a short body only if needed, no references to plans, the factory or models, and no attribution lines' +
      `${retro && retro.markdown ? '; (5) last, retro.markdown as it is: notes on the workflow, not the user\'s project' : ''}. ` +
      deliveryNote(S, tag, W, 'The change') +
      `When the user is done, \`${S.cli} cleanup --run-dir ${S.run.runDir}\` removes the worktree and keeps the transcript; add --all to delete everything.`,
  }
}

// ---- The Feature tier's report, facts and result.

// The Feature tier's outcome lines in the retro's run facts.
function buildFacts(S, o) {
  const b = S.build, oc = o.outcome
  return [
    `- Plan: ${oc.kind === 'consensus' ? `consensus on ${oc.W} in round ${oc.round}${oc.via === 'approval' ? ' by approval' : ''}` : `no consensus after ${plural(oc.round, 'round')}; the scorecard picked ${oc.W}`}, ` +
      `with up to ${plural(S.rounds, 'round')} allowed. No ratification: the audit reviews the change.`,
    `- Build: ${plural(b.increments.length, 'increment')} by ${o.W.L}: ` +
      `${b.increments.map(x => `inc${x.n} ${!x.reported ? 'no report' : !x.check ? 'not measured' : suiteWord(x.check.suite)}${x.deviations.length ? `, ${plural(x.deviations.length, 'deviation')}` : ''}`).join('; ')}` +
      `${o.audit && o.audit.fixPass ? '; then one audit fix pass' : ''}.`,
  ].join('\n')
}

const suiteWord = s => !s || !s.ran ? 'no suite' : s.passed ? 'suite PASS' : 'suite FAIL'

function incrementLine(S, x) {
  const c = x.check
  const checked = !c ? 'not measured' : `${suiteWord(c.suite)}, ${plural(c.stats.files, 'file')} +${c.stats.added}/−${c.stats.removed} so far`
  return `- **Increment ${x.n}, ${oneLine(x.title, 160)}:** ${x.reported ? sentence(oneLine(x.summary, 300)) || '(no summary)' : 'the turn returned nothing.'} Check: ${checked}.` +
    (x.deviations.length ? ` Departed from the plan: ${x.deviations.map(d => oneLine(d, 200)).join('; ')}.` : '')
}

// `o`: {outcome, W, rows, ready, audit}. rows: the plans' scorecard when the plan was chosen.
function featureReport(S, o) {
  const { outcome, W, rows, audit } = o
  const { why, ending, rank } = chosenWhy(S, outcome, W, rows)
  const b = S.build
  const merged = S.adoptions.filter(a => a.by === W.L && a.round === 'F')
  const build = [`- **The final plan:** ${b.plan}, built in ${plural(b.increments.length, 'increment')}${b.listed ? '' : ' (it listed none, so one turn built it whole)'}.`]
  if (merged.length) build.push(`- **Merged from the other plans:** ${merged.map(a => `${who(S, a.from)}: ${oneLine(a.idea, 160)}`).join('; ')}`)
  build.push(...b.increments.map(x => incrementLine(S, x)))

  const fin = [
    `- **Readiness:** ${readinessText(o.ready)}`,
    `- **Neutral check of the final change:** ${finalSummary(S, W.L)}`,
  ]
  if (!S.baselineOk) fin.push(`- **Baseline:** the verification command already failed before any change: ${S.baselineNote}`)
  if (S.declined.length) fin.push(`- **Declined:** ${S.declined.map(d => `${oneLine(d.ref, 80)}: ${oneLine(d.why, 160) || 'no reason given'}`).join('; ')}`)
  const open = S.ledger.filter(c => isStanding(S, c) && c.target === W.L)
    .map(c => `standing finding [${c.id}] from ${who(S, c.author)} (${c.severity}, ${c.status}): ${oneLine(c.statement, 200)}`)
  for (const q of S.questions.filter(q => !answered(S, q.id))) open.push(`assumption on [${q.id}] ${oneLine(q.text, 160)}: ${Object.entries(q.assumptions).map(([L, a]) => `${L} assumed ${oneLine(a, 120)}`).join('; ')}`)
  fin.push(open.length ? `- **Still open:**\n${open.map(x => `  - ${x}`).join('\n')}` : '- **Still open:** nothing.')

  const markdown = assumptionsSection(S) + [
    `### Plan chosen: ${who(S, W.L)}\n\n${why.join('\n')}`,
    `### The plans\n\n${positionsSection(S, rows, W.L)}`,
    `### How the planning debate went\n\n${roundsSection(S, outcome.round, ending)}`,
    `### The debates\n\n${debateSection(S, W.L)}`,
    `### The build\n\n${build.join('\n')}`,
    `### How it turned out\n\n${fin.join('\n')}`,
  ].join('\n\n') + specSection(S) + auditSection(S, W, audit) + problemsSection(S)
  return {
    chosen: { seat: W.L, model: W.name, how: outcome.kind, round: outcome.round, rank, voters: outcome.voters,
      runnerUp: rows.find(r => r.seat !== W.L) ? rows.find(r => r.seat !== W.L).seat : null },
    debates: debates(S, W.L).length,
    markdown,
  }
}

// `o`: {outcome, W, rows, table, ready, audit, report, retro}. routedResult or escalatedResult then
// adds how the tier was reached.
function featureResult(S, o) {
  const { outcome, W, ready, audit, report, retro } = o
  const tag = audit.finalTag || (audit.fixPass ? roundTag('I') : S.auditedTag)
  const b = S.build
  return {
    status: 'done', tier: 'feature', mode: S.mode, task: S.task, runDir: S.run.runDir, room: S.run.room, refs: S.refs,
    report,
    plan: {
      author: W.L, model: W.name, post: b.plan,
      how: outcome.kind === 'consensus' ? `Consensus in round ${outcome.round}: ${outcome.voters.join(', ')} voted for ${W.L}'s plan.` : `No consensus after ${plural(outcome.round, 'round')}. The scorecard picked ${W.L}'s plan.`,
      votesByRound: S.votes, listed: b.listed,
    },
    build: b.increments.map(x => ({ n: x.n, title: x.title, delivers: x.delivers, reported: x.reported, summary: x.summary, deviations: x.deviations,
      post: x.reported ? postPath(S, W.L, `K${x.n}`) : null, suite: x.check ? x.check.suite : null, stats: x.check ? x.check.stats : null })),
    final: {
      author: W.L, model: W.name, post: S.pos[W.L].post,
      diff: `${S.run.room}/${tag}/${W.L}.diff`, snapshotRef: `refs/council/${S.run.runId}/${W.L}-${tag}`, worktree: W.wt,
      check: finalSummary(S, W.L), readiness: ready, suite: S.pos[W.L].suite, criteria: S.pos[W.L].criteria, auditFixPass: audit.fixPass,
      standingFindings: S.ledger.filter(c => isStanding(S, c) && c.target === W.L).map(c => ({ id: c.id, from: c.author, severity: c.severity, status: c.status, statement: c.statement })),
    },
    scorecards: {
      positions: o.rows,
      seats: seatRows(S),
      markdown: `### The plans when one was chosen\n\n${o.table}\n\n### Final change (${W.L})\n\n${finalSummary(S, W.L)}\n\n### Seats\n\n${seatTable(S)}`,
    },
    spec: specResult(S),
    audit: auditResult(S, audit),
    seats: reveal(S),
    ledger: { claims: S.ledger.length, byStatus: S.ledger.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m }, {}) },
    notes: S.notes,
    retro,
    forTheOrchestrator:
      `${ready.state === 'ready' ? '' : `The final change is ${ready.state.toUpperCase()} (final.readiness: ${[...ready.blocked, ...ready.incomplete].join('; ')}). Say so at the top of your summary, before anything else. `}` +
      (S.spec.assumptions.length
        ? `Before any work began, the council assumed ${plural(S.spec.assumptions.length, 'answer')} to questions about the request that only the user can settle (spec.assumptions; report.markdown opens with them). ` +
          'The result is built on them, so list them next, each as a question the user can answer yes or no. If one is wrong, the fix is a new run with the answer in the task or the context. '
        : '') +
      `${plural(S.seats.length, 'seat')} planned the change blind and debated the plans; ${W.L}'s plan was chosen and merged with the best of the others, and its author built it in ${plural(b.increments.length, 'increment')}, ` +
      `each checked; then auditors who never saw the planning reviewed it (${listText(S.auditors.map(a => a.lens))}). ` +
      'You present this; you do not re-decide it, and you do not relay it unread. Read the final plan and the diff yourself and spot-check their load-bearing claims before repeating them. ' +
      'Then give the user, in this order: ' +
      '(1) a summary in your own words: a short paragraph on what the task was, whose plan was chosen (by model) and why (report.markdown\'s "Plan chosen" section), ' +
      'what the other plans proposed and what was merged from them, how the build went (departures from the plan, increments whose check failed), ' +
      'and what the audit found and how it was settled; then the planning debates as a short list, one line each on what was argued and how it was settled (from "The debates"; say so if there were none); ' +
      '(2) report.markdown, computed from the ledger. Keep its facts, seats and rulings as they are; you may tighten the wording; (3) scorecards.markdown; ' +
      '(4) what your spot-check found, including anything you disagree with; ' +
      '(5) a suggested commit message for the final change, in a code block. Write it yourself from the final diff, after a look at `git log --oneline -15` to match the repository\'s style. ' +
      'Keep it concise: one imperative subject line, plus a short body only if the change genuinely needs one. Describe the change itself: no references to plan documents or their steps, ' +
      `to the factory, seats or models, and no Co-Authored-By or other attribution lines. Use it if the user later asks you to commit${retro && retro.markdown ? '; ' : '. '}` +
      (retro && retro.markdown ? '(6) last, retro.markdown as it is: notes on the workflow, not the user\'s project, so don\'t act on them unless the user asks. ' : '') +
      'Run `git status` in the main tree to confirm no seat touched it. ' +
      deliveryNote(S, tag, W, 'The final change') +
      `The room (${S.run.room}) holds the full transcript. When the user is done with it, \`${S.cli} cleanup --run-dir ${S.run.runDir}\` ` +
      'removes the worktrees and snapshot refs and keeps the transcript; add --all to delete everything. ' +
      `Codex and Gemini token usage: \`${S.cli} usage --run-dir ${S.run.runDir}\`.`,
  }
}

// A run a lower tier handed up: that tier's own result, opening with why. A run handed up twice
// (Simple, then Feature) is wrapped once, by the last hand-up, which knows the whole chain.
function escalatedResult(S, res) {
  if (!res || typeof res !== 'object' || res.escalated) return res
  const e = S.factory.escalation
  const chain = escalationChain(e)
  const f = S.factory
  const as = { simple: 'a simple change', feature: 'a feature' }
  return {
    ...res, escalated: true,
    factory: { tier: e.to, startedAt: chain[0].from, chosenBy: f.chosenBy, asked: f.asked, recommended: f.recommended,
      escalation: { from: e.from, to: e.to, trigger: e.trigger, why: e.why, runDir: e.runDir, ...(chain.length > 1 ? { earlier: chain.slice(0, -1).map(x => ({ from: x.from, to: x.to, trigger: x.trigger, why: x.why, runDir: x.runDir })) } : {}) } },
    report: res.report ? { ...res.report, markdown: `${escalatedSection(S)}${res.report.markdown}` } : res.report,
    forTheOrchestrator: `This run started as ${as[chain[0].from] || chain[0].from} and the factory handed it ${chain.map(x => `to the ${x.to} tier because ${x.why}`).join(', then ')}. Say so first, in one sentence. ` +
      chain.map(x => `The ${capital(x.from)} attempt is in ${x.runDir}; clean it up with \`${S.cli} cleanup --run-dir ${x.runDir} --all\` when the user is done. `).join('') + (res.forTheOrchestrator || ''),
  }
}

// A council, Feature or Architecture run the factory routed to directly: its result, with how the
// tier was chosen. One that was handed up on the way already says how it got there.
function routedResult(S, res) {
  if (!res || typeof res !== 'object' || res.escalated) return res
  const f = S.factory
  return { ...res,
    ...(res.mode === 'implement' && res.final && res.final.snapshotRef ? {
      final: { ...res.final, snapshotTree: S.pos[res.final.author]?.tree?.hash || null },
      delivery: { status: 'pending', record: `${res.runDir}/delivery.json` },
    } : {}),
    factory: { tier: f.tier, chosenBy: f.chosenBy, asked: f.asked, recommended: f.recommended, reasons: f.intake ? f.intake.reasons : '' },
    forTheOrchestrator: `The factory ran this at the ${f.tier} tier (${f.chosenBy === 'intake' ? 'intake\'s choice' : f.chosenBy === 'pinned' ? 'the user\'s choice, which intake agreed with' : `the user's choice, over intake's ${f.recommended}`}); mention it in a few words. ${res.forTheOrchestrator || ''}` }
}

// ---- The Architecture tier's milestones, report, facts and result.

// The milestones the final plan lists, made safe: at most MAX_MILESTONES, each with a task, and
// each building only on milestones before it. A tier other than simple is feature: a milestone
// is new work, and one too big for a feature build is the sequencing review's to catch.
function planMilestones(list) {
  const raw = (Array.isArray(list) ? list : []).filter(m => m && String(m.task || '').trim()).slice(0, MAX_MILESTONES)
  return raw.map((m, k) => ({
    n: k + 1, title: oneLine(m.title, 120) || `Milestone ${k + 1}`, task: String(m.task).trim(),
    criteria: (Array.isArray(m.criteria) ? m.criteria : []).map(c => oneLine(c, 400)).filter(Boolean).slice(0, 8),
    after: [...new Set((Array.isArray(m.after) ? m.after : []).filter(x => Number.isInteger(x) && x >= 1 && x <= k))],
    tier: m.tier === 'simple' ? 'simple' : 'feature',
    working: oneLine(m.working, 400),
  }))
}

// Review findings that still stand against milestone n of L's plan.
function milestoneFindings(S, L, n) {
  return S.ledger.filter(c => isStanding(S, c) && c.target === L && c.milestone === n)
}

// The args that run one milestone as a factory run of its own: its task, made to stand alone, with
// the final design as its reference document, and the tier the plan gave it. The tier is
// confirmed and the task not split again, because this run already chose and split.
function milestoneArgs(S, m, design, findings) {
  const lines = [m.task, '',
    `This is milestone ${m.n} of ${S.milestones.length} of a larger piece of work: ${oneLine(S.task, 300)}`,
    `Its design is the reference document ${design}. Build this milestone only${m.after.length ? `; it builds on ${m.after.length === 1 ? 'milestone' : 'milestones'} ${listText(m.after.map(String))}, already done` : ''}.` +
      (m.working ? ` Once it lands: ${sentence(m.working)}` : '')]
  if (m.criteria.length) lines.push('', 'Draft acceptance criteria from the plan, to check against the code as it now is:', ...m.criteria.map(c => `- ${c}`))
  if (findings.length) lines.push('', 'Findings from the review of the plan that still stand against this milestone:', ...findings.map(c => `- ${oneLine(c.statement, 400)}`))
  const original = S.factory && S.factory.args || S.raw
  // Carry every option except what describes this run's task, so a new option isn't dropped.
  const own = new Set(['task', 'prompt', 'question', 'plan', 'mode', 'tier', 'tierConfirmed', 'noSplit', 'criteria', 'clarifications', 'hostRunId'])
  const options = S.host === 'codex'
    ? Object.fromEntries(Object.entries(original).filter(([k, v]) => !own.has(k) && v !== undefined)) : {}
  return { ...options, task: lines.join('\n'), plan: [design, ...S.plan], tier: m.tier, tierConfirmed: true, noSplit: true }
}

// The request asked for the change itself, and got a plan: intake judged it too big for one
// feature, or a Feature run handed it up.
function changeAsked(S) {
  const f = S.factory || {}
  return !!f.escalation || !!(f.intake && f.intake.mode === 'implement')
}

// The Architecture tier's outcome lines in the retro's run facts.
function archFacts(S, o) {
  const oc = o.outcome, ms = S.milestones || []
  return [
    `- Design: ${oc.kind === 'consensus' ? `consensus on ${oc.W} in round ${oc.round}${oc.via === 'approval' ? ' by approval' : ''}` : `no consensus after ${plural(oc.round, 'round')}; the scorecard picked ${oc.W}`}, ` +
      `with up to ${plural(S.rounds, 'round')} allowed. No ratification: the review checks the milestone plan.`,
    `- Milestones: ${ms.length}${ms.length ? ` (${countsOf(ms, m => m.tier)})` : ''} by ${o.W.L}${o.audit && o.audit.fixPass ? ', revised once after the review' : ''}.`,
  ].join('\n')
}

function milestoneLine(S, m, L) {
  const open = milestoneFindings(S, L, m.n)
  return `${m.n}. **${m.title}** (${m.tier}${m.after.length ? `, after ${m.after.join(', ')}` : ''}): ${sentence(oneLine(m.task, 300))}` +
    (m.working ? ` Once it lands: ${sentence(oneLine(m.working, 200))}` : '') +
    ` Draft criteria: ${m.criteria.length ? m.criteria.map(c => oneLine(c, 140)).join('; ') : 'none'}.` +
    (open.length ? ` Still open: ${open.map(c => `[${c.id}] ${oneLine(c.statement, 160)}`).join('; ')}.` : '')
}

// `o`: {outcome, W, rows, ready, audit}. rows: the designs' scorecard when the design was chosen.
function architectureReport(S, o) {
  const { outcome, W, rows, audit } = o
  const { why, ending, rank } = chosenWhy(S, outcome, W, rows)
  const ms = S.milestones || []
  const merged = S.adoptions.filter(a => a.by === W.L && a.round === 'F')
  const plan = [`- **The final design:** ${S.pos[W.L].post}${audit.fixPass ? ', as revised after the review' : ''}.`]
  if (merged.length) plan.push(`- **Merged from the other designs:** ${merged.map(a => `${who(S, a.from)}: ${oneLine(a.idea, 160)}`).join('; ')}`)
  plan.push(ms.length ? `- **${plural(ms.length, 'milestone')}**, each to be built by a factory run of its own:\n${ms.map(m => `  ${milestoneLine(S, m, W.L)}`).join('\n')}` : '- **Milestones:** the plan lists none.')

  const fin = [`- **Readiness:** ${readinessText(o.ready)}`]
  if (changeAsked(S)) fin.push('- **Nothing was built:** the request asked for the change, and the factory judged it too big for one feature, so the milestones are the next step.')
  fin.push(`- **Neutral check of the final plan:** ${finalSummary(S, W.L)}`)
  if (S.declined.length) fin.push(`- **Declined:** ${S.declined.map(d => `${oneLine(d.ref, 80)}: ${oneLine(d.why, 160) || 'no reason given'}`).join('; ')}`)
  const open = S.ledger.filter(c => isStanding(S, c) && c.target === W.L)
    .map(c => `standing finding [${c.id}] from ${who(S, c.author)} (${c.severity}, ${c.status}${c.milestone ? `, milestone ${c.milestone}` : ''}): ${oneLine(c.statement, 200)}`)
  for (const q of S.questions.filter(q => !answered(S, q.id))) open.push(`assumption on [${q.id}] ${oneLine(q.text, 160)}: ${Object.entries(q.assumptions).map(([L, a]) => `${L} assumed ${oneLine(a, 120)}`).join('; ')}`)
  fin.push(open.length ? `- **Still open:**\n${open.map(x => `  - ${x}`).join('\n')}` : '- **Still open:** nothing.')

  const markdown = assumptionsSection(S) + [
    `### Design chosen: ${who(S, W.L)}\n\n${why.join('\n')}`,
    `### The designs\n\n${positionsSection(S, rows, W.L)}`,
    `### How the design debate went\n\n${roundsSection(S, outcome.round, ending)}`,
    `### The debates\n\n${debateSection(S, W.L)}`,
    `### The milestone plan\n\n${plan.join('\n')}`,
    `### How it turned out\n\n${fin.join('\n')}`,
  ].join('\n\n') + specSection(S) + auditSection(S, W, audit) + problemsSection(S)
  return {
    chosen: { seat: W.L, model: W.name, how: outcome.kind, round: outcome.round, rank, voters: outcome.voters,
      runnerUp: rows.find(r => r.seat !== W.L) ? rows.find(r => r.seat !== W.L).seat : null },
    debates: debates(S, W.L).length,
    markdown,
  }
}

// `o`: {outcome, W, rows, table, ready, audit, report, retro}. routedResult or escalatedResult then
// adds how the tier was reached.
function architectureResult(S, o) {
  const { outcome, W, ready, audit, report, retro } = o
  const design = S.pos[W.L].post
  const ms = S.milestones || []
  const asked = changeAsked(S)
  return {
    status: 'done', tier: 'architecture', mode: S.mode, task: S.task, runDir: S.run.runDir, room: S.run.room, refs: S.refs,
    report,
    design: {
      author: W.L, model: W.name, post: design,
      how: outcome.kind === 'consensus' ? `Consensus in round ${outcome.round}: ${outcome.voters.join(', ')} voted for ${W.L}'s design.` : `No consensus after ${plural(outcome.round, 'round')}. The scorecard picked ${W.L}'s design.`,
      votesByRound: S.votes,
    },
    milestones: ms.map(m => {
      const findings = milestoneFindings(S, W.L, m.n)
      return { ...m, findings: findings.map(c => ({ id: c.id, severity: c.severity, status: c.status, statement: c.statement })), args: milestoneArgs(S, m, design, findings) }
    }),
    final: {
      author: W.L, model: W.name, post: design, check: finalSummary(S, W.L), readiness: ready, criteria: S.pos[W.L].criteria, revised: audit.fixPass,
      standingFindings: S.ledger.filter(c => isStanding(S, c) && c.target === W.L).map(c => ({ id: c.id, from: c.author, severity: c.severity, status: c.status, milestone: c.milestone || 0, statement: c.statement })),
    },
    scorecards: {
      positions: o.rows,
      seats: seatRows(S),
      markdown: `### The designs when one was chosen\n\n${o.table}\n\n### Final design (${W.L})\n\n${finalSummary(S, W.L)}\n\n### Seats\n\n${seatTable(S)}`,
    },
    spec: specResult(S),
    audit: auditResult(S, audit),
    seats: reveal(S),
    ledger: { claims: S.ledger.length, byStatus: S.ledger.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m }, {}) },
    notes: S.notes,
    retro,
    forTheOrchestrator:
      `${ready.state === 'ready' ? '' : `The milestone plan is ${ready.state.toUpperCase()} (final.readiness: ${[...ready.blocked, ...ready.incomplete].join('; ')}). Say so at the top of your summary, before anything else. `}` +
      (asked ? 'The user asked for the change itself, but the factory judged the work too big for one feature, so nothing in the repository changed: the milestones are the next step. Say so first, in one sentence. ' : '') +
      (S.spec.assumptions.length
        ? `Before any work began, the council assumed ${plural(S.spec.assumptions.length, 'answer')} to questions about the request that only the user can settle (spec.assumptions; report.markdown opens with them). ` +
          'The plan is built on them, so list them next, each as a question the user can answer yes or no. If one is wrong, the fix is a new run with the answer in the task or the context. '
        : '') +
      `${plural(S.seats.length, 'seat')} designed the work blind and debated the designs; ${W.L}'s design was chosen, and its author wrote the final design, merging in the best of the others, and broke it into ${plural(ms.length, 'milestone')}. ` +
      `Reviewers who never saw the debate then reviewed the plan (${listText(S.auditors.map(a => a.lens))})${audit.fixPass ? ', and the author revised it once for what they upheld' : ''}. ` +
      'You present this; you do not re-decide it, and you do not relay it unread. Read the final design yourself and spot-check its load-bearing claims about the code before repeating them. ' +
      'Then give the user, in this order: ' +
      '(1) a summary in your own words: a short paragraph on what the task was, whose design was chosen (by model) and why (report.markdown\'s "Design chosen" section), ' +
      'what the other designs proposed and what was merged from them, and what the review found and how it was settled; then the design debates as a short list, one line each on what was argued and how it was settled ' +
      '(from "The debates"; say so if there were none); ' +
      '(2) report.markdown, computed from the ledger. Keep its facts, seats and rulings as they are; you may tighten the wording; (3) scorecards.markdown; ' +
      '(4) what your spot-check found, including anything you disagree with; ' +
      `(5) the milestones (milestones[]) as a short numbered list: each one's title, tier, the milestones it builds on, and what works once it lands${retro && retro.markdown ? '; (6) last, retro.markdown as it is: notes on the workflow, not the user\'s project, so don\'t act on them unless the user asks' : ''}. ` +
      'Then offer to build the milestones one at a time, in order. Don\'t start one unasked, and don\'t chain them: the user decides after each. ' +
      (S.host === 'codex' ? 'For each, write milestones[i].args to an args file and launch the runner. ' : 'For each: Workflow({name: "factory", args: milestones[i].args}). ') +
      'Those args hold the milestone\'s task with its draft criteria and any review findings still open against it, the final design as its plan document, and the tier the plan gave it, confirmed. ' +
      'If the user settles an open finding or question first, put the answer in the task. ' +
      'Each run starts from HEAD and stops on a dirty tree, so present each result as usual and wait for the user to commit it before the next milestone starts. ' +
      `Keep this run's directory until the milestones are done, since each milestone run reads the design from ${design}: \`${S.cli} cleanup --run-dir ${S.run.runDir}\` (without --all) removes the worktrees and keeps the room. ` +
      'Run `git status` in the main tree to confirm no seat touched it. ' +
      `Codex and Gemini token usage: \`${S.cli} usage --run-dir ${S.run.runDir}\`.`,
  }
}
