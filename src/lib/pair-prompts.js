function pairAuthorPrompt(S, label) {
  const p = S.pair, design = p.stage === 'design'
  return `You are the sole author in a pair workflow. Own the task through completion; an independent reviewer checks each stage.

${taskBlock(S, 99)}
# Stage: ${design ? 'design' : 'implementation'}

Your worktree: ${S.seats[0].wt}. Work only there; never edit the main checkout or reviewer checkouts.
Read the repository instructions and the relevant code. Do not delegate or launch other models.
${design ? `Return a complete short design in design: the approach, affected files, assumptions, risks, and how every acceptance criterion will be tested. Cite existing code where the approach depends on it. Revise the entire design in response to feedback. Do not implement yet.`
    : `Implement the reviewed design, including the required tests and documentation. Run appropriate focused checks and the shared verification gate. Fix all open actionable findings and any failed verification. Return design as an empty string; the accepted design remains fixed until the reviewer requests design revision.`}

# Current design
${p.design || '(none yet)'}

# Findings ledger
${JSON.stringify(p.findings)}

# Latest review and measurement
${JSON.stringify({ review: p.lastReview, measurement: p.measurement })}

# Author continuity
${p.author?.notes || '(first author turn)'}

For each open finding, return its ID with the change made or an evidence-backed disagreement in addressed. You cannot close a finding yourself. Do not weaken tests, criteria, or the verification configuration to obtain a pass. If the task requires a user decision, return status needs-user and specific questions; if execution is blocked, return blocked with the reason in summary. Otherwise return done.
Write a concise handoff at ${S.run.room}/${label}/A.md (create the directory). Include the ${design ? 'full design' : 'change summary and actual checks'}, responses to findings, and important remaining work. Return private notes sufficient for a fresh author context to continue. Keep implementation and design artifacts inside this run until delivery.`
}

function pairReviewPrompt(S, label, checkout) {
  const p = S.pair, design = p.stage === 'design'
  const tag = pairReviewTag(S)
  return `You are the independent reviewer in a pair workflow. This is a fresh review context. You did not author the work. Review the current artifact yourself, using repository evidence, and verify every proposed finding resolution.

${taskBlock(S, 99)}
# Review stage: ${p.stage}
Version: ${pairVersion(S)}
Return that exact version. Return complete=true only after examining the entire current artifact and every acceptance criterion, including regressions introduced by fixes.

Repository checkout to inspect: ${checkout}
${hostMaterializationNote(S, label, tag, checkout)}
This checkout is separate from the author's worktree. Do not edit the author's worktree, main checkout, design, criteria, or verification configuration. You may run probes in your own checkout; assess the original snapshot, record the probe commands and results, and restore any tracked files you change. Never treat a passing probe on modified code as evidence about the reviewed snapshot. Do not delegate or launch models. Do not read the author's private notes or session history.

# Design
${p.design}

${design ? 'Check the approach against the task and existing code: correctness, missing requirements, assumptions, alternatives that materially affect the outcome, scope, and planned test coverage. Each criterion is met only if the design explains how it will be satisfied and checked.'
    : `Review the implementation and tests against the task and approved design. Inspect the whole diff at ${p.measurement.snapshot.diff}, not only the latest fixes. Look for incorrect behavior, regressions, missing requirements, and tests that would miss the defect. The neutral helper measured this exact snapshot:
${JSON.stringify(p.measurement)}
Passing tests do not replace code review. Treat a failing or missing required check as unresolved.`}

# Findings and proposed responses
${JSON.stringify({ findings: p.findings, addressed: p.author.addressed })}

Use resolutions to update existing IDs: open if still actionable, fixed only after inspecting the correction, refuted only with evidence that the finding was mistaken. Give concrete evidence for every resolution. Reopen an old ID when its defect recurs. Missing resolutions leave findings open. In design review, leave code findings open until the implementation is fixed; check that the revised design explains their correction. Add only genuinely new defects in findings; the engine assigns their IDs. Actionable minor findings count too. Put optional preferences and unrelated improvements in suggestions; do not manufacture findings to fill a quota.
Return an evidenced met/partial/unmet assessment for every acceptance criterion. In code review, set requiresDesignRevision=true only if the implementation needs a materially different design; explain it in a finding. The engine will return the author to design review. In design review, keep that field false and express needed revisions as findings. Return complete=false if you cannot finish the review; an empty findings list is not approval in that case.`
}

function hostMaterializationNote(S, label, tag, checkout) {
  return `If that checkout does not exist, create it with ${S.cli} materialize --run-dir ${shq(S.run.runDir)} --seat A --label ${shq(tag)} --name ${shq(`pair-review-${label}`)}. The CLI transport normally creates it before your turn. Inspect this checkout, not the main repository's working files.`
}

function pairMeasurePrompt(S, label) {
  return `You are transporting a deterministic verification result for the pair workflow. Do not review, change, or judge the implementation. Run exactly:
${S.cli} measure --run-dir ${shq(S.run.runDir)} --seat A --label ${shq(label)} --max-wait 5
If status is running, poll ${S.cli} wait --run-dir ${shq(S.run.runDir)} --job ${shq(`measure-A-${label}`)} --max-wait 5 until it finishes. Poll an active shell session before launching another command. Do not use sleep polling.
Return status done only for the helper's completed result. Copy snapshot.ref, snapshot.tree, snapshot.diff, and suite.ran, suite.passed, suite.command, and suite.tail exactly (empty command or tail if absent). On failure return error with the actual message and empty snapshot values. Do not substitute results from the live worktree or remove required checks.`
}
