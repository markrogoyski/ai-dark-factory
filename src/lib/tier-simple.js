// The Simple tier's rules: when it hands the work up, and its report and result. Pure, like the
// rest of lib/; the flow is src/simple.js, and the rules every tier shares are in tiers.js.

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

// A Simple run's report.
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
      storySection(S) + auditSection(S, W, audit) + problemsSection(S),
  }
}

// A Simple run that finished without handing the work up.
function simpleResult(S, o) {
  const { W, ready, audit, report, retro } = o
  const tag = audit.finalTag || (audit.fixPass ? roundTag('I') : S.auditedTag)
  const f = S.factory
  const res = {
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
      `When the user is done, \`${S.cli} cleanup --run-dir ${shp(S.run.runDir)}\` removes the worktree and keeps the transcript; add --all to delete everything.`,
  }
  return { ...res, ...deliveryFields(S, res) }
}
