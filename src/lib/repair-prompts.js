function repairReviewPrompt(S, a, W, round, tag, checkout) {
  const arch = S.tier === 'architecture'
  const findings = S.ledger.filter(c => c.kind === 'finding' && lensOf(c.author) && c.target === W.L && !c.withdrawn)
  const alternatives = arch && a.lens === 'risk' ? active(S).filter(s => s.L !== W.L).map(s => S.pos[s.L].post) : []
  return `Independently review the exact ${arch ? 'design and milestone plan' : 'measured implementation'} below. You have a fresh context. Do not read the debate or author sessions.
${taskBlock(S, round)}
Artifact: ${S.pos[W.L].post}
${arch ? `Repository: ${S.run.repoRoot}. Read only. The plan must be grounded, sequenced and feasible.` : `Snapshot: refs/council/${S.run.runId}/${W.L}-${tag}
Diff: ${S.run.room}/${tag}/${W.L}.diff
Your disposable checkout: ${checkout}. Create it if needed: ${S.cli} materialize --run-dir ${shq(S.run.runDir)} --seat ${W.L} --label ${tag} --name ${round}-${a.lens}
Run reproductions there; never alter the author's worktree.`}
${arch ? 'Read only the named designs and repository; do not write files.' : `Write only in your disposable checkout, ${S.run.room}/tests/, and your review. The verification helper may write its jobs and logs. The user's repository at ${S.run.repoRoot} is read-only.`}
${alternatives.length ? `Alternative designs, for the risk review only: ${alternatives.join(', ')}. Do not read their debate.` : ''}
${arch ? PLAN_LENS[a.lens] : a.lens === 'correctness' && S.auditors.some(x => x.lens === 'tests') ? AUDIT_LENS.correctness.replace(TESTS_BULLET, '') : AUDIT_LENS[a.lens] || AUDIT_LENS.correctness}
${reviewScope(arch)}
Check every criterion and the ${arch ? 'milestone plan' : 'changed code'}, including interactions and defects introduced by a repair. Existing findings are obligations to verify, not conclusions to trust:
${findings.map(c => `[${c.id}] ${c.severity}: ${c.statement} (${c.fixed ? 'checker reports fixed' : c.status}); evidence: ${c.evidence}`).join('\n') || '(none)'}
Do not duplicate an open finding. If a finding reported fixed is still present, file a fact finding citing its original ID and a concrete reproduction; a summary alone cannot block readiness. File new actionable defects with concrete evidence and severity. Preferences alone are not findings. Leave optional suggestions in the summary. A neutral checker and panel establish closure; an author's claim never closes a finding.
${arch ? 'Return the review, with milestone numbers. Do not modify files.' : `${auditPublishing(S, a)}
Never reuse an existing test ID: ${validTests(S).map(t => t.id).join(', ') || '(none)'}.
Write your review to ${auditPost(S, a, round)}.`}
${auditEvidenceBlock(S, a, W, tag)}
${a.vendor === 'gemini' ? GEMINI_REVIEWER : ''}
The process has a bounded repair budget. This review must stand on its evidence even if no further repair remains.`
}

function reviewScope(architecture = false) {
  return architecture ? `Review the plan, not the whole codebase. Problems the plan neither depends on nor makes worse are out of scope.
- blocker: a milestone cannot be built as written, or carrying out the plan would not deliver the task.
- major: broken intermediate states, unmet dependencies, oversized milestones, ineffective criteria, or an unmitigated likely risk.
- minor: anything else worth the author's time.
Preferences without a reason are not findings. A careful review may find nothing.` : `Review the change, not the whole codebase. Pre-existing problems are out of scope unless the task required fixing them or the change makes them worse.
- blocker: wrong results, lost data, a crash or a security hole on realistic inputs, or a regression in working behaviour.
- major: a real defect on a plausible input, changed behaviour no test would catch, or a design problem that materially hinders a likely next change.
- minor: anything else worth the author's time.
Preferences without a reason are not findings. A careful review may find nothing.`
}

function boundedRepairPrompt(S, W, todo, tag, pass, max) {
  return `${S.tier === 'architecture' ? protocol(S, W.L) : S.tier === 'simple' ? simpleIntro(S) : S.tier === 'feature' ? buildIntro(S) : protocol(S, W.L)}
${taskBlock(S, tag)}
${workspaceBlock(S, W, tag)}${notesBlock(S, W)}
Repair pass ${pass} of at most ${max}. Address these obligations, retaining unrelated work:
${[...todo.upheld, ...todo.disputed, ...todo.failing].map(c => `[${c.id}] ${c.statement}\nEvidence: ${c.evidence}\nRuling: ${c.note}`).join('\n')}
${todo.criteria?.length ? `Unmet criteria: ${todo.criteria.map(c => `${c.criterion}: ${c.note || 'not met'}`).join('; ')}` : ''}
${todo.suite ? `The required verification fails: ${todo.suite}` : ''}
${todo.failing.length ? `Published reproductions live under ${S.run.room}/tests/<ID>/files/ and run with test.json. Do not edit those files or create conflicting files at their paths. Add lasting regression coverage to the project's own suite, in its style and at separate paths.` : ''}
${todo.suggestions.length ? `Optional suggestions, not adjudicated; adopt only when they clearly improve this change: ${todo.suggestions.map(c => `[${c.id}] ${c.statement}`).join('; ')}` : ''}
Re-run relevant reproductions and the complete verification gate. A fresh independent review follows; do not claim a finding closed yourself. List each item in addressed or declined, with evidence.
${S.tier === 'architecture' ? 'Revise the design only. Return the complete milestones list, including unchanged milestones.' : 'Implement the repairs in your worktree. Keep the change limited to the review obligations.'}
Write the complete updated final post to ${postPath(S, W.L, tag)}.`
}
