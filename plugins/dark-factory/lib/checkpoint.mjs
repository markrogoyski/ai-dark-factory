// Durable replay at quiescent operation boundaries. A checkpoint is reusable only while its
// repository, reference inputs, snapshots and evidence still match. Never reset user work.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, readlinkSync, readdirSync, realpathSync, appendFileSync, truncateSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'

export const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => typeof value[k] !== 'function' && value[k] !== undefined).map(k => [k, canonical(value[k])])) : value
export const fingerprint = value => digest(JSON.stringify(canonical(value)))

export function writeJsonAtomic(path, value, space) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, space) + '\n')
  renameSync(path + '.tmp', path)
}

// A killed append may leave one unterminated record. Keep complete records strict, and
// repair the tail under the host lock before appending again. Offsets are bytes, not chars.
export function readEventLog(path, repairTail = false) {
  if (!existsSync(path)) return []
  const bytes = readFileSync(path), lines = bytes.toString('utf8').split('\n'), events = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try { events.push(JSON.parse(lines[i])) } catch (error) {
      if (i !== lines.length - 1) throw new Error(`Invalid event log ${path} at line ${i + 1}: ${error.message}`)
      if (repairTail) truncateSync(path, bytes.lastIndexOf(10) + 1)
      return events
    }
  }
  if (repairTail && bytes.length && bytes.at(-1) !== 10) appendFileSync(path, '\n')
  return events
}

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const fileHash = path => {
  try { return lstatSync(path).isSymbolicLink() ? `link:${readlinkSync(path)}` : digest(readFileSync(path)) } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error }
}

export function repositoryIdentity(repo, args) {
  return { root: realpathSync(repo), head: git(repo, 'rev-parse', 'HEAD').trim(),
    index: digest(git(repo, 'diff', '--cached', '--binary', 'HEAD', '--', '.', ':!.council')),
    working: digest(git(repo, 'diff', '--binary', '--', '.', ':!.council')),
    references: Object.fromEntries((Array.isArray(args.plan) ? args.plan : args.plan ? [args.plan] : []).map(p => [resolve(repo, p), fileHash(resolve(repo, p))])) }
}

function inside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path))
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

function artifacts(repo, runs) {
  const files = {}, worktrees = {}, refs = {}
  function scan(path) {
    if (!existsSync(path)) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || stat.isFile()) files[path] = fileHash(path)
    else if (stat.isDirectory()) for (const item of readdirSync(path).sort()) scan(join(path, item))
  }
  for (const run of runs) {
    if (!inside(join(repo, '.council'), run)) throw new Error('Checkpoint run escaped .council')
    const info = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8'))
    if (realpathSync(info.repoRoot) !== repo || realpathSync(info.runDir) !== realpathSync(run)) throw new Error('Checkpoint run identity changed')
    for (const name of ['run.json', 'TASK.md', 'verify.sh', 'verification.json', 'room', 'refs', 'evidence', 'logs', 'seats']) scan(join(run, name))
    const wtRoot = join(run, 'wt')
    if (existsSync(wtRoot)) for (const name of readdirSync(wtRoot).sort()) {
      const wt = join(wtRoot, name)
      if (!inside(run, wt)) throw new Error('Checkpoint worktree escaped its run')
      const paths = git(wt, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
      const content = Object.fromEntries([...new Set(paths)].sort().map(p => [p, fileHash(join(wt, p))]))
      worktrees[wt] = { head: git(wt, 'rev-parse', 'HEAD').trim(), files: content }
    }
    refs[info.runId] = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/council/${info.runId}/`)
  }
  return { files, worktrees, refs }
}

export function loadCheckpoint(path, { repo, args, engine }) {
  const saved = JSON.parse(readFileSync(join(path, 'checkpoint.json'), 'utf8'))
  if (saved.version !== 1 || saved.engine !== engine) throw new Error('Checkpoint engine changed; start a new run.')
  if (fingerprint(saved.repository) !== fingerprint(repositoryIdentity(repo, args))) throw new Error('Checkpoint repository or reference inputs changed; start a new run.')
  const current = artifacts(repo, saved.runs)
  for (const [file, hash] of Object.entries(saved.artifacts.files)) {
    if (current.files[file] !== hash) throw new Error(`Checkpoint evidence changed: ${file}. Start a new run; no files were reset.`)
  }
  for (const file of Object.keys(current.files)) if (!(file in saved.artifacts.files) && !file.includes('/logs/') && !file.includes('/seats/')) throw new Error(`Checkpoint evidence set changed: ${file}. Start a new run.`)
  if (fingerprint(current.worktrees) !== fingerprint(saved.artifacts.worktrees) || fingerprint(current.refs) !== fingerprint(saved.artifacts.refs)) {
    throw new Error('Checkpoint worktree or snapshot changed, possibly by an interrupted write. Start a new run; no files were reset.')
  }
  return saved
}

export function journalRuntime(runtime, { repo, hostRunDir, args, engine, saved, emit }) {
  const entries = saved?.entries || [], runs = new Set(saved?.runs || [])
  const repository = saved?.repository || repositoryIdentity(repo, args)
  let cursor = 0, active = 0, broken = false, fatal = null
  const remaining = new Set(entries.map((_, i) => i))
  const pending = []
  const wrapped = { ...runtime }
  function commit() {
    if (active || broken) return
    const data = { version: 1, engine, repository, runs: [...runs], entries,
      runtime: runtime.checkpointState(), artifacts: artifacts(repo, runs) }
    const file = join(hostRunDir, 'checkpoint.json')
    writeJsonAtomic(file, data)
    emit({ type: 'checkpoint.saved', operations: entries.length, path: file })
  }
  for (const method of ['agent', 'turn', 'measure']) wrapped[method] = async request => {
    if (fatal) throw fatal
    const hash = fingerprint({ method, request })
    if (remaining.size) {
      const index = [...remaining].find(i => entries[i].method === method && entries[i].hash === hash)
      if (index !== undefined) {
        const record = entries[index]
        remaining.delete(index); cursor++
        if (record.diagnostic) request.onResult?.(record.diagnostic)
        emit({ type: 'checkpoint.replayed', method, label: request.label, operation: index + 1 })
        return structuredClone(record.result)
      }
      // Independent pipelines can replay in a different completion order. Let their cached
      // continuations drain before deciding this request changed the dependency graph.
      await new Promise(resolve => setImmediate(resolve))
      if (fatal) throw fatal
      if (remaining.size) {
        broken = true
        fatal = Object.assign(new Error(`Checkpoint request changed at operation ${cursor + 1} (${method}); dependent reviews were not reused. Start a new run.`), { code: 'CHECKPOINT_MISMATCH' })
        throw fatal
      }
    }
    const slot = pending.length
    pending.push(null); active++
    let diagnostic
    try {
      const result = await runtime[method]({ ...request, ...(request.onResult ? { onResult: value => { diagnostic = value; request.onResult(value) } } : {}) })
      if (!result || ['error', 'failed', 'sandboxed'].includes(result.status)) broken = true
      if (request.run?.runDir) runs.add(request.run.runDir)
      if (method === 'agent' && result?.runDir) runs.add(result.runDir)
      pending[slot] = { method, hash, result, ...(diagnostic ? { diagnostic } : {}) }
      return result
    } catch (error) { broken = true; throw error } finally {
      active--
      if (!active && !broken) {
        entries.push(...pending.splice(0)); cursor = entries.length
        commit()
      }
    }
  }
  wrapped.finishCheckpoint = commit
  wrapped.runDirectories = () => [hostRunDir, ...runs]
  return wrapped
}
