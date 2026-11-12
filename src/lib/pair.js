function newPairState() {
  return { stage: 'design', design: '', approvedDesign: '', testContract: null, approvedContract: null,
    replayMapping: [], findings: [], reviews: [], author: null, measurement: null, label: null, lastReview: null, signatures: [], stop: '', questions: [] }
}

// Pair decisions are shared by both hosts. Only the reviewer can close findings.
function parsePairArgs(args) {
  return parseArgs(args)
}

function parsePairConfig(args) {
  const raw = parsePairArgs(args)
  for (const key of ['tier', 'seats', 'simple', 'panel', 'spec', 'audit', 'roles', 'evidence']) {
    if (raw[key] !== undefined) throw new Error(`pair: ${key} is not a pair option; use author, reviewer, and maxReviews.`)
  }
  if (raw.mode && raw.mode !== 'implement') throw new Error('pair: this workflow delivers an implementation.')
  const author = parseSeat(raw.author || (raw.host === 'codex' ? 'sol' : 'opus'), raw.effort)
  const reviewer = parseSeat(raw.reviewer || (author.vendor === 'claude' ? 'astra' : 'opus'), raw.effort)
  const maxReviews = raw.maxReviews === undefined ? 8 : Number(raw.maxReviews)
  if (!Number.isSafeInteger(maxReviews) || maxReviews < 2 || maxReviews > 100) throw new Error('pair: maxReviews must be an integer from 2 to 100.')
  const config = parseConfig({ ...raw, mode: 'implement', retro: false,
    simple: { implementer: author.key, reviewer: reviewer.key } }, { workflow: 'pair', tier: 'simple' })
  // Setup writes the criteria and the gate, and the run inherits their quality: Sonnet setup dropped
  // a stated criterion and stopped on a guess where Opus setup did neither. So setup runs on Opus,
  // except that a Codex (or Gemini) author on the standalone runtime sets up as itself. Effort is the
  // shared setup default unless the user chose one; then setup runs at the author's effort. Native
  // setup reads only the model and always runs at medium.
  const setupKey = config.host === 'codex' && author.vendor !== 'claude' ? author.key : 'opus'
  const setup = raw.effort === undefined ? parseSeat(setupKey, ROLE_EFFORT.setup) : setupKey === author.key ? author : parseSeat(setupKey, author.effort)
  // Reuse setup and transport, without acquiring council roles or Simple escalation rules.
  return { ...config, raw, tier: 'pair', simple: null, panel: [], specReviewers: [],
    roles: { setup }, lineup: [hostSeat(config.host, author)],
    auditors: [{ ...hostSeat(config.host, reviewer), lens: 'review', id: 'PR' }],
    pairOptions: { author, reviewer, maxReviews } }
}

function pairVersion(S) {
  return S.pair.stage === 'design' ? `design:${promptHash(JSON.stringify([S.pair.design, S.pair.testContract]))}:${S.pair.measurement?.snapshot?.tree || 'base'}`
    : `code:${S.pair.measurement?.snapshot?.tree || 'unmeasured'}`
}

function pairReviewTag(S) {
  return S.pair.measurement?.snapshot?.ref?.slice(`refs/council/${S.run.runId}/A-`.length) || 'base'
}

function pairOpen(S) {
  return S.pair.findings.filter(f => f.status === 'open')
}

function pairRelativePath(S, path) {
  return typeof path === 'string' && !!path && !path.includes('\\') && !path.includes('\0') &&
    !/^[A-Za-z]:/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..')
}

function pairContractError(S, contract) {
  if (!contract || !Array.isArray(contract.testRoots) || !Array.isArray(contract.checks) || !contract.checks.length) return 'A concrete test contract is required.'
  const roots = contract.testRoots.map(r => r.path)
  if (new Set(roots).size !== roots.length || contract.testRoots.some(r => !pairRelativePath(S, r.path) || !String(r.evidence || '').trim())) return 'Test roots need distinct relative directories and repository evidence.'
  const inside = path => pairRelativePath(S, path) && roots.some(root => path.startsWith(root + '/'))
  const ids = new Set()
  for (const c of contract.checks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.id || '') || ids.has(c.id) ||
        !Array.isArray(c.criteria) || !c.criteria.length || new Set(c.criteria).size !== c.criteria.length || c.criteria.some(id => !S.criteria.some(x => x.id === id)) ||
        !String(c.scenario || '').trim() || !String(c.expected || '').trim() || !String(c.boundaries || '').trim()) return 'Contract checks need unique IDs, valid criteria, concrete scenarios, expected outcomes, and boundaries.'
    ids.add(c.id)
    if (c.kind === 'test') {
      if (!['changed', 'preserved'].includes(c.purpose) || !inside(c.file) || !String(c.command || '').trim() ||
          !Array.isArray(c.fixtures) || c.fixtures.some(f => !inside(f))) return `Executable check ${c.id} needs a purpose, test file, command, and fixtures under accepted test roots.`
    } else if (c.kind === 'gate') {
      if (c.purpose !== 'preserved' || !S.verify || c.command !== S.verify || c.file !== '' || !Array.isArray(c.fixtures) || c.fixtures.length) return `Gate check ${c.id} must preserve behavior using the exact designated gate, with no file or fixtures.`
    } else if (c.kind !== 'inspection' || !String(c.inspection || '').trim() || !String(c.reason || '').trim()) return `Check ${c.id} needs a concrete alternative inspection and reason.`
  }
  if (S.criteria.some(c => !contract.checks.some(check => check.criteria.includes(c.id)))) return 'The contract must cover every acceptance criterion.'
  return null
}

function pairChallengeError(S, review) {
  const contract = S.pair.testContract, error = pairContractError(S, contract)
  if (error) return error
  const challenges = review.challenges
  if (!Array.isArray(challenges) || challenges.length !== S.criteria.length ||
      new Set(challenges.map(c => c.criterion)).size !== S.criteria.length) return 'Design review needs one unique challenge for every acceptance criterion.'
  for (const c of challenges) {
    const rejectsDesign = review.requiresDesignRevision === true ||
      (review.findings || []).some(f => String(f.statement || '').trim() && String(f.evidence || '').trim() && ['blocker', 'major', 'minor'].includes(f.severity)) ||
      (review.criteria || []).some(a => a.criterion === c.criterion && ['partial', 'unmet'].includes(a.status) && String(a.note || '').trim())
    if (!S.criteria.some(x => x.id === c.criterion) || !String(c.wrongImplementation || '').trim() ||
        !Array.isArray(c.rejectingCheckIds) || (!c.rejectingCheckIds.length && !rejectsDesign) || new Set(c.rejectingCheckIds).size !== c.rejectingCheckIds.length ||
        c.rejectingCheckIds.some(id => !contract.checks.some(check => check.id === id && check.criteria.includes(c.criterion)))) return 'Design challenges need a plausible wrong implementation and valid rejecting checks covering that criterion.'
  }
  return null
}

function pairReplayRequest(S) {
  return { testRoots: (S.pair.approvedContract?.testRoots || []).map(r => r.path), mapping: S.pair.replayMapping }
}

function pairMappingError(S) {
  const checks = S.pair.approvedContract?.checks || []
  const roots = (S.pair.approvedContract?.testRoots || []).map(r => r.path)
  const inside = path => pairRelativePath(S, path) && roots.some(root => path.startsWith(root + '/'))
  for (const e of S.pair.replayMapping) {
    if (!inside(e.file) || !String(e.command || '').trim() || !Array.isArray(e.fixtures) || e.fixtures.some(f => !inside(f)) ||
        !Array.isArray(e.checkIds) || !e.checkIds.length || new Set(e.checkIds).size !== e.checkIds.length ||
        e.checkIds.some(id => !checks.some(c => c.id === id && c.kind === 'test'))) return 'Replay mappings require test files and fixtures under accepted roots, focused commands, and executable check IDs. Whole-suite obligations use kind=gate, never a directory mapping.'
  }
  const missing = checks.filter(c => c.kind === 'test' && !S.pair.replayMapping.some(e => e.checkIds.includes(c.id)))
  return missing.length ? `No replay mapping for ${missing.map(c => c.id).join(', ')}.` : null
}

function pairReplayReadiness(S, blocked, incomplete) {
  const p = S.pair, replay = p.measurement?.replay, request = pairReplayRequest(S)
  const mappingIdentity = entries => JSON.stringify(entries?.map(e => [e.file, e.command, e.checkIds, e.fixtures]))
  if (!replay || replay.snapshotTree !== p.measurement?.snapshot?.tree || !/^[0-9a-f]{40,64}$/.test(S.run?.head || '') || replay.base !== S.run.head ||
      !/^[0-9a-f]{40,64}$/.test(replay.snapshot || '') || JSON.stringify(replay.testRoots) !== JSON.stringify(request.testRoots) ||
      mappingIdentity(replay.mapping) !== mappingIdentity(request.mapping)) {
    incomplete.push('No compatible replay evidence for the measured snapshot and current mapping.')
    return
  }
  const checks = p.approvedContract?.checks || []
  for (const check of checks.filter(c => c.kind === 'gate')) {
    if (check.command !== S.verify || p.measurement?.suite?.command !== check.command || !p.measurement.suite.ran) incomplete.push(`No designated gate execution for ${check.id}.`)
    else if (!p.measurement.suite.passed) blocked.push(`Designated gate check ${check.id} failed.`)
  }
  for (const entry of p.replayMapping) {
    if (!Array.isArray(entry.checkIds) || !entry.checkIds.length || entry.checkIds.some(id => !checks.some(c => c.id === id && c.kind === 'test'))) incomplete.push('Replay mapping contains unknown or non-executable check IDs.')
  }
  for (const check of checks.filter(c => c.kind === 'test')) {
    const mappings = p.replayMapping.filter(e => e.checkIds?.includes(check.id))
    if (!mappings.length) { incomplete.push(`No replay mapping for ${check.id}.`); continue }
    for (const entry of mappings) {
      const records = side => (replay.records || []).filter(r => r.side === side && r.file === entry.file && r.command === entry.command &&
        r.checkIds?.includes(check.id) && r.attempted === true && r.revision === (side === 'base' ? replay.base : replay.snapshot) &&
        ((r.ran === true && r.hasExitCode === true && Number.isInteger(r.exitCode)) || String(r.launchError || '').trim()) &&
        (side === 'base' || r.tree === replay.snapshotTree))
      if (check.purpose === 'changed' && !records('base').length) incomplete.push(`No base execution result for ${check.id} (${entry.file}).`)
      const final = records('final')
      if (!final.length) incomplete.push(`No final execution result for ${check.id} (${entry.file}).`)
      else if (final.some(r => !r.ran || !r.hasExitCode || r.exitCode !== 0 || r.signal || r.timedOut || r.launchError || r.mutated?.length || r.passed !== true)) blocked.push(`Final executable check ${check.id} failed (${entry.file}).`)
    }
  }
}

function pairIngestReview(S, review) {
  const p = S.pair
  if (!review || review.version !== pairVersion(S) || review.complete !== true) return 'The reviewer did not complete a review of the current version.'
  if (p.stage === 'design') {
    const error = pairChallengeError(S, review)
    if (error) return error
  }
  const resolutions = review.resolutions || []
  const seen = new Set()
  for (const r of resolutions) {
    if (!p.findings.some(f => f.id === r.id) || seen.has(r.id) || !['open', 'fixed', 'refuted'].includes(r.status) || !String(r.evidence || '').trim()) {
      return 'The reviewer returned an invalid or unsupported finding resolution.'
    }
    if (p.stage === 'design' && r.status === 'fixed' && p.findings.find(f => f.id === r.id).stage === 'code') {
      return 'Implementation findings must be verified against code, not closed by a revised design.'
    }
    seen.add(r.id)
  }
  for (const f of review.findings || []) {
    if (!String(f.statement || '').trim() || !String(f.evidence || '').trim() || !['blocker', 'major', 'minor'].includes(f.severity)) {
      return 'The reviewer returned a finding without a statement, severity, or evidence.'
    }
  }
  for (const r of resolutions) {
    const f = p.findings.find(f => f.id === r.id)
    f.status = r.status
    f.resolution = r.evidence
    f.history.push({ review: p.reviews.length + 1, ...r })
  }
  for (const f of review.findings || []) {
    // Suppress literal repeats only. Reworded issues retain identity through resolutions,
    // never by fuzzy matching that could merge distinct defects.
    const same = p.findings.find(old => old.stage === p.stage && old.status === 'open' && old.statement.trim().replace(/\s+/g, ' ') === f.statement.trim().replace(/\s+/g, ' '))
    if (same) { same.history.push({ review: p.reviews.length + 1, status: 'open', evidence: f.evidence }); continue }
    p.findings.push({ ...f, id: `P${p.findings.length + 1}`, stage: p.stage, status: 'open', resolution: '', history: [] })
  }
  p.lastReview = review
  p.reviews.push({ stage: p.stage, label: p.label, ...review })
  return null
}

function pairReadiness(S) {
  const p = S.pair, r = p.lastReview
  const blocked = [], incomplete = []
  if (p.stop) incomplete.push(p.stop)
  if (!r || r.version !== pairVersion(S) || !r.complete) incomplete.push('The current version has no completed review.')
  for (const f of pairOpen(S).filter(f => p.stage === 'code' || f.stage === 'design')) blocked.push(`${f.id} (${f.severity}): ${f.statement}`)
  if (!S.criteria.length) incomplete.push('No acceptance criteria were established.')
  for (const c of S.criteria) {
    const assessments = (r?.criteria || []).filter(x => x.criterion === c.id)
    if (assessments.length !== 1 || !String(assessments[0].note || '').trim()) incomplete.push(`No single evidenced assessment of ${c.id}.`)
    else if (assessments[0].status !== 'met') blocked.push(`Criterion ${c.id} is ${assessments[0].status}.`)
  }
  if (p.stage === 'code') {
    if (!p.approvedDesign) incomplete.push('The design has not passed review.')
    if (!p.approvedContract) incomplete.push('The test contract has not passed review.')
    const m = p.measurement
    if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '')) incomplete.push('No measured snapshot of the current implementation.')
    if (S.verify && !m?.suite?.ran) incomplete.push('Required verification did not run.')
    else if (S.verify && !m.suite.passed) blocked.push('Required verification failed on the reviewed snapshot.')
    pairReplayReadiness(S, blocked, incomplete)
  }
  if (r?.requiresDesignRevision) blocked.push('The reviewer requires a revised design.')
  return { state: blocked.length ? 'blocked' : incomplete.length ? 'incomplete' : 'ready', blocked, incomplete }
}

function pairStalled(S) {
  const p = S.pair
  if (pairReadiness(S).state === 'ready') return false
  const signature = JSON.stringify([pairVersion(S), pairOpen(S).map(f => [f.id, f.statement]),
    p.lastReview?.criteria.map(c => [c.criterion, c.status]), p.lastReview?.requiresDesignRevision,
    p.measurement?.suite?.ran, p.measurement?.suite?.passed, pairReplayRequest(S),
    p.measurement?.replay?.exclusions, p.measurement?.replay?.records?.map(r => [r.side, r.file, r.command, r.checkIds, r.attempted, r.ran, r.hasExitCode, r.exitCode, r.signal, r.timedOut, r.launchError, r.passed, r.mutated])])
  p.signatures.push(signature)
  return p.signatures.length >= 2 && p.signatures.at(-2) === signature
}

function pairReviewClean(S) {
  const r = S.pair.lastReview
  return r?.complete && r.version === pairVersion(S) && !r.requiresDesignRevision && !pairOpen(S).length &&
    S.criteria.every(c => r.criteria.filter(a => a.criterion === c.id).length === 1 && r.criteria.some(a => a.criterion === c.id && a.status === 'met' && a.note?.trim()))
}

function pairResult(S, status = 'blocked') {
  const p = S.pair, m = p.stage === 'code' ? p.measurement : null
  const ready = pairReadiness(S)
  if (p.stage !== 'code' && ready.state === 'ready') {
    ready.state = 'incomplete'; ready.incomplete.push('Implementation has not been reviewed.')
  }
  const report = [`Pair: ${S.pairOptions.author.name} authors; ${S.pairOptions.reviewer.name} reviews.`,
    `Readiness: ${ready.state}. Reviews: ${p.reviews.length}/${S.pairOptions.maxReviews}.`,
    `Verification: ${!S.verify ? 'no automated gate configured; no test pass claimed' : !m?.suite?.ran ? 'not run on a final snapshot' : m.suite.passed ? 'passed on the reviewed snapshot' : 'failed on the reviewed snapshot'}.`,
    `Replay: ${m?.replay?.records?.length || 0} file/command records; ${m?.replay?.exclusions?.length || 0} overlay exclusions. Base outcomes require reviewer interpretation.`,
    ...ready.blocked, ...ready.incomplete,
    ...p.findings.map(f => `${f.id}: ${f.status} — ${f.statement}${f.resolution ? ` (${f.resolution})` : ''}`)].join('\n\n')
  return { status, workflow: 'pair', mode: 'implement', task: S.task, runDir: S.run?.runDir || null,
    repositoryNotes: S.repositoryNotes || '',
    room: S.run?.room || null, refs: S.refs, stage: p.stage, stopReason: p.stop,
    design: p.design, testContract: p.approvedContract || p.testContract, replayMapping: p.replayMapping,
    author: S.pairOptions.author.name, reviewer: S.pairOptions.reviewer.name,
    reviews: p.reviews, findings: p.findings, questions: p.questions, notes: S.notes,
    report: { markdown: report },
    final: { author: 'A', model: S.pairOptions.author.name, summary: p.author?.summary || '',
      worktree: S.seats[0]?.wt || null, post: p.label && S.run ? `${S.run.room}/${p.label}/A.md` : null,
      snapshotRef: m?.snapshot?.ref || null, snapshotTree: m?.snapshot?.tree || null, diff: m?.snapshot?.diff || null,
      suite: m?.suite || null, replay: m?.replay || null, criteria: p.lastReview?.criteria || [], readiness: ready },
    delivery: { status: status === 'done' && ready.state === 'ready' ? 'pending' : 'not-ready' },
    forTheOrchestrator: 'Read final.readiness first. Report unresolved findings or missing evidence before any success summary. ' +
      'Spot-check the reviewed snapshot and report the design and implementation review outcomes. The change stays in final.worktree. ' +
      'Deliver only within the user\'s authorization, preserving unrelated edits; use dark-factory verify-delivery afterward. ' +
      'Do not start a council automatically. The Codex host can resume a validated checkpoint with --resume hostRunDir; changed inputs or evidence require a new run.' }
}

