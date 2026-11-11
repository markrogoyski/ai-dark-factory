// Process/filesystem adapter for the shared run-plan policy. Child workflows keep their own
// engine, independent seats, snapshots, reviews, and strict single-run checkpoints.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, lstatSync, readdirSync, linkSync, unlinkSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, digest, writeJsonAtomic } from './checkpoint.mjs'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = join(plugin, 'bin/dark-factory-codex')
const helper = join(plugin, 'bin/dark-factory')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 2) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }

export async function runPlan(options, dependencies = {}) {
  let state, stateDir, planPath, planRel, repo, lock, lockOwned = false, branch, controlFiles = {}
  let interrupted = false, stopChild = null
  const now = dependencies.now || Date.now
  const emit = dependencies.progress || (message => process.stderr.write(message + '\n'))
  const git = (argv, extra = {}) => execFileSync('git', ['-C', repo || options.cwd, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...extra,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...extra.env } }).replace(/\n$/, '')
  const head = () => git(['rev-parse', 'HEAD'])
  const save = async S => { writeJsonAtomic(join(stateDir, 'state.json'), S, 2); state = S }
  const point = async name => { if (dependencies.at) await dependencies.at(name, state) }
  const assertLocation = path => {
    const resolved = resolve(path)
    if (!inside(join(repo, '.council'), resolved) || (existsSync(resolved) && (!inside(realpathSync(join(repo, '.council')), realpathSync(resolved)) || lstatSync(resolved).isSymbolicLink()))) throw new Error('Run-plan artifact escaped .council')
    return resolved
  }
  const clean = () => {
    for (const [path, hash] of Object.entries(controlFiles)) if (!existsSync(join(repo, path)) || lstatSync(join(repo, path)).isSymbolicLink() || digest(readFileSync(join(repo, path))) !== hash) throw new Error(`Run-plan control file changed: ${path}`)
    const rows = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
    if (rows.some(row => row.slice(0, 3) !== '?? ' || !Object.hasOwn(controlFiles, row.slice(3)))) throw new Error('Run-plan checkout is dirty; preserve and resolve its changes before resuming. No files were reset.')
  }
  const unchanged = S => {
    if (head() !== S.head || git(['symbolic-ref', '--short', 'HEAD']) !== S.branch) throw new Error('Run-plan branch or HEAD changed; no saved completion was reused.')
    for (const [path, hash] of Object.entries(S.references)) if (!existsSync(path) || digest(readFileSync(path)) !== hash) throw new Error(`Run-plan reference changed: ${path}. Saved completion was not reused.`)
  }
  const workspaceTree = () => {
    const index = join(stateDir, 'inspect.index')
    try { unlinkSync(index) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const env = { ...process.env, GIT_INDEX_FILE: index }
    git(['read-tree', 'HEAD'], { env })
    git(['add', '-A', '--', '.'], { env })
    for (const path of Object.keys(controlFiles)) git(['update-index', '--force-remove', '--', path], { env })
    return git(['write-tree'], { env })
  }
  const millisecondsLeft = S => {
    if (interrupted) throw new Error('Run-plan interrupted; resume using the same plan file.')
    const remaining = S.active.milliseconds - (now() - S.active.startedAt)
    if (remaining <= 0) throw new Error('Run-plan attempt time budget exhausted.')
    return remaining
  }
  const interrupt = () => { interrupted = true; stopChild?.() }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)

  async function processCall(S, command, argv, label) {
    const timeout = millisecondsLeft(S)
    const log = join(S.active.directory, `${label}.log`)
    return await new Promise((done, reject) => {
      const child = spawn(command, argv, { cwd: repo, env: { ...process.env, PATH: `${join(plugin, 'bin')}:${process.env.PATH || ''}` }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', errorOutput = '', timedOut = false, killer
      const stop = () => {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
      }
      stopChild = stop
      // Reserve before spawning; retain the child PID so another invocation cannot race it.
      S.active.pid = child.pid || null
      writeJsonAtomic(join(stateDir, 'state.json'), S, 2)
      const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
      child.stdout.on('data', bytes => { output = (output + bytes).slice(-8 * 1024 * 1024); appendFileSync(log, bytes) })
      child.stderr.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(-4000); appendFileSync(log, bytes); if (label === 'workflow') emit(String(bytes).trimEnd()) })
      const cleanup = () => { clearTimeout(timer); clearTimeout(killer); stopChild = null; S.active.pid = null }
      child.on('error', error => { cleanup(); reject(error) })
      child.on('close', code => {
        cleanup()
        if (interrupted || timedOut) reject(new Error(interrupted ? 'Run-plan interrupted' : 'Run-plan attempt time budget exhausted'))
        else done({ code, output, error: errorOutput, log })
      })
    })
  }

  function settle(S, result) {
    const a = S.active
    const measured = result?.metrics?.turns
    const spent = Number.isSafeInteger(measured) && measured >= 0 ? Math.min(measured, a.turns) : a.turns
    S.turns -= a.turns - spent
    S.elapsedMs -= a.milliseconds - Math.max(0, (a.finishedAt ?? now()) - a.startedAt)
  }

  async function finish(S, task, result, status) {
    unchanged(S); clean()
    const record = S.tasks[task.id]
    const questions = [result.questions, result.items].find(value => Array.isArray(value) && value.length)
    Object.assign(record, { status, result: join(S.active.directory, 'result.json'),
      question: status === 'parked' ? questions || result.error || result.stopReason || (task.id === 'acceptance'
        ? { error: 'Final acceptance did not establish every criterion as met.', readiness: result.final?.readiness, criteria: result.final?.criteria }
        : result.tier === 'architecture' ? 'Task returned a design instead of an implementation; revise the plan run decomposition.' : result.final?.readiness) || 'Task needs a decision or exhausted its attempts.' : null })
    if (task.id === 'acceptance' && status === 'done') record.head = S.head
    settle(S, result); S.active = null
    await save(S)
    emit(`run-plan ${S.plan.id}: ${task.id} ${status}`)
  }

  async function helperCall(S, argv) {
    let response = await processCall(S, helper, argv, 'delivery')
    let value = JSON.parse(response.output.trim().split('\n').at(-1))
    while (value.status === 'running') {
      response = await processCall(S, helper, ['wait', '--run-dir', S.active.delivery.runDir, '--job', value.job, '--max-wait', '5'], 'delivery')
      value = JSON.parse(response.output.trim().split('\n').at(-1))
    }
    return value
  }

  async function parkDelivery(S, error) {
    const a = S.active, d = a.delivery
    if (!d.failure) {
      d.failure = error.message
      a.finishedAt ??= now()
      await save(S)
      await point('after-delivery-failure')
    }
    assertDeliveryStopped(S)
    // Only undo bytes owned by this delivery. A hook, verifier, or user may have changed
    // other files; retain those changes and the failure journal for manual recovery.
    unchanged(S)
    const known = [d.baseTree, d.snapshotTree, d.tree]
    const indexTree = git(['write-tree']), currentTree = workspaceTree()
    if (!known.includes(indexTree) || !known.includes(currentTree)) {
      throw new Error(`${d.failure} Unexpected delivery changes were preserved; restore the recorded base or delivery bytes before resuming.`)
    }
    if (currentTree !== d.baseTree || indexTree !== d.baseTree) {
      // Stage the known tree directly: a deletion already staged by commit has no path
      // left for `git add <path>`, but restore can still recover it from the base.
      git(['read-tree', currentTree])
      git(['restore', '--source', d.base, '--staged', '--worktree', '--', ...d.paths, ...(d.planBytes ? [planRel] : [])])
    }
    await point('after-delivery-rollback')
    await finish(S, { id: a.task }, { ...json(d.result), error: d.failure }, 'parked')
  }

  function assertDeliveryStopped(S) {
    const job = assertLocation(join(S.active.delivery.runDir, 'jobs/verify-delivery'))
    const status = existsSync(join(job, 'status.json')) ? json(join(job, 'status.json')).status : null
    if ((!status || status === 'running') && existsSync(join(job, 'pid')) && alive(Number(readFileSync(join(job, 'pid'), 'utf8')))) throw new Error('An interrupted delivery verification is still running; wait before resuming')
  }

  async function continueDelivery(S) {
    const a = S.active, d = a.delivery, currentHead = head()
    if (d.failure) { await parkDelivery(S); return }
    if (currentHead !== d.base) {
      // A commit may have completed before the final journal write. Recognize the exact
      // expected parent, tree, and trailers, never just a task ID somewhere in git log.
      if (git(['rev-parse', 'HEAD^']) !== d.base || git(['rev-parse', 'HEAD^{tree}']) !== d.tree ||
          !git(['log', '-1', '--format=%B']).trimEnd().endsWith(d.trailers)) throw new Error('HEAD changed during delivery; preserve the checkout and inspect the plan run journal.')
      clean()
      S.tasks[a.task].status = 'done'; S.tasks[a.task].commit = currentHead; S.tasks[a.task].question = null
      S.head = currentHead; S.active = null
      await save(S)
      return
    }
    if (git(['symbolic-ref', '--short', 'HEAD']) !== S.branch) throw new Error('Run-plan branch changed during delivery')
    if (![d.baseTree, d.snapshotTree, d.tree].includes(git(['write-tree']))) throw new Error('Interrupted delivery has unexpected staged changes; no files were reset.')
    const current = workspaceTree()
    if (current === d.baseTree) {
      clean()
      if (readFileSync(d.patch).length) git(['apply', '--check', d.patch])
      if (readFileSync(d.patch).length) git(['apply', d.patch])
      await point('after-apply')
    } else if (current !== d.snapshotTree && current !== d.tree) {
      throw new Error('Interrupted delivery has unexpected checkout changes; no files were reset. Restore the recorded base or reviewed delivery bytes before resuming.')
    }
    if (d.planBytes) writeFileSync(planPath, d.planBytes)
    if (workspaceTree() !== d.tree) throw new Error('Delivery differs from the prepared tree')
    // A verification that passed before an interruption covers these exact bytes on this base:
    // its run is unique to this delivery, and the checkout still equals the prepared tree.
    const deliveryFile = join(d.runDir, 'delivery.json')
    const verified = existsSync(deliveryFile) && json(deliveryFile).status === 'delivered' && json(deliveryFile).mainHead === d.base
    await point('before-verify-delivery')
    if (!verified) try {
      const outcome = dependencies.verifyDelivery ? await dependencies.verifyDelivery(S, d) : await helperCall(S, [
        'verify-delivery', '--run-dir', d.runDir, '--result', d.result, '--manifest', d.manifest, '--max-wait', '5',
        '--suite-timeout', String(Math.max(1, Math.floor(millisecondsLeft(S) / 1000))),
      ])
      const delivered = json(join(d.runDir, 'delivery.json'))
      if (outcome.status === 'error' || delivered.status !== 'delivered') throw new Error(`Delivery verification did not pass; inspect ${join(d.runDir, 'delivery.json')}.`)
    } catch (error) {
      if (interrupted) throw error
      await parkDelivery(S, error); return
    }
    if (head() !== d.base || workspaceTree() !== d.tree) throw new Error('Delivery verification changed the checkout')
    // Stage only the reviewed files and deterministic run-plan progress. Hooks remain enabled.
    if (d.paths.length || d.planBytes) git(['add', '-A', '--', ...d.paths, ...(d.planBytes ? [planRel] : [])])
    if (git(['write-tree']) !== d.tree) throw new Error('The index differs from the verified delivery')
    await point('before-commit')
    try {
      git(['commit', '--allow-empty', '-F', d.message], { timeout: Math.max(1, Math.floor(millisecondsLeft(S))) })
    } catch (error) {
      if (head() !== d.base || interrupted) throw error
      await parkDelivery(S, new Error(`Delivery commit failed: ${error.message}`)); return
    }
    await point('after-commit')
    if (git(['rev-parse', 'HEAD^{tree}']) !== d.tree || git(['rev-parse', 'HEAD^']) !== d.base || workspaceTree() !== d.tree) throw new Error('Commit hooks changed the verified delivery; inspect the checkout before resuming')
    clean()
    S.tasks[a.task].commit = head()
    S.head = head()
    await finish(S, { id: a.task }, json(d.result), 'done')
  }

  const runtime = {
    async open(input, normalize) {
      for (const key of Object.keys(input)) if (!['planFile', 'repo', 'answers', 'extendLimits'].includes(key)) throw new Error(`Run-plan option ${key} belongs in the plan file, not runner arguments`)
      repo = realpathSync(git(['rev-parse', '--show-toplevel']))
      const requestedPlan = resolve(repo, input.planFile)
      if (!existsSync(requestedPlan) || !lstatSync(requestedPlan).isFile()) throw new Error('Run-plan file must be a regular file inside the repository')
      planPath = realpathSync(requestedPlan)
      if (!inside(repo, planPath)) throw new Error('Run-plan file must be a regular file inside the repository')
      planRel = relative(repo, planPath)
      if (planRel.startsWith('.council/') || planRel.startsWith('.git/')) throw new Error('Execution plan must be outside .git and .council')
      const planTracked = !!git(['ls-files', '--', planRel])
      branch = git(['symbolic-ref', '--short', 'HEAD'])
      const common = resolve(repo, git(['rev-parse', '--git-common-dir']))
      lock = join(common, 'dark-factory-run-plan.lock')
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, 'utf8'))
        // An empty lock may still be being initialized by its owner. Never reclaim it.
        if (!Number.isSafeInteger(pid) || pid < 2 || alive(pid)) throw new Error('A run-plan is already running in this repository (or its lock is incomplete)')
        unlinkSync(lock)
      }
      // Publish initialized ownership atomically; contenders never see our lock empty.
      const owner = `${lock}.${randomUUID()}`
      writeFileSync(owner, String(process.pid), { flag: 'wx' })
      try { linkSync(owner, lock); lockOwned = true } finally { unlinkSync(owner) }
      const base = join(repo, '.council')
      if (existsSync(base) && (lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory())) throw new Error('.council must be a directory inside the repository')
      mkdirSync(base, { recursive: true })
      const exclude = join(common, 'info/exclude')
      mkdirSync(dirname(exclude), { recursive: true })
      const prior = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!prior.split('\n').includes('/.council/')) appendFileSync(exclude, `${prior.endsWith('\n') ? '' : '\n'}/.council/\n`)
      const raw = json(planPath), plan = normalize(raw)
      const referencePaths = [...new Set([plan.defaults, ...plan.tasks.map(t => t.args), plan.acceptance.args].flatMap(o => o.plan === undefined ? [] : Array.isArray(o.plan) ? o.plan : [o.plan]))]
      const references = Object.fromEntries(referencePaths.map(p => {
        if (typeof p !== 'string' || !p.trim()) throw new Error('Run-plan reference paths must be nonempty strings')
        const path = resolve(repo, p)
        if (path === planPath) throw new Error('Use task criteria and decisions for the execution plan; it cannot also be a changing reference input')
        return [path, digest(readFileSync(path))]
      }))
      const candidates = [planRel, 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md',
        ...Object.keys(references).filter(p => inside(repo, p)).map(p => relative(repo, p))]
      controlFiles = Object.fromEntries([...new Set(candidates)].filter(p => existsSync(join(repo, p)) && !git(['ls-files', '--', p])).map(p => {
        if (!lstatSync(join(repo, p)).isFile() || lstatSync(join(repo, p)).isSymbolicLink()) throw new Error(`Run-plan control file must be regular: ${p}`)
        return [p, digest(readFileSync(join(repo, p)))]
      }))
      stateDir = assertLocation(join(base, `run-plan-${plan.id}`))
      mkdirSync(stateDir, { recursive: true })
      const file = join(stateDir, 'state.json')
      if (existsSync(file)) {
        const S = json(file)
        if (S.version !== 1 || S.repo !== repo || S.branch !== branch || S.planPath !== planPath || S.definition !== fingerprint(plan) || fingerprint(S.references) !== fingerprint(references)) throw new Error('Run-plan definition, references, repository, or branch changed; saved state was not reused. Keep existing artifacts and use a new plan for changed scope.')
        if (fingerprint(S.controlFiles || {}) !== fingerprint(controlFiles)) throw new Error('Run-plan control files changed; saved state was not reused.')
        state = S
        return S
      }
      clean()
      if (raw.progress || readdirSync(stateDir).length) throw new Error('Run-plan journal is missing but progress or artifacts remain; cannot reconstruct spent budgets safely')
      const S = { version: 1, repo, branch, planPath, planTracked, controlFiles, plan, references, definition: fingerprint(plan), head: head(), turns: 0, elapsedMs: 0,
        tasks: Object.fromEntries([...plan.tasks.map(t => t.id), 'acceptance'].map(id => [id, { status: 'pending', attempts: 0 }])), decisions: [], active: null }
      await save(S)
      return S
    },
    save,
    async recover(S) {
      if (!S.active) { unchanged(S); clean(); return }
      const a = S.active
      if (alive(a.pid)) throw new Error(`Run-plan child ${a.pid} is still running; wait for it before resuming`)
      // A killed controller may have left a child host or detached helper job running.
      const log = join(a.directory, 'workflow.log')
      if (existsSync(log)) {
        for (const line of readFileSync(log, 'utf8').split('\n')) {
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'turn.started' || !event.runDir || !event.job) continue
          const job = assertLocation(join(event.runDir, 'jobs', event.job))
          if (existsSync(join(job, 'status.json')) && json(join(job, 'status.json')).status !== 'running') continue
          if (existsSync(join(job, 'pid')) && alive(Number(readFileSync(join(job, 'pid'), 'utf8')))) throw new Error('An interrupted run-plan still has a running model job; wait for it before resuming')
        }
      }
      if (a.delivery) {
        assertDeliveryStopped(S)
        if (a.delivery.failure) { await parkDelivery(S); return }
        if (head() !== a.delivery.base) { await continueDelivery(S); return }
        const deliveryFile = join(a.delivery.runDir, 'delivery.json')
        if (existsSync(deliveryFile) && ['incomplete', 'error'].includes(json(deliveryFile).status)) {
          // Also recover failed deliveries written before failure journaling was added.
          // Retain the existing reservation; idle time and a second verification cost nothing.
          a.finishedAt = a.startedAt + a.milliseconds
          await parkDelivery(S, new Error(`Delivery verification did not pass; inspect ${deliveryFile}.`)); return
        }
        const available = Math.min(S.plan.limits.taskMaxRunMin * 60000, S.plan.limits.maxRunMin * 60000 - S.elapsedMs)
        if (available <= 0) {
          a.finishedAt = a.startedAt + a.milliseconds
          await parkDelivery(S, new Error('No run-plan time budget remains to verify the interrupted delivery.')); return
        }
        // Lost work retains its full reservation. Reserve recovery separately before verifying.
        a.turns = 0; a.milliseconds = available; a.startedAt = now(); S.elapsedMs += available
        await save(S)
        await continueDelivery(S)
      } else {
        unchanged(S); clean()
        S.tasks[a.task].status = 'parked'
        S.tasks[a.task].question = 'Attempt interrupted. Its reserved budget remains charged and its artifacts are retained. Answer to retry within the remaining attempt limit.'
        S.tasks[a.task].result = a.directory
        S.active = null
        await save(S)
      }
    },
    async reserve(S, task) {
      unchanged(S); clean()
      const record = S.tasks[task.id]
      const turns = Math.min(S.plan.limits.taskMaxTurns, S.plan.limits.maxTurns - S.turns)
      const milliseconds = Math.min(S.plan.limits.taskMaxRunMin * 60000, S.plan.limits.maxRunMin * 60000 - S.elapsedMs)
      const directory = assertLocation(join(stateDir, `${task.id}-${record.attempts + 1}`))
      if (existsSync(directory)) throw new Error('Attempt artifacts already exist without an active reservation; preserve them and inspect the journal')
      record.attempts++; record.status = 'running'
      S.turns += turns; S.elapsedMs += milliseconds
      S.active = { task: task.id, base: S.head, directory, turns, milliseconds, startedAt: now(), pid: null }
      S.active.decisionsFile = join(directory, 'decisions.json')
      await save(S)
      await point('after-reservation-journal')
      mkdirSync(directory)
      writeJsonAtomic(S.active.decisionsFile, { decisions: S.plan.decisions, answers: S.decisions,
        completed: Object.fromEntries(S.plan.tasks.filter(t => S.tasks[t.id].status === 'done').map(t => [t.id, S.tasks[t.id].decision])) }, 2)
      emit(`run-plan ${S.plan.id}: ${task.id}, attempt ${record.attempts}`)
      await point('after-reserve')
    },
    async execute(S, task, args) {
      const a = S.active
      const argsFile = join(a.directory, 'args.json'), resultFile = join(a.directory, 'result.json')
      writeJsonAtomic(argsFile, args, 2)
      let result
      if (task.id === 'acceptance') {
        const gate = dependencies.gate ? await dependencies.gate(S) : await processCall(S, '/bin/sh', ['-c', S.plan.acceptance.verify], 'acceptance')
        writeJsonAtomic(join(a.directory, 'acceptance.json'), { command: S.plan.acceptance.verify, cwd: repo, head: S.head, exitCode: gate.code, log: gate.log || null }, 2)
        unchanged(S); clean()
        if (gate.code !== 0) result = { status: 'blocked', error: 'Final acceptance command failed', gate, metrics: { turns: 0 } }
      }
      if (!result) {
        if (dependencies.runTask) result = await dependencies.runTask(S, task, args)
        else {
          const child = await processCall(S, process.execPath, [runner, '--workflow', task.workflow, '--cwd', repo, '--args-file', argsFile,
            '--output', resultFile, '--concurrency', String(options.concurrency || 3), '--timeout-min', String(options.timeoutMin || 90)], 'workflow')
          result = existsSync(resultFile) ? json(resultFile) : { status: 'failed', error: `Task runner exited ${child.code}: ${child.error}` }
        }
      }
      unchanged(S); clean()
      writeJsonAtomic(resultFile, result, 2)
      await save(S)
      await point('after-result')
      return result
    },
    async deliver(S, task, result) {
      const a = S.active, runDir = assertLocation(result.runDir)
      const run = json(join(runDir, 'run.json'))
      if (realpathSync(run.repoRoot) !== repo || run.head !== a.base || realpathSync(run.runDir) !== realpathSync(runDir)) throw new Error('Task result has a different repository or base')
      const ref = result.final.snapshotRef
      if (typeof ref !== 'string' || !ref.startsWith(`refs/council/${run.runId}/`)) throw new Error('Snapshot does not belong to the task run')
      const tree = git(['rev-parse', `${ref}^{tree}`])
      if (tree !== result.final.snapshotTree) throw new Error('Reviewed snapshot changed')
      const paths = git(['diff', '--no-renames', '--name-only', '-z', a.base, ref]).split('\0').filter(Boolean)
      const frozen = new Set([...Object.keys(S.references).filter(p => inside(repo, p)).map(p => relative(repo, p)), ...Object.keys(controlFiles)])
      if (paths.some(p => p === planRel || frozen.has(p) || p === '.council' || p.startsWith('.council/') || p.startsWith('.git/'))) throw new Error('Task changed run-plan-owned files or frozen reference inputs')
      const patch = join(a.directory, 'delivery.patch')
      writeFileSync(patch, git(['diff', '--binary', '--no-ext-diff', a.base, ref]) + (paths.length ? '\n' : ''))
      const resultFile = join(a.directory, 'result.json')
      S.tasks[task.id].result = resultFile
      const designFile = join(a.directory, 'design.json')
      writeJsonAtomic(designFile, { design: result.design || result.plan?.post || null }, 2)
      S.tasks[task.id].decision = { design: designFile, post: result.final.post || null, result: resultFile }
      const progress = { completed: { ...(json(planPath).progress?.completed || {}), [task.id]: { result: resultFile, snapshotRef: ref, snapshotTree: tree } }, decisions: S.decisions }
      const planBytes = S.planTracked === false ? null : JSON.stringify({ ...json(planPath), progress }, null, 2) + '\n'
      const index = join(a.directory, 'delivery.index'), env = { ...process.env, GIT_INDEX_FILE: index }
      git(['read-tree', ref], { env })
      if (planBytes) {
        const blob = git(['hash-object', '-w', '--stdin'], { input: planBytes })
        const mode = git(['ls-tree', a.base, '--', planRel]).split(' ')[0]
        git(['update-index', '--add', '--cacheinfo', mode, blob, planRel], { env })
      }
      const expected = git(['write-tree'], { env })
      const manifest = join(a.directory, 'manifest.json')
      writeJsonAtomic(manifest, { adjustments: [], handoffs: planBytes ? [{ path: planRel, reason: 'Record the verified task and run-plan decisions', sha256: digest(planBytes) }] : [] }, 2)
      const trailers = `Factory-Plan: ${S.plan.id}\nFactory-Task: ${task.id}`
      const message = join(a.directory, 'commit-message.txt')
      writeFileSync(message, `${task.title.replace(/[\r\n]/g, ' ')}\n\n${trailers}\n`)
      a.delivery = { base: a.base, baseTree: git(['rev-parse', `${a.base}^{tree}`]), snapshotTree: tree, tree: expected, planBytes, patch, paths, runDir, manifest, result: resultFile, message, trailers }
      await save(S)
      await point('after-prepare')
      await continueDelivery(S)
    },
    finish,
    async location() { return { planFile: planPath, planRunDir: stateDir } },
  }
  try {
    const source = readFileSync(join(plugin, 'workflows/run-plan.js'), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
    const result = await new AsyncFunction('args', 'factoryRuntime', source)(options.args, { runPlan: runtime })
    writeJsonAtomic(join(stateDir, 'result.json'), result, 2)
    if (options.output) writeJsonAtomic(options.output, result, 2)
    return result
  } catch (error) {
    if (dependencies.throwErrors) throw error
    const result = { status: state ? 'blocked' : 'failed', workflow: 'run-plan', error: error.message, planRunDir: stateDir,
      final: { readiness: { state: 'incomplete', blocked: [], incomplete: [error.message] } } }
    if (stateDir) writeJsonAtomic(join(stateDir, 'result.json'), result, 2)
    if (options.output) writeJsonAtomic(options.output, result, 2)
    return result
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    if (lockOwned) unlinkSync(lock)
  }
}
