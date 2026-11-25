// The same generated workflow runs in Claude's harness or here. Only the runtime changes.
import { accountRun, liveUsage } from './usage.mjs'
import { runHistory } from './history.mjs'
import { digest, fingerprint, loadCheckpoint, journalRuntime, readEventLog, writeJsonAtomic } from './checkpoint.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync, realpathSync, existsSync, readdirSync, lstatSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform as osPlatform } from 'node:os'
import { environmentPin, guardEngine, liveIdentity, runProvenance, validateAdmissions, inspectSeat, isolationIssues, drift, inventoryDigest, packageInventory } from './engine.mjs'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(plugin, 'bin', 'dark-factory')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
import { parseCLI, positiveInteger } from './cli-options.mjs'
import { pairResumeAnswerCheck, promptHash, withdrawResume } from './policy.mjs'
export { parseCLI } from './cli-options.mjs'

export const FACTORY_CHILDREN = ['council', 'pair']

function workflowSource(name, expectedHash, file = join(plugin, 'workflows', `${name}.js`)) {
  const bytes = readFileSync(file)
  if (expectedHash && digest(bytes) !== expectedHash) throw drift(`Workflow changed during Factory launch: ${name}.js`)
  return bytes.toString('utf8').replace(/^export const meta\s*=/m, 'const meta =')
}

function compileWorkflow(source) {
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'factoryRuntime', source)
}

// Factory's own script and its children's, read once at launch and checked byte for byte against
// the package identity recorded for this run. Runs before anything of the run is written, so a
// refusal leaves a paused run's arguments and result as they were. A path through internal
// symlinks (the inventory admits them, for the file or a directory above it) is checked by the
// bytes of the regular file it resolves to, and a link that is the file itself by where it points.
function factorySources(executor) {
  const root = realpathSync(plugin)
  const entries = packageInventory(root, executor.mode === 'pinned')
  if (inventoryDigest(entries) !== executor.packageDigest) throw drift('Engine package changed during Factory launch')
  const entryFor = path => entries.find(([key]) => key === Buffer.from(path).toString('base64'))
  return new Map(['factory', ...FACTORY_CHILDREN].map(name => {
    const path = `workflows/${name}.js`, missing = () => drift(`Factory requires a built workflow file: ${name}.js`)
    const link = entryFor(path)
    if (link?.[1] === '120000' && digest(readlinkSync(join(root, path))) !== link[2]) throw drift(`Workflow changed during Factory launch: ${name}.js`)
    let file
    try { file = realpathSync(join(root, path)) } catch { throw missing() }
    const entry = entryFor(relative(root, file))
    if (!entry || entry[1] === '120000') throw missing()
    return [name, workflowSource(name, entry[2], file)]
  }))
}

export const HELP = `Usage: dark-factory-codex [options] [--] TASK

Run the shared dark-factory engine from Codex. Requires Node.js 20+, Python 3,
Git, and authenticated CLIs for the selected models.

  --workflow NAME            factory, council, pair, ensemble, run-plan (default: factory)
  --plan-file FILE           Tracked execution plan; repeat this invocation to resume
  --cwd DIR                  Target Git repository (default: current directory)
  --tier TIER                simple, fix, feature, or architecture
  --seats a,b                Override the model seats (e.g. astra,sol or opus,astra)
  --author MODEL             Pair author (default in Codex: astra)
  --reviewer MODEL           Pair reviewer (default: other vendor)
  --max-reviews N            Pair review budget across design and code (default: 8)
  --max-design-reviews N     Pair design reviews before the run asks the user how to go on
                             (default: 3, at most maxReviews - 1)
  --no-design                Pair: skip the design stage; the author writes the deliverable
                             directly (for a document or plan deliverable)
  --no-retro                 Pair: skip the closing process retro
  --args-file FILE           Full workflow arguments as a JSON object
  --output FILE              Also write the final result JSON to this path
  --brief                    Print a compact result on stdout (status, readiness, findings,
                             metrics, hostRunDir); the full result stays in result.json
  --concurrency N            Maximum simultaneous model turns (default: 3)
  --timeout-min N            Default deadline per model turn (default: 90)
  --candidates N             Ensemble candidate count (2–6, default: 4)
  --reviewers N              Ensemble review lenses per candidate (default: 2)
  --mode MODE                implement, investigate, or design (workflow dependent)
  --strategy NAME            Factory: auto, pair, or independent
  --no-brief                 Factory: skip goal shaping and its challenger
  --explain                  Resolve the process without setup or implementation (Factory shapes the goal and runs intake)
  --prepare                  Check CLIs and plan documents offline, then stop; no model turn
  --max-turns N              Run-wide model turn budget, including retries
  --max-run-min N            Run-wide active-time limit
  --repair-passes N          Opt into bounded repairs with fresh review after every pass
  --resume DIR               Continue a validated checkpoint in a previous hostRunDir
  --pin-engine DIRECTORY     Export/reuse committed plugin outside candidate/seat write roots
  --help                     Show help without starting a run

Progress goes to stderr; the final result is JSON on stdout. The host log and
result are retained under <repo>/.council/host-*/. Exit codes: 0 ready, 2 needs
input/blocked/incomplete, 1 failed. Results stay in their worktrees. This command
does not apply, commit, or merge them into the main checkout, except run-plan,
which applies and commits verified tasks within its explicitly requested plan.
Every new single run makes the --prepare check first and stops with status
"preflight" before intake when a prerequisite is missing.
Resume retains concurrency and per-turn timeout settings unless explicitly overridden.
`


export function resultExitCode(result) {
  if (!result || ['error', 'failed', 'preflight'].includes(result.status)) return 1
  if (result.preflight?.some(check => !check.ok)) return 1
  if (String(result.status).startsWith('needs-') || result.status === 'blocked') return 2
  if (result.status === 'explained' || result.status === 'prepared') return 0
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
  guardEngine(environmentPin(env))
  return new Promise((done, reject) => {
    const child = spawn(helper, argv, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024) })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); if (environmentPin(env)) process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      const line = stdout.trim().split('\n').at(-1)
      try {
        const result = JSON.parse(line)
        if (!result || typeof result !== 'object' || !result.status) throw new Error('no status')
        if (result.code === 'ENGINE_DRIFT' || result.errorClass === 'engine') { reject(drift(result.error)); return }
        done(code && result.status !== 'error' ? { status: 'error', error: `helper exited ${code}: ${stderr || line}` } : result)
      } catch {
        reject(new Error(`helper exited ${code} without a JSON result: ${stderr || stdout.slice(-2000)}`))
      }
    })
  })
}

// Offline launch check: each reachable vendor's CLI answers --version and every named plan
// document exists. It writes nothing and starts no model turn; authentication stays unknown.
export async function prepareLaunch(options, repo) {
  const policy = await import('./policy.mjs')
  let requirements
  // Invalid arguments stay the workflow's failure to report, with its metrics, unless asked here.
  try { requirements = policy.launchRequirements({}, { workflow: options.workflow, args: options.args }) }
  catch (error) { if (options.prepare) throw error; return null }
  const vendors = Object.keys(requirements.vendors)
  const checked = vendors.length ? await callHelper(['preflight', '--vendors', vendors.join(',')], { cwd: repo, env: process.env }) : { vendors: {} }
  const status = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' })
  return policy.launchReport({}, requirements, {
    vendors: checked.vendors || Object.fromEntries(vendors.map(vendor => [vendor, { ok: false, error: checked.error || checked.status }])),
    missing: requirements.references.filter(path => !existsSync(path)),
    dirty: status.split('\n').filter(Boolean).map(line => line.slice(3)) })
}

function gitRoot(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, 'rev-parse', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function createRuntime({ repo, hostRunDir, concurrency = 3, timeoutMin = 90, signal,
  env = process.env, emit = () => {}, execute = callHelper, gitDirs = [], initialSequence = 0, attempt = 0, elapsedBefore = 0, spentBefore = 0, maxTurns = null, admission = null }) {
  const pin = environmentPin(env)
  if (admission && !pin) throw drift('Pinned admission requires a validated executor')
  if (pin) guardEngine(pin)
  const vendors = admission ? [...new Set(admission.map(route => route.vendor))] : null
  // What the setup preflight checks: the admitted vendors, except that an OpenRouter route names its model.
  const pinnedTargets = admission ? [...new Set(admission.map(route => route.vendor === 'openrouter' ? `openrouter:${route.model}` : route.vendor))] : null
  const limit = createLimiter(concurrency)
  const activeJobs = new Set()
  const ownedRuns = new Set([hostRunDir])
  let cancelled = false
  let sequence = initialSequence
  const started = Date.now()
  let spentTurns = spentBefore, limitStop = ''
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
      if (vendors && !vendors.includes(request.vendor)) throw drift('Provider is outside pinned admission: ' + request.vendor)
      if (cancelled || signal?.aborted) throw new Error('Run interrupted')
      if (maxTurns && spentTurns >= maxTurns) { limitStop = `Run turn budget exhausted (${maxTurns}).`; throw Object.assign(new Error(limitStop), { code: 'RUN_LIMIT' }) }
      spentTurns++
      const runDir = runDirectory(request.run)
      const baseKey = jobKey(request.key || `host-${++sequence}-${String(request.role || 'agent').replace(/[^\w-]/g, '-')}`)
      const key = attempt ? `${baseKey}-resume${attempt}` : baseKey
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
      // An OpenRouter seat keeps one Claude configuration directory across its turns: under the run
      // directory, or under the host run directory for a role (configRoot).
      if (request.vendor === 'openrouter') {
        args.push('--config-key', jobKey(request.configKey || request.threadKey || key))
        if (request.configRoot) args.push('--config-root', request.configRoot)
      }
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
        if (error.code === 'ENGINE_DRIFT') throw error
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
    // An OpenRouter role's Claude configuration lives in the host run directory, which no role can
    // write. Its setup therefore starts in its scratch directory and writes only its own run directory
    // (created here, so the sandbox grants it) and the git data, not the whole repository.
    const endpoint = request.vendor === 'openrouter'
    if (endpoint && setup && !request.setupRunId) throw new Error('An OpenRouter setup turn needs a host-assigned run ID')
    const setupRun = endpoint && setup ? join(repo, '.council', request.setupRunId) : null
    if (setupRun) mkdirSync(setupRun, { recursive: true })
    // Specification amendments (which pass measures: true) remeasure the baseline, including temporary Git indexes and
    // snapshot refs, through the same helper path as a checker.
    const measures = request.role === 'checker' || request.measures === true
    const writes = setup || measures || ['retro', 'record'].includes(request.role)
    const writable = setupRun ? [setupRun, ...gitDirs] : setup ? gitDirs : measures ? [runDir, ...gitDirs] : writes ? [runDir] : []
    let preflight = ''
    const preflightVendors = pinnedTargets || request.preflightVendors
    if (setup && preflightVendors?.length) {
      const checked = await execute(['preflight', '--vendors', preflightVendors.join(',')], { cwd: repo, env: childEnv, signal })
      emit({ type: 'preflight', ...checked })
      if (checked.status !== 'ok') {
        const vendors = checked.vendors || Object.fromEntries(preflightVendors.map(vendor => [vendor, { ok: false, error: checked.error || checked.status }]))
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
      ...(endpoint ? { configKey: `role-${request.role}`, configRoot: hostRunDir } : {}),
      cwd: setup && !setupRun ? repo : scratch, writable, sandbox: writes ? 'workspace-write' : 'read-only', prompt: payload, schema })
    // The shared engine receives provider diagnostics separately from the model's schema.
    request.onResult?.(result)
    if (result.status !== 'done') return null
    const { turn: returnedTag, ...value } = result.result
    if (returnedTag !== tag) return null
    if (setup && value.runDir) {
      runDirectory(value)
      if (Object.hasOwn(request.schema.properties, 'head') && value.head !== JSON.parse(readFileSync(join(value.runDir, 'run.json'), 'utf8')).head) {
        throw new Error('Setup returned a different original base commit than the helper recorded')
      }
      if (request.setupRunId && value.runId !== request.setupRunId) throw new Error('Setup returned a different run ID than the host assigned')
    }
    return value
  }

  // Execute the shared engine's measurement request without another model turn.
  async function measure({ run, seat, label, replay }) {
    if (cancelled || signal?.aborted) throw new Error('Run interrupted')
    if (!/^[A-Z]$/.test(seat) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error('Invalid measurement key')
    const runDir = runDirectory(run), key = `measure-${seat}-${label}`
    const jobDir = confined(runDir, join(runDir, 'jobs', key))
    const options = { cwd: repo, env: childEnv, signal }
    activeJobs.add(jobDir)
    emit({ type: 'measurement.started', job: key, runDir })
    try {
      let result = await execute(['measure', '--run-dir', runDir, '--seat', seat, '--label', label,
        ...(replay ? ['--replay-json', JSON.stringify(replay)] : []), '--max-wait', '5'], options)
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
  function brief({ document, source }) {
    const input = source ? ['--reuse', source] : ['--document', JSON.stringify(document)]
    return callHelper(['brief', '--repo', repo, '--host-dir', hostRunDir, ...input], { cwd: repo, env: childEnv, signal })
  }
  return { agent, turn, measure, brief, cancel, now: () => Date.now(), elapsedBefore, budgetStop: () => limitStop, checkpointState: () => ({ sequence, elapsedMs: elapsedBefore + Date.now() - started, spentTurns }) }
}

export async function runWorkflow(options, dependencies = {}) {
  const pin = environmentPin()
  if (options.pinEngine) throw drift('Use the shipped CLI bootstrap for --pin-engine')
  if (pin && options.workflow === 'run-plan') throw drift('Run-plan does not support pinned execution yet')
  const executor = pin ? guardEngine(pin) : liveIdentity()
  if (options.workflow === 'run-plan') {
    const { runPlan } = await import('./run-plan-runner.mjs')
    return runPlan({ ...options, engine: executor.packageDigest }, dependencies.runPlan)
  }
  let resumeMeta = null
  if (options.resume) {
    resumeMeta = JSON.parse(readFileSync(join(options.resume, 'host.json'), 'utf8'))
    if (options.workflowGiven && options.workflow !== resumeMeta.workflow) throw new Error('Cannot change workflow on resume.')
    options = { ...options, cwd: resumeMeta.repo, workflow: resumeMeta.workflow }
  }
  executor.locations = [...new Set([...(resumeMeta?.provenance?.executor?.locations || []), resumeMeta?.pin?.root, executor.root].filter(Boolean))]
  const runtimeOptions = {}
  for (const [key, fallback] of Object.entries({ concurrency: 3, timeoutMin: 90 })) {
    // Direct API callers may supply values without the CLI's explicit-option markers.
    const given = options[key + 'Given'] ?? (options[key] !== undefined)
    runtimeOptions[key] = positiveInteger(given ? options[key] : resumeMeta?.runtimeOptions?.[key] ?? options[key] ?? fallback, key)
  }
  const repo = realpathSync(gitRoot(resolve(options.cwd), '--show-toplevel'))
  if (pin && isolationIssues(dirname(pin.root), [repo]).length) throw drift('Pinned export overlaps candidate checkout')
  // Prepare before intake, so a missing CLI or document costs no model turn and no run directory.
  const prepared = options.resume ? null : await (dependencies.prepare || prepareLaunch)(options, repo)
  if (options.prepare) return { status: prepared.status === 'ready' ? 'prepared' : 'preflight', prepared }
  if (prepared?.status === 'blocked') return { status: 'preflight', error: `Launch preparation found unmet prerequisites; no model turn ran: ${prepared.blocking.join('; ')}`, prepared }
  const commonGit = resolve(repo, gitRoot(repo, '--git-common-dir'))
  const worktreeGit = resolve(repo, gitRoot(repo, '--git-dir'))
  const hostBase = join(repo, '.council')
  if (existsSync(hostBase) && (lstatSync(hostBase).isSymbolicLink() || !lstatSync(hostBase).isDirectory())) throw new Error('.council must be a directory inside the target repository')
  mkdirSync(hostBase, { recursive: true })
  const hostRunDir = options.resume ? realpathSync(options.resume) : mkdtempSync(join(hostBase, 'host-'))
  confined(hostBase, hostRunDir)
  const lock = join(hostRunDir, 'host.lock')
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'))
    let running = false
    try { process.kill(pid, 0); running = true } catch (error) { if (error.code !== 'ESRCH') running = true }
    if (running) throw new Error('This host run is still active.')
    unlinkSync(lock)
  }
  const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd)
  try { return await executeHost() } finally { unlinkSync(lock) }

  async function executeHost() {
    const events = join(hostRunDir, 'events.jsonl')
    // Each turn's role by job key, for the running token total (earlier attempts' turns included).
    const roles = new Map(readEventLog(events).filter(e => e.type === 'turn.started' && e.job).map(e => [e.job, e.role]))
    const emit = event => {
      if (event.type === 'turn.started' && event.job) roles.set(event.job, event.role)
      const record = { at: new Date().toISOString(), ...event }
      appendFileSync(events, JSON.stringify(record) + '\n')
      ;(dependencies.progress || (line => process.stderr.write(line + '\n')))(JSON.stringify(record))
    }
    const isFactory = options.workflow === 'factory'
    const source = isFactory ? null : workflowSource(options.workflow)
    const factorySource = isFactory ? factorySources(executor) : null
    const engine = executor.packageDigest
    const previous = options.resume ? JSON.parse(readFileSync(join(hostRunDir, 'args.json'), 'utf8')) : {}
    const args = { ...previous, ...options.args, host: 'codex', repo, cli: 'dark-factory', hostRunId: hostRunDir.split('/').at(-1) }
    // Intake is replayed on resume, including after an authorized cap increase.
    // Keep its original budget context stable while execution uses the current caps.
    args.intakeLimits = previous.intakeLimits || { maxTurns: args.maxTurns || null, maxRunMin: args.maxRunMin || null }
    let answeredStop = false
    if (options.resume) {
      const immutable = value => Object.fromEntries(Object.entries(value).filter(([k]) => !['clarifications', 'tierConfirmed', 'noSplit', 'maxTurns', 'maxRunMin', 'explain'].includes(k)))
      if (fingerprint(immutable(args)) !== fingerprint(immutable(previous))) throw new Error('Task or execution arguments changed; start a new run so dependent reviews are fresh.')
      const oldAnswers = previous.clarifications || []
      const stopped = existsSync(join(hostRunDir, 'result.json')) ? JSON.parse(readFileSync(join(hostRunDir, 'result.json'), 'utf8')) : null
      // A Pair stop that can continue: every resume of it, with new answers or none, checks every
      // answer against the run's own questions before anything is written or any turn runs, so a
      // malformed, repeated, unknown or missing ID is named rather than replayed or refused
      // generically. Then answers a stop took must stay as they were; one no stop took (held from
      // the first arguments) never reached a prompt, so it may be removed.
      if (stopped?.status === 'needs-user' && stopped.resumable === true && stopped.brief?.state !== 'provisional') {
        const took = new Set((Array.isArray(stopped.decisions) ? stopped.decisions : []).map(d => d?.id))
        const taken = list => (Array.isArray(list) ? list : []).filter(a => took.has(a?.id))
        const briefIds = new Set((options.workflow === 'factory' && previous.brief === undefined ? stopped.brief?.decisions || [] : []).map(d => d.id))
        const atBrief = answers => answers.filter(a => briefIds.has(a?.id))
        const answers = args.clarifications || []
        if (briefIds.size && (!Array.isArray(answers) || fingerprint(atBrief(answers)) !== fingerprint(atBrief(oldAnswers)))) throw new Error('Existing clarification answers cannot change on resume.')
        const check = pairResumeAnswerCheck(stopped, briefIds.size ? answers.filter(a => !briefIds.has(a?.id)) : answers)
        if (check.settled && fingerprint(taken(args.clarifications)) !== fingerprint(taken(oldAnswers))) throw new Error('Existing clarification answers cannot change on resume.')
        if (!check.settled) {
          const { retro, ...rest } = stopped
          const guidance = String(rest.forTheOrchestrator || '').replace(/ Last, show retro\.markdown as it is: notes on the workflow, not the user's project\./, '')
          return { ...rest, forTheOrchestrator: guidance, stopReason: check.message,
            answerIssues: { missing: check.missing, unknown: check.unknown, invalid: check.invalid },
            ...(rest.summary ? { summary: { ...rest.summary, stopReason: check.message } } : {}) }
        }
        answeredStop = true
      }
    }
    if (options.resume && !answeredStop) {
      const oldAnswers = previous.clarifications || []
      if (fingerprint((args.clarifications || []).slice(0, oldAnswers.length)) !== fingerprint(oldAnswers)) throw new Error('Existing clarification answers cannot change on resume.')
      const newAnswers = (args.clarifications || []).slice(oldAnswers.length)
      const prior = newAnswers.length ? JSON.parse(readFileSync(join(hostRunDir, 'result.json'), 'utf8')) : null
      const answerIDs = new Set(oldAnswers.map(a => a.id))
      for (const answer of newAnswers) {
        if (!answer || answerIDs.has(answer.id) || !String(answer.answer || '').trim()) throw new Error('Clarification IDs must be unique and answers nonempty.')
        answerIDs.add(answer.id)
        const questions = prior.questions || []
        if (prior.status !== 'needs-user' || !questions.some(q => q.id === answer.id)) throw new Error('New clarification must answer a question from this paused run.')
        if (typeof prior.round === 'number') answer.afterRound = prior.round
      }
    }
    const admission = pin ? (await import('./policy.mjs')).reachableProviders({}, { workflow: options.workflow, args }) : null
    if (admission) {
      for (const kind of new Set(admission.map(route => route.vendor))) await inspectSeat(pin, { kind, cwd: repo, repoRoot: repo, writable: [] })
      emit({ type: 'pin.admission', routes: admission })
    }
    const initialProvenance = await runProvenance(repo, args, executor)
    const saved = options.resume ? loadCheckpoint(hostRunDir, { repo, args, engine, executor }) : null
    // The stopped run's retro (or factory record) was its last turn; the continued run ends with its
    // own, so it keeps one, and the replay does not wait for a request that never comes.
    if (saved && answeredStop && ['retro', 'record'].includes(saved.entries.at(-1)?.label)) saved.entries.pop()
    if (saved && pin) await validateAdmissions(hostRunDir, pin)
    const elapsedBefore = Math.max(resumeMeta?.elapsedMs || 0, saved?.runtime.elapsedMs || 0)
    const recordedTurns = readEventLog(events, true).filter(e => e.type === 'turn.started').length
    const spentBefore = Math.max(resumeMeta?.spentTurns || 0, saved?.runtime.spentTurns || 0, recordedTurns)
    const attempt = (resumeMeta?.attempt || 0) + (options.resume ? 1 : 0)
    const hostInfo = { repo, workflow: options.workflow, attempt, runtimeOptions, pin, provenance: initialProvenance }
    writeJsonAtomic(join(hostRunDir, 'host.json'), { ...hostInfo, elapsedMs: elapsedBefore, spentTurns: spentBefore })
    writeJsonAtomic(join(hostRunDir, 'args.json'), args, 2)
    const controller = new AbortController()
    const rawRuntime = createRuntime({ repo, hostRunDir, ...runtimeOptions, admission,
      initialSequence: saved?.runtime.sequence || 0, attempt, elapsedBefore, spentBefore, maxTurns: args.maxTurns, gitDirs: [...new Set([commonGit, worktreeGit])], emit, signal: controller.signal, ...dependencies.runtime })
    const runtime = journalRuntime(rawRuntime, { repo, hostRunDir, args, engine, executor, saved, emit })
    // The running token total for the workflow's milestones: each turn's helper record, read as it
    // is appended (a resumed run starts from the earlier attempts' records).
    const live = liveUsage({ roles: job => roles.get(job) || null })
    runtime.usage = () => live(runtime.runDirectories())
    // --explain: the comparable past runs this repository's .council (and DARK_FACTORY_HISTORY) holds.
    // Read only when the workflow asks (an explanation), so a run that does not explain pays nothing.
    runtime.history = () => (dependencies.history || runHistory)({ repo, env: process.env, exclude: hostRunDir })
    let timedOut = false
    const interrupt = () => { runtime.cancel(); controller.abort() }
    const timer = args.maxRunMin ? setTimeout(() => { timedOut = true; interrupt() }, Math.max(1, positiveInteger(args.maxRunMin, 'maxRunMin') * 60000 - elapsedBefore)) : null
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
    let result, childStarts = 0
    try {
      const scripts = isFactory ? new Map([...factorySource].map(([name, text]) => [name, compileWorkflow(text)])) : null
      if (prepared) emit({ type: 'prepare', ...prepared })
      emit({ type: 'run.started', workflow: options.workflow, repo, hostRunDir, resumed: !!saved })
      const unsupported = () => { throw new Error('The workflow called a runtime function without a host adapter') }
      const parallel = async jobs => {
        const values = await Promise.allSettled(jobs.map(job => job()))
        const failure = values.find(v => v.status === 'rejected')
        if (failure) throw failure.reason
        return values.map(v => v.value)
      }
      const phase = title => emit({ type: 'phase', title })
      const log = message => emit({ type: 'log', message })
      const budget = {}
      const nested = () => { throw new Error('workflow() cannot be called inside a child workflow') }
      const execute = (script, input, callWorkflow) =>
        script(unsupported, parallel, unsupported, phase, log, input, budget, callWorkflow, runtime)

      async function workflow(name, childArgs) {
        if (options.workflow !== 'factory') {
          throw new Error(`workflow() is available on this runner only to dark-factory:factory, not dark-factory:${options.workflow}`)
        }
        const child = FACTORY_CHILDREN.find(child => name === `dark-factory:${child}`)
        if (!child) {
          const type = typeof name
          const shown = name !== null && (type === 'object' || type === 'function') ? type : String(name)
          throw new Error(`Unknown workflow: ${shown}`)
        }
        const input = structuredClone(childArgs)
        childStarts++
        emit({ type: 'workflow.started', name })
        const value = await execute(scripts.get(child), input, nested)
        emit({ type: 'workflow.completed', name })
        return value
      }

      result = await execute(isFactory ? scripts.get('factory') : compileWorkflow(source), args, workflow)
      if (!result || typeof result !== 'object') throw new Error('The workflow returned no result')
      if (controller.signal.aborted) throw new Error('Run interrupted')
    } catch (error) {
      runtime.cancel()
      result = timedOut ? { status: 'blocked', stopReason: 'Run time budget exhausted.', final: { readiness: { state: 'incomplete', blocked: [], incomplete: ['Run time budget exhausted.'] } } }
        : { status: 'failed', error: controller.signal.aborted ? 'Run interrupted' : error.message }
    } finally {
      if (timer) clearTimeout(timer)
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    }
    const runtimeStats = runtime.checkpointState()
    writeJsonAtomic(join(hostRunDir, 'host.json'), { ...hostInfo, ...runtimeStats })
    if (runtime.budgetStop() && result.final?.readiness?.state !== 'ready') result = { ...result, status: 'blocked', stopReason: runtime.budgetStop(), final: { ...result.final, readiness: { state: 'incomplete', blocked: result.final?.readiness?.blocked || [], incomplete: [runtime.budgetStop()] } } }
    // A budget stop cannot continue, so a Pair result loses any resume steps here.
    result = withdrawResume({ ...result })
    result = { ...result, host: 'codex', hostRunDir, hostEvents: events, checkpoint: existsSync(join(hostRunDir, 'checkpoint.json')) ? join(hostRunDir, 'checkpoint.json') : null }
    if (pin) guardEngine(pin)
    // Only Factory starts children. One that started more than one escalated, so its provenance
    // also lists the earlier attempts' directories. Any other run, a setup rerun after an answered
    // stop included, lists the final directory and the host directory only.
    result.provenance = await runProvenance(repo, { ...args, design: result.design || args.design }, executor, { ...result.final, runDir: result.runDir, hostRunDir },
      childStarts > 1 ? runtime.runDirectories() : [])
    if (result.summary) result.summary.provenance = result.provenance
    // An interruption may bypass the engine's final report. Keep measured effort, leaving
    // phase-specific findings and decisions unknown instead of dropping the failed run.
    result.metrics ||= { version: 1, taskId: args.evaluation?.taskId || null, variant: args.evaluation?.variant || null,
      repetition: args.evaluation?.repetition || null, workflow: options.workflow, host: 'codex', tier: args.tier || null,
      strategy: options.workflow === 'pair' ? 'pair' : args.strategy || 'unknown',
      readiness: result.final?.readiness?.state || 'incomplete', findingsByStage: null, escalated: null,
      detailIncomplete: true, tokens: null, cost: null, limits: { maxTurns: args.maxTurns || null, maxRunMin: args.maxRunMin || null } }
    // Every turn of every run directory, with turns whose CLI reported no usage read back from the
    // vendor's session log, or listed in tokens.missing (tokens.complete false).
    try {
      const { turns, ...tokens } = accountRun({ runDirs: runtime.runDirectories(), hostRunDir, roles, homes: dependencies.homes })
      // Each turn's line (role, seat, model, tokens, seconds, source) goes beside the result.
      writeJsonAtomic(join(hostRunDir, 'tokens.json'), { ...tokens, turns }, 2)
      result.metrics.tokens = tokens.records || tokens.missing.length ? { ...tokens, turnsFile: join(hostRunDir, 'tokens.json') } : null
    } catch (error) { result.metrics.tokenError = error.message }
    const history = readEventLog(events)
    result.metrics.turnsByRole = history.filter(e => e.type === 'turn.started').reduce((roles, e) => { roles[e.role || 'agent'] = (roles[e.role || 'agent'] || 0) + 1; return roles }, {})
    result.metrics.failedTurns = history.filter(e => e.type === 'turn.failed' || (e.type === 'turn.completed' && e.status !== 'done')).length
    result.metrics.turns = runtimeStats.spentTurns
    result.metrics.elapsedMs = runtimeStats.elapsedMs
    result.metrics.repositoryHead = gitRoot(repo, 'HEAD')
    if (result.summary && result.runDir && runtime.runDirectories().includes(result.runDir)) {
      result.summaryFile = join(result.runDir, 'summary.json')
      result.summary = { ...result.summary, status: result.status, stopReason: result.stopReason || result.error || '', final: { ...result.summary.final, readiness: result.final?.readiness } }
      writeJsonAtomic(result.summaryFile, result.summary, 2)
      writeJsonAtomic(join(result.runDir, 'result.json'), result, 2)
    }
    const json = JSON.stringify(result, null, 2) + '\n'
    writeJsonAtomic(join(hostRunDir, 'result.json'), result, 2)
    writeJsonAtomic(join(hostRunDir, 'metrics.json'), result.metrics, 2)
    if (options.output) writeFileSync(options.output, json)
    emit({ type: 'run.completed', status: result.status, exitCode: resultExitCode(result), result: join(hostRunDir, 'result.json'), summary: result.summaryFile || null })
    return result
  }
}

// Idle sleep on a Mac stalls a standalone run's turns and measurements. `caffeinate -w` exits
// with this process; -i prevents idle sleep only, so closing the lid still sleeps the machine.
export function keepAwake({ platform = osPlatform(), env = process.env, pid = process.pid, start = spawn } = {}) {
  if (platform !== 'darwin' || env.DARK_FACTORY_KEEP_AWAKE === '0') return null
  try {
    const child = start('caffeinate', ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' })
    child.on?.('error', () => {})
    child.unref?.()
    return child
  } catch { return null }
}

// A transport agent relays stdout through its own tool output, which a full Pair result (tens of
// kilobytes of design and contract text) overflows. --brief keeps what a caller acts on and points
// at the full result on disk.
const BRIEF_DROPPED = ['task', 'design', 'testContract', 'replayMapping', 'reviews', 'report', 'repositoryNotes', 'provenance', 'plan', 'refs']
// forTheOrchestrator is guidance (about 1k characters, a few k at most with a handoff chain), and
// the only thing that tells the orchestrator what to do next, so the brief keeps it, capped.
const BRIEF_GUIDANCE_MAX = 4000
export function briefResult(result) {
  const brief = Object.fromEntries(Object.entries(result || {}).filter(([key]) => !BRIEF_DROPPED.includes(key)))
  if (Array.isArray(result?.findings)) brief.findings = result.findings.map(f => ({ id: f.id, stage: f.stage, severity: f.severity, status: f.status, statement: String(f.statement || '').slice(0, 300) }))
  if (result?.final && typeof result.final === 'object') brief.final = Object.fromEntries(['author', 'model', 'worktree', 'post', 'snapshotRef', 'snapshotTree', 'readiness'].filter(key => key in result.final).map(key => [key, result.final[key]]))
  // The retro's notes and items are in its saved file and result.json; its markdown is what is shown.
  if (result?.retro && typeof result.retro === 'object') brief.retro = Object.fromEntries(['saved', 'error', 'markdown'].filter(key => key in result.retro).map(key => [key, result.retro[key]]))
  if (typeof result?.forTheOrchestrator === 'string' && result.forTheOrchestrator.length > BRIEF_GUIDANCE_MAX) brief.forTheOrchestrator = result.forTheOrchestrator.slice(0, BRIEF_GUIDANCE_MAX) + ' [truncated; the rest is in resultFile]'
  if (result?.hostRunDir) brief.resultFile = join(result.hostRunDir, 'result.json')
  return brief
}

export async function main(argv = process.argv.slice(2)) {
  let result, brief = false, options
  try {
    options = parseCLI(argv)
    if (options.help) { process.stdout.write(HELP); return }
    brief = !!options.brief
    keepAwake()
    result = await runWorkflow(options)
  } catch (error) {
    // A refusal before the run starts (engine drift, a changed resume) still reaches --output,
    // which run-plan reads for the task's result.
    result = { status: 'failed', error: error.message, ...(error.code ? { code: error.code } : {}) }
    if (options?.output) writeFileSync(options.output, JSON.stringify(result, null, 2) + '\n')
  }
  process.stdout.write(brief ? JSON.stringify(briefResult(result)) + '\n' : JSON.stringify(result, null, 2) + '\n')
  process.exitCode = resultExitCode(result)
}
