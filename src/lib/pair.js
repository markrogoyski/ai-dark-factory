function newPairState() {
  return { stage: 'design', design: '', approvedDesign: '', findings: [], reviews: [], author: null, measurement: null, label: null, lastReview: null, signatures: [], stop: '', questions: [] }
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
  // Reuse setup and transport, without acquiring council roles or Simple escalation rules.
  return { ...config, raw, tier: 'pair', simple: null, panel: [], specReviewers: [],
    roles: { setup: author }, lineup: [hostSeat(config.host, author)],
    auditors: [{ ...hostSeat(config.host, reviewer), lens: 'review', id: 'PR' }],
    pairOptions: { author, reviewer, maxReviews } }
}

function pairVersion(S) {
  return S.pair.stage === 'design' ? `design:${promptHash(S.pair.design)}:${S.pair.measurement?.snapshot?.tree || 'base'}`
    : `code:${S.pair.measurement?.snapshot?.tree || 'unmeasured'}`
}

function pairReviewTag(S) {
  return S.pair.measurement?.snapshot?.ref?.slice(`refs/council/${S.run.runId}/A-`.length) || 'base'
}

function pairOpen(S) {
  return S.pair.findings.filter(f => f.status === 'open')
}

function pairIngestReview(S, review) {
  const p = S.pair
  if (!review || review.version !== pairVersion(S) || review.complete !== true) return 'The reviewer did not complete a review of the current version.'
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
    const m = p.measurement
    if (!m || m.status !== 'done' || !/^[0-9a-f]{40,64}$/.test(m.snapshot?.tree || '')) incomplete.push('No measured snapshot of the current implementation.')
    if (S.verify && !m?.suite?.ran) incomplete.push('Required verification did not run.')
    else if (S.verify && !m.suite.passed) blocked.push('Required verification failed on the reviewed snapshot.')
  }
  if (r?.requiresDesignRevision) blocked.push('The reviewer requires a revised design.')
  return { state: blocked.length ? 'blocked' : incomplete.length ? 'incomplete' : 'ready', blocked, incomplete }
}

function pairStalled(S) {
  const p = S.pair
  const signature = JSON.stringify([pairVersion(S), pairOpen(S).map(f => [f.id, f.statement]),
    p.lastReview?.criteria.map(c => [c.criterion, c.status]), p.lastReview?.requiresDesignRevision,
    p.measurement?.suite?.ran, p.measurement?.suite?.passed])
  p.signatures.push(signature)
  return p.signatures.length >= 2 && p.signatures.at(-2) === signature
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
    ...ready.blocked, ...ready.incomplete,
    ...p.findings.map(f => `${f.id}: ${f.status} — ${f.statement}${f.resolution ? ` (${f.resolution})` : ''}`)].join('\n\n')
  return { status, workflow: 'pair', mode: 'implement', task: S.task, runDir: S.run?.runDir || null,
    room: S.run?.room || null, refs: S.refs, stage: p.stage, stopReason: p.stop,
    design: p.design, author: S.pairOptions.author.name, reviewer: S.pairOptions.reviewer.name,
    reviews: p.reviews, findings: p.findings, questions: p.questions, notes: S.notes,
    report: { markdown: report },
    final: { author: 'A', model: S.pairOptions.author.name, summary: p.author?.summary || '',
      worktree: S.seats[0]?.wt || null, post: p.label && S.run ? `${S.run.room}/${p.label}/A.md` : null,
      snapshotRef: m?.snapshot?.ref || null, snapshotTree: m?.snapshot?.tree || null, diff: m?.snapshot?.diff || null,
      suite: m?.suite || null, criteria: p.lastReview?.criteria || [], readiness: ready },
    delivery: { status: status === 'done' && ready.state === 'ready' ? 'pending' : 'not-ready' },
    forTheOrchestrator: 'Read final.readiness first. Report unresolved findings or missing evidence before any success summary. ' +
      'Spot-check the reviewed snapshot and report the design and implementation review outcomes. The change stays in final.worktree. ' +
      'Deliver only within the user\'s authorization, preserving unrelated edits; use dark-factory verify-delivery afterward. ' +
      'Do not start a council automatically. The Codex host can resume a validated checkpoint with --resume hostRunDir; changed inputs or evidence require a new run.' }
}
