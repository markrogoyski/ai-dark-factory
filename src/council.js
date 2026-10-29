// ---------------------------------------------------------------- run

// The council flow, from setup to the report. A function, so the factory can run it after its
// own steps; /council calls it directly (main-council.js). Returns the run's result.
async function councilRun() {
  const stop = await councilSetup()
  if (stop) return stop
  const debated = await debateStage()
  if (debated.stop) return debated.stop
  const { outcome, decisionRows, decisionTable } = debated

  // ---- Synthesis

  phase('Synthesize')
  const W = seat(S, outcome.W)
  await synthesize(W, outcome, SYNTH_SCHEMA)

  // ---- Ratification

  phase('Ratify')
  const raters = active(S).filter(s => s.L !== W.L)
  const reviews = await parallel(raters.map(s => () => seatTurn(s, 'ratify', ratifyPrompt(S, s, W), RATIFY_SCHEMA)))
  const endorsements = [], dissent = [], objections = [], reviewNotes = []
  raters.forEach((s, i) => {
    const r = reviews[i]
    if (!r) { S.notes.push(`Seat ${s.L} did not return a ratification review.`); return }
    reviewNotes.push({ seat: s.L, endorse: !!r.endorse, note: r.note || '' })
    if (r.endorse) endorsements.push(s.L)
    for (const o of (r.objections || []).slice(0, 8)) {
      if (!o || !o.statement) continue
      const c = addClaim(S, {
        round: 'F', author: s.L, kind: 'finding', target: W.L, severity: W8[o.severity] ? o.severity : 'minor',
        judgment: o.kind === 'judgment', statement: o.statement, evidence: o.evidence,
      })
      objections.push(c)
    }
    if (!r.endorse) dissent.push({ seat: s.L, kind: 'did not endorse', note: r.note || '' })
  })
  // Judgment arguments are never adjudicated, so a seat can endorse while still disagreeing.
  // Report the ones against the base position from seats that didn't vote for it.
  {
    const lv = lastVoteRound(S)
    const lastVotes = lv === null ? {} : S.votes[lv]
    for (const c of S.ledger) {
      if (c.kind !== 'finding' || !c.judgment || c.withdrawn || c.target !== W.L) continue
      if (lastVotes[c.author] && lastVotes[c.author].ship === W.L) continue
      dissent.push({ seat: c.author, kind: 'judgment', claim: c.id, severity: c.severity, note: c.statement })
    }
  }

  const toPanel = objections.filter(c => !c.judgment && (c.severity === 'blocker' || c.severity === 'major'))
  let fixPass = false
  if (toPanel.length) {
    log(`ratify: ${toPanel.length} blocking objection(s) to adjudicate: ${toPanel.map(c => c.id).join(', ')}`)
    const results = await panelRun('F', toPanel.map(c => c.id))
    applyPanel(S, toPanel.map(c => c.id), results)
    const upheld = toPanel.filter(c => c.status === 'verified')
    if (upheld.length) {
      fixPass = true
      log(`ratify: ${upheld.length} objection(s) upheld; ${W.L} gets one fix pass`)
      const fix = await seatTurn(W, 'G', fixPrompt(S, W, upheld), SYNTH_SCHEMA)
      if (fix) {
        S.pos[W.L] = { ...S.pos[W.L], summary: fix.summary || S.pos[W.L].summary, post: postPath(S, W.L, 'G') }
        ingestClaims(S, W.L, 'G', fix.claims)
        keepDeclined(S, 'G', fix)
      } else {
        S.notes.push(`${W.L}'s fix pass failed; the upheld objections stand.`)
      }
      await runChecks('G', W.L)
    }
  }

  // ---- Audit

  S.auditedTag = fixPass ? 'final2' : 'final'
  const audit = await runAudit(W)

  // ---- Report

  const finalTag = audit.fixPass ? roundTag('I') : S.auditedTag
  const lastCheck = audit.fixPass ? 'I' : audit.checked ? 'H' : fixPass ? 'G' : 'F'
  const remaining = S.ledger.filter(c => isStanding(S, c) && c.target === W.L)
  const unanswered = S.questions.filter(q => !answered(S, q.id))
  const ready = readiness(S, W.L, lastCheck, raters, reviews, audit.gaps)
  const report = finalReport(S, { outcome, W, rows: decisionRows, endorsements, raters, reviewNotes, objections, fixPass, dissent, remaining, unanswered, ready, audit })

  if (S.retro) phase('Retro')
  const retro = await runRetro({ outcome, endorsements, fixPass, ready, audit, reportMd: report.markdown })

  return {
    status: outcome.kind === 'consensus' ? 'converged' : 'scorecard',
    mode: S.mode,
    task: S.task,
    runDir: S.run.runDir,
    room: S.run.room,
    roundsRun: S.lastRound,
    refs: S.refs,
    report,
    outcome: {
      how: outcome.kind === 'consensus'
        ? outcome.via === 'blind'
          ? `Converged in round 0, before any debate: ${outcome.same.join(', ')} wrote byte-identical versions, so ${outcome.W} ships.`
          : `Converged ${outcome.ballot ? 'in the ballot after' : 'in'} round ${outcome.round}${outcome.via === 'approval' ? ' by approval' : ''}: ${outcome.voters.join(', ')} voted to ship ${outcome.W}.`
        : `No consensus after ${outcome.round} round(s). The scorecard picked ${outcome.W} as the base.`,
      base: outcome.W,
      votesByRound: S.votes,
      ...(S.ballot ? { ballotsByRound: S.ballots } : {}),
      leftContention: S.dropped,
    },
    final: {
      author: W.L,
      model: W.name,
      summary: S.pos[W.L].summary,
      post: S.pos[W.L].post,
      diff: S.mode === 'implement' ? `${S.run.room}/${finalTag}/${W.L}.diff` : null,
      snapshotRef: S.mode === 'implement' ? `refs/council/${S.run.runId}/${W.L}-${finalTag}` : null,
      worktree: W.wt,
      check: finalSummary(S, W.L),
      readiness: ready,
      suite: S.pos[W.L].suite,
      criteria: S.pos[W.L].criteria,
      endorsedBy: endorsements,
      reviews: reviewNotes,
      notEndorsedBy: raters.filter(s => !endorsements.includes(s.L)).map(s => s.L),
      objections: objections.map(c => ({ id: c.id, from: c.author, severity: c.severity, kind: c.judgment ? 'judgment' : 'fact', status: c.fixed ? 'fixed' : c.status, statement: c.statement, note: c.note })),
      fixPass,
      auditFixPass: audit.fixPass,
      standingFindings: remaining.map(c => ({ id: c.id, from: c.author, severity: c.severity, status: c.status, statement: c.statement })),
    },
    scorecards: {
      positions: decisionRows,
      seats: seatRows(S),
      markdown: `### Positions at the end of the debate\n\n${decisionTable}\n\n### Final version (${W.L})\n\n${finalSummary(S, W.L)}\n\n### Seats\n\n${seatTable(S)}`,
    },
    spec: specResult(S),
    audit: auditResult(S, audit),
    dissent,
    assumptions: unanswered.map(q => ({ id: q.id, question: q.text, raisedBy: q.raisedBy, secondedBy: q.seconds, assumptions: q.assumptions })),
    clarificationsUsed: S.clarifications,
    seats: reveal(S),
    ledger: { claims: S.ledger.length, byStatus: S.ledger.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m }, {}) },
    notes: S.notes,
    retro,
    forTheOrchestrator:
      `${ready.state === 'ready' ? '' : `The final version is ${ready.state.toUpperCase()} (final.readiness: ${[...ready.blocked, ...ready.incomplete].join('; ')}). Say so at the top of your summary, before anything else. `}` +
      (S.spec.assumptions.length
        ? `Before any work began, the council assumed ${plural(S.spec.assumptions.length, 'answer')} to questions about the request that only the user can settle (spec.assumptions; report.markdown opens with them). ` +
          'The result is built on them, so list them next, each as a question the user can answer yes or no. If one is wrong, the fix is a new run with the answer in the task or the context. '
        : '') +
      'You present this; you do not re-decide it, and you do not relay it unread. Read the final post' +
      (S.mode === 'implement' ? ' and diff' : '') + ' yourself and spot-check its load-bearing claims before repeating them. ' +
      'Then give the user the council\'s report, in this order: ' +
      '(1) a summary in your own words: a short paragraph on what the task was, which seat\'s work the council went with (by model) and why ' +
      '(the consensus and the voters\' reasons, or the scorecard criterion that put it ahead of the runner-up; see report.markdown\'s "Chosen" section), ' +
      'what the other seats proposed (by model), and how it ended' +
      (audit.ran ? ', including what the independent audit found and how its findings were settled' : '') + '; then the debate topics as a short list, one line each on what was argued and how it was settled ' +
      '(from "The debates"; say so if there were none); ' +
      '(2) report.markdown, which is computed from the ledger: what was chosen and why, the positions, how the debate went round by round, the main debates, and how it turned out. ' +
      'Keep its facts, seats and rulings as they are; you may tighten the wording, and open a post in the room if a debate needs explaining; ' +
      '(3) scorecards.markdown; (4) what your spot-check found, including anything you disagree with' +
      (S.mode === 'implement'
        ? '; (5) a suggested commit message for the final change, in a code block. Write it yourself from the final diff, after a look at ' +
          '`git log --oneline -15` to match the repository\'s style. Keep it concise: one imperative subject line, plus a short body only if ' +
          'the change genuinely needs one. Describe the change itself: no references to plan documents or their steps, to the council, ' +
          'seats or models, and no Co-Authored-By or other attribution lines. Use it if the user later asks you to commit' +
          (retro && retro.markdown ? '; ' : '. ')
        : (retro && retro.markdown ? '; ' : '. ')) +
      (retro && retro.markdown
        ? `(${S.mode === 'implement' ? 6 : 5}) last, retro.markdown as it is: the council's notes on its own process, for tuning the /council workflow. ` +
          'They are about the workflow, not the user\'s project, so don\'t act on them unless the user asks. '
        : '') +
      'Run `git status` in the main tree to confirm no seat touched it. ' +
      (S.mode === 'implement'
        ? deliveryNote(S, finalTag, W, 'The final change')
        : '') +
      `The room (${S.run.room}) holds the full transcript. When the user is done with it, \`${S.cli} cleanup --run-dir ${S.run.runDir}\` ` +
      'removes the worktrees and snapshot refs and keeps the transcript; add --all to delete everything. ' +
      `Codex and Gemini token usage: \`${S.cli} usage --run-dir ${S.run.runDir}\`.`,
  }
}

// Setup and the spec review: the run directory, the seats and the criteria, before anyone starts.
// Shared with the factory's Feature tier. Returns the run's result when it stops here, else null.
async function councilSetup() {
  phase('Setup')
  const setup = await ask(setupPrompt(S), { label: 'setup', phase: 'Setup', schema: SETUP_SCHEMA, model: 'opus', effort: 'medium' }, 'setup')
  if (setup && setup.status === 'needs-plan') return needsPlan(S, setup.planMissing, setup.runDir)
  if (setup && setup.status === 'preflight') {
    const bad = (setup.preflight || []).filter(p => p && !p.ok)
    return preflightStop(S, bad.length ? bad : [{ vendor: '?', ok: false, error: setup.error || 'the preflight check did not pass' }])
  }
  if (!setup || setup.status === 'error' || !setup.runDir) {
    return failure(S, 'failed', setup ? (setup.error || 'setup returned no run directory') : 'the setup agent failed')
  }
  S.run = { runId: setup.runId, runDir: setup.runDir, repoRoot: setup.repoRoot, room: `${setup.runDir}/room` }
  if (!S.modeGiven && MODES.includes(setup.mode) && setup.mode !== S.mode) {
    log(`setup chose mode ${setup.mode} (the task's wording suggested ${S.mode})`)
    S.mode = setup.mode
    S.postWords = WORDS_BY_MODE[S.mode]
  }
  if (setup.status === 'dirty') {
    return failure(S, 'blocked', `the working tree has uncommitted changes to tracked files (${setup.dirty.slice(0, 10).join(', ')}). ` +
      'Seats work from HEAD and would not see them. Commit or stash first, or rerun with allowDirty: true', { dirty: setup.dirty })
  }
  S.criteria = (setup.criteria || []).filter(c => c && c.id && c.text)
  // Only snapshots inside this run's refs/ directory; anything else is a setup mistake, not a document.
  S.refs = (setup.refs || []).filter(r => r && typeof r.path === 'string' && r.path.startsWith(`${S.run.runDir}/refs/`))
    .map(r => ({ source: String(r.source || ''), path: r.path, inWorktrees: !!r.inWorktrees }))
  if ((setup.refs || []).length !== S.refs.length) S.notes.push('Setup reported reference documents outside the run\'s refs/ directory; they were ignored.')
  if (S.plan.length && S.refs.length < S.plan.length) S.notes.push(`${plural(S.plan.length, 'plan document')} given, but setup snapshotted only ${S.refs.length}.`)
  S.verify = String(setup.verify || '').trim()
  S.baselineOk = S.mode !== 'implement' || !S.verify || setup.baselinePasses
  // Expected when the task is to fix a failing test, so it is reported as a fact, not a problem.
  if (!S.baselineOk) S.baselineNote = oneLine(setup.baselineNote, 300) || 'no reason given'

  const order = permutation(S.lineup.length, fnv(S.run.runId))
  S.seats = S.letters.map((L, i) => ({ L, ...S.lineup[order[i]], wt: `${S.run.runDir}/wt/${L}`, active: true }))
  for (const s of S.seats) S.behaviour[s.L] = { turns: [], capitulations: [], ignored: [] }

  log(`council: mode=${S.mode}, ${S.seats.length} seats, up to ${S.rounds} debate rounds, consensus at ${consensusAt(S)}${crossVendor(S) ? ` incl. ${crossVendorText(S)}` : ''}, escalate at ${escalateAt(S)}`)
  log(`seats (hidden from the seats): ${S.seats.map(s => `${s.L}=${s.name}/${s.effort}`).join(', ')}`)
  log(`room: ${S.run.room} · criteria: ${S.criteria.map(c => c.id).join(', ') || 'none'} · verify: ${S.verify || 'none'}`)
  if (S.refs.length) log(`reference documents: ${S.refs.map(r => r.source).join(', ')}`)

  const specQs = await runSpecReview()
  if (specQs) return specQuestions(S, specQs)
  return null
}

// Round 0, blind, and the debate rounds, up to the position the run builds on. Shared with the
// Feature tier, whose positions are plans. Returns {stop: result} when the run stops here.
async function debateStage() {
  phase('Solve')
  const solved = await parallel(S.seats.map(s => () => seatTurn(s, 0, solvePrompt(S, s), SOLVE_SCHEMA)))
  S.seats.forEach((s, i) => {
    if (solved[i]) ingestSolve(S, s, solved[i])
    else { s.active = false; S.notes.push(`Seat ${s.L} (${s.name}) failed in round 0 and was dropped.`) }
  })
  if (active(S).length < 2) return { stop: failure(S, 'failed', 'fewer than two seats produced a solution', { seats: reveal(S) }) }

  await runChecks(0)
  await clusterQuestions(0)
  let escalate = escalation(S, 0)
  if (escalate.length) return { stop: needsUser(S, 0, escalate) }

  // ---- Debate rounds

  let outcome = null
  const blind = blindAgreement(S)
  if (blind) {
    outcome = { kind: 'consensus', W: blind.W, voters: [], same: blind.same, via: 'blind', round: 0 }
    log(`round 0: ${blind.same.join(', ')} are byte-identical and pass verification → skipping the debate; ${blind.W} writes the final version`)
  }
  for (let k = 1; k <= S.rounds && !outcome; k++) {
    phase(`Round ${k}`)
    S.lastRound = k
    const known = knownStanding(S)
    const seated = active(S)
    const posts = await parallel(seated.map(s => () => seatTurn(s, k, debatePrompt(S, s, k), DEBATE_SCHEMA)))
    seated.forEach((s, i) => {
      if (posts[i]) ingestDebate(S, s, k, posts[i])
      else S.notes.push(`Seat ${s.L} returned nothing in round ${k}; it keeps its round-${k - 1} position and abstains.`)
    })

    await runChecks(k)
    behaviourAfter(S, k, known)
    await clusterQuestions(k)
    escalate = escalation(S, k)
    if (escalate.length) return { stop: needsUser(S, k, escalate) }

    const c = consensus(S, k)
    log(`round ${k}: ${votesLine(S, k)}${c ? ` → consensus on ${c.W} (${c.voters.join(', ')}${c.via === 'approval' ? ', by approval' : c.via === 'identical' ? `, identical to ${c.same.filter(X => X !== c.W).join(', ')}` : ''})` : ' → no consensus'}`)
    if (c) { outcome = { kind: 'consensus', W: c.W, voters: c.voters, first: c.first, same: c.same, via: c.via, round: k }; break }
    if (k >= 2 && stable(S, k)) { log('no position or vote changed this round; stopping the debate'); break }
    const b = S.ballot && k < S.rounds ? await runBallot(k) : null
    if (b) outcome = { kind: 'consensus', W: b.W, voters: b.voters, first: b.first, same: b.same, via: b.via, ballot: true, round: k }
    else if (k < S.rounds) {
      const narrowed = narrow(S, k)
      if (narrowed) log(narrowed)
    }
  }

  // The scorecard as it stood when the base was chosen. Reported as-is: the final version is
  // re-checked separately, and mixing it into this table would compare unlike versions.
  const decisionRows = rankPositions(S)
  const decisionTable = positionTable(S)
  if (!outcome) {
    outcome = { kind: 'scorecard', W: decisionRows[0].seat, voters: [], round: S.lastRound }
    log(`no consensus after ${S.lastRound} round(s); scorecard picks ${outcome.W} as the base`)
  }
  return { outcome, decisionRows, decisionTable }
}

// The author of the chosen position writes the final version, which is then checked. Returns what
// the turn returned (null if it failed). The Feature tier passes a schema that also lists its increments.
async function synthesize(W, outcome, schema) {
  const synth = await seatTurn(W, 'F', synthPrompt(S, W, outcome, S.lastRound), schema)
  if (!synth) {
    S.notes.push(`Synthesis by ${W.L} failed; the final version is ${W.L}'s round-${S.pos[W.L].round} position as it stands.`)
  } else {
    S.pos[W.L] = { ...S.pos[W.L], summary: synth.summary || S.pos[W.L].summary, post: postPath(S, W.L, 'F') }
    keepNotes(S, W, 'F', synth)
    for (const a of (synth.adopted || []).filter(a => a && isLetter(S, a.from) && a.from !== W.L && a.idea)) {
      S.adoptions.push({ round: 'F', by: W.L, from: a.from, idea: a.idea })
    }
    ingestClaims(S, W.L, 'F', synth.claims)
    keepDeclined(S, 'F', synth)
  }
  await runChecks('F', W.L)
  return synth
}
