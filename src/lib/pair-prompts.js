// A run whose task builds on changes absent from HEAD measures its baseline without them, and its
// reviewers check out a tree that lacks them; applying them in the worktree also fails in the
// sandbox. Setup stops before creating the run, so the user commits them and reruns.
const PAIR_FROM_HEAD_RULE = 'Before step 2 creates the run, check that the work starts from HEAD. Stop when the task, the context or a reference document tells the author to apply a patch, diff, stash or saved snapshot before starting, or says the work to fix or extend is uncommitted (for example "fix the review findings in my uncommitted change"): return status "needs-commit", with error naming those changes and quoting the words that show it, and empty values elsewhere. The worktrees, the baseline and every review start from HEAD, so the run would measure and review code without them. When the task only calls the work uncommitted, check `git status --short` first: if it lists no tracked changes and HEAD\'s code already has the work, it was committed after the task was written, so continue and say so in repositoryNotes. Work already in history does not count (a commit, a branch, or an earlier change the task names), nor do reference documents, committed or not, which the author and reviewer read by path, nor a patch or diff given only to read rather than to apply first.'

function pairSetupPrompt(S) {
  return setupPrompt(S) + '\n\nPair also requires head: copy the full original commit from the helper init output (head), or run.json. Do not use a later author commit or snapshot. This identity will be checked against every baseline replay.\n' + PAIR_FROM_HEAD_RULE + '\nKeep the original task unchanged, including in TASK.md. Return repositoryNotes with observations from HEAD, configuration/tool paths, and proposed interpretations of outdated wording. These are proposals for the author and reviewer to check, not replacement requirements. Explicit user decisions and required plan filenames override the default separate-test-file preference. If substantive requirements conflict, return status needs-user with precise questions immediately. Leave questions=[] when none remain.\nYou own the criteria you write: word each one so evidence inside this run can check it, by a test, the gate, or inspection of the code. A limitation that the task or a reference document explicitly accepts is not a gap: write the criterion to match what it accepts, cite where it says so, and leave it out of unverifiable. List in unverifiable only the criteria that you have established cannot be fully met with evidence available inside this run, with origin supplied when the task, criteria or a reference document states the criterion in substance, and written when you drafted it and no checkable wording keeps its intent: anything that needs downstream, post-delivery, production or live-service evidence, or a capability the author and reviewer lack. Give the criterion ID and the reason. If a tool or capability a criterion needs might be missing, check it with one command first (for example `php -m | grep -i pcov` for a coverage driver, or run the target itself), and list the criterion only when that check shows it is missing, citing the command and its output in the reason. Doubt alone ("may not be runnable") is not a reason: record it in repositoryNotes. The verification gate and the test replays run in the helper\'s measurement, outside your sandbox: a check that fails only inside your own sandbox (a refused port bind, socket or network call, or a denied tool) does not make a criterion unverifiable. Record that in repositoryNotes instead. Return unverifiable=[] when every criterion can be checked here.\nList in liveChecks each criterion that the run can check only against a stand-in for something outside it, where the real thing can behave differently: a network service, credentials, the machine\'s certificate store or another platform-specific resource, an external CLI\'s login. Give the criterion ID, the command or action that checks it against the real thing, and why the stand-in can\'t show it. Don\'t list such a criterion in unverifiable: the run still checks it with the stand-in, and the user runs the live check before delivery. Return liveChecks=[] when there are none.' + (pairDecisionsBlock(S) && `\nThis setup runs again because the user answered questions the run asked, listed below: write the acceptance criteria so that they follow every answer.\n${pairDecisionsBlock(S)}`)
}

// The user's answers to the run's questions, from a stop this run continued past. Empty without
// any, so every prompt before the first answered stop has the same bytes with and without answers.
function pairDecisionsBlock(S) {
  const decisions = S.pair?.decisions || []
  if (!decisions.length) return ''
  return `\n# Explicit user decisions\n\nThe user answered ${decisions.length === 1 ? 'this question' : 'these questions'} during the run. ` +
    `${decisions.length === 1 ? 'The answer overrides' : 'The answers override'} setup observations and readings for the rest of the run. ` +
    `The reviewer resolves any finding a decision settles under its existing ID.\n` +
    decisions.map(d => `- ${d.id} (about ${d.about}; asked in ${d.label}): ${d.question} Answer: ${d.answer}` +
      `${typeof d.criterion === 'string' ? ` ${d.about} now reads: ${d.criterion}` : d.drop === true ? ` ${d.about} was dropped.` : d.implement === true ? ' The user chose to start the implementation with the open design findings carried into code review as open items.' : ''}`).join('\n') + '\n'
}

// The spec findings a reading settles, for the author to answer in its readings ledger and the
// reviewer to rule on there. Empty without any, so a run with a clean spec review has the same
// prompts as one without a spec review.
function pairSpecBlock(S, role) {
  const fs = pairSpecFindings(S)
  if (!fs.length) return ''
  const one = fs.length === 1
  const intro = role === 'author'
    ? `Before any work began, an independent reviewer read the criteria against the task, its documents and the code, and found ${one ? 'this problem' : 'these problems'}. Answer ${one ? 'it' : 'each'} in readings, citing its ID in requirement (for example "${fs[0].id}, C1"), with what the work does about it: the proposed reading, or another the task's words allow, with the reason. The reviewer rules on each reading like any other. Where a finding has no proposed reading and none inside the task's words settles it, return needs-user with the question instead.`
    : `Before any work began, a spec review read the criteria against the task, its documents and the code, and found ${one ? 'this problem' : 'these problems'}. The author answers ${one ? 'it' : 'each'} in the readings ledger under its ID. Rule on those readings like any other; a reading that answers a spec finding may also rest on the code the finding cites. A spec finding no reading in the ledger answers is unresolved: file it as a finding.`
  return `\n# Spec review findings\n\n${intro}\n` + fs.map(f => [`- ${f.id}${f.criteria.length ? ` (about ${f.criteria.join(', ')})` : ''}: ${f.statement}`,
    ...(f.quoted.length ? [`  Requirements as written: ${f.quoted.join('; ')}`] : []), ...(f.evidence ? [`  Evidence: ${f.evidence}`] : []),
    f.reading ? `  Proposed reading: ${f.reading}` : f.question ? `  No reading settles it, the spec reviewer found: ${f.question}` : '  No reading proposed.',
    ...(f.repeats ? [`  It repeats ${f.repeats}, which the user answered above; read it by that answer.`] : [])].join('\n')).join('\n') + '\n'
}

// The rules a Pair run holds the work to, as the spec reviewer checks the criteria against them.
function pairStageRules(S) {
  return [
    `- The author works in its own git worktree, checked out from HEAD, and changes nothing outside it until delivery.${pairDesigned(S) ? ' It designs first: the design and its test contract are reviewed before any code is written.' : ' This run has no design stage: the author writes the deliverable and its test contract together.'}`,
    '- Every criterion is covered by a test, by the verification command, or by a named inspection. Each test file and fixture lives under a test root: a test directory the base project already uses, never a production directory or the repository root.',
    '- Tests that depend on new code go in their own files, apart from the tests of behaviour that must stay the same, unless the user or a plan names the files.',
    '- The added and modified test files and fixtures are replayed on the original base revision, without the production, configuration or dependency changes, and on the final snapshot. A test of changed behaviour is expected to fail on base and pass at the end; a test of preserved behaviour passes on both.',
    `- ${S.verify ? 'The verification command runs on the final snapshot and must pass. ' : ''}A specified exception or error message is asserted exactly. Tests, criteria and the verification configuration are never weakened to obtain a pass.`,
  ].join('\n')
}

// The spec review, after setup and before the first author turn (pairSpecReview). One fresh
// reviewer reads the criteria against the task, its documents, the run's rules and the code, and
// sorts each problem into one a reading settles (to the author) and one only the user can (a stop).
function pairSpecPrompt(S) {
  const given = Array.isArray(S.raw.criteria) && S.raw.criteria.length, decided = !!S.pair.decisions.length
  return `You are reviewing the acceptance criteria of a pair run before its author starts. One author will ${pairDesigned(S) ? 'design the task below and then implement it' : 'do the task below'}, and an independent reviewer will hold every version to these criteria. When two requirements can't both hold, the run otherwise finds out only after one or more design reviews and then stops for the user, so find such problems now. This is a short read of the criteria against the task, its documents and the code, not a design review: don't attempt or design the task, and don't modify anything.

# Task

${S.task}
${refsBlock(S)}${S.context ? `\n# Context from the user\n\n${S.context}\n` : ''}
# Acceptance criteria (${given ? 'given by the user' : 'written by setup from the task and the code'})

${specCriteria(S)}

# Verification command

${S.verify ? `\`${S.verify}\`, run from the root of a worktree. At the starting commit it ${S.baselineOk ? 'passes' : `fails: ${oneLine(S.baselineNote, 300)}`}.` : '(none)'}
${pairDecisionsBlock(S)}
# Setup observations and proposals (not requirements)

${S.repositoryNotes || '(none)'}

# The rules this run holds the work to

${pairStageRules(S)}

The repository is at ${S.run.repoRoot}, at the commit the author starts from. Read the code each criterion depends on, the reference documents and the repository instructions, and no more than that needs.

# What to look for

- Contradictions: two criteria that can't both hold as written, or a criterion that can't hold beside the task, a reference document, an explicit user decision or a rule above. Try to meet all of them at once on the hardest case they cover: a mechanism one criterion names against a limit another sets, a file one criterion fixes against a rule that needs another.
- Criteria wrong about the code: one that describes a function, file, option or behaviour that isn't there or works otherwise. Cite the file and line.
- Dropped requirements: something the task or a reference document requires that no criterion states, or that a criterion states more weakly. Quote it.
Don't ask for criteria the task doesn't call for, don't report preferences or wording, and don't judge whether a criterion can be checked inside the run: setup did that.

# Who settles each finding

- "reading": a reading inside the words of the task, the documents and the decisions settles it: an ambiguity with a conservative reading, a criterion that misdescribes the code but has an obvious correct reading, or a dropped requirement the work can simply meet. Put that reading in \`reading\`: what the work should do. The author answers each such finding in its readings ledger, and the reviewer rules on it there.
- "user": no such reading settles it: two requirements that can't both hold as written, or one that a fact you found makes impossible as written. Ask in \`question\`, saying what conflicts and giving the options you see, and set \`reading\` to "". The run stops and asks the user before the author starts, and setup then rewrites the criteria to the answer.
Choose "reading" whenever a reading keeps every requirement's intent.${decided ? ' The user\'s decisions above settle what they answer: don\'t ask again about anything they settle, only about a conflict they leave open, and then set `revisits` to the decision\'s ID and say in `leftOpen` what its answer leaves open. A question an answer already settles goes to the author, not the user.' : ''} In each finding, \`criteria\` lists the criterion IDs involved ([] when no criterion states the requirement), \`quoted\` the exact words of each requirement involved (a criterion, the task, a document or a rule above), and \`evidence\` a file:line, a quote, or a command and the real tail of its output.

An empty findings list is the right answer when the criteria hold together: don't pad it. In \`summary\`, give your verdict in one or two sentences.`
}

// The contract and mapping rules, shared by the design stage and by a run without one.
const PAIR_CONTRACT_RULES = `testRoots are repository-relative test directories, each with evidence from the base project's configuration or established layout. Never use '.' or designate a production directory as a test root. Each check needs a stable local id, criterion IDs in criteria, a concrete scenario (inputs/setup), expected observable outcome, and boundaries (or a reason none apply). For kind=test, supply purpose=changed or preserved, the planned file, a focused command run from repository root, and required fixtures, all files under those roots. For kind=gate, use purpose=preserved and the EXACT designated verification command, with file="" and fixtures=[]; explain which whole-suite requirement it checks. A gate is measured on the final snapshot and needs no replay mapping; it cannot replace changed-behavior tests or their baseline evidence. For kind=inspection, give a concrete inspection and reason automation is unsuitable; leave test execution fields empty. Cover every criterion without inventing meaningless tests. When the change copies, mirrors or reimplements behaviour another function already has (argument checks, messages, edge cases), add a check that runs both on the same inputs side by side, including combinations of arguments, and asserts they behave the same; a list of the criterion's cases alone does not show they agree. When the task, a plan or a criterion specifies an exception or error message, the planned check asserts that exact message: equality on the caught message, a match anchored at both ends, or the framework's exact-equality form (in PHPUnit, assertSame on the caught exception's getMessage()). Substring matchers (PHPUnit's expectExceptionMessage among them) and unanchored or $-anchored patterns do not count, because they also accept a message with extra text.`
const PAIR_LAYOUT_RULES = 'Prefer separate files for tests depending on a new API so load-time failures cannot erase preserved evidence. Explicit user decisions or required plan filenames override this layout preference. In shared files, give distinct focused commands for changed and preserved checks and verify that the preserved selection can load on base; a designated-gate check can cover the final whole-suite obligation.'
const pairMappingRules = (checks, roots) => `one entry per test file/focused command, with file, command, checkIds from ${checks} executable checks, and fixtures. Isolate commands at least by file; never group multiple test files into a command. Include every kind=test check, including preserved behavior; omit kind=gate and inspection checks from replayMapping. Never use a directory as file. Validate every mapping against ${roots} test roots before returning. Omissions do not remove obligations.`
const PAIR_REPLAY_NOTE = 'The helper replays added/modified test files and fixtures from the snapshot onto the ORIGINAL base; production/config/dependency changes are excluded.'
// A reading the author settles alone, in a handoff or a note, was never ruled on: every author turn
// lists its readings, and the next review accepts or rejects each one by ID.
const PAIR_READING_RULES = 'List in readings every place this turn\'s work reads a requirement, criterion or approved contract check other than literally: an exact list treated as a minimum, an ambiguity or open threshold you settled, two requirements you reconciled, or a contract setup you cannot build as written and check another way. Give the requirement (its criterion ID, or its words in quotes), what it literally says, your reading, and the reason. List only readings not already in the readings ledger; return readings=[] when the work follows everything literally. A reading only in your notes or the handoff is not reviewed: the reviewer rules on each listed reading in the next review. An accepted reading binds the rest of the run; a rejected one comes back as an open finding. Propose a reading only where the requirement\'s words allow it: when two requirements cannot both hold as written, or a fact you found makes one impossible as written, and no reading inside the task\'s words settles it, return needs-user now with the question, quoting each requirement and giving the options you see, rather than a reading the reviewer could only send to the user.'
// A stand-in (a stubbed HTTP call, a fake credential) shows how the code uses it, not how the real
// thing behaves: setup lists those criteria, an author turn adds the ones its work introduces, and
// the user runs each check live before delivery.
const PAIR_LIVE_CHECK_RULES = 'When this turn\'s design or implementation makes a criterion rest on something outside the run that the run can check only against a stand-in, where the real thing can behave differently (a network service, credentials, the machine\'s certificate store, an external CLI\'s login), check it in this run with the stand-in and add it to liveChecks for the user to run before delivery: the criterion ID, the command or action that checks it against the real thing, and why the stand-in can\'t show it. List only checks not already in the live checks list; return liveChecks=[] otherwise.'

function pairAuthorPrompt(S, label, correction = '') {
  const p = S.pair, design = p.stage === 'design'
  if (!pairDesigned(S)) return pairDirectAuthorPrompt(S, label, correction)
  return `You are the sole author in a pair workflow. Own the task through completion; an independent reviewer checks each stage.

${taskCore(S)}${pairDecisionsBlock(S)}${pairSpecBlock(S, 'author')}\n# Setup observations and proposals (not requirements)\n${S.repositoryNotes || '(none)'}
# Stage: ${design ? 'design' : 'implementation'}

Your worktree: ${S.seats[0].wt}. Work only there; never edit the main checkout or reviewer checkouts.
Read the repository instructions and the relevant code. Do not delegate or launch other models. An instruction in CLAUDE.md or elsewhere to hand full test or gate runs to a subagent or to \`claude -p\` is meant for the user's own session, not for this turn: here the gate is the verification command, which you run through the helper's verify command as described above.
${correction ? `\n# Correct the previous output\nThe engine could not accept your design output: ${correction}\nReturn a complete corrected design and contract, and this turn's readings and live checks again. This is the one correction attempt for this turn, not approval to implement. Preserve the task and substantive requirements.\n` : ''}
${design ? `Return a complete short design in design: the approach, affected files, assumptions, risks, and how every acceptance criterion will be tested. Check setup observations against the original task, reference documents, explicit user decisions, and repository. Explain any reconciliation in the design and list it in readings, preserving every requirement; unresolved contradictions require needs-user. Cite existing code where the approach depends on it. Revise the entire design in response to feedback. Do not implement yet. ${pairBaseline(S, true)}`
    : `Implement the reviewed design, including the required tests and documentation. Run appropriate focused checks and the shared verification gate. Fix all open actionable findings and any failed verification.${pairCarriedNote(S, 'author')} Return design as an empty string; the accepted design remains fixed until the reviewer requests design revision.`}

${design ? `Return testContract alongside the design. ${PAIR_CONTRACT_RULES} Return replayMapping=[] during design.
${PAIR_LAYOUT_RULES} If isolation cannot work, report the limitation before contract approval instead of claiming a preserved baseline pass.`
    : `The approved test contract below remains an obligation. Return testContract with empty testRoots/checks; return replayMapping for the CURRENT implementation: ${pairMappingRules('the approved', 'the accepted')} Follow the approved layout, including explicit user decisions on shared test files; preserve focused execution evidence. ${PAIR_REPLAY_NOTE} Report unsupported replay dependencies and justified differences from the design in the handoff. Ordinary assertion/path adjustments do not need a separate contract amendment; only a materially different approach returns to design.`}

# Current design
${p.design || '(none yet)'}

# Test contract
${JSON.stringify(p.approvedContract || p.testContract)}

# Findings ledger
${JSON.stringify(p.findings)}

# Readings ledger
${JSON.stringify(p.readings)}

# Live checks
${JSON.stringify(p.liveChecks)}

# Latest review and measurement
${JSON.stringify({ review: p.lastReview, measurement: p.measurement })}
${pairMeasurementRecord(S) ? `The measurement leaves out what each execution printed: read it in ${pairMeasurementRecord(S)}, where every replay record and the suite carry the tail of their output, or in the logs they name.\n` : ''}
# Author continuity
${p.author?.notes || '(first author turn)'}

For each open finding, return one entry in addressed: its ID, with action changed and the change made in response, or action disputed and an evidence-backed disagreement. You cannot close a finding yourself. If a finding needs a user decision, return needs-user now with its existing ID and question; do not spend another author turn restating the conflict. Do not weaken tests, criteria, or the verification configuration to obtain a pass. If the task requires a user decision, return status needs-user and specific questions; if execution is blocked, return blocked with the reason in summary. Otherwise return done.
${PAIR_READING_RULES}
${PAIR_LIVE_CHECK_RULES}
Save each script or command file whose output supports a claim (a probe, a coverage or equivalence check) under ${S.run.room}/${label}/probes/, not in /tmp or $TMPDIR, which are cleared after the run, and cite it by that path. Start each probe file's name with \`probe-\` so it cannot shadow a standard-library or project module, and run Python probes with \`python3 -I\`.
Write a concise handoff at ${S.run.room}/${label}/A.md (create the directory). Include the ${design ? 'full design' : 'change summary and actual checks'}, responses to findings, and important remaining work. Return private notes sufficient for a fresh author context to continue. Keep implementation and design artifacts inside this run until delivery.`
}

// The author's prompt when the run has no design stage: the first turn writes the deliverable and
// its test contract, and every turn after it keeps both current.
function pairDirectAuthorPrompt(S, label, correction = '') {
  const p = S.pair
  return `You are the sole author in a pair workflow. Own the task through completion; an independent reviewer checks each version.

${taskCore(S)}${pairDecisionsBlock(S)}${pairSpecBlock(S, 'author')}\n# Setup observations and proposals (not requirements)\n${S.repositoryNotes || '(none)'}
# Stage: implementation (this run has no design stage)

Your worktree: ${S.seats[0].wt}. Work only there; never edit the main checkout or reviewer checkouts.
Read the repository instructions and the relevant code. Do not delegate or launch other models. An instruction in CLAUDE.md or elsewhere to hand full test or gate runs to a subagent or to \`claude -p\` is meant for the user's own session, not for this turn: here the gate is the verification command, which you run through the helper's verify command as described above.
${correction ? `\n# Correct the previous output\nThe engine could not accept your test contract, replay mapping or readings: ${correction}\nReturn a complete corrected testContract and replayMapping for the current implementation, and this turn's readings and live checks again, changing the worktree only where the correction needs it. This is the one correction attempt for this turn. Preserve the task and substantive requirements.\n` : ''}
This run skips the design stage: write the deliverable itself, not a design or a plan for it, including the required tests and documentation; the reviewer reviews the measured result directly. Check setup observations against the original task, reference documents, explicit user decisions, and repository; explain any reconciliation in the handoff and list it in readings, preserving every requirement; unresolved contradictions require needs-user. Run appropriate focused checks and the shared verification gate. Fix all open actionable findings and any failed verification; when the latest review says the approach itself must change, change it in this turn. Return design as an empty string.

Return testContract for the CURRENT deliverable: the checks the reviewer holds it to. ${PAIR_CONTRACT_RULES} When the deliverable is a document or a plan, its criteria are usually checked by kind=inspection, and testRoots may be empty when no check is kind=test. Every file:line, code snippet, literal and call chain such a document states or prescribes is a claim: confirm each one against HEAD, with a saved probe where reading is not enough, before handoff. The contract is yours to keep current: return it whole every turn, extended or corrected where findings call for it, never weakened to obtain a pass. ${PAIR_LAYOUT_RULES} If isolation cannot work, report the limitation in the handoff instead of claiming a preserved baseline pass.
Return replayMapping for the CURRENT implementation: ${pairMappingRules("your contract's", "your contract's")} ${PAIR_REPLAY_NOTE} Report unsupported replay dependencies in the handoff.

# Test contract
${p.approvedContract ? JSON.stringify(p.approvedContract) : '(none yet)'}

# Findings ledger
${JSON.stringify(p.findings)}

# Readings ledger
${JSON.stringify(p.readings)}

# Live checks
${JSON.stringify(p.liveChecks)}

# Latest review and measurement
${JSON.stringify({ review: p.lastReview, measurement: p.measurement })}
${pairMeasurementRecord(S) ? `The measurement leaves out what each execution printed: read it in ${pairMeasurementRecord(S)}, where every replay record and the suite carry the tail of their output, or in the logs they name.\n` : ''}
# Author continuity
${p.author?.notes || '(first author turn)'}

For each open finding, return one entry in addressed: its ID, with action changed and the change made in response, or action disputed and an evidence-backed disagreement. You cannot close a finding yourself. If a finding needs a user decision, return needs-user now with its existing ID and question; do not spend another author turn restating the conflict. Do not weaken tests, criteria, or the verification configuration to obtain a pass. If the task requires a user decision, return status needs-user and specific questions; if execution is blocked, return blocked with the reason in summary. Otherwise return done.
${PAIR_READING_RULES}
${PAIR_LIVE_CHECK_RULES}
Save each script or command file whose output supports a claim (a probe, a coverage or equivalence check) under ${S.run.room}/${label}/probes/, not in /tmp or $TMPDIR, which are cleared after the run, and cite it by that path. Start each probe file's name with \`probe-\` so it cannot shadow a standard-library or project module, and run Python probes with \`python3 -I\`.
Write a concise handoff at ${S.run.room}/${label}/A.md (create the directory). Include the change summary and actual checks, responses to findings, and important remaining work. Return private notes sufficient for a fresh author context to continue. Keep implementation artifacts inside this run until delivery.`
}

function pairReviewPrompt(S, label, checkout, correction = null) {
  const p = S.pair, design = p.stage === 'design', designed = pairDesigned(S), challenged = pairChallengesDue(S)
  const tag = pairReviewTag(S)
  return `You are the independent reviewer in a pair workflow. This is a fresh review context. You did not author the work. Review the current artifact yourself, using repository evidence, and verify every proposed finding resolution. Resolve existing findings under their current IDs in both design and code reviews; never refile an unresolved issue under a new ID.

${taskCore(S)}${pairDecisionsBlock(S)}${pairSpecBlock(S, 'reviewer')}\n# Setup observations and proposals (not requirements)\n${S.repositoryNotes || '(none)'}
# Review stage: ${p.stage}
Version: ${pairVersion(S)}
Return that exact version. Return complete=true only after examining the entire current artifact and every acceptance criterion, including regressions introduced by fixes.
${correction ? `\n# Correct the previous structured review\n${correction.error}\nThis is one correction attempt for this artifact. Preserve substantive criticisms, findings, and resolutions; correct the invalid structured fields. Do not invent rejecting checks or convert rejection into approval. The prior submission was:\n${JSON.stringify(correction.review)}\n` : ''}

Repository checkout to inspect: ${checkout}
${hostMaterializationNote(S, label, tag, checkout)}
This checkout is separate from the author's worktree. Do not edit the author's worktree, main checkout, design, criteria, or verification configuration. You may run probes in your own checkout; assess the original snapshot, record the probe commands and results, and restore any tracked files you change. Save each probe script or command file under ${S.run.room}/review-${label}/probes/, not in /tmp or $TMPDIR, which are cleared after the run, and cite it by that path in your evidence. Start each probe file's name with \`probe-\` so it cannot shadow a standard-library or project module, and run Python probes with \`python3 -I\`. Never treat a passing probe on modified code as evidence about the reviewed snapshot. Do not delegate or launch models. Do not read the author's private notes or session history.${S.auditors[0]?.vendor === 'gemini' ? `\n${GEMINI_REVIEWER}` : ''}

${designed ? `# Design\n${p.design}\n\n` : ''}# Test contract
${JSON.stringify(p.approvedContract || p.testContract)}

${design ? `Independently check proposed reconciliations against the original task, reference documents, and explicit user decisions; setup notes cannot waive requirements. Check that the criteria cover the entire original request. Check the approach against the task and existing code: correctness, missing requirements, assumptions, alternatives that materially affect the outcome, scope, and planned test coverage. Where the change copies or mirrors behaviour from another function, require a side-by-side check that the two agree. Verify every proposed test root against the BASE repository configuration/layout and its cited evidence; naming a directory does not make it a test root. Reject production roots and missing concrete outcomes/boundaries. Check that every planned test and fixture is a regular file under an accepted root and each focused command is executable by the replay helper. Shared files are allowed when required by the user or plan: inspect focused selection and base loadability. Prefer separate files otherwise. Whole-suite preservation must use kind=gate with the exact designated command, never a directory in a file mapping. Gate evidence establishes final-suite success, not a changed-behavior baseline failure. Each criterion is met only if the design explains how it will be satisfied and checked; assess it met when the design satisfies it apart from minor findings.
${pairChallengeRules(true)} ${pairBaseline(S)}`
    : `${designed ? 'Review the implementation and tests against the task and approved design.' : `Review the implementation and tests against the task. This run has no design stage, so no one has reviewed the test contract above: review it here as part of the artifact. Verify every test root against the BASE repository configuration/layout and its cited evidence, check that the contract covers the entire original request and every criterion, and ${challenged ? `file a finding for each gap. No review has challenged this contract yet. ${pairChallengeRules(false)}` : 'judge for each criterion whether its checks would reject a plausible wrong implementation; file a finding for each gap.'} Inspection checks must name a concrete inspection; perform each one yourself.`} Inspect the whole diff at ${p.measurement.snapshot.diff}, not only the latest fixes. Look for incorrect behavior, regressions, missing requirements, and tests that would miss the defect. The neutral helper measured this exact snapshot. This summary leaves out what each execution printed: read that in the helper's full record, ${pairMeasurementRecord(S)}, where every replay record and the suite carry the tail of their output, and in the logs they name:
${JSON.stringify(p.measurement)}
Passing tests do not replace code review. Treat a failing or missing required check as unresolved.${pairInfrastructure(S).length ? ` This measurement could not run because of the environment, not the snapshot (${pairInfrastructure(S).join(' ')}). Readiness already reports that, and neither the author nor you can fix it: don't file a finding for it or reopen one about it. Assess a criterion that needs the missing results partial, with that reason in its note, and review the code on its merits.` : ''}
Interpret the raw replay records for each check from their output in that record, reading the logs when the tail is not enough. A base fatal at file level (including a missing new API), pass, timeout, or tool error is evidence to interpret, not an automatic red/green verdict. Records cover files/commands and associated check IDs; an aborted file does not prove individual assertions ran. Preserved behavior should pass on base; changed behavior passing there needs investigation. Distinguish the intended missing behavior from infrastructure failure using actual output. If inconclusive, reflect that in criterion assessments/findings rather than approving solely because a record exists. A base record with reused=true is the same execution as an earlier measurement's, carried over because its inputs were identical (base commit, command, test and fixture bytes, timeout and settings); it is not a new run.
Inspect every overlay exclusion and missing preserved-behavior signal. Compare actual assertions and coverage with the ${designed ? 'approved ' : ''}contract and report omissions or weakening through findings. Check that each mapped command really isolates its named file and executes its claimed checks. Attack the whole implementation for uncovered requirements, regressions, races, numeric mistakes, and defects introduced by fixes: the contract is a floor, not the review checklist. Where the change copies or mirrors behaviour from another function, run both on the same inputs beyond the listed cases, including combinations of arguments, and file any difference.${challenged ? '' : ' Return challenges=[] during code review.'}
That measurement is the gate result for this snapshot: don't rerun the verification command or the checks in it. Run only targeted probes, such as one test or one analyser on the changed files. Sandboxes can block the sockets that parallel workers use: if a probe fails that way, run the tool single-process.`}

# Findings and proposed responses
${JSON.stringify({ findings: p.findings, addressed: p.author.addressed })}

# Readings ledger
${JSON.stringify(p.readings)}
${pairLiveChecksNote(S)}
Use resolutions to update existing IDs: open if still actionable, fixed only after inspecting the correction, refuted only with evidence that the finding was mistaken. Give concrete evidence for every resolution. Reopen an old ID when its defect recurs. Missing resolutions leave findings open.${designed ? ' In design review, leave code findings open until the implementation is fixed; check that the revised design explains their correction.' : ''}${pairCarriedNote(S, 'reviewer')} Add only genuinely new defects in findings; the engine assigns their IDs. ${design ? PAIR_DESIGN_SEVERITY : 'Actionable minor findings count too.'} Put optional preferences and unrelated improvements in suggestions; do not manufacture findings to fill a quota.
In rulings, rule on every reading the ledger lists as proposed, exactly one ruling each, with evidence. Accept a reading only when it keeps the requirement's intent and the original task, reference documents or explicit user decisions support it; setup observations alone cannot. Reject it when the requirement can and must be met as written, citing what shows that; the engine files each rejected reading as a major finding. Rule needs-user only on a reading that one of your questions cites. Accepted readings are settled: hold the work to them and do not reopen them. Return rulings=[] when no reading is proposed.
Return a question in questions when a finding, new or existing, or a reading can be settled only by the user: two requirements that cannot both hold as written, or a requirement that a fact your evidence shows makes impossible as written, with no reading inside the task's words that settles it. Put the exact words of each requirement involved in quoted; in question, cite the finding or reading ID and give the options you see; say in summary what the user must decide. Keep any finding it concerns open as usual. A question stops the run and goes to the user at once, so ask it in the first review that can show the conflict, not after another round. Ordinary defects, missing evidence, unclear code and preferences are findings, never questions. Otherwise return questions=[].
Return an evidenced met/partial/unmet assessment for every acceptance criterion, exactly one each, with criterion set to its bare ID (C1, not the criterion's text); challenges name their criterion the same way. ${designed ? 'In code review, set requiresDesignRevision=true only if the implementation needs a materially different design; explain it in a finding. The engine will return the author to design review. In design review, keep that field false and express needed revisions as findings.' : 'This run has no design stage to return to: keep requiresDesignRevision false, and when the approach itself must change, say so in a finding; the author reworks it in the next implementation turn.'} Return complete=false if you cannot finish the review; an empty findings list is not approval in that case.`
}

// At design, minor findings don't hold the design: they stay open into the code stage, where every
// open finding blocks readiness. So design review spends its findings on what the design decides.
const PAIR_DESIGN_SEVERITY = 'Minor findings do not block design approval: they stay open, and code review checks them against the implementation, where every open finding blocks readiness. Blocker and major findings block design approval. At design, raise a new finding for a defect that affects an acceptance criterion, correctness or scope; leave benchmark, documentation and wording detail to code review unless a criterion depends on it.'

// Design findings still open at the code stage: minor ones the design was approved with, and any
// the user chose to carry into the implementation. Both participants hold them as code-stage items.
function pairCarriedNote(S, role) {
  const p = S.pair
  const ids = p.stage === 'code' && pairDesigned(S) ? pairOpen(S).filter(f => f.stage === 'design').map(f => f.id) : []
  if (!ids.length) return ''
  const list = ids.length === 1 ? `Design finding ${ids[0]} is` : `Design findings ${ids.join(', ')} are`
  return role === 'author'
    ? ` ${list} still open and carried into this implementation: fix each in the code, tests or documentation, or dispute it with evidence; the reviewer checks ${ids.length === 1 ? 'it' : 'them'} against the code.`
    : ` ${list} still open and carried into code review: resolve ${ids.length === 1 ? 'it' : 'each'} against the implementation, fixed once the code, tests or documentation address it, open otherwise.`
}

// The reviewer reads the live checks and leaves them alone: they are for the user to run, against
// the real thing, before delivery.
function pairLiveChecksNote(S) {
  const live = S.pair.liveChecks || []
  return live.length ? `\n# Live checks\n${JSON.stringify(live)}\nThese criteria are checked in this run only against a stand-in for something outside it, and the user runs each live check against the real thing before delivery. Assess them on the evidence inside this run, the stand-in included. Don't run the live checks (you have no network), and don't file the missing live result as a finding.\n` : ''
}

// The structured challenge a design review returns, and a code review without a design stage
// returns whenever the contract is new to review: for each criterion a plausible wrong
// implementation and the checks that reject it.
function pairChallengeRules(designed) {
  return `Return exactly one structured challenge per criterion in challenges: criterion, a substantive wrongImplementation, and rejectingCheckIds that resolve to contract checks covering that criterion: each cited check's criteria must include the challenged criterion (a check covering only C5 cannot reject a wrong implementation of C3). If no check rejects a plausible wrong implementation, return rejectingCheckIds=[] and raise an evidenced ${designed ? 'blocker or major finding, assess that criterion partial/unmet, or request design revision with the reason in summary' : 'finding, or assess that criterion partial/unmet'}. Never cite a check you believe is ineffective just to fill the array. Approval requires a rejecting check for every challenge. Describe a plausible incorrect result and its rejecting inspection for non-code criteria. Judge whether the checks actually reject that implementation; valid IDs alone are insufficient.`
}

// The design stage needs no gate run: setup measured the base revision, or on the standalone
// runtime the runner did, outside any model's sandbox. Focused checks are another matter: without
// them a design author proved its tests through reflection and auto_prepend workarounds, and could
// show neither that a planned test fails on base nor that a filter selects the tests it names.
function pairBaseline(S, author = false) {
  if (!S.verify) return ''
  return `${S.runnerBaseline ? 'The runner ran the verification command on the base revision, outside any model\'s sandbox,' : 'Setup ran the verification command on the base revision,'} and it ${S.baselineOk ? 'passed' : `failed: ${S.baselineNote}`}. Don't run that full command during the design stage. ` +
    (author ? 'Focused checks that gather evidence for the design are fine: a single test file or filter, one analyser on the files in question, a probe, or prototype code run against the existing tests from a scratch copy in this turn\'s probes directory. Use them to show, for example, that a planned test fails on base or that a filter selects the intended tests, and cite them in the design. Change no tracked file in the worktree until implementation. '
      : 'Focused checks of a claim in the design are fine: a single test file or filter, one analyser on the files in question, or a probe in your own checkout. ') +
    'The design says which of the full command\'s checks the implementation must pass and how the new tests are checked.'
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

// A native stop's record of the state a resume must find: wt/A's HEAD and files, and the snapshot
// ref the run last measured ('base' before the first code measurement). It never overwrites an
// earlier record, so at a resume the replayed turn leaves the original record in place.
function pairStopRecordPrompt(S, stop, tag) {
  return pairResumeCommandPrompt(S, `${S.cli} resume-check --run-dir ${shq(S.run.runDir)} --stop ${stop} --snapshot ${shq(tag)} --record`)
}

// Just before a native run continues past an answered stop: refuses when HEAD, the checkout, wt/A
// or the snapshot ref moved since the stop, or when this stop was continued with other answers.
function pairResumeCheckPrompt(S, stop, tag, answers) {
  return pairResumeCommandPrompt(S, `${S.cli} resume-check --run-dir ${shq(S.run.runDir)} --stop ${stop} --snapshot ${shq(tag)} --answers ${shq(answers)}`)
}

function pairResumeCommandPrompt(S, cmd) {
  return `You are transporting a deterministic check for the pair workflow. Do not review, change, or judge anything. Make one Bash call, exactly as written:
${cmd}
It prints one line of JSON with status and reason. Return status and reason exactly as printed. If the command fails without printing that JSON, return status error with the actual message in reason.`
}
