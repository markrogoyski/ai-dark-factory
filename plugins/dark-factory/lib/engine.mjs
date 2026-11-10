// Package I/O and bootstrap. The importable policy is loaded only after inventory validation.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, mkdirSync, symlinkSync, chmodSync, existsSync } from 'node:fs'
import { dirname, resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ALGORITHM = 'sha256-path-content-mode-v1'
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const textGit = (repo, ...args) => git(repo, ...args).toString().trim()
export function drift(message) { return Object.assign(new Error(message), { code: 'ENGINE_DRIFT' }) }
export function physical(path) {
  path = resolve(path)
  try { return realpathSync(path) } catch (e) {
    if (e.code !== 'ENOENT') throw e
    if (dirname(path) === path) throw e
    return join(physical(dirname(path)), path.slice(dirname(path).length + 1))
  }
}
export function within(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}
export function isolationIssues(exportRoot, roots) {
  const p = physical(exportRoot)
  return roots.filter(Boolean).filter(r => {
    const q = physical(r)
    return within(p, q) || within(q, p)
  })
}
function safePath(bytes) {
  if (!bytes.length || bytes[0] === 47 || bytes.includes(0) || bytes.toString().split('/').some(p => !p || p === '.' || p === '..')) throw drift('Unsafe package path')
}
const rawPath = (root, bytes) => Buffer.concat([Buffer.from(root + '/'), bytes])
function sorted(entries) { return entries.sort((a, b) => Buffer.compare(Buffer.from(a[0], 'base64'), Buffer.from(b[0], 'base64'))) }
export function inventoryDigest(entries) { return sha256(JSON.stringify([1, ALGORITHM, entries])) }

export function packageInventory(root) {
  root = realpathSync(root)
  const entries = []
  function walk(prefix) {
    const directory = prefix.length ? rawPath(root, prefix) : root
    for (const name of readdirSync(directory, { encoding: 'buffer' })) {
      const path = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name
      safePath(path)
      const full = rawPath(root, path), stat = lstatSync(full)
      if (stat.isDirectory()) { walk(path); continue }
      let mode, bytes
      if (stat.isSymbolicLink()) {
        mode = '120000'; bytes = readlinkSync(full, { encoding: 'buffer' })
        let target
        try { target = realpathSync(full) } catch { throw drift(`Dangling or cyclic package symlink: ${path}`) }
        if (!within(root, target)) throw drift(`Escaping package symlink: ${path}`)
      } else if (stat.isFile()) { mode = stat.mode & 0o100 ? '100755' : '100644'; bytes = readFileSync(full) }
      else throw drift(`Unsupported package entry: ${path}`)
      entries.push([path.toString('base64'), mode, sha256(bytes)])
    }
  }
  walk(Buffer.alloc(0))
  return sorted(entries)
}

export function committedInventory(source, revision = 'HEAD') {
  const commit = textGit(source, 'rev-parse', '--verify', revision + '^{commit}')
  const tree = textGit(source, 'rev-parse', commit + ':plugins/dark-factory')
  const rows = git(source, 'ls-tree', '-rz', tree), entries = [], blobs = []
  for (const record of splitNul(rows)) {
    const tab = record.indexOf(9), [mode, type, object] = record.subarray(0, tab).toString().split(' '), path = record.subarray(tab + 1)
    safePath(path)
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw drift('Unsupported committed package entry')
    const bytes = git(source, 'cat-file', 'blob', object)
    entries.push([path.toString('base64'), mode, sha256(bytes)])
    blobs.push({ path, mode, bytes })
  }
  return { commit, tree, entries: sorted(entries), blobs }
}
function splitNul(buffer) {
  const out = []; let start = 0
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0) { out.push(buffer.subarray(start, i)); start = i + 1 }
  return out
}
function checkManifest(m) {
  if (m?.version !== 1 || m.algorithm !== ALGORITHM || !/^[a-f0-9]{40,64}$/.test(m.sourceRevision || '') || !/^[a-f0-9]{64}$/.test(m.packageDigest || '') || !Array.isArray(m.entries) || !m.entries.length) throw drift('Unsupported engine manifest')
  const paths = new Set()
  for (const row of m.entries) {
    if (!Array.isArray(row) || row.length !== 3 || !['100644', '100755', '120000'].includes(row[1]) || !/^[a-f0-9]{64}$/.test(row[2] || '')) throw drift('Invalid manifest entry')
    const path = Buffer.from(row[0], 'base64'); safePath(path)
    if (path.toString('base64') !== row[0] || paths.has(row[0])) throw drift('Noncanonical or duplicate manifest path')
    paths.add(row[0])
  }
  if (JSON.stringify(sorted([...m.entries])) !== JSON.stringify(m.entries) || inventoryDigest(m.entries) !== m.packageDigest) throw drift('Manifest digest changed')
}
export function validateImports(root, entries) {
  const paths = new Set(entries.map(e => Buffer.from(e[0], 'base64').toString()))
  for (const path of paths) {
    if (!/\.(mjs|js)$/.test(path) && !path.startsWith('bin/dark-factory-')) continue
    const source = readFileSync(join(root, path), 'utf8')
    for (const match of source.matchAll(/\b(?:import\s*\(\s*|(?:import|export)\s+(?:[^'"\n]*?\s+from\s*)?)(['"])([^'"\n]+)\1/g)) {
      const spec = match[2]
      if (spec.startsWith('node:')) continue
      const target = relative(root, resolve(dirname(join(root, path)), spec))
      if (!spec.startsWith('.') || !within(root, resolve(root, target)) || !paths.has(target)) throw drift(`Untracked or external engine import: ${path}: ${spec}`)
    }
    if (/\bimport\s*\(\s*[^'"\s]/.test(source)) throw drift(`Unresolved dynamic engine import: ${path}`)
  }
}
let runtimes
export function runtimeVersions() {
  if (!runtimes) runtimes = { node: process.version,
    python: execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim(),
    git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() }
  return runtimes
}
export function validateExport(directory, expected = null) {
  directory = physical(directory)
  let manifest
  try { manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) } catch (e) { throw drift(`Engine manifest unreadable: ${e.message}`) }
  checkManifest(manifest)
  const root = join(directory, 'plugin')
  if (lstatSync(root).isSymbolicLink()) throw drift('Engine plugin root is a symlink')
  const entries = packageInventory(root)
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) throw drift('Engine package content or mode changed')
  for (const required of ['bin/dark-factory', 'bin/dark-factory-codex', 'bin/dark-factory-evaluate', 'lib/engine.mjs', 'lib/engine-observations.mjs', 'lib/policy.mjs', 'lib/checkpoint.mjs', 'lib/evaluate.mjs', 'lib/codex-runner.mjs', 'schemas/provenance.schema.json', '.claude-plugin/plugin.json', 'skills/dark-factory/scripts/run.mjs', ...['factory', 'pair', 'council', 'ensemble', 'run-plan'].map(n => `workflows/${n}.js`)]) {
    if (!entries.some(e => Buffer.from(e[0], 'base64').toString() === required)) throw drift(`Incomplete engine package: ${required}`)
  }
  validateImports(root, entries)
  const identity = { version: 1, algorithm: ALGORITHM, mode: 'pinned', packageDigest: manifest.packageDigest,
    sourceRevision: manifest.sourceRevision, root: realpathSync(root), runtimeVersions: runtimeVersions() }
  if (expected) {
    for (const key of ['version', 'algorithm', 'mode', 'packageDigest', 'sourceRevision']) if (identity[key] !== expected[key]) throw drift(`Executor ${key} changed`)
    if (JSON.stringify(identity.runtimeVersions) !== JSON.stringify(expected.runtimeVersions)) throw drift('Executor runtime changed')
  }
  return identity
}
export function exportEngine(source, directory, candidate = source, roots = []) {
  directory = physical(directory)
  if (isolationIssues(directory, [source, candidate, ...roots]).length) throw drift('Export overlaps source, candidate or writable root')
  if (existsSync(directory)) return validateExport(directory)
  const status = git(source, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'plugins/dark-factory').toString()
  if (status.trim()) throw drift('Committed plugin export requires clean shipped inputs (including untracked/ignored files)')
  const committed = committedInventory(source)
  const names = committed.blobs.map(b => b.path.toString())
  const links = new Map(committed.blobs.filter(b => b.mode === '120000').map(b => [b.path.toString(), b.bytes.toString()]))
  for (const [name, target] of links) {
    let next = name; const seen = new Set()
    while (links.has(next)) {
      if (seen.has(next)) throw drift(`Cyclic committed symlink: ${name}`)
      seen.add(next)
      const value = links.get(next)
      if (isAbsolute(value) || value.includes('\0')) throw drift(`External committed symlink: ${name}`)
      next = relative('/', resolve('/', dirname(next), value))
      const lexical = resolve('/plugin', dirname([...seen].at(-1)), value)
      if (!within('/plugin', lexical)) throw drift(`Escaping committed symlink: ${name}`)
    }
    if (!names.some(p => p === next || p.startsWith(next + '/'))) throw drift(`Dangling committed symlink: ${name}`)
  }
  mkdirSync(directory, { recursive: true })
  const root = join(directory, 'plugin'); mkdirSync(root)
  // Write regular files before links; no created link is traversed by a later write.
  for (const blob of [...committed.blobs.filter(b => b.mode !== '120000'), ...committed.blobs.filter(b => b.mode === '120000')]) {
    const full = rawPath(root, blob.path)
    mkdirSync(full.subarray(0, full.lastIndexOf(47)), { recursive: true })
    if (blob.mode === '120000') symlinkSync(blob.bytes, full)
    else { writeFileSync(full, blob.bytes); chmodSync(full, blob.mode === '100755' ? 0o755 : 0o644) }
  }
  const actual = packageInventory(root)
  if (JSON.stringify(actual) !== JSON.stringify(committed.entries)) throw drift('Committed/exported package identity differs')
  const manifest = { version: 1, algorithm: ALGORITHM, sourceRevision: committed.commit, sourceTree: committed.tree,
    packageDigest: inventoryDigest(actual), entries: actual }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return validateExport(directory)
}
export function environmentPin(env = process.env) {
  if (!env.DARK_FACTORY_PIN) return null
  try { return JSON.parse(env.DARK_FACTORY_PIN) } catch { throw drift('Invalid executor pin context') }
}
export function guardEngine(pin = environmentPin(), executable = null) {
  if (!pin) return null
  const identity = validateExport(dirname(pin.root), pin)
  if (realpathSync(pluginRoot) !== identity.root) throw drift('Running adapter belongs to a different executor')
  if (executable && realpathSync(executable) !== join(identity.root, 'bin/dark-factory')) throw drift('Mismatched helper executable')
  return identity
}
export function liveIdentity() {
  let sourceRevision = null
  try { sourceRevision = textGit(pluginRoot, 'rev-parse', 'HEAD') } catch {}
  return { version: 1, algorithm: ALGORITHM, mode: 'live', packageDigest: inventoryDigest(packageInventory(pluginRoot)), sourceRevision,
    root: pluginRoot, runtimeVersions: runtimeVersions() }
}
const quote = x => "'" + String(x).replaceAll("'", "'\\''") + "'"
function ancestors(path) {
  const result = []
  for (let p = resolve(path); ; p = dirname(p)) { result.push(p); if (dirname(p) === p) return result }
}
function parseToml(text) {
  const out = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8' })
  if (out.status !== 0) throw drift('Unsupported TOML settings (pinned execution needs Python 3.11+)')
  return JSON.parse(out.stdout)
}
export async function inspectSeat(pin, spec, env = process.env) {
  const executor = guardEngine(pin)
  if (!executor) return null
  return inspectBounds(executor, spec, env)
}
async function inspectBounds(executor, spec, env) {
  const pin = executor
  const { readHostSource, providerDefaults, providerFacts } = await import('./engine-observations.mjs')
  const { pinnedOperationIssues } = await import('./policy.mjs')
  const vendor = spec.kind || spec.vendor, home = env.HOME || '', repo = spec.repoRoot || spec.cwd
  const defaults = providerDefaults(vendor)
  const defaultIssues = pinnedOperationIssues({}, pin, { executor, overlaps: isolationIssues(dirname(pin.root), defaults) })
  if (defaultIssues.length) throw drift('Default write-root overlap: ' + defaultIssues.join('; '))
  const facts = providerFacts(vendor), unknown = [...(facts.unknown || [])], roots = [spec.cwd, ...(spec.writable || []), ...(spec.gitRoots || []), ...defaults, ...(facts.defaults || [])]
  const catalog = vendor === 'codex' ? [join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), '/etc/codex/managed_config.toml', '/Library/Preferences/com.openai.codex.plist',
    ...ancestors(spec.cwd).map(p => join(p, '.codex/config.toml'))]
    : vendor === 'claude' ? [join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), '/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.d',
      ...ancestors(spec.cwd).flatMap(p => [join(p, '.claude/settings.json'), join(p, '.claude/settings.local.json')])]
    : [join(home, '.gemini/antigravity-cli/settings.json')]
  const sources = [], hookIssues = []
  const expand = (value, base) => {
    if (typeof value !== 'string' || !value || /[\[*?{}$]/.test(value)) { unknown.push('unbounded/unsupported write grant'); return }
    roots.push(resolve(base, value.startsWith('~/') ? join(home, value.slice(2)) : value))
  }
  for (const path of [...new Set(catalog)]) {
    const raw = readHostSource(path)
    sources.push([path, raw.status, raw.status === 'file' ? sha256(raw.text) : null])
    if (raw.status === 'absent') continue
    if (path.endsWith('/managed-settings.d')) { unknown.push(`unsupported managed settings directory: ${path}`); continue }
    if (raw.status !== 'file') { unknown.push(`unreadable settings: ${path}`); continue }
    try {
      const data = path.endsWith('.toml') ? parseToml(raw.text) : JSON.parse(raw.text)
      const base = path.includes('/.claude/') || path.includes('/.codex/') ? dirname(dirname(path)) : repo
      const scan = obj => {
        for (const [key, value] of Object.entries(obj || {})) {
          if (['writable_roots', 'allowWrite', 'additionalDirectories'].includes(key)) {
            if (!Array.isArray(value)) unknown.push('invalid root list'); else value.forEach(x => expand(x, base))
          } else if (key === 'allow') {
            if (!Array.isArray(value)) { unknown.push('invalid permission rules'); continue }
            for (const rule of value) {
              if (/^Read\(/.test(rule)) continue
              const m = /^(?:write_file|Edit|Write)\(([^)]+)\)$/.exec(rule)
              if (m) expand(m[1], base); else unknown.push(`unbounded permission: ${rule}`)
            }
          } else if (['disableAllHooks', 'allowManagedHooksOnly', 'dangerouslyDisableSandbox', 'disabled', 'allowUnsandboxedCommands'].includes(key)) {
            if (value !== false) hookIssues.push(`unsupported control: ${key}`)
          } else if (['sandbox_mode', 'approval_policy', 'toolPermission'].includes(key)) {
            if (!['workspace-write', 'read-only', 'on-request', 'never', 'proceed-in-sandbox'].includes(value)) unknown.push(`unbounded control: ${key}`)
          } else if (['hooks', 'mcpServers', 'enabledPlugins', 'managedSettings', 'policy', 'settingsSources'].includes(key)) unknown.push(`opaque settings: ${key}`)
          else if (['deny', 'ask', 'model', 'model_reasoning_effort', 'name', 'description', 'version', 'effortLevel'].includes(key)) continue
          else if (value && typeof value === 'object') scan(value)
          else if (!['enabled', 'failIfUnavailable', 'autoAllowBashIfSandboxed', 'exclude_slash_tmp', 'exclude_tmpdir_env_var'].includes(key)) unknown.push(`unsupported settings key: ${key}`)
        }
      }
      scan(data)
    } catch (e) { unknown.push(`invalid settings ${path}: ${e.message}`) }
  }
  if (!facts.immutable && !(vendor === 'claude' && facts.hooks)) unknown.push('provider cannot bound settings reload')
  unknown.push(...hookIssues)
  const overlaps = isolationIssues(dirname(pin.root), [repo, ...roots])
  const settingsHash = sha256(JSON.stringify({ sources, facts, roots }))
  const issues = pinnedOperationIssues({}, pin, { executor, unknown, overlaps, settingsChanged: !!spec.settingsHash && spec.settingsHash !== settingsHash })
  if (issues.length) throw drift(issues.join('; '))
  return { settingsHash, sources, roots, facts }
}

export function candidateFacts(repo, final = {}) {
  final ||= {}
  const get = (...args) => { try { return textGit(repo, ...args) } catch { return null } }
  const baseCommit = get('rev-parse', 'HEAD'), snapshotCommit = final.snapshotRef ? get('rev-parse', final.snapshotRef) : null
  let packageDigest = null
  try { packageDigest = inventoryDigest(committedInventory(repo, baseCommit).entries) } catch {}
  return { repository: physical(repo), baseCommit, baseTree: get('rev-parse', 'HEAD^{tree}'), packageDigest,
    snapshotCommit, snapshotTree: final.snapshotTree || (snapshotCommit ? get('rev-parse', snapshotCommit + '^{tree}') : null), deliveredCommit: null, deliveredTree: null }
}
export async function validateAdmissions(hostRunDir, pin) {
  if (!pin) return
  const checkpoint = JSON.parse(readFileSync(join(hostRunDir, 'checkpoint.json'), 'utf8'))
  for (const run of new Set([hostRunDir, ...(checkpoint.runs || [])])) {
    let jobs = []
    try { jobs = readdirSync(join(run, 'jobs')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    for (const job of jobs) {
      let spec
      try { spec = JSON.parse(readFileSync(join(run, 'jobs', job, 'spec.json'), 'utf8')) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e }
      if (spec.pin && ['codex', 'claude', 'gemini'].includes(spec.kind)) await inspectSeat(pin, spec)
    }
  }
}
export async function runProvenance(repo, args, executor, final = {}) {
  const { provenanceFacts } = await import('./policy.mjs')
  const references = {}
  for (const p of Array.isArray(args.plan) ? args.plan : args.plan ? [args.plan] : []) references[resolve(repo, p)] = sha256(readFileSync(resolve(repo, p)))
  const gate = final?.runDir || repo
  const providerSettings = []
  for (const run of new Set([final?.runDir, final?.hostRunDir].filter(Boolean))) {
    let jobs = []
    try { jobs = readdirSync(join(run, 'jobs')).sort() } catch (e) { if (e.code !== 'ENOENT') throw e }
    for (const job of jobs) {
      try {
        const spec = JSON.parse(readFileSync(join(run, 'jobs', job, 'spec.json'), 'utf8'))
        if (spec.settingsHash) providerSettings.push({ job, kind: spec.kind, hash: spec.settingsHash, sources: spec.settingsSources })
      } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e }
    }
  }
  const maybe = p => { try { return sha256(readFileSync(p)) } catch { return null } }
  return provenanceFacts({}, { executor, evaluator: { packageDigest: executor.packageDigest, entrypoint: 'lib/evaluate.mjs', sha256: sha256(readFileSync(join(pluginRoot, 'lib/evaluate.mjs'))) },
    invocation: process.env.DARK_FACTORY_INVOCATION ? JSON.parse(process.env.DARK_FACTORY_INVOCATION) : null, candidate: candidateFacts(repo, final),
    inputs: { requirements: sha256(JSON.stringify([args.task || '', args.criteria || []])), design: args.design ? sha256(String(args.design)) : null, references,
      gate: maybe(join(gate, 'verify.sh')), settings: maybe(join(gate, 'verification.json')), providerSettings,
      environment: sha256(JSON.stringify(Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(k => [k, process.env[k] || null])))) } })
}

export async function bootstrap(argv, entry = 'bin/dark-factory-codex') {
  let directory = null, resume = null, workflow = null
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { rest.push(...argv.slice(i)); break }
    if (argv[i] === '--pin-engine' || argv[i].startsWith('--pin-engine=')) {
      const value = argv[i].includes('=') ? argv[i].slice(13) : argv[++i]
      if (!value || value.startsWith('--')) throw drift('--pin-engine requires a directory')
      directory = resolve(value); continue
    }
    if (argv[i] === '--resume') resume = argv[i + 1]
    if (argv[i].startsWith('--resume=')) resume = argv[i].slice(9)
    if (argv[i] === '--workflow') workflow = argv[i + 1]
    if (argv[i].startsWith('--workflow=')) workflow = argv[i].slice(11)
    rest.push(argv[i])
  }
  if (workflow === 'run-plan' && (directory || environmentPin())) throw drift('Run-plan does not support pinned execution yet')
  let saved = null
  if (resume) {
    const host = JSON.parse(readFileSync(join(resolve(resume), 'host.json'), 'utf8'))
    saved = host.pin || null
    if (directory && !saved) throw drift('Cannot migrate a legacy/unpinned active run to pinned execution')
  }
  let pin = environmentPin() || saved
  // A validated relocation survives the bootstrap re-exec; saved identity still binds it.
  if (saved && !directory && pin) pin = validateExport(dirname(pin.root), saved)
  if (entry === 'bin/dark-factory-evaluate') {
    const inputs = []
    for (let i = 0; i < rest.length; i++) {
      if (['--output', '--outcomes'].includes(rest[i])) { i++; continue }
      if (!rest[i].startsWith('-')) inputs.push(rest[i])
    }
    for (const input of inputs) {
      const recorded = JSON.parse(readFileSync(resolve(input), 'utf8')).provenance?.executor
      if (recorded?.mode !== 'pinned') continue
      if (pin && (pin.packageDigest !== recorded.packageDigest || pin.sourceRevision !== recorded.sourceRevision)) throw drift('Evaluation inputs declare different executors')
      pin ||= recorded
    }
  }
  if (directory && !process.env.DARK_FACTORY_INVOCATION) {
    let revision = null, dirty = null
    try { revision = textGit(pluginRoot, 'rev-parse', 'HEAD'); dirty = !!textGit(pluginRoot, 'status', '--porcelain', '--', '.') } catch {}
    process.env.DARK_FACTORY_INVOCATION = JSON.stringify({ root: pluginRoot, revision, dirty })
  }
  if (directory) {
    if (saved) pin = validateExport(directory, saved)
    else if (existsSync(directory)) pin = validateExport(directory)
    else {
      const source = resolve(pluginRoot, '../..')
      let cwd = process.cwd()
      const index = rest.indexOf('--cwd'); if (index >= 0) cwd = resolve(rest[index + 1])
      const equal = rest.find(arg => arg.startsWith('--cwd=')); if (equal) cwd = resolve(equal.slice(6))
      // Before creating an executable export, prove the committed source and conservative
      // provider bounds. Actual seats are checked again with their concrete grants.
      const committed = committedInventory(source)
      if (textGit(source, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'plugins/dark-factory') ||
          JSON.stringify(packageInventory(pluginRoot)) !== JSON.stringify(committed.entries)) throw drift('Committed plugin export requires clean shipped inputs')
      validateImports(pluginRoot, committed.entries)
      const modelFree = (['pair', 'ensemble'].includes(workflow) && rest.includes('--explain')) || rest.includes('--help')
      if (!modelFree) {
        const provisional = { version: 1, algorithm: ALGORITHM, mode: 'pinned', packageDigest: inventoryDigest(committed.entries), sourceRevision: committed.commit, root: join(directory, 'plugin'), runtimeVersions: runtimeVersions() }
        const vendors = ['codex', 'claude']
        const argsIndex = rest.indexOf('--args-file')
        const routing = argsIndex >= 0 ? JSON.parse(readFileSync(resolve(rest[argsIndex + 1]), 'utf8')) : {}
        const selected = ['author', 'reviewer', 'seats', 'roles', 'panel', 'simple'].map(k => routing[k]).filter(Boolean)
        for (let i = 0; i < rest.length && rest[i] !== '--'; i++) {
          if (/^--(?:author|reviewer|seats)$/.test(rest[i])) selected.push(rest[++i])
          else if (/^--(?:author|reviewer|seats)=/.test(rest[i])) selected.push(rest[i].split('=').slice(1).join('='))
        }
        if (/gemini/i.test(JSON.stringify(selected))) vendors.push('gemini')
        for (const kind of vendors) await inspectBounds(provisional, { kind, cwd, writable: [] }, process.env)
      }
      pin = exportEngine(source, directory, cwd)
    }
  } else if (pin) pin = validateExport(dirname(pin.root), pin)
  if (pin && physical(pluginRoot) !== pin.root) {
    const child = spawnSync(process.execPath, [join(pin.root, entry), ...rest], { env: { ...process.env, DARK_FACTORY_PIN: JSON.stringify(pin) }, stdio: 'inherit' })
    if (child.error) throw child.error
    process.exitCode = child.status ?? 1
    return null
  }
  if (pin) { process.env.DARK_FACTORY_PIN = JSON.stringify(pin); guardEngine(pin) }
  return rest
}

export async function engineMain(argv) {
  const command = argv[0]
  if (command === 'hook') {
    const request = JSON.parse(readFileSync(0, 'utf8'))
    const spec = JSON.parse(readFileSync(argv[1] || process.env.DARK_FACTORY_SEAT_SPEC, 'utf8'))
    const pin = spec.pin
    if (!pin) throw drift('Missing pinned hook identity')
    await inspectSeat(pin, spec)
    const input = { ...request.tool_input }
    if (request.tool_name === 'Bash') input.command = `export PATH=${quote(join(pin.root, 'bin'))}:"$PATH"\n${input.command}`
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: input } }
  }
  const request = JSON.parse(readFileSync(0, 'utf8'))
  const own = !request.pin && !environmentPin() && existsSync(join(dirname(pluginRoot), 'manifest.json')) ? validateExport(dirname(pluginRoot)) : null
  const executor = guardEngine(request.pin || environmentPin() || own, request.executable)
  if (!executor) throw drift('Missing pinned executor')
  if (request.repo && isolationIssues(dirname(executor.root), [request.repo]).length) throw drift('Pinned export overlaps candidate checkout')
  const settings = request.spec ? await inspectSeat(executor, request.spec) : null
  return { executor, settings, ...(request.repo ? { candidate: candidateFacts(request.repo, request.final) } : {}) }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await engineMain(process.argv.slice(2))) + '\n') }
  catch (error) {
    if (process.argv[2] === 'hook') { process.stderr.write(error.message + '\n'); process.exitCode = 2 }
    else { process.stdout.write(JSON.stringify({ status: 'error', error: error.message, errorClass: 'engine', code: 'ENGINE_DRIFT' }) + '\n'); process.exitCode = 1 }
  }
}
