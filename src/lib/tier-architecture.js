// The Architecture tier's rules: its milestones (and each one's run args), report, facts and
// result. Pure, like the rest of lib/; the flow is src/architecture.js, and the rules every tier
// shares are in tiers.js.

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
      (S.host === 'codex' ? 'For each, write milestones[i].args to an args file and launch the runner. ' : 'For each: Workflow({name: "dark-factory:factory", args: milestones[i].args}). ') +
      'Those args hold the milestone\'s task with its draft criteria and any review findings still open against it, the final design as its plan document, and the tier the plan gave it, confirmed. ' +
      'If the user settles an open finding or question first, put the answer in the task. ' +
      'Each run starts from HEAD and stops on a dirty tree, so present each result as usual and wait for the user to commit it before the next milestone starts. ' +
      `Keep this run's directory until the milestones are done, since each milestone run reads the design from ${design}: \`${S.cli} cleanup --run-dir ${shp(S.run.runDir)}\` (without --all) removes the worktrees and keeps the room. ` +
      'Run `git status` in the main tree to confirm no seat touched it. ' +
      `Token use of every model, the workflow's own Claude agents included: \`${S.cli} usage --run-dir ${shp(S.run.runDir)}\`.`,
  }
}
