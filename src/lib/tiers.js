// The factory's tiers: which one a run starts at, how a run hands the work up, and the facts each
// run records so the router can be tuned. Pure, like the rest of lib/. Each tier's own rules are in
// tier-simple.js, tier-feature.js and tier-architecture.js.
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
    ...(tierProfile(S).architecture ? { milestones: (S.milestones || []).length } : {}),
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

// The opening of the report of a run a lower tier handed up.
function escalatedSection(S) {
  return escalationChain(S.factory && S.factory.escalation).map(e => e.from === 'feature'
    ? `### Escalated from Feature\n\nThe factory first planned this as one feature and handed it to the ${e.to} tier, before building anything, because ${e.why}. ` +
      `The designs below started fresh: blind, without that plan. The Feature attempt is in ${e.runDir}.\n\n`
    : `### Escalated from Simple\n\nThe factory first tried this as a simple change (one implementer, one reviewer) and handed it to the ${e.to} tier because ${e.why}. ` +
      `The council below started fresh: blind, without that attempt's change. The Simple attempt is in ${e.runDir}.\n\n`).join('')
}

// The user pinned a tier that intake would not pick: stop before anything is created, and ask.
function needsTier(S, push, intake) {
  return {
    status: 'needs-tier', task: S.task, asked: push.asked, recommended: push.recommended,
    reasons: intake.reasons || '', signals: intake.signals || null, notes: S.notes,
    forTheOrchestrator:
      `The factory stopped before ${S.factory?.brief ? 'tier work' : 'creating anything'}: the user asked for the ${push.asked} tier, and intake recommends ${push.recommended} (${oneLine(intake.reasons, 400) || 'no reason given'}). ` +
      `Ask the user in one short message whether to keep ${push.asked} or switch to ${push.recommended}, with intake's reason. ` +
      (S.host === 'codex'
        ? `Rerun the runner with the original args file and tierConfirmed: true to keep it, or tier: "${push.recommended}" to switch. This starts a new run. `
        : `To keep it: Workflow({name: "dark-factory:factory", resumeFromRunId: <this run's id>, args: <exactly the args you launched with, as an object>, plus tierConfirmed: true}). ` +
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
      `The factory stopped before ${S.factory?.brief ? 'tier work' : 'creating anything'}: intake found ${items.length} separate pieces of work in this task (${oneLine(intake.reasons, 400) || 'no reason given'}). ` +
      'One run would debate and review them all together, at the cost of the hardest piece. ' +
      `Show the user the pieces (items[]: title, estimated tier, and the earlier pieces each builds on) and ask in one short message: run them one at a time (recommended), or the whole task as one ${pinned || tier} run. ` +
      (S.host === 'codex'
        ? 'One at a time: rerun the runner for each piece in order, preserving the original args and replacing task with that piece\'s task, so plan, context and the rest carry over. '
        : 'One at a time: for each piece in order, Workflow({name: "dark-factory:factory", args: <the args you launched with>, with task replaced by the piece\'s task}), so plan, context and the rest carry over. ') +
      'Each run starts from HEAD and stops on a dirty tree, so present each result as usual and wait for the user to commit it before the next piece starts. ' +
      `Don't pin the estimated tiers: each run's intake picks its own${pinned ? `. The user pinned ${pinned} for the whole task; ask whether it applies to each piece` : ''}. ` +
      (S.host === 'codex'
        ? 'As one: rerun the runner with the original args and noSplit: true. This starts a new run.'
        : 'As one: Workflow({name: "dark-factory:factory", resumeFromRunId: <this run\'s id>, args: <exactly the args you launched with, as an object>, plus noSplit: true}). Intake replays from cache.'),
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

// The delivery record every Factory implement result carries (Simple, routed, handed up), which
// Run-plan reads before it commits: the snapshot's tree as the final author's measurement left it,
// and 'pending' only when there is a snapshot and a measured tree to deliver. A result that has its
// own record, or no snapshot, gets nothing.
function deliveryFields(S, res) {
  if (!res || res.delivery || res.mode !== 'implement' || !res.final || !res.final.snapshotRef) return {}
  const tree = res.final.snapshotTree || S.pos[res.final.author]?.tree?.hash || null
  return { final: { ...res.final, snapshotTree: tree },
    delivery: { status: tree ? 'pending' : 'not-ready', record: `${res.runDir}/delivery.json` } }
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
    ...res, ...deliveryFields(S, res), escalated: true,
    factory: { tier: e.to, startedAt: chain[0].from, chosenBy: f.chosenBy, asked: f.asked, recommended: f.recommended,
      escalation: { from: e.from, to: e.to, trigger: e.trigger, why: e.why, runDir: e.runDir, ...(chain.length > 1 ? { earlier: chain.slice(0, -1).map(x => ({ from: x.from, to: x.to, trigger: x.trigger, why: x.why, runDir: x.runDir })) } : {}) } },
    report: res.report ? { ...res.report, markdown: `${escalatedSection(S)}${res.report.markdown}` } : res.report,
    forTheOrchestrator: `This run started as ${as[chain[0].from] || chain[0].from} and the factory handed it ${chain.map(x => `to the ${x.to} tier because ${x.why}`).join(', then ')}. Say so first, in one sentence. ` +
      chain.map(x => `The ${capital(x.from)} attempt is in ${x.runDir}; clean it up with \`${S.cli} cleanup --run-dir ${shp(x.runDir)} --all\` when the user is done. `).join('') + (res.forTheOrchestrator || ''),
  }
}

// A council, Feature or Architecture run the factory routed to directly: its result, with how the
// tier was chosen. One that was handed up on the way already says how it got there.
function routedResult(S, res) {
  if (!res || typeof res !== 'object' || res.escalated) return res
  const f = S.factory
  return { ...res,
    ...deliveryFields(S, res),
    factory: { tier: f.tier, chosenBy: f.chosenBy, asked: f.asked, recommended: f.recommended, reasons: f.intake ? f.intake.reasons : '' },
    forTheOrchestrator: `The factory ran this at the ${f.tier} tier (${f.chosenBy === 'intake' ? 'intake\'s choice' : f.chosenBy === 'pinned' ? 'the user\'s choice, which intake agreed with' : `the user's choice, over intake's ${f.recommended}`}); mention it in a few words. ${res.forTheOrchestrator || ''}` }
}

// The input before intake deliberately excludes pins, budgets and clarification answers:
// resuming a stop must replay the very same shaper and challenger requests.
function briefInputs(S) {
  return `Original task: ${S.task}
Context: ${S.context || '(none)'}
Documents: ${JSON.stringify(S.plan)}
Explicit constraints: ${JSON.stringify({ mode: S.raw.mode, criteria: S.raw.criteria, verify: S.raw.verify })}
Inspect the repository${S.raw.repo ? ' at ' + S.raw.repo : ''} and the documents relevant to this request. Read only, apart from saving the requested brief. Preserve the user's wording and decisions. If a required document cannot be found, name it in planMissing where provided. Include "testing", "implementation" and "internal design" in delegated. Keep the brief short.`
}

function goalBriefBlock(S, full = false) {
  const doc = S.factory?.brief
  if (!doc) return ''
  const b = doc.brief
  const lines = [`Outcome: ${b.outcome}`, `Purpose: ${b.purpose}`]
  if (full) lines.push(`Scope: ${b.scope}`, `Non-goals: ${b.nonGoals}`, 'Acceptance examples:', ...b.acceptanceExamples.map(e => '- ' + e),
    `Verification: ${b.verification}`, `Delegated decisions: ${b.delegated.join(', ')}.`,
    ...doc.decisions.map(d => `User decision ${d.id} (${d.question}): ${d.answer}`))
  return '\n# Goal brief\n\n' + lines.join('\n') + '\n'
}

// The generated brief snapshot is additional to the user's plan documents.
function planReferenceCount(S) {
  return S.factory?.briefFile ? S.refs.filter(r => r.source !== S.factory.briefFile).length : S.refs.length
}

function withGoalBrief(S, result) {
  if (!S.factory?.brief) return result
  const snapshot = S.refs.find(r => r.source === S.factory.briefFile)
  const briefFile = snapshot?.path || S.factory.briefFile
  const entry = goalBriefBlock(S, true).replace('\n# Goal brief\n\n', '').trimEnd() + '\nBrief file: ' + briefFile
  let markdown = result.report?.markdown || ''
  const heading = /^(?:### )?How the run went:?$/m
  markdown = heading.test(markdown) ? markdown.replace(heading, title => title + '\n\n' + entry) :
    '### How the run went\n\n' + entry + (markdown ? '\n\n' + markdown : '')
  return { ...result, brief: S.factory.brief, briefFile, report: { ...result.report, markdown } }
}
