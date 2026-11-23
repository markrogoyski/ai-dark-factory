// What a run costs, in tokens and time: the running total on milestone lines, the report's
// "Token use" section, and --explain's estimate from past runs. The runtime reads the figures (the
// standalone runner's usage() and history(); Claude Code's budget meter); these functions only
// format and compare them. No prices: a dollar figure needs a dated price table, which nothing here has.

// 950, 31k, 1.2M.
function tokenAmount(n) {
  if (!Number.isFinite(n)) return '?'
  const short = v => String(v < 10 ? Math.round(v * 10) / 10 : Math.round(v))
  return n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${short(n / 1e3)}k` : `${short(n / 1e6)}M`
}

const minutesOf = ms => Math.round(ms / 6e4)

// "1.2M in (1.1M cached) / 31k out"
function tokenFigures(t) {
  return `${tokenAmount(t.input)} in${t.cachedInput ? ` (${tokenAmount(t.cachedInput)} cached)` : ''} / ${tokenAmount(t.output)} out`
}

// The milestone suffix. usage: the runner's running total ({total, missing}), or Claude Code's
// budget meter ({meter}: output tokens since the workflow started). Empty before anything counted.
function usageLine(S, usage) {
  if (!usage) return ''
  if (usage.meter !== undefined) return usage.meter > 0 ? `Claude output so far ≈ ${tokenAmount(usage.meter)} (budget meter)` : ''
  const t = usage.total, missing = (usage.missing || []).length
  if (!t || (!t.turns && !missing)) return ''
  return `tokens so far: ${tokenFigures(t)}${missing ? `; ${plural(missing, 'turn')} not counted yet` : ''}`
}

// The report's section, per model. Before the runner's final count (metrics.tokens), which also
// reads back turns their CLI did not report.
function usageSection(S, usage) {
  if (!usage) return ''
  if (usage.meter !== undefined) {
    return usage.meter > 0 ? `\n\n### Token use\n\nClaude Code's budget meter counted about ${tokenAmount(usage.meter)} output tokens while this workflow ran (its own agents and anything else in the session). ` +
      `Input, cache and per-model counts, Codex and Gemini turns included: \`${S.cli} usage --run-dir ${shq(S.run?.runDir || 'RUN')}\`.` : ''
  }
  const rows = Object.entries(usage.byModel || {})
  const missing = usage.missing || []
  if (!rows.length && !missing.length) return ''
  const line = (name, r) => `| ${name} | ${r.turns} | ${tokenAmount(r.input)} | ${tokenAmount(r.cachedInput)} | ${tokenAmount(r.cacheCreation)} | ${tokenAmount(r.output)} | ${minutesOf(r.seconds * 1000)} min |`
  const table = rows.length ? ['| Model | Turns | Input | Cached | Cache writes | Output | Turn time |', '|---|---|---|---|---|---|---|',
    ...rows.sort((a, b) => b[1].input - a[1].input).map(([model, r]) => line(model, r)), line('**Total**', usage.total)].join('\n') : ''
  const gap = missing.length ? `\n\n${plural(missing.length, 'turn')} reported no usage (${[...new Set(missing.map(m => m.reason))].slice(0, 3).join('; ')}): the result's metrics.tokens reads them back from the vendors' logs where it can, and lists the rest as missing.` : ''
  return `\n\n### Token use\n\n${table}${gap}`
}

// The lineup of a plan as history.mjs records it: participants / reviewers, by model key.
function planLineup(plan) {
  return [plan.participants, plan.reviewers].map(xs => (xs || []).map(p => p.model || '?').join('+')).join(' / ')
}

const ESTIMATE_MIN_SAMPLE = 3

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const spread = xs => xs.length ? { median: quantile(xs, 0.5), low: Math.min(...xs), high: Math.max(...xs) } : null

// The estimate --explain prints: the comparable past runs' median and range of tokens and active
// time. runs: what the runtime read (history.mjs pastRun), or null where no runtime can read them.
// The narrowest comparison with enough runs wins: workflow, tier, strategy and lineup; then
// workflow, tier and strategy; then workflow alone. With fewer than ESTIMATE_MIN_SAMPLE runs at
// every level, the level with the most runs is used and called a small sample.
function historyEstimate(S, plan, runs) {
  if (!Array.isArray(runs)) return { runs: 0, basis: null, text: 'No history here: this runtime cannot read past runs. The standalone runner\'s --explain (dark-factory-codex --explain) reads them from the repository\'s .council.' }
  const lineup = planLineup(plan)
  const levels = [
    ['workflow, tier, strategy and lineup', r => r.tier === plan.tier && r.strategy === plan.strategy && r.lineup === lineup],
    ['workflow, tier and strategy', r => r.tier === plan.tier && r.strategy === plan.strategy],
    ['workflow', () => true],
  ].map(([basis, keep]) => ({ basis, runs: runs.filter(r => r && r.workflow === plan.workflow && keep(r)) }))
  const chosen = levels.find(l => l.runs.length >= ESTIMATE_MIN_SAMPLE) || levels.reduce((a, b) => b.runs.length > a.runs.length ? b : a)
  const n = chosen.runs.length
  if (!n) return { runs: 0, basis: null, text: `No history: no earlier ${plan.workflow} run with a recorded result was found.` }
  // partial: the count lists turns it missed; older: recorded before every turn was counted, so it
  // cannot say whether it missed any.
  const counted = chosen.runs.filter(r => r.tokens)
  const partial = counted.filter(r => !r.tokens.complete && !r.tokens.legacy).length, older = counted.filter(r => r.tokens.legacy).length
  const timed = chosen.runs.filter(r => Number.isFinite(r.elapsedMs))
  const tokens = counted.length ? { runs: counted.length, partial, older,
    input: spread(counted.map(r => r.tokens.input)), cachedInput: spread(counted.map(r => r.tokens.cachedInput)), output: spread(counted.map(r => r.tokens.output)) } : null
  const minutes = timed.length ? spread(timed.map(r => r.elapsedMs / 6e4)) : null
  const range = (s, f, unit) => s.low === s.high ? '' : `, range ${f(s.low)}–${f(s.high)} ${unit}`
  const small = n < ESTIMATE_MIN_SAMPLE ? ' (a small sample: a rough guide only)' : ''
  const parts = [
    tokens ? `median ${tokenFigures({ input: tokens.input.median, cachedInput: tokens.cachedInput.median, output: tokens.output.median })}${range(tokens.input, tokenAmount, 'in')}` +
      `${tokens.runs < n ? ` (${tokens.runs} of the ${n} have token counts)` : ''}` +
      `${partial ? `; ${partial} of those ${partial === 1 ? 'misses' : 'miss'} turns, so the true figures are higher` : ''}` +
      `${older ? `; ${older} of those ${older === 1 ? 'was' : 'were'} counted before every turn was, and may miss some` : ''}` : 'no token counts recorded',
    minutes ? `median ${Math.round(minutes.median)} min active${range(minutes, v => Math.round(v), 'min')}` : 'no active time recorded',
  ]
  return { runs: n, basis: `same ${chosen.basis}`, tokens, minutes,
    text: `Estimate from ${plural(n, `past ${plan.workflow} run`)} with the same ${chosen.basis}${small}: ${parts.join('; ')}.` }
}
