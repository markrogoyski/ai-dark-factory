// Offline comparisons. No models, network, pricing assumptions, or account configuration.
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { guardEngine, environmentPin } from './engine.mjs'

export function tokenUsage(directories) {
  const byModel = {}
  let records = 0
  for (const dir of new Set(directories)) {
    const path = join(dir, 'usage.jsonl')
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line), row = byModel[r.model] || (byModel[r.model] = {})
      for (const [key, value] of Object.entries(r.usage || {})) if (Number.isFinite(value) && value >= 0) row[key] = (row[key] || 0) + value
      records++
    }
  }
  return records ? { records, byModel } : null
}

export function summarize(results) {
  const groups = {}, paired = {}, seen = new Set()
  for (const { result, source, delivery, observation } of results) {
    const id = result.hostRunDir || result.runDir || source
    if (seen.has(id)) continue
    seen.add(id)
    const m = result.metrics
    if (!m || m.version !== 1) throw new Error(`Missing supported metrics in ${source}`)
    const key = [m.host, m.workflow, m.tier || '-', m.strategy, m.variant || 'default', m.scope || 'complete'].join('/')
    const group = groups[key] || (groups[key] = { runs: 0, ready: 0, delivered: 0, deliveryFailed: 0, deliveryUnknown: 0, postDeliveryObserved: 0, postDeliveryRegressions: 0, escalated: 0,
      turns: 0, timedRuns: 0, elapsedMs: 0, elapsedSources: {}, failedTurns: 0, candidates: 0, readyCandidates: 0, runsWithReadyCandidate: 0, findingsByStage: {}, tokensByModel: {}, tokenMeasuredRuns: 0, tokenSources: {}, taskIds: new Set() })
    group.runs++; group.ready += m.readiness === 'ready' ? 1 : 0
    group.turns += m.turns || 0; group.failedTurns += m.failedTurns || 0; group.escalated += m.escalated ? 1 : 0
    group.candidates += m.candidates?.total || 0; group.readyCandidates += m.candidates?.ready || 0
    if (m.candidates?.ready > 0) group.runsWithReadyCandidate++
    // Older native facts estimated wall time from run.json mtime, including idle resumes.
    if (m.elapsedFrom !== 'setup' && m.elapsedMs !== null && Number.isFinite(m.elapsedMs)) {
      group.timedRuns++; group.elapsedMs += m.elapsedMs
      const source = m.elapsedSource || 'recorded'
      group.elapsedSources[source] = (group.elapsedSources[source] || 0) + 1
    }
    const deliveryState = delivery?.status || result.delivery?.status
    if (deliveryState === 'delivered') group.delivered++
    else if (delivery && deliveryState !== 'pending') group.deliveryFailed++
    else group.deliveryUnknown++
    if (observation) {
      if (!['passed', 'regression'].includes(observation.status) || !String(observation.evidence || '').trim()) throw new Error(`Invalid post-delivery observation for ${source}`)
      group.postDeliveryObserved++
      if (observation.status === 'regression') group.postDeliveryRegressions++
    }
    if (m.taskId) {
      group.taskIds.add(m.taskId)
      const taskKey = m.taskId + (m.repositoryHead ? '@' + m.repositoryHead : '@revision-unknown')
      const cell = paired[taskKey] || (paired[taskKey] = {})
      const variant = cell[key] || (cell[key] = { runs: 0, ready: 0, turns: 0 })
      variant.runs++; variant.ready += m.readiness === 'ready' ? 1 : 0; variant.turns += m.turns || 0
    }
    for (const [stage, values] of Object.entries(m.findingsByStage || {})) {
      const row = group.findingsByStage[stage] || (group.findingsByStage[stage] = {})
      for (const [field, value] of Object.entries(values)) row[field] = (row[field] || 0) + value
    }
    const tokenGroups = m.tokens?.byModel ? [m.tokens.byModel] : [m.tokens?.external, m.tokens?.claude].filter(Boolean)
    if (tokenGroups.some(models => Object.keys(models).length)) {
      group.tokenMeasuredRuns++
      const source = m.tokenSource || 'recorded'
      group.tokenSources[source] = (group.tokenSources[source] || 0) + 1
      for (const models of tokenGroups) for (const [model, usage] of Object.entries(models)) {
        const row = group.tokensByModel[model] || (group.tokensByModel[model] = {})
        for (const [field, value] of Object.entries(usage)) if (!['turns', 'messages'].includes(field) && Number.isFinite(value) && value >= 0) row[field] = (row[field] || 0) + value
      }
    }
  }
  for (const group of Object.values(groups)) {
    group.taskIds = [...group.taskIds].sort()
    group.turnsPerReadyResult = group.ready ? group.turns / group.ready : null
    group.turnsPerReadyCandidate = group.readyCandidates ? group.turns / group.readyCandidates : null
    group.readyRate = group.ready / group.runs
    group.escalationRate = group.escalated / group.runs
    group.elapsedMsPerReadyResult = group.ready && group.timedRuns === group.runs ? group.elapsedMs / group.ready : null
  }
  return { version: 1, runs: seen.size, groups, matchedTasks: paired,
    interpretation: 'Compare repeated runs on the same task IDs and repository revisions. Readiness is process evidence, not proof of correctness. Delivery failures are measured only when delivery.json exists; missing token, time and dollar costs remain unknown, and helper-usage token totals (tokenSources) omit native Claude turns. Findings may overlap across reviewers. No default tuning is performed.' }
}

// Native results have no exact clock; the helper's timeline gives their active time. Mirrors
// timeline_elapsed in bin/dark-factory: jobs count in full, other gaps up to 15 minutes.
const TIMELINE_GAP_MS = 15 * 60 * 1000
export function timelineElapsed(runDir) {
  const path = runDir && join(runDir, 'timeline.jsonl')
  if (!path || !existsSync(path)) return null
  const events = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try { const e = JSON.parse(line), at = Date.parse(e.at); if (Number.isFinite(at)) events.push({ ...e, at }) } catch {}
  }
  if (!events.length) return null
  events.sort((a, b) => a.at - b.at)
  const open = {}, spans = []
  for (const e of events) {
    if (e.event === 'job-start' && e.job) open[e.job] = e.at
    else if (e.event === 'job-end' && e.job in open) { spans.push([open[e.job], e.at]); delete open[e.job] }
  }
  const points = [...new Set(events.map(e => e.at))].sort((a, b) => a - b)
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    total += spans.some(([start, end]) => start <= a && b <= end) ? b - a : Math.min(b - a, TIMELINE_GAP_MS)
  }
  return Math.round(total)
}

// A native workflow can read no files, so its result has no clock and tokens: null. Fill both from
// what the helper wrote to the run directory. The Codex host's recorded values always win. The
// helper's usage.jsonl holds only the external CLI turns (Codex, Gemini), not the native Claude
// turns, so those totals are labelled and must not be read as the run's complete usage.
export function fillNativeMetrics(result) {
  const m = result?.metrics
  if (!m || m.host === 'codex') return result
  if (m.elapsedMs === null || m.elapsedMs === undefined || m.elapsedFrom === 'setup') {
    const elapsed = timelineElapsed(result.runDir)
    if (elapsed !== null) { Object.assign(m, { elapsedMs: elapsed, elapsedSource: 'helper-timeline' }); delete m.elapsedFrom }
  }
  if ((m.tokens === null || m.tokens === undefined) && result.runDir) {
    try {
      const tokens = tokenUsage([result.runDir])
      if (tokens) Object.assign(m, { tokens, tokenSource: 'helper-usage', nativeClaudeTurnsIncluded: false })
    } catch (error) { m.tokenError = error.message }
  }
  return result
}

export function evaluateFiles(files, observations = {}) {
  let evaluator = null
  const summary = summarize(files.map(source => {
    const result = fillNativeMetrics(JSON.parse(readFileSync(source, 'utf8')))
    const pin = result.provenance?.executor
    if (pin?.mode === 'pinned') {
      const own = guardEngine(environmentPin() || pin)
      if (own.packageDigest !== pin.packageDigest) throw new Error('Authoritative evaluator differs from recorded executor')
      evaluator = { packageDigest: own.packageDigest, entrypoint: 'lib/evaluate.mjs' }
    }
    const path = result.runDir && join(result.runDir, 'delivery.json')
    const delivery = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    return { source, result, delivery, observation: observations[result.hostRunDir] || observations[result.runDir] }
  }))
  return evaluator ? { ...summary, evaluator } : summary
}

// Find every host run under a repository's .council, so failed and interrupted runs are counted
// next to the completed ones rather than left out because nobody listed them.
export function collectResults(directory) {
  const base = existsSync(join(directory, '.council')) ? join(directory, '.council') : directory
  const files = [], incomplete = []
  for (const name of readdirSync(base).sort()) {
    const run = join(base, name)
    if (!name.startsWith('host-') || !statSync(run).isDirectory() || !existsSync(join(run, 'host.json'))) continue
    const file = join(run, 'result.json')
    if (!existsSync(file)) { incomplete.push({ hostRunDir: run, reason: existsSync(join(run, 'host.lock')) ? 'running or killed without a result' : 'no result recorded' }); continue }
    let result = null
    try { result = JSON.parse(readFileSync(file, 'utf8')) } catch { incomplete.push({ hostRunDir: run, reason: 'unreadable result.json' }); continue }
    if (result?.metrics?.version !== 1) { incomplete.push({ hostRunDir: run, reason: 'result has no supported metrics' }); continue }
    files.push(file)
  }
  return { base, files, incomplete }
}

export function evaluationMain(argv) {
  if (argv.includes('--help') || !argv.length) {
    process.stdout.write('Usage: dark-factory-evaluate [--output summary.json] [--outcomes outcomes.json] [--collect REPO] [result.json ...]\nOffline aggregation of recorded outcomes, turns, tokens, findings and delivery checks. --collect adds every host run under REPO/.council and lists runs without a usable result. Use evaluation: {taskId, variant, repetition} in run arguments for matched comparisons.\n')
    return
  }
  const files = [], options = {}, collected = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') { if (!argv[i + 1]) throw new Error('--output needs a path'); options.output = resolve(argv[++i]) }
    else if (argv[i] === '--outcomes') { if (!argv[i + 1]) throw new Error('--outcomes needs a path'); options.observations = JSON.parse(readFileSync(resolve(argv[++i]), 'utf8')) }
    else if (argv[i] === '--collect') { if (!argv[i + 1]) throw new Error('--collect needs a directory'); collected.push(collectResults(resolve(argv[++i]))) }
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option: ${argv[i]}`)
    else files.push(resolve(argv[i]))
  }
  for (const found of collected) files.push(...found.files)
  if (!files.length) throw new Error('Provide at least one result.json.')
  const summary = evaluateFiles([...new Set(files)], options.observations)
  if (collected.length) summary.collected = collected.map(({ base, files, incomplete }) => ({ base, results: files.length, incomplete }))
  const json = JSON.stringify(summary, null, 2) + '\n'
  if (options.output) writeFileSync(options.output, json)
  process.stdout.write(json)
}
