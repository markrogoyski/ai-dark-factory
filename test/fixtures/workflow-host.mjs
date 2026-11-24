// Plays the native workflow() host for tests. workflowHost runs a built child workflow the way the
// runtime does: the native parameter list, the caller's own agent, parallel and budget meter, and a
// copy of the args. routedHandoff runs Factory's own source up to routing and returns the handoff
// envelope Factory builds there, so a test can hand a child exactly the state inline Factory had.
// factoryFromHandoff plays a Factory that delegates: it takes that envelope and runs the children.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FACTORY_CHILDREN } from '../../plugins/dark-factory/lib/codex-runner.mjs'
import { TARGETS, HANDOFF_LIB, PAIR_LIB } from '../../tools/sources.mjs'
import { loadLib } from '../lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
// The parameters the native runtime passes a workflow script, in order.
export const PARAMS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime']
const unmeta = text => text.replace(/^export const meta\s*=/m, 'const meta =')

// host: {agent, parallel, pipeline, phase, log, budget, factoryRuntime}, shared with every child.
// Only the named children load; any other name throws, and so does a child's own workflow() call.
// ran records each child run as {name, args}, args as the caller passed them.
export function workflowHost(host, { dir = join(root, 'plugins', 'dark-factory', 'workflows'), children = FACTORY_CHILDREN } = {}) {
  const ran = []
  const scripts = new Map()
  const nested = () => { throw new Error('workflow() cannot be called inside a child workflow') }
  async function workflow(name, args) {
    const m = typeof name === 'string' && name.match(/^dark-factory:([\w-]+)$/)
    if (!m || !children.includes(m[1])) throw new Error(`Unknown workflow: ${typeof name === 'string' ? name : JSON.stringify(name)}`)
    if (!scripts.has(m[1])) scripts.set(m[1], new AsyncFunction(...PARAMS, unmeta(readFileSync(join(dir, `${m[1]}.js`), 'utf8'))))
    const copy = structuredClone(args)
    ran.push({ name, args: structuredClone(args) })
    return scripts.get(m[1])(host.agent, host.parallel, host.pipeline, host.phase, host.log, copy, host.budget, nested, host.factoryRuntime)
  }
  return { workflow, ran }
}

export function runHosted(script, host, args, opts) {
  return script(host.agent, host.parallel, host.pipeline, host.phase, host.log, args, host.budget,
    workflowHost(host, opts).workflow, host.factoryRuntime)
}

// Factory's source from src/, in the factory target's order, with the handoff library after the
// Pair library and a hook, just before the factory flow, that builds the envelope from the live
// state and request control.
let probe = null
function routeProbe() {
  if (probe) return probe
  const order = TARGETS.factory.order.slice(1)
  const at = order.indexOf(PAIR_LIB.at(-1)) + 1
  const files = [...order.slice(0, at), ...HANDOFF_LIB, ...order.slice(at)]
  const hook = 'routeHook.handoff = () => factoryHandoff(S, factoryControl(requestControl, meterStart))\n'
  const text = files.map(f => (f === 'src/main-factory.js' ? hook : '') + readFileSync(join(root, f), 'utf8')).join('\n')
  probe = new AsyncFunction(...PARAMS, 'routeHook', text)
  return probe
}
const ROUTED = Symbol('routed')

// Runs Factory through the host up to its routing line, which it does not log: the shaping,
// challenge and intake turns run as scripted, and the envelope carries the state they left
// (brief, history, turns). Returns {handoff, result: null}, the envelope copied as workflow()
// copies args, or {handoff: null, result} when Factory finished before routing.
export async function routedHandoff(host, args) {
  const hook = {}
  let handoff = null
  const log = line => {
    if (/^factory: tier /.test(line)) { handoff = hook.handoff(); throw ROUTED }
    host.log(line)
  }
  try {
    const result = await routeProbe()(host.agent, host.parallel, host.pipeline, host.phase, log, args, host.budget, null, host.factoryRuntime, hook)
    return { handoff: null, result }
  } catch (e) {
    if (e !== ROUTED) throw e
    return { handoff: structuredClone(handoff), result: null }
  }
}

// Factory's token use at the end of the run: the standalone runner's own total, or the budget meter
// read against the baseline Factory took at its start, which the envelope carries.
function factoryUsage(host, h) {
  const rt = host.factoryRuntime
  if (rt?.usage) { try { return rt.usage() } catch { return null } }
  let spent = null
  try { spent = host.budget && typeof host.budget.spent === 'function' ? host.budget.spent() : null } catch {}
  return spent === null || h.control.meterStart === null ? null : { meter: Math.max(0, spent - h.control.meterStart) }
}

// Runs Factory up to routing, then plays the Factory that delegates from there: it logs the routing
// line, runs the child the envelope names, and for each hand-up logs the escalation and runs the
// next tier's child from the next envelope. A final result that had a report gets the usage section,
// with the CLI of the last child's effective state and the child's run directory. Returns
// {result, ran, handoffs}: Factory's own stop before routing has ran = [].
export async function factoryFromHandoff(host, args) {
  const { handoff, result } = await routedHandoff(host, args)
  if (!handoff) return { result, ran: [], handoffs: [] }
  const L = loadLib()
  const wf = workflowHost(host)
  const handoffs = [handoff]
  let h = handoff
  const f = h.factory
  host.log(`factory: tier ${f.tier} (${f.chosenBy}${f.chosenBy === 'intake' ? '' : `; intake recommends ${f.recommended}`}): ${L.oneLine(f.intake.reasons, 200)}`)
  for (;;) {
    const out = L.childOutcome(h, await wf.workflow(L.childWorkflow(h), { factoryHandoff: h }))
    if (out.handUp) {
      const up = out.handUp
      host.log(`factory: escalating from ${up.escalation.from} to ${up.to} (${up.trigger}): ${up.why}`)
      h = L.nextHandoff(h, up)
      handoffs.push(h)
      continue
    }
    const final = out.final
    if (!out.usage) return { result: final, ran: wf.ran, handoffs }
    const cli = (h.strategy === 'pair' ? L.handoffPairState(h) : L.handoffState(h)).cli
    const section = L.usageSection({ cli, run: final.runDir ? { runDir: final.runDir } : undefined }, factoryUsage(host, h))
    return { result: section ? { ...final, report: { ...final.report, markdown: `${final.report.markdown}${section}` } } : final, ran: wf.ran, handoffs }
  }
}
