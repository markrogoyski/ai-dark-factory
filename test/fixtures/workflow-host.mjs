// Plays the native workflow() host for tests. workflowHost runs a built child workflow the way the
// runtime does: the native parameter list, the caller's own agent, parallel and budget meter, and a
// JSON copy of the args. runCandidate runs the delegating Factory itself, built in memory from src/
// (build('factory')), with its children run through workflowHost.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { FACTORY_CHILDREN } from '../../plugins/dark-factory/lib/codex-runner.mjs'
import { build } from '../../tools/build.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
// The parameters the native runtime passes a workflow script, in order.
export const PARAMS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime']
const unmeta = text => text.replace(/^export const meta\s*=/m, 'const meta =')

// host: {agent, parallel, pipeline, phase, log, budget, factoryRuntime}, shared with every child.
// Only the named children load; any other name throws, and so does a child's own workflow() call.
// ran records each child run as {name, args}, args as the caller passed them, and returned each
// child's raw response as {result, dispatches}: the response itself (not a copy), and, when the
// caller passes a dispatches() counter of its agent turns, how many the child started (else null).
export function workflowHost(host, { dir = join(root, 'plugins', 'dark-factory', 'workflows'), children = FACTORY_CHILDREN, dispatches = null } = {}) {
  const ran = [], returned = []
  const scripts = new Map()
  const nested = () => { throw new Error('workflow() cannot be called inside a child workflow') }
  async function workflow(name, args) {
    const m = typeof name === 'string' && name.match(/^dark-factory:([\w-]+)$/)
    if (!m || !children.includes(m[1])) throw new Error(`Unknown workflow: ${typeof name === 'string' ? name : JSON.stringify(name)}`)
    if (!scripts.has(m[1])) scripts.set(m[1], new AsyncFunction(...PARAMS, unmeta(readFileSync(join(dir, `${m[1]}.js`), 'utf8'))))
    // The runtime hands the child its args as JSON, so args JSON would change (an undefined field,
    // a number past the double range) are refused here rather than quietly passed on.
    const copy = JSON.parse(JSON.stringify(args))
    if (!isDeepStrictEqual(copy, args)) throw new Error(`workflow(${name}): args do not survive JSON unchanged`)
    ran.push({ name, args: JSON.parse(JSON.stringify(args)) })
    const before = dispatches ? dispatches() : null
    const result = await scripts.get(m[1])(host.agent, host.parallel, host.pipeline, host.phase, host.log, copy, host.budget, nested, host.factoryRuntime)
    returned.push({ result, dispatches: dispatches ? dispatches() - before : null })
    return result
  }
  return { workflow, ran, returned }
}

// The delegating Factory candidate, built once from src/.
let candidate = null
export function candidateScript() {
  return candidate ||= new AsyncFunction(...PARAMS, unmeta(build('factory')))
}

// Runs the candidate on the host, with its children run through workflowHost (opts are its options).
// A caller that passes its own wf can still read wf.ran after the run rejects. Returns
// {result, ran, returned}.
export async function runCandidate(host, args, { wf, ...opts } = {}) {
  const w = wf || workflowHost(host, opts)
  const result = await candidateScript()(host.agent, host.parallel, host.pipeline, host.phase, host.log, args, host.budget, w.workflow, host.factoryRuntime)
  return { result, ran: w.ran, returned: w.returned }
}

export function runHosted(script, host, args, opts) {
  return script(host.agent, host.parallel, host.pipeline, host.phase, host.log, args, host.budget,
    workflowHost(host, opts).workflow, host.factoryRuntime)
}
