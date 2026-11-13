// Runs a built workflow end to end with scripted model turns. By default the run is fictional
// (/repo, fixed trees); `behavior.setup`, `behavior.tree` and `behavior.measure` point it at a
// real run directory, so its actual result can go through the delivery helpers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateResult } from '../../plugins/dark-factory/lib/codex-runner.mjs'
import { contract, mapping, challenges, replay } from './pair-contract.mjs'

export const empty = s => s.enum ? s.enum[0] : s.type === 'object' ? Object.fromEntries(Object.entries(s.properties || {}).map(([k,v]) => [k,empty(v)])) : s.type === 'array' ? [] : s.type === 'string' ? '' : s.type === 'boolean' ? false : 0
const root = new URL('../../', import.meta.url)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function simulate(workflow, args = {}, behavior = {}) {
  const source = readFileSync(new URL(`plugins/dark-factory/workflows/${workflow}.js`, root), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
  const execute = new AsyncFunction('args','factoryRuntime','parallel','agent','phase','log',source)
  const calls = []; let repairs = 0, reviewCount = 0
  const run = behavior.setup?.runDir || '/repo/.council/demo'
  const tree = behavior.tree || (() => String(behavior.stall ? 1 : repairs + 1).repeat(40))
  const criteria = [{ criterion: 'C1', status: 'met', note: 'Verified the boundary behavior.' }]
  const respond = async r => {
    calls.push(r)
    if (behavior.error) throw behavior.error
    if (behavior.fail?.(r)) return null
    const v = empty(r.schema)
    if (r.role === 'intake') Object.assign(v, { status: 'ok', tier: 'simple', mode: 'implement', strategy: behavior.pair ? 'pair' : 'independent', reasons: 'Scoped implementation.' })
    else if (r.role === 'setup') {
      Object.assign(v, { status: 'ok', runId: 'demo', runDir: run, repoRoot: '/repo', ...('head' in v ? { head: 'b'.repeat(40) } : {}), mode: 'implement', dirty: [], verify: 'check', baselinePasses: true, criteria: [{ id: 'C1', text: 'The boundary works.' }] })
      for (const [k, x] of Object.entries(behavior.setup || {})) if (k in v) v[k] = x
    }
    else if (r.role === 'checker') Object.assign(v, { measured: true, diff: { files: 1, added: 2, removed: 1, tree: tree() }, suite: { ran: true, passed: true, tail: 'pass' }, criteria,
      rulings: [...r.prompt.matchAll(/^- \[([^\]]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', fixed: repairs && !behavior.stall ? 'yes' : 'no', note: 'Reproduced on the named snapshot.' })) })
    else if (r.role === 'panel') Object.assign(v, { rulings: [...r.prompt.matchAll(/^## \[([^\]]+)\]/gm)].map(m => ({ claim: m[1], verdict: 'verified', note: 'Confirmed defect.' })) })
    else if (r.role === 'auditor') {
      reviewCount++
      Object.assign(v, { summary: 'Checked the exact revision.', findings: reviewCount <= (behavior.findings || 0) ? [{ severity: 'major', kind: 'fact', statement: `Defect ${behavior.stall ? 1 : reviewCount}`, evidence: 'file.js:1 reproduces the wrong boundary.' }] : [] })
    } else if (r.role === 'seat') {
      if (r.key?.includes('repair')) repairs++
      if ('summary' in v) Object.assign(v, { summary: behavior.stall ? 'unchanged' : `revision ${repairs}` })
      if ('approach' in v) Object.assign(v, { approach: 'Fix the boundary.', worktreePath: r.cwd, verification: 'check passed', diff: 'diff', confidence: 4 })
    } else if (r.role === 'author') Object.assign(v, { status: 'done', design: 'Fix and test the boundary.', summary: 'Implemented.', testContract: contract(), replayMapping: mapping() })
    else if (r.role === 'reviewer' && 'version' in v) Object.assign(v, { complete: true, version: r.prompt.match(/^Version: (.+)$/m)[1], criteria, requiresDesignRevision: false, challenges: challenges() })
    else if (r.role === 'reviewer') Object.assign(v, { complete: true, snapshotTree: tree(), criteria, verdict: 'sound', score: 8 })
    else if (r.role === 'compare') Object.assign(v, { ranking: [{ candidate: 1, rank: 1, why: 'Smallest complete change.' }], recommendation: 'adopt-one', mergePlan: 'No merge needed.' })
    if (behavior.modify) behavior.modify(v, r)
    validateResult(v, r.schema)
    return v
  }
  const runtime = {
    ...(behavior.clock ? { now: behavior.clock } : {}),
    agent: respond,
    turn: async r => { const result = await respond(r); return result && { status: 'done', result } },
    measure: behavior.measure || (async ({ label }) => {
      if (behavior.measureError) throw behavior.measureError
      return { status: 'done', snapshot: { ref: `refs/council/demo/A-${label}`, tree: tree(), diff: `${run}/room/${label}/A.diff` }, suite: { ran: true, passed: true, tail: 'pass', command: 'check' }, replay: replay(tree()) }
    }),
  }
  const nativeAgent = (prompt, opts) => {
    const role = opts.label === 'setup' ? 'setup' : opts.label.startsWith('check ') ? 'checker'
      : opts.label.startsWith('r0:') ? 'seat' : opts.label.startsWith('ensemble-') ? 'reviewer' : opts.label === 'compare' ? 'compare' : null
    assert.ok(role, `Unexpected native call: ${opts.label}`)
    return respond({ ...opts, prompt, role, cwd: '/repo', vendor: 'claude' })
  }
  const result = await execute({ task: 'Fix the boundary', host: behavior.native ? 'claude' : 'codex', retro: false, ...args }, behavior.native ? null : runtime,
    async jobs => { const all = await Promise.allSettled(jobs.map(f => f())); const bad = all.find(x => x.status === 'rejected'); if (bad) throw bad.reason; return all.map(x => x.value) },
    behavior.native ? nativeAgent : () => { throw new Error('Unexpected native call') }, () => {}, () => {})
  return { result, calls, repairs }
}
