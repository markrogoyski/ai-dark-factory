function pairSetupPrompt(S) {
  return setupPrompt(S) + '\n\nPair also requires head: copy the full original commit from the helper init output (head), or run.json. Do not use a later author commit or snapshot. This identity will be checked against every baseline replay.\nKeep the original task unchanged, including in TASK.md. Return repositoryNotes with observations from HEAD, configuration/tool paths, and proposed interpretations of outdated wording. These are proposals for the author and reviewer to check, not replacement requirements. Explicit user decisions and required plan filenames override the default separate-test-file preference. If substantive requirements conflict, return status needs-user with precise questions immediately. Leave questions=[] when none remain.\nList in unverifiable only the criteria, supplied or written by you, that you have established cannot be fully met with evidence available inside this run: anything that needs downstream, post-delivery, production or live-service evidence, or a capability the author and reviewer lack. Give the criterion ID and the reason. If a tool or capability a criterion needs might be missing, check it with one command first (for example `php -m | grep -i pcov` for a coverage driver, or run the target itself), and list the criterion only when that check shows it is missing, citing the command and its output in the reason. Doubt alone ("may not be runnable") is not a reason: record it in repositoryNotes. The verification gate and the test replays run in the helper\'s measurement, outside your sandbox: a check that fails only inside your own sandbox (a refused port bind, socket or network call, or a denied tool) does not make a criterion unverifiable. Record that in repositoryNotes instead. Return unverifiable=[] when every criterion can be checked here.'
}

function pairAuthorPrompt(S, label, correction = '') {
  const p = S.pair, design = p.stage === 'design'
  return `You are the sole author in a pair workflow. Own the task through completion; an independent reviewer checks each stage.

${taskBlock(S, 99)}\n# Setup observations and proposals (not requirements)\n${S.repositoryNotes || '(none)'}
# Stage: ${design ? 'design' : 'implementation'}

Your worktree: ${S.seats[0].wt}. Work only there; never edit the main checkout or reviewer checkouts.
Read the repository instructions and the relevant code. Do not delegate or launch other models.
${correction ? `\n# Correct the previous output\nThe engine could not accept your design output: ${correction}\nReturn a complete corrected design and contract. This is the one correction attempt for this turn, not approval to implement. Preserve the task and substantive requirements.\n` : ''}
${design ? `Return a complete short design in design: the approach, affected files, assumptions, risks, and how every acceptance criterion will be tested. Check setup observations against the original task, reference documents, explicit user decisions, and repository. Explain any reconciliation in the design, preserving every requirement; unresolved contradictions require needs-user. Cite existing code where the approach depends on it. Revise the entire design in response to feedback. Do not implement yet. ${pairBaseline(S)}`
    : `Implement the reviewed design, including the required tests and documentation. Run appropriate focused checks and the shared verification gate. Fix all open actionable findings and any failed verification. Return design as an empty string; the accepted design remains fixed until the reviewer requests design revision.`}

${design ? `Return testContract alongside the design. testRoots are repository-relative test directories, each with evidence from the base project's configuration or established layout. Never use '.' or designate a production directory as a test root. Each check needs a stable local id, criterion IDs in criteria, a concrete scenario (inputs/setup), expected observable outcome, and boundaries (or a reason none apply). For kind=test, supply purpose=changed or preserved, the planned file, a focused command run from repository root, and required fixtures, all files under those roots. For kind=gate, use purpose=preserved and the EXACT designated verification command, with file="" and fixtures=[]; explain which whole-suite requirement it checks. A gate is measured on the final snapshot and needs no replay mapping; it cannot replace changed-behavior tests or their baseline evidence. For kind=inspection, give a concrete inspection and reason automation is unsuitable; leave test execution fields empty. Cover every criterion without inventing meaningless tests. When the task, a plan or a criterion specifies an exception or error message, the planned check asserts that exact message: equality on the caught message, a match anchored at both ends, or the framework's exact-equality form (in PHPUnit, assertSame on the caught exception's getMessage()). Substring matchers (PHPUnit's expectExceptionMessage among them) and unanchored or $-anchored patterns do not count, because they also accept a message with extra text. Return replayMapping=[] during design.
Prefer separate files for tests depending on a new API so load-time failures cannot erase preserved evidence. Explicit user decisions or required plan filenames override this layout preference. In shared files, give distinct focused commands for changed and preserved checks and verify that the preserved selection can load on base; a designated-gate check can cover the final whole-suite obligation. If isolation cannot work, report the limitation before contract approval instead of claiming a preserved baseline pass.`
    : `The approved test contract below remains an obligation. Return testContract with empty testRoots/checks; return replayMapping for the CURRENT implementation: one entry per test file/focused command, with file, command, checkIds from the approved executable checks, and fixtures. Isolate commands at least by file; never group multiple test files into a command. Include every kind=test check, including preserved behavior; omit kind=gate and inspection checks from replayMapping. Never use a directory as file. Validate every mapping against the accepted test roots before returning. Omissions do not remove obligations. Follow the approved layout, including explicit user decisions on shared test files; preserve focused execution evidence. The helper replays added/modified test files and fixtures from the snapshot onto the ORIGINAL base; production/config/dependency changes are excluded. Report unsupported replay dependencies and justified differences from the design in the handoff. Ordinary assertion/path adjustments do not need a separate contract amendment; only a materially different approach returns to design.`}

# Current design
${p.design || '(none yet)'}

# Test contract
${JSON.stringify(p.approvedContract || p.testContract)}

# Findings ledger
${JSON.stringify(p.findings)}

# Latest review and measurement
${JSON.stringify({ review: p.lastReview, measurement: p.measurement })}
${pairMeasurementRecord(S) ? `The measurement leaves out what each execution printed: read it in ${pairMeasurementRecord(S)}, where every replay record and the suite carry the tail of their output, or in the logs they name.\n` : ''}
# Author continuity
${p.author?.notes || '(first author turn)'}

For each open finding, return its ID with the change made or an evidence-backed disagreement in addressed. You cannot close a finding yourself. If a finding needs a user decision, return needs-user now with its existing ID and question; do not spend another author turn restating the conflict. Do not weaken tests, criteria, or the verification configuration to obtain a pass. If the task requires a user decision, return status needs-user and specific questions; if execution is blocked, return blocked with the reason in summary. Otherwise return done.
Write a concise handoff at ${S.run.room}/${label}/A.md (create the directory). Include the ${design ? 'full design' : 'change summary and actual checks'}, responses to findings, and important remaining work. Return private notes sufficient for a fresh author context to continue. Keep implementation and design artifacts inside this run until delivery.`
}

function pairReviewPrompt(S, label, checkout, correction = null) {
  const p = S.pair, design = p.stage === 'design'
  const tag = pairReviewTag(S)
  return `You are the independent reviewer in a pair workflow. This is a fresh review context. You did not author the work. Review the current artifact yourself, using repository evidence, and verify every proposed finding resolution. Resolve existing findings under their current IDs in both design and code reviews; never refile an unresolved issue under a new ID.

${taskBlock(S, 99)}\n# Setup observations and proposals (not requirements)\n${S.repositoryNotes || '(none)'}
# Review stage: ${p.stage}
Version: ${pairVersion(S)}
Return that exact version. Return complete=true only after examining the entire current artifact and every acceptance criterion, including regressions introduced by fixes.
${correction ? `\n# Correct the previous structured review\n${correction.error}\nThis is one correction attempt for this artifact. Preserve substantive criticisms, findings, and resolutions; correct the invalid structured fields. Do not invent rejecting checks or convert rejection into approval. The prior submission was:\n${JSON.stringify(correction.review)}\n` : ''}

Repository checkout to inspect: ${checkout}
${hostMaterializationNote(S, label, tag, checkout)}
This checkout is separate from the author's worktree. Do not edit the author's worktree, main checkout, design, criteria, or verification configuration. You may run probes in your own checkout; assess the original snapshot, record the probe commands and results, and restore any tracked files you change. Never treat a passing probe on modified code as evidence about the reviewed snapshot. Do not delegate or launch models. Do not read the author's private notes or session history.

# Design
${p.design}

# Test contract
${JSON.stringify(p.approvedContract || p.testContract)}

${design ? `Independently check proposed reconciliations against the original task, reference documents, and explicit user decisions; setup notes cannot waive requirements. Check that the criteria cover the entire original request. Check the approach against the task and existing code: correctness, missing requirements, assumptions, alternatives that materially affect the outcome, scope, and planned test coverage. Verify every proposed test root against the BASE repository configuration/layout and its cited evidence; naming a directory does not make it a test root. Reject production roots and missing concrete outcomes/boundaries. Check that every planned test and fixture is a regular file under an accepted root and each focused command is executable by the replay helper. Shared files are allowed when required by the user or plan: inspect focused selection and base loadability. Prefer separate files otherwise. Whole-suite preservation must use kind=gate with the exact designated command, never a directory in a file mapping. Gate evidence establishes final-suite success, not a changed-behavior baseline failure. Each criterion is met only if the design explains how it will be satisfied and checked.
Return exactly one structured challenge per criterion in challenges: criterion, a substantive wrongImplementation, and rejectingCheckIds that resolve to contract checks covering that criterion. If no check rejects a plausible wrong implementation, return rejectingCheckIds=[] and raise an evidenced finding, assess that criterion partial/unmet, or request design revision with the reason in summary. Never cite a check you believe is ineffective just to fill the array. Approval requires a rejecting check for every challenge. Describe a plausible incorrect result and its rejecting inspection for non-code criteria. Judge whether the checks actually reject that implementation; valid IDs alone are insufficient. ${pairBaseline(S)}`
    : `Review the implementation and tests against the task and approved design. Inspect the whole diff at ${p.measurement.snapshot.diff}, not only the latest fixes. Look for incorrect behavior, regressions, missing requirements, and tests that would miss the defect. The neutral helper measured this exact snapshot. This summary leaves out what each execution printed: read that in the helper's full record, ${pairMeasurementRecord(S)}, where every replay record and the suite carry the tail of their output, and in the logs they name:
${JSON.stringify(p.measurement)}
Passing tests do not replace code review. Treat a failing or missing required check as unresolved.
Interpret the raw replay records for each check from their output in that record, reading the logs when the tail is not enough. A base fatal at file level (including a missing new API), pass, timeout, or tool error is evidence to interpret, not an automatic red/green verdict. Records cover files/commands and associated check IDs; an aborted file does not prove individual assertions ran. Preserved behavior should pass on base; changed behavior passing there needs investigation. Distinguish the intended missing behavior from infrastructure failure using actual output. If inconclusive, reflect that in criterion assessments/findings rather than approving solely because a record exists. A base record with reused=true is the same execution as an earlier measurement's, carried over because its inputs were identical (base commit, command, test and fixture bytes, timeout and settings); it is not a new run.
Inspect every overlay exclusion and missing preserved-behavior signal. Compare actual assertions and coverage with the approved contract and report omissions or weakening through findings. Check that each mapped command really isolates its named file and executes its claimed checks. Attack the whole implementation for uncovered requirements, regressions, races, numeric mistakes, and defects introduced by fixes: the contract is a floor, not the review checklist. Return challenges=[] during code review.
That measurement is the gate result for this snapshot: don't rerun the verification command or the checks in it. Run only targeted probes, such as one test or one analyser on the changed files. Sandboxes can block the sockets that parallel workers use: if a probe fails that way, run the tool single-process.`}

# Findings and proposed responses
${JSON.stringify({ findings: p.findings, addressed: p.author.addressed })}

Use resolutions to update existing IDs: open if still actionable, fixed only after inspecting the correction, refuted only with evidence that the finding was mistaken. Give concrete evidence for every resolution. Reopen an old ID when its defect recurs. Missing resolutions leave findings open. In design review, leave code findings open until the implementation is fixed; check that the revised design explains their correction. Add only genuinely new defects in findings; the engine assigns their IDs. Actionable minor findings count too. Put optional preferences and unrelated improvements in suggestions; do not manufacture findings to fill a quota.
Return an evidenced met/partial/unmet assessment for every acceptance criterion. In code review, set requiresDesignRevision=true only if the implementation needs a materially different design; explain it in a finding. The engine will return the author to design review. In design review, keep that field false and express needed revisions as findings. Return complete=false if you cannot finish the review; an empty findings list is not approval in that case.`
}

// The design stage needs no gate run: setup measured the base revision.
function pairBaseline(S) {
  if (!S.verify) return ''
  return `Setup ran the verification command on the base revision, and it ${S.baselineOk ? 'passed' : `failed: ${S.baselineNote}`}. Don't run it, or the checks in it, during the design stage; the design says which of them the implementation must pass and how the new tests are checked.`
}

function hostMaterializationNote(S, label, tag, checkout) {
  return `If that checkout does not exist, create it with ${S.cli} materialize --run-dir ${shq(S.run.runDir)} --seat A --label ${shq(tag)} --name ${shq(`pair-review-${label}`)}. The CLI transport normally creates it before your turn. Inspect this checkout, not the main repository's working files.`
}

// --brief prints the result already in the output schema's shape, without what each execution
// printed (the job's status.json keeps it), so the transport copies about a third of the record.
function pairMeasurePrompt(S, label) {
  return `You are transporting a deterministic verification result for the pair workflow. Do not review, change, or judge the implementation. Run exactly:
${S.cli} measure --run-dir ${shq(S.run.runDir)} --seat A --label ${shq(label)} --replay-json ${shq(JSON.stringify(pairReplayRequest(S)))} --brief --max-wait 5
If status is running, poll ${S.cli} wait --run-dir ${shq(S.run.runDir)} --job ${shq(`measure-A-${label}`)} --brief --max-wait 5 until it finishes. Poll an active shell session before launching another command. Do not use sleep polling.
The finished result is one line of JSON in exactly the shape you return. Return it as printed: the same keys and values, including the whole replay object and every record, with nothing added, dropped, reformatted or summarized. Never interpret base failures. If the command fails without printing that result, return status error with the actual message in error and empty snapshot, suite and replay values. Do not substitute results from the live worktree or remove required checks.`
}
