// Past runs, for --explain's estimate. The source is the standalone runner's own record of each run:
// <repo>/.council/host-*/result.json, whose metrics hold the exact active time (elapsedMs) and the
// accountant's token total, and whose plan names the lineup. Native Claude Code runs write no
// result file and their time is reconstructed from the helper's timeline, so they are not used.
// DARK_FACTORY_HISTORY adds directories (colon-separated) searched for the same files: a repository,
// its .council, or a tree of them such as the benchmark's work directory. Reads files only; the
// pure engine (src/lib/estimate.js) picks the comparable runs and computes the figures.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tokenTotals } from './usage.mjs'

const MAX_DEPTH = 7, MAX_RUNS = 2000

function councilDirs(root, depth = 0, out = new Set()) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  if (basename(root) === '.council') { out.add(root); return out }
  if (entries.some(e => e.isDirectory() && e.name === '.council')) out.add(join(root, '.council'))
  if (depth >= MAX_DEPTH) return out
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.council' || e.name === '.git' || e.name === 'node_modules' || e.name === 'vendor') continue
    councilDirs(join(root, e.name), depth + 1, out)
  }
  return out
}

const lineupOf = plan => plan && typeof plan === 'object'
  ? [plan.participants, plan.reviewers].map(xs => (Array.isArray(xs) ? xs : []).map(p => p?.model || '?').join('+')).join(' / ')
  : null

// One past run as the estimate reads it, or null for a result that ran nothing (an explanation, a
// preflight stop) or has no metrics.
export function pastRun(result, file) {
  const m = result?.metrics
  if (!m || m.version !== 1 || ['explained', 'prepared', 'preflight'].includes(result.status)) return null
  const tokens = tokenTotals(m.tokens)
  return { file, workflow: m.workflow || null, tier: m.tier || null, strategy: m.strategy || null, variant: m.variant || null,
    lineup: lineupOf(result.plan), readiness: m.readiness || null, turns: Number.isFinite(m.turns) ? m.turns : null,
    elapsedMs: Number.isFinite(m.elapsedMs) && m.elapsedFrom !== 'setup' ? m.elapsedMs : null,
    tokens: tokens && { complete: tokens.complete, legacy: !!tokens.legacy, ...Object.fromEntries(['input', 'cachedInput', 'cacheCreation', 'output'].map(k => [k, tokens.total[k]])) },
    at: (() => { try { return statSync(file).mtime.toISOString() } catch { return null } })() }
}

export function runHistory({ repo, env = process.env, exclude = null } = {}) {
  const dirs = new Set(), add = dir => { try { dirs.add(realpathSync(dir)) } catch {} }
  if (repo && existsSync(join(repo, '.council'))) add(join(repo, '.council'))
  for (const root of String(env.DARK_FACTORY_HISTORY || '').split(':').filter(Boolean).map(p => resolve(p))) for (const dir of councilDirs(root)) add(dir)
  const skip = exclude && existsSync(exclude) ? realpathSync(exclude) : null
  const runs = []
  for (const dir of [...dirs].sort()) {
    let names = []
    try { names = readdirSync(dir).filter(n => n.startsWith('host-')).sort() } catch {}
    for (const name of names) {
      // A host run has host.json; the run directories it owns (host-*-pair) hold a copy of its result.
      const file = join(dir, name, 'result.json')
      if (join(dir, name) === skip || !existsSync(join(dir, name, 'host.json')) || !existsSync(file) || runs.length >= MAX_RUNS) continue
      try { const run = pastRun(JSON.parse(readFileSync(file, 'utf8')), file); if (run) runs.push(run) } catch {}
    }
  }
  return runs
}
