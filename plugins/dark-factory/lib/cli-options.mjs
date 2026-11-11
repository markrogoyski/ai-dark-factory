import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const workflows = new Set(['factory', 'council', 'pair', 'ensemble', 'run-plan'])
const tiers = new Set(['simple', 'fix', 'feature', 'architecture'])

export function positiveInteger(value, name) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return Number(value)
}

export function parseCLI(argv, cwd = process.cwd()) {
  const out = { workflow: 'factory', cwd, concurrency: 3, timeoutMin: 90, concurrencyGiven: false, timeoutMinGiven: false, args: {} }
  const task = []
  const values = new Set(['workflow', 'cwd', 'tier', 'seats', 'author', 'reviewer', 'max-reviews', 'args-file', 'output', 'concurrency', 'timeout-min', 'strategy', 'max-turns', 'max-run-min', 'repair-passes', 'resume', 'candidates', 'reviewers', 'mode', 'plan-file', 'pin-engine'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { task.push(...argv.slice(i + 1)); break }
    if (arg === '--explain') { out.args.explain = true; continue }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (!arg.startsWith('-')) { task.push(arg); continue }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match || !values.has(match[1])) throw new Error(`Unknown option: ${arg}`)
    const name = match[1], value = match[2] ?? argv[++i]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    if (['tier', 'seats', 'author', 'reviewer', 'strategy', 'mode'].includes(name)) out.args[name] = value
    else if (name === 'candidates' || name === 'reviewers') out.args[name] = positiveInteger(value, `--${name}`)
    else if (name === 'max-turns') out.args.maxTurns = positiveInteger(value, '--max-turns')
    else if (name === 'max-run-min') out.args.maxRunMin = positiveInteger(value, '--max-run-min')
    else if (name === 'repair-passes') out.args.repair = { maxPasses: positiveInteger(value, '--repair-passes') }
    else if (name === 'resume') out.resume = resolve(cwd, value)
    else if (name === 'pin-engine') out.pinEngine = resolve(cwd, value)
    else if (name === 'plan-file') out.args.planFile = resolve(cwd, value)
    else if (name === 'workflow') { out.workflow = value; out.workflowGiven = true }
    else if (name === 'max-reviews') out.args.maxReviews = positiveInteger(value, '--max-reviews')
    else if (name === 'concurrency') { out.concurrency = positiveInteger(value, '--concurrency'); out.concurrencyGiven = true }
    else if (name === 'timeout-min') { out.timeoutMin = positiveInteger(value, '--timeout-min'); out.timeoutMinGiven = true }
    else if (name === 'args-file') out.argsFile = resolve(cwd, value)
    else if (name === 'cwd' || name === 'output') out[name] = resolve(cwd, value)
    else out[name] = value
  }
  if (!workflows.has(out.workflow)) throw new Error('--workflow must be factory or council or pair or ensemble or run-plan')
  if (out.argsFile && !out.help) {
    const args = JSON.parse(readFileSync(out.argsFile, 'utf8'))
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args-file must contain a JSON object')
    out.args = { ...args, ...out.args }
  }
  if (task.length) out.args.task = task.join(' ')
  if (!out.resume && out.workflow !== 'pair' && ['author', 'reviewer', 'maxReviews'].some(key => out.args[key] !== undefined)) throw new Error('author, reviewer, and maxReviews require --workflow pair')
  if (out.args.tier && !tiers.has(out.args.tier)) throw new Error('Unknown tier: ' + out.args.tier)
  if (!out.help && out.workflow === 'run-plan' && (out.resume || !out.args.planFile)) throw new Error('Run-plan requires --plan-file; repeat it to resume, without --resume')
  if (!out.help && out.workflow !== 'run-plan' && !out.resume && !String(out.args.task || out.args.prompt || out.args.question || '').trim()) throw new Error('Provide a task or an --args-file containing task')
  return out
}

