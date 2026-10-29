// The text the run hands back: the report, the retro payload and prompt, and the early-stop
// results. Pure functions of the state.

const MAX_DEBATES = 10

function who(S, L) {
  const s = seat(S, L), a = auditor(S, L)
  return s ? `${L} (${s.name})` : a ? `the ${a.lens} auditor (${a.name})` : String(L)
}

// A debate is a finding one seat filed against another's position during the rounds, or a claim
// another seat disputed. (Objections at ratification and the audit's findings are reported in their
// own sections.) Most
// severe first (a disputed verification or test counts as major), then the contested ones, then
// those involving the chosen position; ties keep the order they were raised in.
function debates(S, chosen) {
  const rows = []
  S.ledger.forEach((c, i) => {
    if (typeof c.round !== 'number') return
    const disputes = uniqueBy(S.challenges.filter(x => x.claim === c.id), x => x.by)
    if (c.kind !== 'finding' && !disputes.length) return
    const severity = c.kind === 'finding' ? W8[c.severity] || 1 : loadBearing(c) ? 2 : 1
    const contested = disputes.length > 0 || c.ruledBy.startsWith('panel')
    const weight = 100 * severity + (contested ? 10 : 0) + (chosen && (c.target === chosen || c.author === chosen) ? 1 : 0)
    rows.push({ c, disputes, weight, i })
  })
  return rows.sort((a, b) => (b.weight - a.weight) || (a.i - b.i))
}

function rulingText(c) {
  if (c.withdrawn) return 'withdrawn by its author'
  if (c.status === 'judgment') return 'a judgment call: argued, not adjudicated'
  const panel = c.ruledBy.startsWith('panel')
  const by = panel ? 'the two-vendor panel' : 'the neutral checker'
  const note = c.note ? `: ${oneLine(c.note, 240)}` : ''
  switch (c.status) {
    case 'verified':   return `${c.kind === 'finding' ? 'upheld' : 'verified'} by ${by}${note}`
    case 'refuted':    return `refuted by ${by}${note}`
    case 'fabricated': return `ruled fabricated by ${by}${note}`
    case 'unresolved': return `${panel ? 'the panel split, so it stays unresolved' : 'the checker could not settle it'}${note}`
    default:           return 'not ruled on'
  }
}

function debateEntry(S, d, W) {
  const c = d.c
  const out = []
  if (c.kind === 'finding') {
    out.push(`- **[${c.id}] ${who(S, c.author)} against ${who(S, c.target)}, ${c.judgment ? `judgment (${c.severity})` : c.severity}, ` +
      `${c.round === 'F' ? 'objection to the final version' : `round ${c.round}`}.** ${oneLine(c.statement, 280)}`)
    for (const x of d.disputes) out.push(`  - ${who(S, x.by)} disputed it: ${oneLine(x.reason, 220) || '(no reason given)'}`)
  } else {
    out.push(`- **[${c.id}] ${d.disputes.map(x => who(S, x.by)).join(' and ')} disputed ${who(S, c.author)}'s ` +
      `${c.kind === 'test' ? 'test' : `${c.kind} claim`}, round ${d.disputes[0].round}.** ${oneLine(c.statement, 220)}`)
    for (const x of d.disputes) out.push(`  - ${who(S, x.by)}: ${oneLine(x.reason, 220) || '(no reason given)'}`)
  }
  out.push(`  - Ruling: ${rulingText(c)}`)
  const after = []
  if (c.conceded) after.push(`${c.target} conceded it${c.concededIn !== undefined ? ` ${atRound(c.concededIn)}` : ''}`)
  if (c.fixed) after.push(`fixed${c.fixedIn !== undefined ? ` ${atRound(c.fixedIn)}` : ''}`)
  if (W && isStanding(S, c) && c.target === W) after.push('still stands against the final version')
  if (after.length) out.push(`  - Outcome: ${after.join('; ')}`)
  return out.join('\n')
}

function debateSection(S, W) {
  const all = debates(S, W)
  if (!all.length) return '- No findings were filed and no claims were disputed.'
  const shown = all.slice(0, MAX_DEBATES)
  const rest = all.slice(MAX_DEBATES)
  const lines = shown.map(d => debateEntry(S, d, W))
  if (rest.length) {
    const minor = rest.filter(d => d.c.kind === 'finding' && d.c.severity === 'minor').length
    lines.push(`- … and ${plural(rest.length, 'smaller point')} not listed${minor ? ` (${minor} of them minor findings)` : ''}; the full ledger is in the room.`)
  }
  return lines.join('\n')
}

function rowEvidence(S, r) {
  const bits = []
  if (r.gated) bits.push(`disqualified: ${r.gateReasons.join('; ')}`)
  bits.push(`standing findings ${r.blockers} blocker / ${r.majors} major / ${r.minors} minor`)
  if (S.mode === 'implement' && !S.build) bits.push(`published tests ${r.crossTotal ? `${r.crossPass}/${r.crossTotal}` : 'none'}`)
  bits.push(`criteria ${r.criteriaScore}/${r.criteriaTotal}`)
  return bits.join(' · ')
}

function positionsSection(S, rows, W) {
  const lastV = lastVoteRound(S)
  const votes = lastV === null ? {} : S.votes[lastV]
  return S.seats.map(s => {
    const p = S.pos[s.L]
    if (!p) return `- **${who(S, s.L)}**: failed in round 0 and was dropped.`
    const d = droppedInfo(S, s.L)
    const rank = rows.findIndex(r => r.seat === s.L) + 1
    const fate = !s.active ? 'dropped after a failed turn'
      : s.L === W ? 'chosen'
      : d ? `left contention after round ${d.afterRound} (ranked ${d.rank} of ${d.of}) and reviewed from then on`
      : `ranked ${rank} of ${rows.length} on the scorecard`
    const v = votes[s.L] && s.L !== W ? `; last voted for ${votes[s.L].ship}` : ''
    const moved = s.L !== W && p.summary && p.summary !== p.opening ? ` Ended at: ${sentence(oneLine(p.summary, 240))}` : ''
    return `- **${who(S, s.L)}**, ${fate}${v}. Opened with: ${sentence(oneLine(p.opening, 240))}${moved}`
  }).join('\n')
}

function roundsSection(S, upto, ending) {
  const lines = []
  const r0 = S.ledger.filter(c => c.round === 0 && (c.kind === 'fact' || c.kind === 'verification') && c.status !== 'open')
  const failed = S.seats.filter(s => !S.pos[s.L])
  lines.push(`- **Round 0, blind:** ${S.seats.length} seats worked alone${failed.length ? ` (${failed.map(s => s.L).join(', ')} failed and ${failed.length === 1 ? 'was' : 'were'} dropped)` : ''}. ` +
    `Checkers ruled on ${plural(r0.length, 'claim')}: ${r0.filter(c => c.status === 'verified').length} verified, ${r0.filter(isBad).length} refuted or fabricated.` +
    (ending && ending.round === 0 ? ` Then ${ending.text}.` : ''))
  for (let k = 1; k <= upto; k++) {
    const bits = []
    const filed = S.ledger.filter(c => c.round === k && c.kind === 'finding')
    if (filed.length) {
      bits.push(`${plural(filed.length, 'finding')} filed (${filed.filter(c => c.status === 'verified').length} upheld, ` +
        `${filed.filter(isBad).length} refuted, ${filed.filter(c => c.judgment).length} judgment)`)
    }
    const disputed = S.challenges.filter(x => x.round === k).length
    if (disputed) bits.push(`${plural(disputed, 'claim')} disputed`)
    const revised = S.seats.map(s => ({ L: s.L, t: S.behaviour[s.L].turns.find(t => t.round === k) })).filter(x => x.t && x.t.changed)
    if (revised.length) bits.push(`revised: ${revised.map(x => `${x.L} (${oneLine(x.t.note, 160) || 'no note'})`).join('; ')}`)
    const adopted = S.adoptions.filter(a => a.round === k)
    if (adopted.length) bits.push(`adopted: ${adopted.map(a => `${a.by} took ${a.from}'s idea (${oneLine(a.idea, 120)})`).join('; ')}`)
    const v = Object.entries(S.votes[k] || {})
    bits.push(`votes ${v.map(([by, x]) => `${by}→${x.ship}`).join(', ') || 'none counted'}`)
    const bv = Object.entries(S.ballots[k] || {})
    if (bv.length) bits.push(`ballot after the checks ${bv.map(([by, x]) => `${by}→${x.ship}`).join(', ')}`)
    const drops = S.dropped.filter(d => d.afterRound === k)
    if (ending && ending.round === k) bits.push(ending.text)
    else if (drops.length) bits.push(`no consensus, so the field narrowed: ${drops.map(d => `${d.seat} (ranked ${d.rank} of ${d.of})`).join(', ')} left contention`)
    else bits.push('no consensus')
    lines.push(`- **Round ${k}:** ${bits.map(capital).join('. ')}.`)
  }
  return lines.join('\n')
}

function problemsSection(S) {
  if (!S.notes.length) return ''
  return `\n\n### Problems during the run\n\n${S.notes.slice(0, 12).map(n => `- ${oneLine(n, 300)}`).join('\n')}` +
    (S.notes.length > 12 ? `\n- … ${S.notes.length - 12} more in \`notes\`` : '')
}

// How an audit finding or test ended, in a few words.
function auditOutcome(S, c, W, audit) {
  const declined = S.declined.find(d => d.round === 'I' && idOf(d.ref) === c.id)
  const taken = (audit.addressed || []).find(d => idOf(d.ref) === c.id)
  const bits = []
  if (c.kind === 'test') {
    const before = audit.testsAtAudit[c.id], now = (S.testResults[c.id] || {})[W]
    bits.push(c.status === 'open' ? 'not ruled on' : c.status === 'verified' ? 'a valid test' : rulingText(c))
    if (before) bits.push(`${before} on the audited version${audit.fixPass && now ? `, ${now} after the fix` : ''}`)
  } else if (c.judgment) {
    bits.push(c.ruledBy.startsWith('panel') ? `the panel split, so it stays a judgment call: ${oneLine(c.note, 200)}` : 'a suggestion to the author, not adjudicated')
    if (taken) bits.push(`taken: ${oneLine(taken.how, 160)}`)
  } else if (c.status === 'open') {
    bits.push(c.round === 'J' ? 'not adjudicated (minor, raised after the last fix)' : 'not ruled on')
  } else {
    bits.push(rulingText(c))
    if (c.fixed) bits.push(S.tier === 'architecture' ? 'fixed in the revision' : 'fixed in the audit fix pass')
    else if (isStanding(S, c)) bits.push('still stands against the final version')
  }
  if (declined) bits.push(`declined by the author: ${oneLine(declined.why, 200) || 'no reason given'}`)
  return bits.join('; ')
}

// `audit`: what runAudit returns.
function auditSection(S, W, audit) {
  if (!audit || !audit.ran) return ''
  const simple = S.tier === 'simple', arch = S.tier === 'architecture'
  const lines = [simple ? `A reviewer from another vendor, ${S.auditors.map(a => a.name).join(', ')}, read the change without seeing how it was made.`
    : arch ? `Reviewers who never saw the debate reviewed the milestone plan, each through one lens: ${listText(S.auditors.map(a => `${a.lens} (${a.name})`))}.`
    : `Auditors who never saw the debate reviewed the final ${S.build ? 'change' : 'version'}, each through one lens: ${listText(S.auditors.map(a => `${a.lens} (${a.name})`))}.`, '']
  for (const a of S.auditors) {
    const r = audit.reviews[a.lens]
    lines.push(`- **${capital(a.lens)}, ${a.name}:** ${r ? sentence(oneLine(r.summary, 500)) || '(no summary)' : 'returned no review.'}`)
    for (const p of r ? r.probes : []) lines.push(`  - Probe: ${oneLine(p.change, 160)} → ${p.verdict}: ${oneLine(p.touches, 200)}`)
    const items = S.ledger.filter(c => c.author === a.id && c.round === 'H')
    for (const c of items) {
      lines.push(`  - [${c.id}] ${c.kind === 'test' ? 'test' : `${c.severity}${c.judgment || c.status === 'judgment' ? ', judgment' : ''}${c.milestone ? `, milestone ${c.milestone}` : ''}`}: ${oneLine(c.statement, 240)} → ${auditOutcome(S, c, W.L, audit)}`)
    }
    if (r && !items.length) lines.push('  - No findings.')
  }
  const pass = simple ? 'Fix pass' : arch ? 'Revision' : 'Audit fix pass'
  lines.push(audit.fixPass
    ? `- **${pass}:** ${W.L} ${arch ? 'revised the plan for what was upheld, and it was checked again' : 'fixed what was upheld or failing, and the final version was checked again'}.`
    : `- **${pass}:** not needed: nothing was upheld, disputed or failing.`)
  if (audit.fixPass && !simple) {
    const late = S.ledger.filter(c => c.round === 'J')
    const looked = Object.keys(audit.rereviews || {})
    const what = arch ? 'the revision' : 'the fix'
    lines.push(!looked.length ? `- **Re-review of ${what}:** none (${arch ? 'no reviewer returned' : 'the fix changed no code, or no auditor returned'}).`
      : late.length ? `- **Re-review of ${what}** (${looked.join(', ')}):\n${late.map(c => `  - [${c.id}] ${c.severity}: ${oneLine(c.statement, 240)} → ${auditOutcome(S, c, W.L, audit)}`).join('\n')}`
      : `- **Re-review of ${what}** (${looked.join(', ')}): nothing new.`)
  }
  return `\n\n### ${simple ? 'Review' : arch ? 'Independent review' : 'Independent audit'}\n\n${lines.join('\n')}`
}

// The finished run. `o`: {outcome, W, rows, endorsements, raters, reviewNotes, objections, fixPass, dissent, remaining, unanswered, ready, audit}
// The spec review's assumptions open the report: the result is built on them, and only the user
// can say whether they are right.
function assumptionsSection(S) {
  if (!S.spec.assumptions.length) return ''
  return `### Assumptions to check\n\nThe request left ${S.spec.assumptions.length === 1 ? 'this question' : 'these questions'} open. Before any work began, the council chose ` +
    `the most conservative reading, and the acceptance criteria, so the result, follow it. Check ${S.spec.assumptions.length === 1 ? 'it' : 'them'} first.\n\n` +
    S.spec.assumptions.map(a => `- **[${a.id}]** ${sentence(oneLine(a.question, 300))} Assumed: ${sentence(oneLine(a.chosen, 300))}` +
      `${a.alternative ? ` The alternative: ${sentence(oneLine(a.alternative, 200))}` : ''}${a.impact ? ` Under it: ${sentence(oneLine(a.impact, 200))}` : ''}`).join('\n') + '\n\n'
}

function specOutcome(S, f) {
  const applied = S.spec.applied.find(a => a.id === f.id)
  const answer = S.clarifications.find(c => c.id === f.id)
  const assumed = S.spec.assumptions.find(a => a.id === f.id)
  const ruled = {
    accepted: 'accepted by the panel',
    rejected: `rejected by the panel (${oneLine(f.note, 200)})`,
    decision: answer ? `a question for the user, who answered "${oneLine(answer.answer, 200)}"` : assumed ? `a question for the user; assumed: ${oneLine(assumed.chosen, 200)}` : 'a question for the user, left open',
    disputed: 'the panel split, so the criteria were left as they were',
    unruled: 'not ruled on',
    open: 'not ruled on',
  }[f.status]
  return `${ruled}${applied && applied.change ? `; amended: ${oneLine(applied.change, 200)}` : ''}`
}

function specSection(S) {
  if (!S.spec.ran) return ''
  const lines = S.specReviewers.map(r => `- **${capital(r.lens)}, ${r.name}:** ${S.spec.reviews[r.lens] ? oneLine(S.spec.reviews[r.lens].summary, 400) || '(no summary)' : 'returned no review.'}`)
  lines.push(`- **Findings:**${S.spec.findings.length ? '' : ' none.'}`)
  for (const f of S.spec.findings) {
    lines.push(`  - [${f.id}] ${f.lens}, ${f.severity}${f.criterion ? `, ${f.criterion}` : ''}: ${oneLine(f.statement, 200)} → ${specOutcome(S, f)}`)
  }
  const b = S.spec.before
  lines.push(`- **Criteria:** ${b ? `amended before work began: ${S.criteria.map(c => c.id).join(', ')} (setup wrote ${b.criteria.map(c => c.id).join(', ')})` +
    `${b.verify !== S.verify ? `; verification command now \`${S.verify || '(none)'}\`` : ''}` : 'as setup wrote them'}.`)
  return `\n\n### Specification review\n\n${lines.join('\n')}`
}

function specFacts(S) {
  const f = S.spec.findings
  return `${S.specReviewers.map(r => `${r.lens} by ${r.name}${S.spec.reviews[r.lens] ? '' : ' (no review)'}`).join(', ')}; ` +
    `${plural(f.length, 'finding')}${f.length ? ` (${countsOf(f, x => `${x.severity} ${x.status}`)})` : ''}; ` +
    `criteria ${S.spec.before ? 'amended' : 'unchanged'}${S.spec.assumptions.length ? `; assumed ${S.spec.assumptions.map(a => a.id).join(', ')}` : ''}` +
    `${S.spec.answered.length ? `; the user answered ${S.spec.answered.join(', ')}` : ''}`
}

// spec: 'ask' stops here, before any seat starts, on the questions only the user can answer.
function specQuestions(S, qs) {
  return {
    status: 'needs-user', mode: S.mode, task: S.task, round: 'spec', runDir: S.run.runDir, room: S.run.room,
    questions: qs.map(f => ({ id: f.id, question: f.statement, readings: f.readings, raisedBy: `the ${f.lens} reviewer`, evidence: f.evidence, adjudicators: f.note })),
    criteria: S.criteria, notes: S.notes,
    forTheOrchestrator:
      `Before any seat started, the spec review found ${qs.length === 1 ? 'a question' : 'questions'} about the request that the code and the task don't settle, ` +
      'and this run was told to ask rather than assume (spec: "ask"). Ask the user (AskUserQuestion works well: offer each question\'s readings as options; the first is the most conservative). ' +
      `Then resume the same run: Workflow({name: "${S.workflowName}", resumeFromRunId: <this run's id>, args: <exactly the args you launched with, as an object; ` +
      'if you passed a plain string, use {task: <that string>}>, plus clarifications: [<any earlier clarifications, unchanged>, {id, answer}, …]}). ' +
      'The review replays from cache, the criteria are amended to the answers, and the council starts. Workspaces persist on disk, so this works only from this session.',
  }
}

// Why the debate chose W, and how its last round ended: the opening of the council's report, and
// of the Feature tier's, whose positions are plans.
function chosenWhy(S, outcome, W, rows) {
  const row = rows.find(r => r.seat === W.L)
  const rank = rows.indexOf(row) + 1

  const why = []
  const votes = Object.entries(((outcome.ballot ? S.ballots : S.votes)[outcome.round]) || {})
  const where = outcome.ballot ? `in the ballot after round ${outcome.round}` : `in round ${outcome.round}`
  const needs = `consensus needs ${consensusAt(S)} of ${active(S).length} seats${crossVendor(S) ? `, from ${crossVendorText(S)}` : ''}`
  if (outcome.kind === 'consensus' && outcome.via === 'approval') {
    why.push(`- Converged ${where} by approval, an experiment turned on for this run: ${outcome.first.map(L => who(S, L)).join(', ')} voted for it first, and ` +
      `${outcome.voters.filter(L => !outcome.first.includes(L)).map(L => who(S, L)).join(', ')} also accepted it (${needs}).`)
  } else if (outcome.kind === 'consensus' && outcome.via === 'blind') {
    why.push(`- Converged in round 0, before any debate: ${outcome.same.map(L => who(S, L)).join(', ')} wrote byte-identical versions independently, ` +
      `and the verification command passes on that version, so the debate was skipped. ${W.L} ships as the copy highest on the scorecard.`)
  } else if (outcome.kind === 'consensus' && outcome.via === 'identical') {
    why.push(`- Converged ${where} on byte-identical versions: ${outcome.same.map(L => who(S, L)).join(', ')} have the same snapshot, so the votes of ` +
      `${outcome.voters.map(L => who(S, L)).join(', ')} counted together (${needs}). ${W.L} ships as the copy with the most votes, then the highest on the scorecard.`)
  } else if (outcome.kind === 'consensus') {
    why.push(`- Converged ${where}: ${outcome.voters.map(L => who(S, L)).join(', ')} voted to ship it (${needs}).`)
  } else {
    why.push(`- No consensus after ${plural(outcome.round, 'round')}, so the evidence scorecard decided, and it ranked ${W.L} first.`)
  }
  if (votes.length) {
    why.push(`- Votes ${where}, with reasons:`)
    for (const [by, v] of votes) why.push(`  - ${who(S, by)} → ${v.ship}: ${oneLine(v.reason, 240) || '(no reason given)'}`)
  }
  if (rank === 1 && rows[1]) why.push(`- On the scorecard, ${separation(row, rows[1])}.`)
  else if (rank > 1) why.push(`- On the scorecard it ranked ${rank} of ${rows.length}: ${separation(rows[0], row)}. The seats voted for ${W.L} anyway.`)
  why.push(`- Its evidence when chosen: ${rowEvidence(S, row)}.`)

  const ending = outcome.kind === 'consensus'
    ? { round: outcome.round, text: outcome.via === 'blind' ? `every version was byte-identical, so the debate was skipped and ${W.L} wrote the final version` : `consensus on ${W.L}${outcome.via === 'approval' ? ' by approval' : outcome.via === 'identical' ? ` (identical to ${outcome.same.filter(X => X !== W.L).join(', ')})` : ''}${outcome.ballot ? ' in the ballot after the round' : ''}` }
    : { round: outcome.round, text: outcome.round < S.rounds ? 'no position or vote changed, so the debate stopped and the scorecard decided' : 'no consensus in the last round, so the scorecard decided' }
  return { why, ending, rank }
}

// The spec review and the audit as the result reports them, for the council and the Feature tier.
function specResult(S) {
  return S.spec.ran ? {
    reviewers: S.specReviewers.map(r => ({ lens: r.lens, model: r.name, reviewed: !!S.spec.reviews[r.lens], summary: (S.spec.reviews[r.lens] || {}).summary || '' })),
    findings: S.spec.findings.map(f => ({ id: f.id, lens: f.lens, severity: f.severity, kind: f.kind, criterion: f.criterion, status: f.status,
      statement: f.statement, evidence: f.evidence, readings: f.readings, note: f.note, amended: (S.spec.applied.find(a => a.id === f.id) || {}).change || '' })),
    criteria: S.criteria,
    criteriaBefore: S.spec.before ? S.spec.before.criteria : null,
    assumptions: S.spec.assumptions,
    answered: S.spec.answered,
  } : null
}

function auditResult(S, audit) {
  return audit.ran ? {
    auditors: S.auditors.map(a => ({ lens: a.lens, model: a.name, reviewed: !!audit.reviews[a.lens], summary: (audit.reviews[a.lens] || {}).summary || '', probes: (audit.reviews[a.lens] || {}).probes || [] })),
    items: S.ledger.filter(c => lensOf(c.author)).map(c => ({ id: c.id, lens: lensOf(c.author), round: roundTag(c.round), kind: c.kind, severity: c.severity, judgment: c.judgment,
      status: c.fixed ? 'fixed' : c.status, statement: c.statement, evidence: c.evidence, note: c.note })),
    fixPass: audit.fixPass,
  } : null
}

function finalReport(S, o) {
  const { outcome, W, rows } = o
  const { why, ending, rank } = chosenWhy(S, outcome, W, rows)

  const fin = []
  fin.push(`- **Readiness:** ${o.ready ? readinessText(o.ready) : 'not assessed'}`)
  fin.push(`- **Final version** by ${who(S, W.L)}: ${oneLine(S.pos[W.L].summary, 500)}`)
  const folded = S.adoptions.filter(a => a.by === W.L && (a.round === 'F' || a.round === 'G'))
  if (folded.length) fin.push(`- **Folded in from other seats:** ${folded.map(a => `${who(S, a.from)}: ${oneLine(a.idea, 160)}`).join('; ')}`)
  if (S.declined.length) fin.push(`- **Declined:** ${S.declined.map(d => `${oneLine(d.ref, 80)}: ${oneLine(d.why, 160) || 'no reason given'}`).join('; ')}`)
  fin.push(`- **Neutral check of the final version:** ${finalSummary(S, W.L)}`)
  if (!S.baselineOk) fin.push(`- **Baseline:** the verification command already failed before any change, so a failing suite didn't disqualify positions: ${S.baselineNote}`)
  const notEndorsed = o.raters.filter(s => !o.endorsements.includes(s.L))
  fin.push(`- **Ratification:** ${o.endorsements.length ? `endorsed by ${o.endorsements.map(L => who(S, L)).join(', ')}` : 'no endorsements'}` +
    (notEndorsed.length ? `; not endorsed by ${notEndorsed.map(s => {
      const r = o.reviewNotes.find(x => x.seat === s.L)
      return `${who(S, s.L)}${r && r.note ? ` (${oneLine(r.note, 200)})` : ' (no review)'}`
    }).join('; ')}` : '') + '.')
  for (const c of o.objections) {
    fin.push(`  - Objection [${c.id}] from ${who(S, c.author)}, ${c.judgment ? 'judgment' : c.severity}: ${oneLine(c.statement, 200)} → ` +
      `${c.judgment ? 'recorded as dissent' : c.fixed ? 'upheld and fixed in the fix pass' : c.status === 'open' ? 'not adjudicated (minor)' : rulingText(c)}`)
  }
  const open = []
  for (const c of o.remaining) open.push(`standing finding [${c.id}] from ${who(S, c.author)} (${c.severity}, ${c.status}): ${oneLine(c.statement, 200)}`)
  for (const d of o.dissent.filter(d => d.kind === 'judgment')) open.push(`dissent from ${who(S, d.seat)} (judgment): ${oneLine(d.note, 200)}`)
  for (const q of o.unanswered) open.push(`assumption on [${q.id}] ${oneLine(q.text, 160)}: ${Object.entries(q.assumptions).map(([L, a]) => `${L} assumed ${oneLine(a, 120)}`).join('; ')}`)
  fin.push(open.length ? `- **Still open:**\n${open.map(x => `  - ${x}`).join('\n')}` : '- **Still open:** nothing.')

  const markdown = assumptionsSection(S) + [
    `### Chosen: ${who(S, W.L)}\n\n${why.join('\n')}`,
    `### The positions\n\n${positionsSection(S, rows, W.L)}`,
    `### How the debate went\n\n${roundsSection(S, outcome.round, ending)}`,
    `### The debates\n\n${debateSection(S, W.L)}`,
    `### How it turned out\n\n${fin.join('\n')}`,
  ].join('\n\n') + specSection(S) + auditSection(S, W, o.audit) + problemsSection(S)

  return {
    chosen: { seat: W.L, model: W.name, how: outcome.kind, round: outcome.round, rank, voters: outcome.voters,
      runnerUp: rows.find(r => r.seat !== W.L) ? rows.find(r => r.seat !== W.L).seat : null },
    debates: debates(S, W.L).length,
    markdown,
  }
}

// An escalation pauses the run; the user gets the debate so far to answer the question against.
function interimReport(S, k) {
  const rows = rankPositions(S)
  return {
    markdown: [
      `### The positions so far\n\n${positionsSection(S, rows, null)}`,
      `### How the debate went\n\n${roundsSection(S, k, { round: k, text: 'a question about the request reached the escalation threshold' })}`,
      `### The debates so far\n\n${debateSection(S, null)}`,
    ].join('\n\n') + problemsSection(S),
  }
}

function retroFacts(S, o) {
  const claude = S.turnLog.filter(t => t.vendor === 'claude')
  const others = ['codex', 'gemini'].map(v => [v, S.turnLog.filter(t => t.vendor === v)]).filter(([, ts]) => ts.length)
  const failed = S.turnLog.filter(t => !t.ok).map(t => t.turn)
  const panelRuled = S.ledger.filter(c => String(c.ruledBy || '').startsWith('panel')).length
  return [
    `- Run ${S.run.runId} in ${S.run.repoRoot}, ${S.mode} mode. Task: ${oneLine(S.task, 300)}`,
    factoryFacts(S),
    `- Seats: ${S.seats.map(s => `${s.L}=${s.name} (${s.effort})${s.active ? '' : ', dropped'}`).join(', ')}. Panel: ${S.panel.map(m => m.name).join(', ')}. Checkers: ${S.checkModel}.`,
    !o.outcome ? `- Outcome: the Simple change by ${o.W.L}${o.audit && o.audit.fixPass ? ', with one fix pass' : ''}.` : S.build ? buildFacts(S, o) : S.tier === 'architecture' ? archFacts(S, o) : `- Outcome: ${o.outcome.kind === 'consensus' ? `consensus on ${o.outcome.W} in round ${o.outcome.round}${o.outcome.via === 'blind' ? `, before any debate, because ${o.outcome.same.join(', ')} were byte-identical` : o.outcome.via === 'identical' ? ` by pooling the votes for identical versions ${o.outcome.same.join(', ')}` : o.outcome.via === 'approval' ? ' by approval' : ''}` : `no consensus after ${plural(o.outcome.round, 'round')}; the scorecard picked ${o.outcome.W}`}, ` +
      `with up to ${plural(S.rounds, 'round')} allowed. Endorsed at ratification by ${o.endorsements.length ? o.endorsements.join(', ') : 'nobody'}` +
      `${o.fixPass ? '; one fix pass for upheld objections' : ''}.`,
    S.dropped.length ? `- Left contention: ${S.dropped.map(d => `${d.seat} after round ${d.afterRound}`).join(', ')}.` : '',
    `- Claude agent turns: ${claude.length} (${countsOf(claude, t => t.role)}).${others.map(([v, ts]) => ` ${VENDOR_NAME[v]} turns: ${ts.length} (${countsOf(ts, t => t.role)}).`).join('')}`,
    failed.length ? `- Turns that returned nothing: ${failed.join(', ')}.` : '',
    S.relayFailures.length ? `- Relay attempts that didn't return a result: ${S.relayFailures.map(r => `${r.turn} via ${r.model}: ${r.status}${r.errorClass ? ` [${r.errorClass}]` : ''}${r.error ? ` (${r.error})` : ''}`).join('; ')}.` : '',
    externalTimes(S),
    S.longPosts.length ? `- Posts over the ${S.postWords}-word limit: ${S.longPosts.map(p => `${p.turn} ${p.words} words`).join(', ')}.` : '',
    `- Ledger: ${plural(S.ledger.length, 'item')} (${countsOf(S.ledger, c => c.status || 'open')}), ${plural(S.challenges.length, 'challenge')}, ` +
      `${panelRuled} ruled by the panel. Questions raised: ${S.questions.length}.`,
    `- Ledger by kind: ${['fact', 'verification', 'finding', 'test'].map(kind => [kind, S.ledger.filter(c => c.kind === kind)]).filter(([, cs]) => cs.length)
      .map(([kind, cs]) => `${kind} ${cs.length} (${countsOf(cs, c => c.status)})`).join('; ')}.`,
    `- Votes by round: ${voteHistory(S) || 'none'}.`,
    S.spec.ran ? `- Spec review: ${specFacts(S)}.` : '',
    o.audit && o.audit.ran ? `- Audit: ${auditFacts(S, o.audit)}.` : '',
    o.ready ? `- Final readiness: ${readinessText(o.ready)}.` : '',
    S.baselineOk ? '' : `- The verification command failed at baseline (expected when the task is to fix a failing test): ${S.baselineNote}`,
    S.notes.length
      ? `- Problems during the run:\n${S.notes.slice(0, 30).map(n => `  - ${oneLine(n, 300)}`).join('\n')}${S.notes.length > 30 ? `\n  - … ${S.notes.length - 30} more` : ''}`
      : '- Problems during the run: none.',
  ].filter(Boolean).join('\n')
}

function auditFacts(S, audit) {
  const items = S.ledger.filter(c => lensOf(c.author))
  const f = items.filter(c => c.kind === 'finding' && c.round === 'H'), t = items.filter(c => c.kind === 'test'), late = items.filter(c => c.round === 'J')
  return `${S.auditors.map(a => `${a.lens} by ${a.name}${audit.reviews[a.lens] ? '' : ' (no review)'}`).join(', ')}; ` +
    `${plural(f.length, 'finding')}${f.length ? ` (${countsOf(f, c => `${c.severity} ${c.status}`)})` : ''}, ${plural(t.length, 'test')}${t.length ? ` (${countsOf(t, c => c.status)})` : ''}; ` +
    `${audit.fixPass ? `a fix pass, then ${plural(late.length, 're-review finding')}` : 'no fix pass'}`
}

// Who voted for what, round by round, with a ballot's votes after its round: whether votes moved,
// and when, is what the vote-timing experiments are judged on.
function voteHistory(S) {
  const rounds = Object.keys(S.votes).map(Number).filter(k => Object.keys(S.votes[k]).length).sort((a, b) => a - b)
  return rounds.map(k => {
    const line = v => Object.entries(v).map(([by, x]) => `${by}→${x.ship}${x.acceptable && x.acceptable.length ? `(+${x.acceptable.map(a => a.seat).join('')})` : ''}`).join(' ')
    return `r${k} ${line(S.votes[k])}${S.ballots[k] && Object.keys(S.ballots[k]).length ? ` · ballot b${k} ${line(S.ballots[k])}` : ''}`
  }).join('; ')
}

function externalTimes(S) {
  if (!S.vendorTimes.length) return ''
  const xs = S.vendorTimes.map(t => t.seconds).sort((a, b) => a - b)
  const median = xs[Math.floor(xs.length / 2)]
  const slow = S.vendorTimes.slice().sort((a, b) => b.seconds - a.seconds).slice(0, 3)
  return `- Codex and Gemini turn times: median ${Math.round(median)}s; slowest ${slow.map(t => `${t.turn} ${Math.round(t.seconds)}s`).join(', ')}.`
}

// `council retro` saves this byte for byte, reading it from the retro agent's own saved prompt as
// seat-run does. Trailing whitespace is dropped: the harness's re-indenting wouldn't keep it.
// A factory run adds its facts as JSON, which `council retro` also saves on their own for the tally.
function retroPayload(S, facts, data) {
  const notes = S.processNotes.length
    ? S.processNotes.map(n => `- ${n.turn} (${n.role}, ${n.who}): ${n.text}`).join('\n')
    : '- None: no turn reported anything in its way.'
  const json = data ? `\n\n## Run facts (data)\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` : ''
  return `## Process notes\n\n${notes}\n\n## Run facts\n\n${facts}${json}`.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
}

function retroPrompt(S, reportMd, payload, hash) {
  return `You are running a short retrospective on one run of ${S.factory ? `/factory, a workflow that routes a task to a tier of process (the run facts say which tier this run used and why) and runs it; its higher tiers run /council, in which several AI models solve one task independently, debate it on an evidence ledger, and converge on one result` : '/council, a workflow in which several AI models solve one task independently, debate it on an evidence ledger, and converge on one result'}. Its author is still tuning the workflow and wants to know what in its process to change. Your subject is the council's process, not the task: don't judge the solution, don't redo the work, and read the code under review only to confirm a point about the process.

# What you have
- The process notes at the end. During the run, every agent could say in a line or two what in its turn's instructions, inputs or tools got in its way. Seats are the debating models; checkers verify claims and run the tests; the panel adjudicates disputed claims; auditors review the final version afterwards without seeing the debate; relays are small agents that pass prompts to the Codex CLI or the Gemini CLI (agy); setup creates the run.
- The run facts at the end, computed by the workflow, and the run's report below.
- The run directory, ${S.run.runDir}: TASK.md; room/ holds every post, by round; jobs/ holds each Codex and Gemini turn's prompt and log. \`${S.cli} usage --run-dir ${shq(S.run.runDir)}\` prints their token use.
- The workflow's source, if a change needs it: workflows/${S.workflowName}.js (the prompts, limits and round structure) and bin/dark-factory (the CLI the agents run), both in the dark-factory plugin's directory, the parent of the bin/ that \`command -v dark-factory\` prints. Both are long, so grep for the instruction a note is about rather than reading them whole.

# What to look for
Weigh the notes; don't count them. One agent's complaint is a lead to check against the posts and facts; the same problem from several agents or turns is a pattern. Be sceptical of notes that ask for more of everything (more rounds, more context, longer posts) unless the run shows the lack cost something, and of a losing seat's complaints about how it was scored. Look past the notes too: posts that repeat each other, rounds in which nothing changed, checks that failed, relays that retried, posts far over their limit. If the run went smoothly, say so and suggest fewer changes; don't invent problems.

Return up to 3 things that worked and should be kept, and 3 to 5 changes, the most valuable first. Each change concrete enough to make (a specific prompt, limit, step or command), with why, the evidence from this run (turn labels such as r1:A, file paths, run facts) and where it would change.

# Save it
1. Write ${S.run.runDir}/retro.md in this shape:
\`\`\`markdown
# Council retro: ${S.run.runId}

<one line: the task, the mode, and how the run ended>

## What worked

- <what>: <evidence>

## Changes to make

1. **<change>** <why>. Evidence: <evidence>. Where: <where>.
\`\`\`
Don't copy the process notes or run facts into it; the next command attaches them exactly.
2. Run this with the Bash tool, exactly as written: ${S.cli} retro --run-dir ${shq(S.run.runDir)} --expect ${hash}
   The last line it prints is JSON. "ok": set saved to its "path". "sandboxed": run the same command again with the sandbox disabled (dangerouslyDisableSandbox: true). "error", or "sandboxed" again: set saved to "" and error to what it printed.

# The report

${reportMd}

# Process notes and run facts

=====BEGIN PAYLOAD ${hash}=====
${payload}
=====END PAYLOAD ${hash}=====`
}

function retroMarkdown(r) {
  const worked = (r.worked || []).filter(w => w && w.what)
  const changes = (r.changes || []).filter(c => c && c.change)
  const ev = t => oneLine(t, 300).replace(/\.$/, '')
  return [
    '### Process retro',
    'The council\'s notes on its own process, for tuning the /council workflow.',
    worked.length ? `What worked:\n\n${worked.map(w => `- ${sentence(clip(w.what, 300))}${w.evidence ? ` (${ev(w.evidence)})` : ''}`).join('\n')}` : '',
    changes.length
      ? `What to change, most valuable first:\n\n${changes.map((c, i) =>
          `${i + 1}. **${sentence(clip(c.change, 300))}** ${sentence(clip(c.why, 400))}${c.evidence ? ` Evidence: ${ev(c.evidence)}.` : ''}`).join('\n')}`
      : 'No changes suggested.',
    r.saved ? `Saved to \`${r.saved}\`, with the run's process notes and facts.` : `Not saved${r.error ? ` (${oneLine(r.error, 200)})` : ''}; the notes are in retro.notes.`,
  ].filter(Boolean).join('\n\n')
}

// How the orchestrator hands an implement-mode result to the user. A seat may have committed (when
// the task asked for commits); its snapshot keeps those commits, so they go over as commits.
function deliveryNote(S, label, W, what) {
  const ref = `refs/council/${S.run.runId}/${W.L}-${label}`
  return `Nothing has been applied to the user's tree. ${what} is ${S.run.room}/${label}/${W.L}.diff (worktree ${W.wt}; snapshot ${ref}). ` +
    `Run \`git log --oneline HEAD..${ref}\` from the repo root. If it lists only one commit, named "council …", the change is uncommitted: after the user approves, ` +
    'apply the diff with `git apply` from the repo root. Otherwise the author committed it as the task asked: after the user approves, `git cherry-pick` those commits, ' +
    'and if the top commit is named "council … uncommitted changes", show the user what it holds (often working files such as notes) rather than applying it unasked. ' +
    'Then run the project\'s gates through a fresh Sonnet subagent. '
}

// Setup (or the factory's intake) found that the task depends on a document it can't see.
function needsPlan(S, missing, runDir) {
  return {
    status: 'needs-plan', reason: `the task depends on a document the council couldn't find: ${missing || 'unspecified'}`,
    mode: S.mode, task: S.task, runDir: runDir || null, notes: S.notes,
    forTheOrchestrator:
      `The council stopped before any seat started: the task depends on a plan or document it couldn't find (${oneLine(missing, 300) || 'unspecified'}). ` +
      'Seats work in worktrees checked out from HEAD and can\'t see uncommitted files, so the document has to be passed in. Find it yourself: ' +
      'a plan made in this conversation is under ~/.claude/plans/; otherwise look in the repository for the file the user named. ' +
      `Then rerun with object args and its absolute path: Workflow({name: "${S.workflowName}", args: {task: <the task, saying which part to do>, plan: ["/abs/path"], …the other args}}). ` +
      'Don\'t paste the document into the task. If you can\'t tell which document is meant, ask the user.' +
      (runDir ? ` Remove the partial run with \`${S.cli} cleanup --run-dir ${runDir} --all\`.` : ''),
  }
}

function reveal(S) {
  return S.seats.map(s => ({ seat: s.L, model: s.name, vendor: s.vendor, effort: s.effort, active: s.active }))
}

function failure(S, status, reason, extra) {
  return { status, reason, mode: S.mode, task: S.task, runDir: S.run ? S.run.runDir : null, notes: S.notes, ...(extra || {}),
    forTheOrchestrator: `The council stopped early (${status}): ${reason}. Tell the user plainly; nothing was applied to their tree.` +
      (S.run ? ` Clean up with \`${S.cli} cleanup --run-dir ${S.run.runDir} --all\` unless they want to inspect it.` : '') }
}

// A vendor CLI that can't run would cost its seat every turn after round 0 (a Gemini seat once sat
// out three of four phases). Stop before anything starts and say how to fix it or swap the seat.
function preflightStop(S, bad) {
  const lines = bad.map(p => `${p.vendor}: ${oneLine(p.error, 300) || 'failed'}`)
  const used = bad.map(p => p.vendor)
  const seats = S.lineup.filter(s => used.includes(s.vendor)).map(s => s.key)
  const panel = S.panel.filter(m => used.includes(m.vendor)).map(m => m.key)
  // The factory's auditors are named too: the Architecture tier's risk reviewer is Gemini by default.
  const lenses = S.tier ? S.auditors.filter(a => used.includes(a.vendor)).map(a => a.lens) : []
  return {
    status: 'blocked', reason: `a vendor CLI can't run from this session (${lines.join('; ')})`, mode: S.mode, task: S.task, runDir: null,
    preflight: bad, notes: S.notes,
    forTheOrchestrator:
      `The council stopped before creating anything: the preflight check found that ${lines.join('; ')}. Tell the user plainly, and offer the fix that fits: ` +
      `if the error says the command ran inside a sandbox, the user adds "Bash(${S.cli}:*)" to permissions.allow in ~/.claude/settings.json (or approves running it outside the sandbox when asked); ` +
      'if a CLI is missing or its settings are wrong, they install or fix it as the error says. ' +
      `Or rerun without that vendor: swap ${seats.length ? `the seat(s) ${seats.join(', ')}` : 'nothing in the lineup'}${panel.length ? ` and the panel member(s) ${panel.join(', ')} (args.panel, e.g. ["opus", "sonnet"])` : ''}${lenses.length ? ` and the auditor(s) ${lenses.join(', ')} (args.audit, e.g. {${lenses[0]}: "sonnet"})` : ''} ` +
      'for models from vendors that work, e.g. args.seats ["opus", "sonnet", "astra", "sol"] when Gemini is the problem.',
  }
}

function needsUser(S, k, qs) {
  return {
    status: 'needs-user', mode: S.mode, task: S.task, round: k, runDir: S.run.runDir, room: S.run.room,
    questions: qs.map(q => ({ id: q.id, question: q.text, raisedBy: q.raisedBy, secondedBy: q.seconds, assumptions: q.assumptions })),
    positionsSoFar: active(S).map(s => ({ seat: s.L, summary: S.pos[s.L].summary, post: S.pos[s.L].post })),
    report: interimReport(S, k),
    seats: reveal(S), notes: S.notes,
    forTheOrchestrator:
      `${qs.length === 1 ? 'A question' : 'Questions'} reached the escalation threshold (${escalateAt(S)} seats) after ${roundTag(k)}: ` +
      'the council believes the request itself is ambiguous. First show the user report.markdown, the debate so far, with the seat-to-model reveal, so they can see what prompted the question. ' +
      'Then ask (AskUserQuestion works well; show each seat\'s assumption as an option). ' +
      `Then resume the same run: Workflow({name: "${S.workflowName}", resumeFromRunId: <this run's id>, args: <exactly the args you launched with, as an object; ` +
      `if you passed a plain string, use {task: <that string>}>, plus clarifications: [<any earlier clarifications, unchanged>, {id, answer, afterRound: ${k}}, …]}). ` +
      'Completed rounds replay from cache; the debate continues with the answers. Workspaces and Codex and Gemini threads persist on disk, so this works only from this session.',
  }
}
