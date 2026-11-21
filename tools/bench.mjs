// Ground truth for the workflows: "revert the fix" tasks mined from real history, graded by the
// fix's own tests, which the workflow never sees. Development only; nothing here ships.
// docs/evaluation.md#benchmark describes the task format and the whole loop.
//   node tools/bench.mjs list
//   node tools/bench.mjs prepare ID [--force]                    leak-proof clone at base; no models
//   node tools/bench.mjs validate ID...                           hidden tests fail at base, pass at the fix; no models
//   node tools/bench.mjs run ID --variant V --rep N [--yes]       LIVE MODELS, costs money; without --yes, prints the plan
//   node tools/bench.mjs grade FILE... [--outcomes FILE]         hidden tests on each run's reviewed snapshot
//   node tools/bench.mjs results [ID...]                          result files of the recorded runs, for the evaluator
// --bench DIR holds tasks/, variants.json and validations/ (default: bench/ in this checkout).
// --root DIR holds clones and records (default: $DARK_FACTORY_BENCH_ROOT or ~/.cache/dark-factory-bench).
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GIT_REPO_ENV } from '../plugins/dark-factory/lib/engine.mjs'

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const RUNNER = join(checkout, 'plugins/dark-factory/bin/dark-factory-codex')
const WORKFLOWS = ['factory', 'council', 'pair', 'ensemble']
const TIERS = ['simple', 'fix', 'feature', 'architecture']
// The harness sets these; a manifest or variant that set them would break the run's identity or isolation.
const HARNESS_ARGS = ['task', 'prompt', 'question', 'evaluation', 'repo', 'cwd', 'host', 'hostRunId', 'cli', 'plan', 'planFile', 'resume']
const MANIFEST_KEYS = ['id', 'repo', 'fixCommit', 'base', 'task', 'hiddenTests', 'grade', 'gradeTimeoutSec', 'dependencies', 'args', 'tags', 'notes']
const KINDS = ['bug', 'feature'], SIZES = ['small', 'medium', 'large']
const SHA = /^[0-9a-f]{40}$/

// ---------------------------------------------------------------- processes

function env(extra = {}) {
  const out = { ...process.env }
  for (const name of GIT_REPO_ENV) delete out[name]
  return { ...out, ...extra }
}

export function git(cwd, args, { input, env: extra, encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding, input, env: env(extra), maxBuffer: 1 << 30,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
}

function gitOk(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { env: env(), stdio: 'ignore' }).status === 0
}

function tail(text, lines = 15, chars = 2000) {
  return text.split('\n').filter(Boolean).slice(-lines).join('\n').slice(-chars)
}

// Runs a shell command with its output in `log`, interleaved as it was written.
export function runShell(command, cwd, { log, timeoutSec = 600, extraEnv } = {}) {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'w'), started = Date.now()
  let r
  try {
    r = spawnSync('/bin/sh', ['-c', command], { cwd, env: env(extraEnv), stdio: ['ignore', fd, fd], timeout: timeoutSec * 1000, killSignal: 'SIGKILL' })
  } finally { closeSync(fd) }
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return { command, exitCode: r.status, signal: r.signal || null, timedOut, launchError: !timedOut && r.error ? r.error.message : null,
    durationMs: Date.now() - started, log, tail: tail(readFileSync(log, 'utf8')) }
}

function home(path) {
  const h = homedir()
  return path && (path === h || path.startsWith(h + '/')) ? '~' + path.slice(h.length) : path
}

function expandHome(path) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

// ---------------------------------------------------------------- locations and manifests

export function benchPaths({ bench, root } = {}) {
  const b = resolve(bench || join(checkout, 'bench'))
  const r = resolve(expandHome(root || process.env.DARK_FACTORY_BENCH_ROOT || join(homedir(), '.cache/dark-factory-bench')))
  if (inside(checkout, r)) throw new Error(`The bench root ${r} is inside this checkout; agents working there could read the hidden tests. Choose a directory outside it.`)
  return { bench: b, root: r, tasks: join(b, 'tasks'), validations: join(b, 'validations'), variants: join(b, 'variants.json'),
    prepared: join(r, 'tasks'), work: join(r, 'work'), records: join(r, 'records') }
}

function safeRelative(path) {
  return typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\\') && posix.normalize(path) === path &&
    !path.split('/').includes('..') && path !== '.'
}

// Every problem with a manifest, without touching its repository.
export function manifestProblems(m, file = null) {
  const problems = []
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the manifest must be a JSON object']
  for (const key of Object.keys(m)) if (!MANIFEST_KEYS.includes(key)) problems.push(`unknown field ${key}`)
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.id)) problems.push('id must be lowercase letters, digits and dashes')
  else if (file && basename(file, '.json') !== m.id) problems.push(`id ${m.id} does not match the file name ${basename(file)}`)
  if (typeof m.repo !== 'string' || !m.repo.trim()) problems.push('repo must be the path of a local repository')
  if (typeof m.fixCommit !== 'string' || !SHA.test(m.fixCommit)) problems.push('fixCommit must be a full 40-character commit hash')
  if (m.base !== undefined && (typeof m.base !== 'string' || !SHA.test(m.base))) problems.push('base, when given, must be a full 40-character commit hash')
  if (!Array.isArray(m.hiddenTests) || !m.hiddenTests.length) problems.push('hiddenTests must list at least one test file')
  else {
    for (const path of m.hiddenTests) if (!safeRelative(path)) problems.push(`hidden test ${JSON.stringify(path)} must be a normalized repository-relative path`)
    if (new Set(m.hiddenTests).size !== m.hiddenTests.length) problems.push('hiddenTests lists a file twice')
  }
  if (typeof m.task !== 'string' || m.task.trim().length < 20) problems.push('task must describe the problem the way a user would report it')
  else {
    const text = m.task.toLowerCase()
    if (typeof m.fixCommit === 'string' && m.fixCommit.length >= 7 && text.includes(m.fixCommit.slice(0, 7).toLowerCase())) problems.push('task names the fix commit')
    for (const path of Array.isArray(m.hiddenTests) ? m.hiddenTests.filter(p => typeof p === 'string') : []) {
      const name = basename(path).toLowerCase(), stem = name.replace(/\.[^.]+$/, '')
      if (text.includes(path.toLowerCase()) || text.includes(name) || (stem.length >= 6 && text.includes(stem))) problems.push(`task names the hidden test ${path}`)
    }
  }
  if (typeof m.grade !== 'string' || !m.grade.trim()) problems.push('grade must be the command that runs only the hidden tests')
  if (m.gradeTimeoutSec !== undefined && (!Number.isSafeInteger(m.gradeTimeoutSec) || m.gradeTimeoutSec < 1 || m.gradeTimeoutSec > 7200)) problems.push('gradeTimeoutSec must be an integer from 1 to 7200')
  if (m.dependencies !== undefined) {
    const d = m.dependencies
    if (!d || typeof d !== 'object' || Array.isArray(d)) problems.push('dependencies must be an object')
    else {
      for (const key of Object.keys(d)) if (!['install', 'paths'].includes(key)) problems.push(`unknown dependencies field ${key}`)
      if (d.install !== undefined && (typeof d.install !== 'string' || !d.install.trim())) problems.push('dependencies.install must be a command')
      if (!Array.isArray(d.paths) || !d.paths.length || !d.paths.every(safeRelative)) problems.push('dependencies.paths must list the ignored dependency directories, such as vendor')
    }
  }
  problems.push(...argsProblems(m.args, 'args', true))
  const t = m.tags
  if (!t || typeof t !== 'object' || !KINDS.includes(t.kind) || !SIZES.includes(t.size)) problems.push(`tags must have kind (${KINDS.join('/')}) and size (${SIZES.join('/')})`)
  return problems
}

function argsProblems(args, where, needWorkflow) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [`${where} must be an object`]
  const problems = []
  if (needWorkflow ? !WORKFLOWS.includes(args.workflow) : args.workflow !== undefined && !WORKFLOWS.includes(args.workflow)) problems.push(`${where}.workflow must be one of ${WORKFLOWS.join(', ')}`)
  if (args.tier !== undefined && !TIERS.includes(args.tier)) problems.push(`${where}.tier must be one of ${TIERS.join(', ')}`)
  for (const key of HARNESS_ARGS) if (key in args) problems.push(`${where}.${key} is set by the harness`)
  return problems
}

export function loadManifest(paths, id) {
  const file = join(paths.tasks, `${id}.json`)
  if (!existsSync(file)) throw new Error(`No task ${id} in ${paths.tasks}`)
  const m = JSON.parse(readFileSync(file, 'utf8'))
  const problems = manifestProblems(m, file)
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`)
  return { ...m, repo: resolve(paths.bench, expandHome(m.repo)), file }
}

export function listManifests(paths) {
  return existsSync(paths.tasks) ? readdirSync(paths.tasks).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort() : []
}

// What validation depends on; a change to any of it needs a new validation.
export function manifestDigest(m) {
  const { fixCommit, base = null, hiddenTests, grade, dependencies = null } = m
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ fixCommit, base, hiddenTests, grade, dependencies })).digest('hex')
}

export function resolveBase(m) {
  if (!gitOk(m.repo, ['cat-file', '-e', `${m.fixCommit}^{commit}`])) throw new Error(`${m.repo} has no commit ${m.fixCommit}`)
  return git(m.repo, ['rev-parse', '--verify', `${m.base || m.fixCommit + '^'}^{commit}`]).trim()
}

// Hidden tests must come from the fix: added by it, or modified so its copy replaces the solver's.
export function hiddenTestProblems(m, base) {
  const status = Object.fromEntries(git(m.repo, ['diff', '--no-renames', '--name-status', base, m.fixCommit, '--', ...m.hiddenTests])
    .split('\n').filter(Boolean).map(line => line.split('\t')).map(([s, path]) => [path, s]))
  return m.hiddenTests.filter(path => !['A', 'M'].includes(status[path])).map(path => `hidden test ${path} is not added or modified by the fix commit`)
}

function hiddenBlobs(m) {
  return m.hiddenTests.map(path => {
    const [info] = git(m.repo, ['ls-tree', m.fixCommit, '--', path]).split('\t')
    const [mode, type, blob] = info.trim().split(' ')
    if (type !== 'blob') throw new Error(`hidden test ${path} is not a file at the fix commit`)
    return { path, mode, blob }
  })
}

// The hidden tests' bytes that only the fix has: what a clone at base must not contain.
function fixedBlobs(m, base) {
  return hiddenBlobs(m).filter(({ path, blob }) => spawnSync('git', ['-C', m.repo, 'rev-parse', '--verify', '--quiet', `${base}:${path}`], { env: env(), encoding: 'utf8' }).stdout.trim() !== blob)
}

// ---------------------------------------------------------------- leak-proof clones

// A fresh repository holding only `base` and its history: no remote, no tags, no FETCH_HEAD, no
// alternates, so `git log --all` and `git cat-file` inside it can't reach the fix or anything later.
export function leakProofClone(source, base, dest) {
  if (existsSync(dest)) throw new Error(`${dest} already exists`)
  mkdirSync(dirname(dest), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', dest], { env: env(), stdio: 'ignore' })
  // Protocol v2 serves any commit by hash; the older protocols serve only advertised tips.
  git(dest, ['-c', 'protocol.version=2', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', source, base])
  git(dest, ['update-ref', 'refs/heads/main', base])
  git(dest, ['reset', '--quiet', '--hard', 'refs/heads/main'])
  git(dest, ['config', 'user.name', 'bench'])
  git(dest, ['config', 'user.email', 'bench@localhost'])
  return dest
}

// Checks that `clone` holds nothing from the fix commit or later: the fix itself, the hidden tests'
// fixed bytes, and every commit of `source` outside base's history must be missing.
export function leakProblems(clone, { source, base, fixCommit, blobs = [] }) {
  const problems = []
  if (gitOk(clone, ['cat-file', '-e', fixCommit])) problems.push(`the fix commit ${fixCommit} is present`)
  const remotes = git(clone, ['remote']).trim()
  if (remotes) problems.push(`the clone has remotes: ${remotes.split('\n').join(', ')}`)
  const gitDir = git(clone, ['rev-parse', '--absolute-git-dir']).trim()
  for (const name of ['objects/info/alternates', 'FETCH_HEAD', 'shallow']) if (existsSync(join(gitDir, name))) problems.push(`the clone has ${name}`)
  if (git(clone, ['rev-parse', 'HEAD']).trim() !== base) problems.push('HEAD is not the base commit')
  for (const line of git(clone, ['for-each-ref', '--format=%(objectname) %(refname)']).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split(' ')
    if (!ref.startsWith('refs/heads/')) problems.push(`unexpected ref ${ref}`)
    else if (!gitOk(clone, ['merge-base', '--is-ancestor', sha, base])) problems.push(`${ref} is not in base's history`)
  }
  const later = git(source, ['rev-list', '--all', '--not', base]).split('\n').filter(Boolean)
  const check = list => git(clone, ['cat-file', '--batch-check'], { input: list.join('\n') + '\n' }).split('\n').filter(Boolean)
  if (later.length) {
    const present = check(later).filter(line => !line.endsWith(' missing'))
    if (present.length) problems.push(`${present.length} commit(s) outside base's history are present, e.g. ${present[0].split(' ')[0]}`)
  }
  for (const { path, blob } of blobs) {
    if (gitOk(clone, ['cat-file', '-e', blob])) problems.push(`the fixed bytes of hidden test ${path} (${blob}) are present`)
  }
  return problems
}

export function assertLeakProof(clone, facts) {
  const problems = leakProblems(clone, facts)
  if (problems.length) throw new Error(`Clone ${clone} is not leak-proof: ${problems.join('; ')}`)
  return { fixCommitAbsent: true, checkedAt: new Date().toISOString() }
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  // A copy-on-write clone where the filesystem has one (APFS cp -c, reflinks); a plain copy otherwise.
  const fast = platform() === 'darwin' ? ['-c', '-R'] : ['-R', '--reflink=auto']
  if (spawnSync('cp', [...fast, from, to], { stdio: 'ignore' }).status === 0) return
  rmSync(to, { recursive: true, force: true })
  const plain = spawnSync('cp', ['-R', from, to], { encoding: 'utf8' })
  if (plain.status !== 0) throw new Error(`Could not copy ${from}: ${plain.stderr}`)
}

function checkDependencies(m, clone) {
  for (const path of m.dependencies?.paths || []) {
    if (!existsSync(join(clone, path))) throw new Error(`dependency path ${path} is missing from ${clone}`)
    if (!gitOk(clone, ['check-ignore', '-q', '--', path])) throw new Error(`dependency path ${path} is not ignored at base, so it would show up in every snapshot`)
  }
  const dirty = git(clone, ['status', '--porcelain', '--untracked-files=no']).trim()
  if (dirty) throw new Error(`setting up dependencies changed tracked files in ${clone}: ${dirty.split('\n')[0]}`)
}

// Installs at base when the manifest says how and it works; otherwise copies the source checkout's
// dependency directories, whose versions follow that checkout rather than base.
function setUpDependencies(m, clone, logDir) {
  const d = m.dependencies
  if (!d) return { method: 'none' }
  let install = null
  if (d.install) {
    const r = runShell(d.install, clone, { log: join(logDir, 'install.log'), timeoutSec: 900 })
    install = { command: d.install, exitCode: r.exitCode, timedOut: r.timedOut, log: home(r.log) }
    if (r.exitCode === 0 && d.paths.every(path => existsSync(join(clone, path)))) {
      checkDependencies(m, clone)
      return { method: 'install', install, paths: d.paths }
    }
  }
  for (const path of d.paths) {
    if (!existsSync(join(m.repo, path))) throw new Error(`dependency path ${path} is missing from ${m.repo}; install it there or give dependencies.install`)
    copyTree(join(m.repo, path), join(clone, path))
  }
  checkDependencies(m, clone)
  return { method: 'copy', install, paths: d.paths,
    caveat: 'Copied from the source checkout as it is now, not installed at base: dependency versions follow that checkout, not base\'s lock file.' }
}

export function preparedRecord(paths, id) {
  return readJson(join(paths.prepared, id, 'prepared.json'))
}

// The pristine clone every run of the task is cloned from.
export function prepare(paths, id, { force = false } = {}) {
  const m = loadManifest(paths, id), base = resolveBase(m)
  const dir = join(paths.prepared, id), clone = join(dir, 'repo'), recordFile = join(dir, 'prepared.json')
  const facts = { source: m.repo, base, fixCommit: m.fixCommit, blobs: fixedBlobs(m, base) }
  const existing = readJson(recordFile)
  if (!force && existing && existing.base === base && existing.manifestDigest === manifestDigest(m) && existsSync(clone)) {
    return { ...existing, reused: true, leakCheck: assertLeakProof(clone, facts) }
  }
  rmSync(dir, { recursive: true, force: true })
  leakProofClone(m.repo, base, clone)
  const dependencies = setUpDependencies(m, clone, join(paths.records, 'prepare', id))
  const record = { id, source: m.repo, fixCommit: m.fixCommit, base, clone, manifestDigest: manifestDigest(m),
    preparedAt: new Date().toISOString(), dependencies, leakCheck: assertLeakProof(clone, facts) }
  writeJson(recordFile, record)
  return record
}

// ---------------------------------------------------------------- grading trees

// Writes commit's tree to dest through a throwaway index: the repository's own index, worktree and
// worktree list stay as they were (the source repositories are read-only), and export-ignore
// attributes don't drop test directories the way git archive would.
export function checkoutTree(repo, commit, dest) {
  const scratch = mkdtempSync(join(tmpdir(), 'bench-index-'))
  try {
    mkdirSync(dest, { recursive: true })
    const extra = { GIT_INDEX_FILE: join(scratch, 'index') }
    git(repo, ['read-tree', commit], { env: extra })
    git(repo, ['checkout-index', '-a', '-f', `--prefix=${dest.replace(/\/?$/, '/')}`], { env: extra })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function overlayHiddenTests(m, dest) {
  return hiddenBlobs(m).map(({ path, mode, blob }) => {
    const target = join(dest, path)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, git(m.repo, ['cat-file', 'blob', blob], { encoding: 'buffer' }))
    chmodSync(target, mode === '100755' ? 0o755 : 0o644)
    return { path, blob }
  })
}

// Runs the grade on `commit` of `repo` in a scratch directory that is removed afterwards, so no
// later agent can find the hidden tests on disk.
export function gradeTree(m, { repo, commit, overlay, depsFrom, log }) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dark-factory-bench-')))
  try {
    const tree = join(scratch, 'tree')
    checkoutTree(repo, commit, tree)
    const overlaid = overlay ? overlayHiddenTests(m, tree) : []
    for (const path of m.dependencies?.paths || []) {
      if (!existsSync(join(depsFrom, path))) throw new Error(`dependency path ${path} is missing from ${depsFrom}`)
      copyTree(join(depsFrom, path), join(tree, path))
    }
    const run = runShell(m.grade, tree, { log, timeoutSec: m.gradeTimeoutSec || 600 })
    return { ...run, tail: run.tail.split(tree).join('<tree>'), commit, overlaid }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function summary(run) {
  const { exitCode, signal, timedOut, launchError, durationMs, log, tail: t, commit } = run
  return { commit, exitCode, signal, timedOut, ...(launchError ? { launchError } : {}), durationMs, log: home(log), tail: t }
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-') }

// No models: the hidden tests must fail at base (with the fix's tests in place) and pass at the fix.
export function validate(paths, id) {
  const m = loadManifest(paths, id), base = resolveBase(m)
  const problems = hiddenTestProblems(m, base)
  const prepared = problems.length ? null : prepare(paths, id)
  const logs = join(paths.records, 'validate', id, stamp())
  let atBase = null, atFix = null
  if (prepared) {
    atBase = gradeTree(m, { repo: prepared.clone, commit: base, overlay: true, depsFrom: prepared.clone, log: join(logs, 'base.log') })
    atFix = gradeTree(m, { repo: m.repo, commit: m.fixCommit, overlay: false, depsFrom: prepared.clone, log: join(logs, 'fix.log') })
    if (atBase.launchError || atFix.launchError) problems.push(`the grade command could not start: ${atBase.launchError || atFix.launchError}`)
    else {
      if (atBase.exitCode === 0) problems.push('the hidden tests pass at base, so they do not detect the problem')
      if (atFix.exitCode !== 0) problems.push(`the hidden tests fail at the fix commit${atFix.timedOut ? ' (timed out)' : ''}`)
    }
  }
  const record = { id, valid: !problems.length, problems, manifestDigest: manifestDigest(m), fixCommit: m.fixCommit, base,
    validatedAt: new Date().toISOString(), environment: { platform: platform(), node: process.version },
    dependencies: prepared && { method: prepared.dependencies.method, ...(prepared.dependencies.caveat ? { caveat: prepared.dependencies.caveat } : {}) },
    atBase: atBase && summary(atBase), atFix: atFix && summary(atFix) }
  writeJson(join(paths.validations, `${id}.json`), record)
  return record
}

export function validationRecord(paths, id) {
  return readJson(join(paths.validations, `${id}.json`))
}

// ---------------------------------------------------------------- runs

export function loadVariants(paths) {
  const variants = readJson(paths.variants)
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) throw new Error(`${paths.variants} must map variant names to {description, args}`)
  for (const [name, v] of Object.entries(variants)) {
    const problems = [
      ...(!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name) ? ['the name must be lowercase letters, digits, dots and dashes'] : []),
      ...(v && typeof v.description === 'string' ? [] : ['description is required']),
      ...argsProblems(v?.args, 'args', false),
      ...(v?.runnerFlags === undefined || (Array.isArray(v.runnerFlags) && v.runnerFlags.every(f => typeof f === 'string')) ? [] : ['runnerFlags must be a list of strings']),
    ]
    if (problems.length) throw new Error(`variant ${name}: ${problems.join('; ')}`)
  }
  return variants
}

export function runPlan(paths, id, { variant, rep }) {
  const m = loadManifest(paths, id)
  const validation = validationRecord(paths, id)
  if (!validation?.valid) throw new Error(`Task ${id} has not validated; run \`node tools/bench.mjs validate ${id}\` first`)
  if (validation.manifestDigest !== manifestDigest(m)) throw new Error(`Task ${id} changed since it validated; validate it again`)
  const variants = loadVariants(paths)
  if (!variant || !variants[variant]) throw new Error(`Unknown variant ${variant}; known: ${Object.keys(variants).join(', ')}`)
  if (!/^\d+$/.test(String(rep)) || Number(rep) < 1) throw new Error('--rep must be a positive integer')
  const repetition = Number(rep), v = variants[variant]
  const { workflow, ...args } = { ...m.args, ...v.args }
  const dir = join(paths.records, 'runs', id, variant)
  const clone = join(paths.work, id, variant, `rep-${repetition}`, 'repo')
  const argsFile = join(dir, `rep-${repetition}.args.json`)
  return { m, validation, workflow, clone, argsFile, recordFile: join(dir, `rep-${repetition}.json`), runnerLog: join(dir, `rep-${repetition}.runner.log`),
    args: { ...args, task: m.task, evaluation: { taskId: id, variant, repetition } },
    command: [process.execPath, RUNNER, '--cwd', clone, '--workflow', workflow, ...(v.runnerFlags || []), '--args-file', argsFile, '--brief'] }
}

export const COST_WARNING = 'run launches the standalone runner with live models: every model turn is billed to the accounts its CLIs are signed in to.'

// LIVE MODELS. Each run gets its own clone, so one repetition can't read another's snapshot refs.
export async function run(paths, id, { variant, rep, yes = false, replace = false, runner = RUNNER, extraEnv = {}, progress = line => process.stderr.write(line) } = {}) {
  const plan = runPlan(paths, id, { variant, rep })
  plan.command[1] = runner
  if (!yes) return { status: 'dry-run', warning: COST_WARNING + ' Pass --yes to run it.', command: plan.command, args: plan.args, clone: plan.clone }
  const prepared = preparedRecord(paths, id)
  if (!prepared || prepared.base !== plan.validation.base || !existsSync(prepared.clone)) throw new Error(`Task ${id} is not prepared; run \`node tools/bench.mjs prepare ${id}\``)
  const runDir = dirname(plan.clone)
  if (existsSync(plan.recordFile) || existsSync(runDir)) {
    if (!replace) throw new Error(`${home(runDir)} or its record already exists; pass --replace to discard them`)
    rmSync(runDir, { recursive: true, force: true }); rmSync(plan.recordFile, { force: true })
  }
  const m = plan.m
  leakProofClone(prepared.clone, prepared.base, plan.clone)
  for (const path of m.dependencies?.paths || []) copyTree(join(prepared.clone, path), join(plan.clone, path))
  checkDependencies(m, plan.clone)
  const leakCheck = assertLeakProof(plan.clone, { source: m.repo, base: prepared.base, fixCommit: m.fixCommit, blobs: fixedBlobs(m, prepared.base) })
  writeJson(plan.argsFile, plan.args)
  const startedAt = new Date().toISOString()
  mkdirSync(dirname(plan.runnerLog), { recursive: true })
  const log = openSync(plan.runnerLog, 'w')
  const { exitCode, stdout } = await new Promise((done, fail) => {
    const child = spawn(plan.command[0], plan.command.slice(1), { cwd: plan.clone, env: env(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { writeFileSync(log, chunk); progress(String(chunk)) })
    child.on('error', fail)
    child.on('close', code => done({ exitCode: code, stdout: out }))
  }).finally(() => closeSync(log))
  let brief = null
  try { brief = JSON.parse(stdout.trim().split('\n').at(-1)) } catch {}
  const hostRunDir = brief?.hostRunDir || null
  const record = { taskId: id, variant, repetition: plan.args.evaluation.repetition, workflow: plan.workflow, args: plan.args,
    clone: plan.clone, base: prepared.base, command: plan.command, startedAt, finishedAt: new Date().toISOString(), exitCode,
    status: brief?.status || 'unknown', readiness: brief?.final?.readiness?.state || null, error: brief?.error || null,
    snapshotRef: brief?.final?.snapshotRef || null, hostRunDir,
    resultFile: brief?.resultFile || (hostRunDir ? join(hostRunDir, 'result.json') : null), runnerLog: plan.runnerLog, leakCheck }
  writeJson(plan.recordFile, record)
  return record
}

// ---------------------------------------------------------------- grading results

function identityOf(result) {
  const m = result.metrics || {}
  if (m.taskId) return { taskId: m.taskId, variant: m.variant || null, repetition: m.repetition || null }
  const args = result.hostRunDir && readJson(join(result.hostRunDir, 'args.json'))
  return args?.evaluation?.taskId ? { variant: null, repetition: null, ...args.evaluation } : null
}

function repositoryOf(result) {
  const args = result.hostRunDir && readJson(join(result.hostRunDir, 'args.json'))
  if (args?.repo) return args.repo
  const run = result.runDir && readJson(join(result.runDir, 'run.json'))
  if (run?.repoRoot) return run.repoRoot
  return null
}

// The reviewed snapshot is final.snapshotRef in the run's repository, and final.snapshotTree its
// tree, as delivery checks it. Every result with one is graded, ready or not.
export function gradeResult(paths, file, result) {
  const identity = identityOf(result)
  if (!identity) throw new Error(`${file} has no evaluation identity (metrics.taskId); runs launched by tools/bench.mjs run have one`)
  const m = loadManifest(paths, identity.taskId)
  const key = result.hostRunDir || result.runDir
  const outcome = { kind: 'hidden-tests', taskId: identity.taskId, variant: identity.variant, repetition: identity.repetition,
    readiness: result.final?.readiness?.state || result.metrics?.readiness || null, result: file, gradedAt: new Date().toISOString() }
  const ungraded = reason => ({ ...outcome, status: 'ungraded', reason, evidence: file })
  const ref = result.final?.snapshotRef
  if (!ref) return { key, outcome: ungraded('the result has no reviewed snapshot') }
  const repo = repositoryOf(result)
  if (!repo || !existsSync(repo)) return { key, outcome: ungraded('the run\'s repository is not on disk') }
  const commit = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env: env(), encoding: 'utf8' }).stdout.trim()
  if (!commit) return { key, outcome: ungraded(`${ref} is missing from ${repo}`) }
  const tree = git(repo, ['rev-parse', `${commit}^{tree}`]).trim()
  if (result.final.snapshotTree && result.final.snapshotTree !== tree) return { key, outcome: ungraded(`${ref} no longer has the tree the result records`) }
  const name = [identity.variant || 'unknown', `rep-${identity.repetition || 0}`, basename(key || file)].join('-').replace(/[^\w.-]/g, '_')
  const log = join(paths.records, 'grades', identity.taskId, `${name}.log`)
  const run = gradeTree(m, { repo, commit, overlay: true, depsFrom: repo, log })
  if (run.launchError) return { key, outcome: { ...ungraded(`the grade command could not start: ${run.launchError}`), evidence: log } }
  return { key, outcome: { ...outcome, status: run.exitCode === 0 ? 'passed' : 'failed', evidence: log, snapshotRef: ref, commit, tree,
    exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs } }
}

// One key can hold a post-delivery observation and a hidden-test outcome. A single entry stays a
// plain object, the format the evaluator has always read.
export function mergeOutcome(outcomes, key, outcome) {
  const prior = outcomes[key] === undefined ? [] : Array.isArray(outcomes[key]) ? outcomes[key] : [outcomes[key]]
  const kept = prior.filter(o => (o?.kind || 'post-delivery') !== outcome.kind)
  const all = [...kept, outcome]
  outcomes[key] = all.length === 1 ? all[0] : all
  return outcomes
}

export function grade(paths, files, { outcomes: outcomesFile = join(paths.records, 'outcomes.json') } = {}) {
  const outcomes = readJson(outcomesFile) || {}
  const graded = []
  for (const given of files.map(f => resolve(f))) {
    let file = given, result = JSON.parse(readFileSync(file, 'utf8'))
    // A run record from `run` names its result file.
    if (!result.metrics && 'resultFile' in result && 'taskId' in result) {
      if (!result.resultFile || !existsSync(result.resultFile)) { graded.push({ record: file, status: 'skipped', reason: 'the run recorded no result file' }); continue }
      file = result.resultFile
      result = JSON.parse(readFileSync(file, 'utf8'))
    }
    const { key, outcome } = gradeResult(paths, file, result)
    if (!key) throw new Error(`${file} has neither hostRunDir nor runDir`)
    mergeOutcome(outcomes, key, outcome)
    graded.push({ key, result: file, status: outcome.status, readiness: outcome.readiness, taskId: outcome.taskId, variant: outcome.variant,
      repetition: outcome.repetition, evidence: outcome.evidence, ...(outcome.reason ? { reason: outcome.reason } : {}) })
  }
  writeJson(outcomesFile, outcomes)
  return { outcomes: outcomesFile, graded }
}

// The result files of every recorded run, optionally of some tasks only, for the evaluator.
export function resultFiles(paths, ids = []) {
  const runs = join(paths.records, 'runs')
  if (!existsSync(runs)) return []
  const files = []
  for (const id of readdirSync(runs).sort()) {
    if (ids.length && !ids.includes(id)) continue
    for (const variant of readdirSync(join(runs, id)).sort()) {
      for (const name of readdirSync(join(runs, id, variant)).filter(n => /^rep-\d+\.json$/.test(n)).sort()) {
        const record = readJson(join(runs, id, variant, name))
        if (record?.resultFile && existsSync(record.resultFile)) files.push(record.resultFile)
      }
    }
  }
  return files
}

// ---------------------------------------------------------------- command line

function listTasks(paths) {
  return listManifests(paths).map(id => {
    let m = null, problem = null
    try { m = loadManifest(paths, id) } catch (error) { problem = error.message }
    const v = validationRecord(paths, id)
    return { id, repo: m && home(m.repo), fixCommit: m?.fixCommit.slice(0, 10), kind: m?.tags.kind, size: m?.tags.size, workflow: m?.args.workflow,
      validated: !!(m && v?.valid && v.manifestDigest === manifestDigest(m)), ...(problem ? { problem } : {}), ...(v && !v.valid ? { problems: v.problems } : {}) }
  })
}

export const USAGE = `Usage: node tools/bench.mjs COMMAND [options]
  list                                   the tasks and whether each validated
  prepare ID [--force]                   leak-proof clone at base under the root, with dependencies; no models
  validate ID...                         hidden tests must fail at base and pass at the fix; no models
  run ID --variant V --rep N [--yes]     LIVE MODELS, costs money. Without --yes it prints the command and arguments only.
                                         --replace discards an earlier clone and record of the same repetition
  grade FILE... [--outcomes F]           hidden tests on each run's reviewed snapshot, into the evaluator's outcomes file;
                                         FILE is a result.json or a run record
  results [ID...]                        the result file of every recorded run, one per line
Options: --bench DIR (tasks/, variants.json, validations/; default bench/), --root DIR (clones and records;
default $DARK_FACTORY_BENCH_ROOT or ~/.cache/dark-factory-bench). Then:
  dark-factory-evaluate --outcomes ROOT/records/outcomes.json $(node tools/bench.mjs results)
`

export function parseArgs(argv) {
  const out = { positional: [], flags: {} }
  const values = ['bench', 'root', 'variant', 'rep', 'outcomes']
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out.positional.push(arg); continue }
    const name = arg.slice(2)
    if (values.includes(name)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`)
      out.flags[name] = argv[++i]
    } else if (['force', 'yes', 'replace', 'help'].includes(name)) out.flags[name] = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return out
}

export async function main(argv) {
  const { positional: [command, ...rest], flags } = parseArgs(argv)
  if (!command || flags.help) { process.stdout.write(USAGE); return 0 }
  const paths = benchPaths({ bench: flags.bench, root: flags.root })
  const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  if (command === 'list') { print(listTasks(paths)); return 0 }
  if (command === 'results') { process.stdout.write(resultFiles(paths, rest).map(f => f + '\n').join('')); return 0 }
  if (!rest.length) throw new Error(`${command} needs ${command === 'grade' ? 'result files' : 'a task ID'}`)
  if (command === 'prepare') { print(prepare(paths, rest[0], { force: !!flags.force })); return 0 }
  if (command === 'validate') {
    const records = rest.map(id => validate(paths, id))
    print(records.map(({ id, valid, problems, atBase, atFix }) => ({ id, valid, problems,
      atBase: atBase && { exitCode: atBase.exitCode, timedOut: atBase.timedOut }, atFix: atFix && { exitCode: atFix.exitCode, timedOut: atFix.timedOut } })))
    return records.every(r => r.valid) ? 0 : 1
  }
  if (command === 'run') {
    if (flags.yes) process.stderr.write(`bench: ${COST_WARNING}\n`)
    const record = await run(paths, rest[0], { variant: flags.variant, rep: flags.rep, yes: !!flags.yes, replace: !!flags.replace })
    print(record)
    return record.status === 'dry-run' ? 2 : 0
  }
  if (command === 'grade') { print(grade(paths, rest, flags.outcomes ? { outcomes: resolve(flags.outcomes) } : {})); return 0 }
  throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { process.stderr.write(`bench: ${error.message}\n`); process.exitCode = 1 })
}
