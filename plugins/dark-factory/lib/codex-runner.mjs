// The same generated workflow runs in Claude's harness or here. Only the runtime changes.
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(plugin, 'bin', 'dark-factory')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflows = new Set(['factory', 'council', 'pair'])
const tiers = new Set(['simple', 'fix', 'feature', 'architecture'])

export const HELP = `Usage: dark-factory-codex [options] [--] TASK

Run the shared dark-factory engine from Codex. Requires Node.js 20+, Python 3,
Git, and authenticated CLIs for the selected models.

  --workflow NAME            factory, council, or pair (default: factory)
  --cwd DIR                  Target Git repository (default: current directory)
  --tier TIER                simple, fix, feature, or architecture
  --seats a,b                Override the model seats (e.g. astra,sol or opus,astra)
  --author MODEL             Pair author (default in Codex: sol)
  --reviewer MODEL           Pair reviewer (default: other vendor)
  --max-reviews N            Pair review budget across design and code (default: 8)
  --args-file FILE           Full workflow arguments as a JSON object
  --output FILE              Also write the final result JSON to this path
  --concurrency N            Maximum simultaneous model turns (default: 3)
  --timeout-min N            Default deadline per model turn (default: 90)
  --help                     Show help without starting a run

Progress goes to stderr; the final result is JSON on stdout. The host log and
result are retained under <repo>/.council/host-*/. Exit codes: 0 ready, 2 needs
input/blocked/incomplete, 1 failed. Results stay in their worktrees. This command
does not apply, commit, or merge them into the main checkout.
`

function positiveInteger(value, name) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return Number(value)
}

export function parseCLI(argv, cwd = process.cwd()) {
  const out = { workflow: 'factory', cwd, concurrency: 3, timeoutMin: 90, args: {} }
  const task = []
  const values = new Set(['workflow', 'cwd', 'tier', 'seats', 'author', 'reviewer', 'max-reviews', 'args-file', 'output', 'concurrency', 'timeout-min'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { task.push(...argv.slice(i + 1)); break }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (!arg.startsWith('-')) { task.push(arg); continue }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match || !values.has(match[1])) throw new Error(`Unknown option: ${arg}`)
    const name = match[1], value = match[2] ?? argv[++i]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    if (['tier', 'seats', 'author', 'reviewer'].includes(name)) out.args[name] = value
    else if (name === 'max-reviews') out.args.maxReviews = positiveInteger(value, '--max-reviews')
    else if (name === 'concurrency') out.concurrency = positiveInteger(value, '--concurrency')
    else if (name === 'timeout-min') out.timeoutMin = positiveInteger(value, '--timeout-min')
    else if (name === 'args-file') out.argsFile = resolve(cwd, value)
    else if (name === 'cwd' || name === 'output') out[name] = resolve(cwd, value)
    else out[name] = value
  }
  if (!workflows.has(out.workflow)) throw new Error('--workflow must be factory or council or pair')
  if (out.argsFile && !out.help) {
    const args = JSON.parse(readFileSync(out.argsFile, 'utf8'))
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args-file must contain a JSON object')
    out.args = { ...args, ...out.args }
  }
  if (task.length) out.args.task = task.join(' ')
  if (out.workflow !== 'pair' && ['author', 'reviewer', 'maxReviews'].some(key => out.args[key] !== undefined)) throw new Error('author, reviewer, and maxReviews require --workflow pair')
  if (out.args.tier && !tiers.has(out.args.tier)) throw new Error('Unknown tier: ' + out.args.tier)
  if (!out.help && !String(out.args.task || out.args.prompt || out.args.question || '').trim()) throw new Error('Provide a task or an --args-file containing task')
  return out
}

export function resultExitCode(result) {
  if (!result || ['error', 'failed', 'preflight'].includes(result.status)) return 1
  if (result.preflight?.some(check => !check.ok)) return 1
  if (String(result.status).startsWith('needs-') || result.status === 'blocked') return 2
  const readiness = result.final?.readiness || result.readiness
  return readiness?.state === 'ready' ? 0 : 2
}

// Validates the deliberately small JSON Schema subset used by src/schemas.js.
// Provider output is untrusted even when its process exited successfully.
export function validateResult(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') throw new Error('Missing output schema')
  const type = schema.type
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'null' ? value === null
    : typeof value === type
  if (!valid) throw new Error(`${path}: expected ${type}`)
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: value is outside the allowed enum`)
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: missing required field`)
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateResult(item, schema.properties[key], `${path}.${key}`)
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unexpected field`)
    }
  } else if (type === 'array') {
    value.forEach((item, index) => validateResult(item, schema.items, `${path}[${index}]`))
  }
  return value
}

function promptHash(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '')
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) hash = Math.imul((hash ^ normalized.charCodeAt(i)) >>> 0, 0x01000193) >>> 0
  return `${normalized.length}-${hash.toString(16).padStart(8, '0')}`
}

function jobKey(value) {
  const raw = String(value)
  if (!raw || raw === '.' || raw === '..') throw new Error('Invalid job key')
  if (/^[\w.-]+$/.test(raw) && raw.length <= 120) return raw
  return `${raw.replace(/[^\w.-]/g, '_').slice(0, 100)}-${promptHash(raw).split('-')[1]}`
}

function inside(root, path) {
  const rel = relative(root, path)
  return !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)
}

function realLocation(path) {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(realLocation(parent), relative(parent, path))
}

function confined(root, path) {
  if (!inside(root, resolve(path)) || !inside(realpathSync(root), realLocation(resolve(path)))) {
    throw new Error(`Path is outside the run directory: ${path}`)
  }
  return path
}

function schemaDefaults(schema) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaDefaults(value)]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'string') return ''
  return 0
}

export function createLimiter(max) {
  positiveInteger(max, 'concurrency')
  let active = 0
  const queue = []
  return async function limit(fn) {
    if (active >= max) await new Promise(resolve => queue.push(resolve))
    else active++
    try { return await fn() } finally {
      if (queue.length) queue.shift()()
      else active--
    }
  }
}

function callHelper(argv, { cwd, env, signal }) {
  return new Promise((done, reject) => {
    const child = spawn(helper, argv, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
    child.on('error', reject)
    child.on('close', code => {
      const line = stdout.trim().split('\n').at(-1)
      try {
        const result = JSON.parse(line)
        if (!result || typeof result !== 'object' || !result.status) throw new Error('no status')
        done(code && result.status !== 'error' ? { status: 'error', error: `helper exited ${code}: ${stderr || line}` } : result)
      } catch {
        reject(new Error(`helper exited ${code} without a JSON result: ${stderr || stdout.slice(-2000)}`))
      }
    })
  })
}

function gitRoot(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, 'rev-parse', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function createRuntime({ repo, hostRunDir, concurrency = 3, timeoutMin = 90, signal,
  env = process.env, emit = () => {}, execute = callHelper, gitDirs = [] }) {
  const limit = createLimiter(concurrency)
  const activeJobs = new Set()
  const ownedRuns = new Set([hostRunDir])
  let cancelled = false
  let sequence = 0
  const childEnv = { ...env, PATH: `${join(plugin, 'bin')}:${env.PATH || ''}`, COUNCIL_TRANSCRIPT_WAIT: '0' }

  function runDirectory(run) {
    if (!run) return hostRunDir
    const runDir = resolve(run.runDir)
    if (!inside(join(repo, '.council'), runDir) || !inside(realLocation(join(repo, '.council')), realLocation(runDir))) {
      throw new Error('The setup returned a run directory outside the repository .council directory')
    }
    const metadata = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    if (realpathSync(metadata.repoRoot) !== repo || realpathSync(run.repoRoot) !== repo ||
        realpathSync(metadata.runDir) !== realpathSync(runDir) || metadata.runId !== run.runId) {
      throw new Error('The setup run directory does not match its repository metadata')
    }
    ownedRuns.add(runDir)
    return runDir
  }

  async function turn(request) {
    return limit(async () => {
      if (cancelled || signal?.aborted) throw new Error('Run interrupted')
      const runDir = runDirectory(request.run)
      const key = jobKey(request.key || `host-${++sequence}-${String(request.role || 'agent').replace(/[^\w-]/g, '-')}`)
      const promptFile = confined(runDir, join(runDir, 'jobs', `${key}.host.prompt.md`))
      const jobDir = confined(runDir, join(runDir, 'jobs', key))
      mkdirSync(dirname(promptFile), { recursive: true })
      writeFileSync(promptFile, request.prompt)
      const args = ['seat-run', '--run-dir', runDir, '--vendor', request.vendor, '--seat', jobKey(request.threadKey || key),
        '--job', key, '--model', request.model, '--effort', request.effort || 'high', '--sandbox', request.sandbox || 'workspace-write',
        '--cwd', request.cwd || repo, '--prompt-file', promptFile, '--expect', promptHash(request.prompt), '--no-transcript',
        '--timeout-min', String(request.resumeSession ? Math.min(request.timeoutMin || timeoutMin, timeoutMin) : request.timeoutMin || timeoutMin), '--max-wait', '5']
      for (const writable of request.writable || []) args.push('--writable', writable)
      if (request.fresh) args.push('--fresh')
      if (request.resumeSession) args.push('--resume-session', request.resumeSession)
      if (request.checkout) args.push('--checkout', request.checkout)
      const options = { cwd: repo, env: { ...childEnv, COUNCIL_RETRO_DIR: join(runDir, 'retros') }, signal }
      emit({ type: 'turn.started', label: request.label, role: request.role, vendor: request.vendor, model: request.model, job: key, runDir })
      activeJobs.add(jobDir)
      try {
        let result = await execute(args, options)
        let lastProgress = Date.now()
        while (result.status === 'running') {
          if (cancelled || signal?.aborted) throw new Error('Run interrupted')
          if (Date.now() - lastProgress >= 30_000) { emit({ type: 'turn.running', label: request.label, job: key }); lastProgress = Date.now() }
          result = await execute(['wait', '--run-dir', runDir, '--job', key, '--max-wait', '5'], options)
        }
        if (cancelled || signal?.aborted) throw new Error('Run interrupted')
        if (result.status === 'done') {
          try { validateResult(result.result, request.schema) } catch (error) {
            result = { ...result, status: 'error', error: `Invalid ${request.label || key} output: ${error.message}`, errorClass: 'schema' }
          }
        }
        // Report filesystem evidence to the shared engine; it decides whether to recover.
        // Compare against the saved job prompt, not the host payload rewritten on replay.
        if (request.recoveryPost && result.status === 'error' && result.thread) {
          try {
            const post = confined(runDir, request.recoveryPost)
            const info = lstatSync(post)
            const started = lstatSync(confined(runDir, join(jobDir, 'prompt.md'))).mtimeMs
            if (info.isFile() && info.mtimeMs >= started && readFileSync(post, 'utf8').trim()) {
              result = { ...result, recoverySession: result.thread }
            }
          } catch {} // A missing, stale, empty or unconfined post cannot justify recovery.
        }
        emit({ type: 'turn.completed', label: request.label, job: key, status: result.status, seconds: result.seconds,
          error: result.error, permissionDenials: result.permissionDenials })
        return result
      } catch (error) {
        emit({ type: 'turn.failed', label: request.label, job: key, error: error.message })
        if (signal?.aborted) throw error
        return { status: 'error', error: error.message, errorClass: 'runtime' }
      } finally { activeJobs.delete(jobDir) }
    })
  }

  async function agent(request) {
    if (cancelled || signal?.aborted) throw new Error('Run interrupted')
    const runDir = runDirectory(request.run)
    const key = `host-${++sequence}-${String(request.role || request.label || 'agent').replace(/[^\w-]/g, '-')}`
    const scratch = confined(runDir, join(runDir, 'scratch', key))
    mkdirSync(scratch, { recursive: true })
    if (request.payloadFile) {
      confined(runDir, request.payloadFile)
      mkdirSync(dirname(request.payloadFile), { recursive: true })
      writeFileSync(request.payloadFile, request.payload)
    }
    const setup = request.role === 'setup'
    if (setup && request.setupRunId) {
      if (!/^[\w.-]+$/.test(request.setupRunId) || request.setupRunId === '.' || request.setupRunId === '..') throw new Error('Invalid setup run ID')
      ownedRuns.add(join(repo, '.council', request.setupRunId))
    }
    // Specification amendments remeasure the baseline, including temporary Git indexes and
    // snapshot refs, through the same helper path as a checker.
    const measures = request.role === 'checker' || request.label === 'spec amend'
    const writes = setup || measures || ['retro', 'record'].includes(request.role)
    const writable = setup ? gitDirs : measures ? [runDir, ...gitDirs] : writes ? [runDir] : []
    let preflight = ''
    if (setup && request.preflightVendors?.length) {
      const checked = await execute(['preflight', '--vendors', request.preflightVendors.join(',')], { cwd: repo, env: childEnv, signal })
      emit({ type: 'preflight', ...checked })
      if (checked.status !== 'ok') {
        const vendors = checked.vendors || Object.fromEntries(request.preflightVendors.map(vendor => [vendor, { ok: false, error: checked.error || checked.status }]))
        return { ...schemaDefaults(request.schema), status: 'preflight', error: checked.error || '',
          preflight: Object.entries(vendors).map(([vendor, check]) => ({ vendor, ok: !!check.ok, error: check.error || '' })) }
      }
      preflight = `\n\n# CLI preflight (performed by the host runtime)\n\n${JSON.stringify(checked)}\n`
    }
    const prompt = `Repository: ${repo}\nRun all project inspection against this absolute path. Your shell may start in a scratch directory.\n\n${request.prompt}${preflight}`
    const tag = `${key}-${promptHash(prompt).split('-')[1]}`
    const schema = { ...request.schema, properties: { ...request.schema.properties, turn: { type: 'string', enum: [tag] } },
      required: [...(request.schema.required || []), 'turn'] }
    const payload = `${prompt}\n\nSet \`turn\` in your output to exactly "${tag}".\n\n<<<OUTPUT_SCHEMA\n${JSON.stringify(schema)}\nOUTPUT_SCHEMA>>>\n`
    const result = await turn({ ...request, key, threadKey: key, fresh: true,
      cwd: setup ? repo : scratch, writable, sandbox: writes ? 'workspace-write' : 'read-only', prompt: payload, schema })
    // The shared engine receives provider diagnostics separately from the model's schema.
    request.onResult?.(result)
    if (result.status !== 'done') return null
    const { turn: returnedTag, ...value } = result.result
    if (returnedTag !== tag) return null
    if (setup && value.runDir) {
      runDirectory(value)
      if (request.setupRunId && value.runId !== request.setupRunId) throw new Error('Setup returned a different run ID than the host assigned')
    }
    return value
  }

  // Execute the shared engine's measurement request without another model turn.
  async function measure({ run, seat, label }) {
    if (cancelled || signal?.aborted) throw new Error('Run interrupted')
    if (!/^[A-Z]$/.test(seat) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error('Invalid measurement key')
    const runDir = runDirectory(run), key = `measure-${seat}-${label}`
    const jobDir = confined(runDir, join(runDir, 'jobs', key))
    const options = { cwd: repo, env: childEnv, signal }
    activeJobs.add(jobDir)
    emit({ type: 'measurement.started', job: key, runDir })
    try {
      let result = await execute(['measure', '--run-dir', runDir, '--seat', seat, '--label', label, '--max-wait', '5'], options)
      while (result.status === 'running') {
        if (cancelled || signal?.aborted) throw new Error('Run interrupted')
        result = await execute(['wait', '--run-dir', runDir, '--job', key, '--max-wait', '5'], options)
      }
      if (cancelled || signal?.aborted) throw new Error('Run interrupted')
      emit({ type: 'measurement.completed', job: key, status: result.status, passed: result.suite?.passed })
      return result
    } finally { activeJobs.delete(jobDir) }
  }

  function cancel() {
    cancelled = true
    // Include measurements launched by the setup/checker inside this workflow's runs.
    const jobs = new Set(activeJobs)
    for (const runDir of ownedRuns) {
      try {
        for (const entry of readdirSync(join(runDir, 'jobs'), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const jobDir = confined(runDir, join(runDir, 'jobs', entry.name))
          if (!existsSync(join(jobDir, 'status.json'))) jobs.add(jobDir)
        }
      } catch {}
    }
    const kill = file => {
      try {
        const pid = Number(readFileSync(file, 'utf8').trim())
        if (Number.isInteger(pid) && pid > 1) process.kill(-pid, 'SIGTERM')
      } catch {}
    }
    for (const jobDir of jobs) {
      for (const name of ['pid', 'codex.pid', 'agy.pid', 'claude.pid']) {
        kill(join(jobDir, name))
      }
      try { writeFileSync(join(jobDir, 'status.json'), JSON.stringify({ status: 'error', error: 'Host run interrupted', errorClass: 'cancelled' })) } catch {}
    }
    function logs(path) {
      try {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isDirectory()) logs(join(path, entry.name))
          else if (entry.isFile() && entry.name.endsWith('.pid')) kill(join(path, entry.name))
        }
      } catch {}
    }
    for (const runDir of ownedRuns) {
      logs(join(runDir, 'logs'))
    }
  }
  return { agent, turn, measure, cancel }
}

export async function runWorkflow(options, dependencies = {}) {
  const repo = realpathSync(gitRoot(resolve(options.cwd), '--show-toplevel'))
  const commonGit = resolve(repo, gitRoot(repo, '--git-common-dir'))
  const worktreeGit = resolve(repo, gitRoot(repo, '--git-dir'))
  const hostBase = join(repo, '.council')
  if (existsSync(hostBase) && (lstatSync(hostBase).isSymbolicLink() || !lstatSync(hostBase).isDirectory())) throw new Error('.council must be a directory inside the target repository')
  mkdirSync(hostBase, { recursive: true })
  const hostRunDir = mkdtempSync(join(hostBase, 'host-'))
  const events = join(hostRunDir, 'events.jsonl')
  const emit = event => {
    const record = { at: new Date().toISOString(), ...event }
    appendFileSync(events, JSON.stringify(record) + '\n')
    ;(dependencies.progress || (line => process.stderr.write(line + '\n')))(JSON.stringify(record))
  }
  const args = { ...options.args, host: 'codex', repo, cli: 'dark-factory', hostRunId: hostRunDir.split('/').at(-1) }
  writeFileSync(join(hostRunDir, 'args.json'), JSON.stringify(args, null, 2) + '\n')
  const controller = new AbortController()
  const runtime = createRuntime({ repo, hostRunDir, concurrency: options.concurrency, timeoutMin: options.timeoutMin,
    gitDirs: [...new Set([commonGit, worktreeGit])], emit, signal: controller.signal, ...dependencies.runtime })
  const interrupt = () => { runtime.cancel(); controller.abort() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let result
  try {
    emit({ type: 'run.started', workflow: options.workflow, repo, hostRunDir })
    const source = readFileSync(join(plugin, 'workflows', `${options.workflow}.js`), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
    const execute = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime', source)
    const unsupported = () => { throw new Error('The workflow called a runtime function without a host adapter') }
    result = await execute(unsupported, jobs => Promise.all(jobs.map(job => job())), unsupported,
      title => emit({ type: 'phase', title }), message => emit({ type: 'log', message }), args, {}, unsupported, runtime)
    if (!result || typeof result !== 'object') throw new Error('The workflow returned no result')
    if (controller.signal.aborted) result = { status: 'failed', error: 'Run interrupted' }
  } catch (error) {
    runtime.cancel()
    result = { status: 'failed', error: controller.signal.aborted ? 'Run interrupted' : error.message }
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  result = { ...result, host: 'codex', hostRunDir, hostEvents: events }
  const json = JSON.stringify(result, null, 2) + '\n'
  writeFileSync(join(hostRunDir, 'result.json'), json)
  if (options.output) writeFileSync(options.output, json)
  emit({ type: 'run.completed', status: result.status, exitCode: resultExitCode(result), result: join(hostRunDir, 'result.json') })
  return result
}

export async function main(argv = process.argv.slice(2)) {
  let result
  try {
    const options = parseCLI(argv)
    if (options.help) { process.stdout.write(HELP); return }
    result = await runWorkflow(options)
  } catch (error) { result = { status: 'failed', error: error.message } }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exitCode = resultExitCode(result)
}
