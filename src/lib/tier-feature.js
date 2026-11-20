// The Feature tier's rules: its increments, when it hands the work up, and its report, facts and
// result. Pure, like the rest of lib/; the flow is src/feature.js, and the rules every tier shares
// are in tiers.js.

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
      `The room (${S.run.room}) holds the full transcript. When the user is done with it, \`${S.cli} cleanup --run-dir ${shp(S.run.runDir)}\` ` +
      'removes the worktrees and snapshot refs and keeps the transcript; add --all to delete everything. ' +
      `Codex and Gemini token usage: \`${S.cli} usage --run-dir ${shp(S.run.runDir)}\`.`,
  }
}
