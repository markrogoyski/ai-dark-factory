// Runs a built workflow end to end with scripted model turns. By default the run is fictional
// (/repo, fixed trees); `behavior.setup`, `behavior.tree` and `behavior.measure` point it at a
// real run directory, so its actual result can go through the delivery helpers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateResult } from '../../plugins/dark-factory/lib/codex-runner.mjs'
import { contract, mapping, challenges, replay } from './pair-contract.mjs'
import { PARAMS, runHosted, runCandidate, workflowHost } from './workflow-host.mjs'

export const empty = s => s.enum ? s.enum[0] : s.type === 'object' ? Object.fromEntries(Object.entries(s.properties || {}).map(([k,v]) => [k,empty(v)])) : s.type === 'array' ? [] : s.type === 'string' ? '' : s.type === 'boolean' ? false : 0
const workflows = fileURLToPath(new URL('../../plugins/dark-factory/workflows/', import.meta.url))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function simulate(workflow, args = {}, behavior = {}, dir = workflows) {
  // Execute the workflow body after the host has scanned its metadata, with no runtime meta binding.
  const source = readFileSync(join(dir, `${workflow}.js`), 'utf8').replace(/^export const meta\s*=/m, 'void')
  const execute = new AsyncFunction(...PARAMS, source)
  const calls = []; let repairs = 0, reviewCount = 0
  const run = behavior.setup?.runDir || '/repo/.council/demo'
  const tree = behavior.tree || (() => String(behavior.stall ? 1 : repairs + 1).repeat(40))
  const criteria = [{ criterion: 'C1', status: 'met', note: 'Verified the boundary behavior.' }]
  const respond = async r => {
    calls.push(r)
    if (behavior.error) throw behavior.error
    if (behavior.fail?.(r)) return null
    const v = empty(r.schema)
    if (r.label?.startsWith('brief ')) {
      v.brief = { outcome: 'Emit the retry count in the debug log.', purpose: 'Help an operator diagnose repeated requests.',
        scope: 'Retries only.', nonGoals: 'Changing retry timing.', acceptanceExamples: ['Retry two logs count 2.'],
        verification: 'Observe the debug entry after a retry.', delegated: ['testing', 'implementation', 'internal design'] }
    } else if (r.role === 'intake') Object.assign(v, { status: 'ok', tier: 'simple', mode: 'implement', strategy: behavior.pair ? 'pair' : 'independent', reasons: 'Scoped implementation.' })
    else if (r.role === 'setup') {
      Object.assign(v, { status: 'ok', runId: 'demo', runDir: run, repoRoot: '/repo', ...('head' in v ? { head: 'b'.repeat(40) } : {}), mode: 'implement', dirty: [], verify: 'check', baselinePasses: true, criteria: [{ id: 'C1', text: 'The boundary works.' }] })
      if (r.prompt.includes("--ref '/repo/.council/host-test/BRIEF.json'")) v.refs = [{ source: '/repo/.council/host-test/BRIEF.json', path: run + '/refs/BRIEF.json', inWorktrees: false }]
      for (const [k, x] of Object.entries(behavior.setup || {})) if (k in v) v[k] = x
    }
    else if (r.role === 'checker') Object.assign(v, { measured: true, diff: { files: 1, added: 2, removed: 1, tree: tree() }, suite: { ran: true, passed: true, tail: 'pass', scratchFailed: false }, criteria,
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
    // The runner's running token total and past runs, when a test supplies them.
    ...(behavior.usage ? { usage: behavior.usage } : {}),
    ...(behavior.history ? { history: behavior.history } : {}),
    // behavior.brief answers the helper's brief call ({document} to save, {source} to load) instead.
    brief: behavior.brief || (async ({ document }) => ({ document, briefFile: '/repo/.council/host-test/' +
      (document.state === 'settled' ? 'BRIEF.json' : 'BRIEF.provisional.json') })),
    agent: respond,
    turn: async r => { const result = await respond(r); return result && { status: 'done', result } },
    measure: behavior.measure || (async ({ label }) => {
      if (behavior.measureError) throw behavior.measureError
      return { status: 'done', snapshot: { ref: `refs/council/demo/A-${label}`, tree: tree(), diff: `${run}/room/${label}/A.diff` }, suite: { ran: true, passed: true, tail: 'pass', command: 'check' }, replay: replay(tree()) }
    }),
  }
  const nativeAgent = (prompt, opts) => {
    const role = opts.label === 'intake' || opts.label.startsWith('brief ') ? 'intake' : opts.label === 'setup' ? 'setup' : opts.label.startsWith('check ') ? 'checker'
      : opts.label.startsWith('r0:') ? 'seat' : opts.label.startsWith('ensemble-') ? 'reviewer' : opts.label === 'compare' ? 'compare' : null
    assert.ok(role, `Unexpected native call: ${opts.label}`)
    return respond({ ...opts, prompt, role, cwd: '/repo', vendor: 'claude' })
  }
  const budget = behavior.meter ? { spent: () => 5000 + 1000 * calls.length } : undefined
  const host = {
    agent: behavior.native ? nativeAgent : () => { throw new Error('Unexpected native call') },
    async parallel(jobs) {
      const all = await Promise.allSettled(jobs.map(f => f()))
      const bad = all.find(x => x.status === 'rejected')
      if (bad) throw bad.reason
      return all.map(x => x.value)
    },
    phase: () => {},
    log: behavior.log || (() => {}),
    budget,
    factoryRuntime: behavior.native ? null : runtime,
  }
  // A standalone Pair or council run skips its goal brief unless the test passes brief itself (brief:
  // undefined runs the shaper and challenger).
  const input = typeof args === 'string' ? args : { task: 'Fix the boundary', host: behavior.native ? 'claude' : 'codex', retro: false,
    ...(['pair', 'council'].includes(workflow) ? { brief: false } : {}), ...args }
  // behavior.candidate runs the delegating Factory built from src/ instead, its children from dir:
  // ran and returned record what it passed to workflow() and got back, with the turns each child
  // started. An object given as behavior.candidate gets the same two arrays before the run starts,
  // so a caller can read them after the run rejects.
  if (behavior.candidate) {
    assert.equal(workflow, 'factory', 'only Factory has a delegating candidate')
    const wf = workflowHost(host, { dir, dispatches: () => calls.length })
    if (typeof behavior.candidate === 'object') Object.assign(behavior.candidate, { ran: wf.ran, returned: wf.returned })
    const { result, ran, returned } = await runCandidate(host, input, { wf })
    return { result, calls, repairs, ran, returned }
  }
  const result = await runHosted(execute, host, input, { dir })
  return { result, calls, repairs }
}
