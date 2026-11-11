// Package I/O and bootstrap. The importable policy is loaded only after inventory validation.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, mkdirSync, symlinkSync, chmodSync, existsSync, mkdtempSync, rmSync, openSync, closeSync, fstatSync, constants } from 'node:fs'
import { dirname, resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
const require = createRequire(import.meta.url)

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

function ownedDirectory(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid()) throw drift('Engine directory ownership changed')
}
function ownedRead(path) {
  const before = lstatSync(path)
  const valid = stat => stat.isFile() && stat.uid === process.geteuid() && stat.nlink === 1
  if (!valid(before)) throw drift('Engine file ownership or single-link invariant changed')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!valid(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw drift('Engine file ownership or identity changed')
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path)
    if (!valid(after) || !valid(named) || named.dev !== opened.dev || named.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw drift('Engine file changed during read')
    return bytes
  } finally { closeSync(fd) }
}
export function packageInventory(root, owned = false) {
  root = realpathSync(root)
  const entries = []
  function walk(prefix) {
    const directory = prefix.length ? rawPath(root, prefix) : root
    if (owned) ownedDirectory(directory)
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
      } else if (stat.isFile()) { mode = stat.mode & 0o100 ? '100755' : '100644'; bytes = owned ? ownedRead(full) : readFileSync(full) }
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
// This recognizes a finite loader syntax, not the capabilities of arbitrary JavaScript.
function loaderSyntax(ast, esm, refuse) {
  const wrapperNames = new Set(['require', 'module', 'exports', 'arguments'])
  const processMembers = new Set(['argv', 'env', 'exitCode', 'execPath', 'on', 'once', 'removeListener', 'kill', 'pid', 'stdout', 'stderr', 'version', 'geteuid', 'cwd'])
  const globals = new Set(['globalThis', 'global', 'self'])
  const member = node => node.computed ? node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null : node.property.name
  const moduleSource = value => value === 'module' || value === 'node:module'
  const scope = (parent, variable = false) => ({ parent, variable, names: new Map() })
  const root = scope(null, true), parents = new WeakMap(), contexts = new WeakMap(), bindings = [], refs = [], writes = new WeakSet(), expressions = [], aliases = []
  const variableScope = s => { while (!s.variable) s = s.parent; return s }
  const lookup = (s, name) => { while (s && !s.names.has(name)) s = s.parent; return s?.names.get(name) }
  const declare = (s, id, kind, declaration = null) => {
    if (!esm && s === root && wrapperNames.has(id.name)) refuse('Unsupported CJS wrapper declaration')
    const previous = s.names.get(id.name)
    // var redeclaration preserves a parameter or that function's arguments binding.
    if (previous && kind === 'var') return previous
    const binding = { name: id.name, scope: s, kind, declaration, role: null }
    s.names.set(id.name, binding); bindings.push(binding); return binding
  }
  if (!esm) for (const name of wrapperNames) root.names.set(name, { name, scope: root, kind: 'wrapper', role: name })
  function pattern(node, s, kind, declaration) {
    if (!node) return
    contexts.set(node, s)
    if (node.type === 'Identifier') declare(s, node, kind, declaration)
    else if (node.type === 'RestElement') pattern(node.argument, s, kind, declaration)
    else if (node.type === 'AssignmentPattern') { pattern(node.left, s, kind, declaration); scan(node.right, s, node) }
    else if (node.type === 'ArrayPattern') node.elements.forEach(n => pattern(n, s, kind, declaration))
    else if (node.type === 'ObjectPattern') node.properties.forEach(p => { if (p.computed) scan(p.key, s, p); pattern(p.type === 'RestElement' ? p.argument : p.value, s, kind, declaration) })
    else refuse('Unsupported engine binding pattern')
  }
  function target(node, s, parent) {
    if (!node) return
    if (node.type === 'Identifier' || node.type === 'MemberExpression') { scan(node, s, parent, true); return }
    contexts.set(node, s); parents.set(node, parent)
    if (node.type === 'RestElement') target(node.argument, s, node)
    else if (node.type === 'AssignmentPattern') { target(node.left, s, node); scan(node.right, s, node) }
    else if (node.type === 'ArrayPattern') node.elements.forEach(n => target(n, s, node))
    else if (node.type === 'ObjectPattern') node.properties.forEach(p => { if (p.computed) scan(p.key, s, p); target(p.type === 'RestElement' ? p.argument : p.value, s, p) })
    else refuse('Unsupported engine assignment target')
  }
  function scan(node, s, parent = null, write = false) {
    if (!node?.type) return
    contexts.set(node, s); parents.set(node, parent); expressions.push(node)
    switch (node.type) {
      case 'Identifier': refs.push({ node, s, write }); if (write) writes.add(node); return
      case 'Program': node.body.forEach(n => scan(n, s, node)); return
      case 'WithStatement': refuse('Unsupported engine dynamic scope (with)'); return
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        if (node.type === 'FunctionDeclaration' && node.id) {
          if (!esm && variableScope(s) === root && wrapperNames.has(node.id.name)) refuse('Unsupported CJS wrapper declaration')
          declare(s, node.id, 'function', node)
        }
        const f = scope(s, true)
        if (node.type !== 'ArrowFunctionExpression') f.names.set('arguments', { name: 'arguments', scope: f, kind: 'implicit', role: null })
        if (node.id && node.type === 'FunctionExpression') declare(f, node.id, 'function', node)
        node.params.forEach(p => pattern(p, f, 'parameter', node)); scan(node.body, f, node); return
      }
      case 'BlockStatement': case 'StaticBlock': {
        const b = scope(s, node.type === 'StaticBlock'); node.body.forEach(n => scan(n, b, node)); return
      }
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          contexts.set(d, s); parents.set(d, node)
          pattern(d.id, node.kind === 'var' ? variableScope(s) : s, node.kind, d)
          scan(d.init, s, d); aliases.push({ left: d.id, right: d.init, s })
        }
        return
      case 'ClassDeclaration': case 'ClassExpression': {
        if (node.id && node.type === 'ClassDeclaration') declare(s, node.id, 'class', node)
        const c = scope(s)
        if (node.id) declare(c, node.id, 'class', node)
        scan(node.superClass, c, node); scan(node.body, c, node); return
      }
      case 'CatchClause': { const b = scope(s); pattern(node.param, b, 'catch', node); scan(node.body, b, node); return }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const b = scope(s)
        for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) {
          if (['ForInStatement', 'ForOfStatement'].includes(node.type) && key === 'left' && node.left.type !== 'VariableDeclaration') target(node.left, b, node)
          else scan(node[key], b, node)
        }
        return
      }
      case 'SwitchStatement': { const b = scope(s); scan(node.discriminant, s, node); node.cases.forEach(n => scan(n, b, node)); return }
      case 'ImportDeclaration':
        for (const item of node.specifiers) {
          if (moduleSource(node.source.value)) {
            const name = item.imported?.name ?? item.imported?.value
            if (item.type !== 'ImportSpecifier' || !['createRequire', 'isBuiltin'].includes(name) || (name === 'createRequire' && item.local.name !== name) || (name === 'isBuiltin' && ['require', 'createRequire'].includes(item.local.name))) refuse('Unsupported engine module acquisition')
            const binding = declare(s, item.local, 'import', node)
            if (name === 'createRequire') binding.role = 'factory'
          } else declare(s, item.local, 'import', node)
        }
        return
      case 'ExportNamedDeclaration': case 'ExportAllDeclaration':
        if (node.source && moduleSource(node.source.value)) refuse('Unsupported engine module re-export')
        scan(node.declaration, s, node)
        if (!node.source) node.specifiers?.forEach(item => scan(item.local, s, item))
        return
      case 'MemberExpression': {
        if (['require', 'createRequire', 'getBuiltinModule', 'eval', 'Function'].includes(member(node))) refuse('Unsupported engine loader/evaluator member')
        scan(node.object, s, node); if (node.computed) scan(node.property, s, node); return
      }
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition':
        if (node.computed) scan(node.key, s, node)
        scan(node.value, s, node); return
      case 'AssignmentExpression':
        target(node.left, s, node); scan(node.right, s, node); aliases.push({ left: node.left, right: node.right, s }); return
      case 'UpdateExpression': target(node.argument, s, node); return
      case 'UnaryExpression':
        if (node.operator === 'delete') { target(node.argument, s, node); return }
        break
      case 'LabeledStatement': scan(node.body, s, node); return
      case 'BreakStatement': case 'ContinueStatement': case 'Literal': case 'TemplateElement': case 'MetaProperty': case 'PrivateIdentifier': return
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(n => scan(n, s, node)); else if (value?.type) scan(value, s, node)
  }
  scan(ast, root)
  const bindingOf = node => lookup(contexts.get(node), node.name)
  const role = node => {
    if (!node) return null
    if (node.type === 'Identifier') {
      const binding = bindingOf(node)
      return binding ? binding.role : node.name === 'process' ? 'process' : globals.has(node.name) ? 'global' : null
    }
    if (node.type === 'MemberExpression' && role(node.object) === 'global') return member(node) === 'process' ? 'process' : globals.has(member(node)) ? 'global' : null
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      const values = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right]
      const roles = values.map(role)
      return roles.includes('process') ? 'process' : roles.includes('global') ? 'global' : null
    }
    return null
  }
  // Monotone provenance: a later ordinary assignment cannot erase a known global carrier.
  let changed
  do {
    changed = false
    for (const a of aliases) if (a.left.type === 'Identifier' && role(a.right) === 'global') {
      const b = lookup(a.s, a.left.name)
      if (!b) refuse('Unsupported engine global assignment')
      if (!b.role) { b.role = 'global'; changed = true }
      else if (b.role !== 'global') refuse('Unsupported engine carrier rebinding')
    }
  } while (changed)
  const factories = new Set(), requires = new Set()
  for (const b of bindings) if (b.name === 'require' && b.declaration?.type === 'VariableDeclarator') {
    const d = b.declaration, call = d.init, origin = call?.arguments?.[0]
    if (call?.type === 'CallExpression' && call.callee.type === 'Identifier' && bindingOf(call.callee)?.role === 'factory') {
      if (!esm || b.scope !== root || b.kind !== 'const' || d.id.type !== 'Identifier' || parents.get(parents.get(d))?.type !== 'Program' || call.optional || call.arguments.length !== 1 || origin?.type !== 'MemberExpression' || origin.computed || origin.optional || origin.property.name !== 'url' || origin.object.type !== 'MetaProperty' || origin.object.meta.name !== 'import' || origin.object.property.name !== 'meta') refuse('Unsupported engine require origin')
      b.role = 'loader'; factories.add(call)
    }
  }
  if (factories.size) for (const b of bindings) if ((b.name === 'require' && b.role !== 'loader') || (b.name === 'createRequire' && b.role !== 'factory')) refuse('Unsupported engine loader shadow binding')
  for (const { node, s, write } of refs) {
    const b = lookup(s, node.name), parent = parents.get(node)
    if (['eval', 'Function'].includes(node.name)) refuse('Unsupported engine evaluator reference')
    if (write && (b?.kind === 'wrapper' || ['loader', 'factory'].includes(b?.role))) refuse('Unsupported engine wrapper/loader assignment')
    if (b?.role === 'arguments' || (!b && node.name === 'arguments')) refuse('Unsupported CJS wrapper arguments')
    if (b?.role === 'module' || (!b && node.name === 'module')) {
      if (!((parent?.type === 'MemberExpression' && parent.object === node && member(parent) === 'exports' && !parent.optional) || (parent?.type === 'UnaryExpression' && parent.operator === 'typeof'))) refuse('Unsupported engine module reference')
    }
    if (b?.role === 'factory' && !(parent?.type === 'CallExpression' && parent.callee === node && factories.has(parent))) refuse('Unsupported engine factory reference')
    if (['require', 'loader'].includes(b?.role) || (!b && node.name === 'require')) {
      if (!b || parent?.type !== 'CallExpression' || parent.callee !== node || parent.optional || parent.arguments.length !== 1) refuse('Unsupported engine require reference')
      requires.add(parent)
    }
  }
  const aliasContext = node => {
    let parent = parents.get(node)
    while (parent && ((parent.type === 'ConditionalExpression' && parent.test !== node) || parent.type === 'LogicalExpression')) { node = parent; parent = parents.get(node) }
    if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') return bindingOf(parent.id)?.role === 'global'
    if (parent?.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'Identifier') return bindingOf(parent.left)?.role === 'global'
    return false
  }
  for (const node of expressions) {
    const kind = role(node)
    if (!['global', 'process'].includes(kind)) continue
    const parent = parents.get(node)
    if (node.type === 'Identifier' && writes.has(node)) continue
    if (parent?.type === 'MemberExpression' && parent.object === node && !parent.optional) {
      const key = member(parent)
      if (key === null || (kind === 'process' && !processMembers.has(key))) refuse('Unsupported engine process/global member')
    } else if (kind === 'global' && ((parent?.type === 'UnaryExpression' && parent.operator === 'typeof') || aliasContext(node))) continue
    else refuse('Unsupported engine process/global escape')
  }
  return requires
}

export function validateImports(root, entries, owned = false) {
  const paths = new Set(entries.map(e => Buffer.from(e[0], 'base64').toString()))
  // Invoking adapter is the trust root. Never execute a parser from the inspected package.
  const { parse } = require('./vendor/acorn.cjs')
  for (const path of paths) {
    if (!/\.(mjs|cjs|js)$/.test(path) && !path.startsWith('bin/dark-factory-')) continue
    const source = (owned ? ownedRead(realpathSync(join(root, path))) : readFileSync(join(root, path))).toString('utf8'), workflow = path.startsWith('workflows/')
    const module = path.endsWith('.mjs') || path.startsWith('bin/dark-factory-') || workflow
    let ast
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowReturnOutsideFunction: workflow, allowAwaitOutsideFunction: workflow }) }
    catch (e) { throw drift(`Unsupported engine syntax: ${path}: ${e.message}`) }
    const dependency = (node, kind) => {
      if (node?.type !== 'Literal' || typeof node.value !== 'string') throw drift(`Unresolved dynamic engine import: ${path}`)
      const spec = node.value
      if (isBuiltin(spec)) {
        if (!['child_process', 'crypto', 'fs', 'module', 'os', 'path', 'url'].includes(spec.replace(/^node:/, ''))) throw drift(`Unsupported engine builtin: ${path}`)
        if (['module', 'node:module'].includes(spec) && kind !== 'static') throw drift(`Unsupported engine module acquisition: ${path}`)
        return
      }
      const refuse = () => { throw drift(`Untracked or external engine import: ${path}`) }
      if (!/^\.\.?\//.test(spec)) refuse()
      let full
      try {
        if (kind !== 'cjs') {
          if (/%(?:2f|5c)/i.test(spec) || /[?#\\]/.test(spec)) refuse()
          const url = new URL(spec, pathToFileURL(join(root, path)))
          if (url.protocol !== 'file:' || url.search || url.hash) refuse()
          full = fileURLToPath(url)
        } else {
          // The supported CJS subset uses explicit files, without extension or package search.
          full = resolve(dirname(join(root, path)), spec)
          if (!lstatSync(realpathSync(full)).isFile()) refuse()
        }
        const target = relative(root, full), physicalTarget = realpathSync(full)
        if (!/\.(?:mjs|cjs|js|json)$/.test(target) || !within(root, full) || !paths.has(target) || !within(realpathSync(root), physicalTarget) || !paths.has(relative(realpathSync(root), physicalTarget))) refuse()
      } catch { refuse() }
    }
    const requires = loaderSyntax(ast, module, message => { throw drift(`${message}: ${path}`) })
    const visit = (node, parent = null) => {
      if (!node || typeof node !== 'object') return
      if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
        if (node.attributes?.length || node.assertions?.length) throw drift(`Unsupported engine import attributes: ${path}`)
        dependency(node.source, 'static')
      }
      if (node.type === 'ImportExpression') {
        if (node.options) throw drift(`Unsupported engine import options: ${path}`)
        dependency(node.source, 'esm')
      }
      if (requires.has(node)) {
        dependency(node.arguments[0], 'cjs')
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => visit(child, node)); else if (value && typeof value === 'object') visit(value, node)
    }
    visit(ast)
  }
}

let runtimes
export function runtimeVersions() {
  if (!runtimes) runtimes = { node: process.version,
    python: execFileSync('python3', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    git: execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  return runtimes
}
export function validateExport(directory, expected = null) {
  directory = physical(directory)
  ownedDirectory(directory)
  let manifest
  try { manifest = JSON.parse(ownedRead(join(directory, 'manifest.json')).toString('utf8')) } catch (e) { if (e.code === 'ENGINE_DRIFT') throw e; throw drift('Engine manifest unreadable') }
  checkManifest(manifest)
  const root = join(directory, 'plugin')
  if (lstatSync(root).isSymbolicLink()) throw drift('Engine plugin root is a symlink')
  const entries = packageInventory(root, true)
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) throw drift('Engine package content or mode changed')
  for (const required of ['bin/dark-factory', 'bin/dark-factory-codex', 'bin/dark-factory-evaluate', 'lib/engine.mjs', 'lib/engine-observations.mjs', 'lib/cli-options.mjs', 'lib/engine-publish.py', 'lib/vendor/acorn.cjs', 'lib/vendor/acorn.LICENSE', 'lib/vendor/acorn.json', 'lib/policy.mjs', 'lib/checkpoint.mjs', 'lib/evaluate.mjs', 'lib/codex-runner.mjs', 'schemas/provenance.schema.json', '.claude-plugin/plugin.json', 'skills/dark-factory/scripts/run.mjs', ...['factory', 'pair', 'council', 'ensemble', 'run-plan'].map(n => `workflows/${n}.js`)]) {
    if (!entries.some(e => Buffer.from(e[0], 'base64').toString() === required)) throw drift(`Incomplete engine package: ${required}`)
  }
  validateImports(root, entries, true)
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
  try { lstatSync(directory); return validateExport(directory) } catch (e) { if (e.code !== 'ENOENT') throw e }
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
  const parent = dirname(directory)
  const ensureParent = path => {
    try {
      const st = lstatSync(path)
      if (!st.isDirectory() || st.isSymbolicLink()) throw drift('Unsafe publication parent')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      ensureParent(dirname(path))
      try { mkdirSync(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
      const st = lstatSync(path)
      if (!st.isDirectory() || st.isSymbolicLink()) throw drift('Publication parent changed')
    }
  }
  ensureParent(parent)
  const parentStat = lstatSync(parent), staging = mkdtempSync(join(parent, '.engine-stage-'))
  chmodSync(staging, 0o700)
  const owned = lstatSync(staging)
  try {
    const root = join(staging, 'plugin'); mkdirSync(root)
    // Write regular files before links; no created link is traversed by a later write.
    for (const blob of [...committed.blobs.filter(b => b.mode !== '120000'), ...committed.blobs.filter(b => b.mode === '120000')]) {
      const full = rawPath(root, blob.path)
      mkdirSync(full.subarray(0, full.lastIndexOf(47)), { recursive: true })
      if (blob.mode === '120000') symlinkSync(blob.bytes, full)
      else { writeFileSync(full, blob.bytes, { flag: 'wx' }); chmodSync(full, blob.mode === '100755' ? 0o755 : 0o644) }
    }
    const actual = packageInventory(root, true)
    if (JSON.stringify(actual) !== JSON.stringify(committed.entries)) throw drift('Committed/exported package identity differs')
    const manifest = { version: 1, algorithm: ALGORITHM, sourceRevision: committed.commit, sourceTree: committed.tree,
      packageDigest: inventoryDigest(actual), entries: actual }
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    const staged = validateExport(staging)
    if (isolationIssues(directory, [source, candidate, ...roots]).length) throw drift('Export overlaps writable root')
    const out = spawnSync('python3', [join(pluginRoot, 'lib/engine-publish.py'), parent, relative(parent, staging), relative(parent, directory),
      String(parentStat.dev), String(parentStat.ino), String(owned.dev), String(owned.ino)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (out.error) throw out.error
    if (out.status === 17) return validateExport(directory, staged)
    if (out.status !== 0) throw drift(`Atomic export publication refused: ${out.stderr.trim()}`)
    return validateExport(directory, staged)
  } finally {
    let current
    try { current = lstatSync(staging) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (current && current.dev === owned.dev && current.ino === owned.ino && current.isDirectory() && !current.isSymbolicLink()) rmSync(staging, { recursive: true })
  }
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
  const out = spawnSync('python3', ['-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
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
  const { pinnedOperationIssues, providerConfiguration } = await import('./policy.mjs')
  const vendor = spec.kind || spec.vendor, home = env.HOME || '', repo = spec.repoRoot || spec.cwd
  const configHome = env.CODEX_HOME || join(home, '.codex'), claudeHome = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const catalog = vendor === 'codex' ? ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/Library/Preferences/com.openai.codex.plist', join(configHome, 'config.toml')]
    : vendor === 'claude' ? [join(claudeHome, 'settings.json'),
      ...ancestors(spec.cwd).reverse().flatMap(p => [join(p, '.claude/settings.json'), join(p, '.claude/settings.local.json')]),
      '/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.d', '/Library/Managed Preferences/com.anthropic.claudecode.plist']
    : [join(home, '.gemini/antigravity-cli/settings.json')]
  const scope = path => path.startsWith(configHome + '/') || path.startsWith(claudeHome + '/') || path === join(home, '.gemini/antigravity-cli/settings.json') ? 'user'
    : path.startsWith('/etc/') || path.startsWith('/Library/') ? path.endsWith('/config.toml') ? 'system' : 'managed' : 'project'
  const label = path => ['config.toml', 'settings.json', 'settings.local.json', 'managed-settings.json', 'managed-settings.d'].find(name => path.endsWith('/' + name)) || 'component'
  const watching = providerConfiguration({}, { vendor, stage: 'watching', roles: spec.roles || [spec.role || 'seat'], facts: { immutable: true, deliveryKnown: true }, layers: catalog.map(path => ({ source: path, scope: scope(path), name: label(path), data: {} })) }).diagnostic
  const diagnostic = (status, extra = {}) => process.stderr.write(JSON.stringify({ ...watching, status, ...extra }) + '\n')
  diagnostic('watching')
  const defaults = providerDefaults(vendor)
  const defaultIssues = pinnedOperationIssues({}, pin, { executor, overlaps: isolationIssues(dirname(pin.root), defaults) })
  if (defaultIssues.length) { diagnostic('refused', { reasons: ['default-write-root-overlap'] }); throw drift('Default write-root overlap: ' + defaultIssues.join('; ')) }
  const facts = providerFacts(vendor), unknown = [], roots = [spec.cwd, ...(spec.writable || []), ...(spec.gitRoots || []), ...defaults, ...(facts.defaults || [])]
  const sources = [], layers = [], plugins = [], trust = [], capabilitySources = [], mcpSources = []
  const read = path => {
    let raw
    try { raw = readHostSource(path) } catch { raw = { status: 'unknown' } }
    sources.push([path, raw.status, raw.status === 'file' ? sha256(raw.text) : null])
    return raw
  }
  const parsed = path => {
    const raw = read(path)
    if (raw.status === 'absent') return null
    if (path.endsWith('/managed-settings.d')) { unknown.push(`${raw.status === 'unknown' ? 'unreadable' : 'unsupported'} managed settings directory`); return null }
    if (raw.status !== 'file') { unknown.push('unreadable settings source'); return null }
    try { return path.endsWith('.toml') ? parseToml(raw.text) : JSON.parse(raw.text) }
    catch (e) { unknown.push('invalid settings source'); return null }
  }
  for (const path of [...new Set(catalog)]) {
    const data = parsed(path)
    if (data && vendor === 'claude' && path.includes('managed-settings') && !facts.managedImmutable) unknown.push('claude: mutable mandatory policy cannot enforce executable settings reload')
    if (data) layers.push({ source: path, scope: scope(path), data, base: vendor === 'codex' ? dirname(path) : path.includes('/.claude/') ? dirname(dirname(path)) : repo })
  }
  if (vendor === 'codex') {
    // Project layers apply only under established trust; untrusted bytes stay provenance.
    for (const layer of layers) for (const [path, entry] of Object.entries(layer.data.projects || {})) trust.push([physical(path), entry?.trust_level])
    const trusted = trust.some(([path, level]) => level === 'trusted' && within(path, physical(spec.cwd)))
    for (const path of [...new Set(ancestors(spec.cwd).reverse().map(p => join(p, '.codex/config.toml')))]) {
      if (catalog.includes(path)) continue
      const data = parsed(path)
      if (data) layers.push({ source: path, scope: 'project', data, base: dirname(dirname(path)), applicable: trusted })
    }
    for (const [base, applicable] of [[configHome, true], ...ancestors(spec.cwd).map(p => [join(p, '.codex'), trusted])]) {
      for (const name of ['rules', 'hooks.json', 'plugins']) {
        const source = join(base, name), raw = read(source)
        capabilitySources.push({ source, kind: name, applicable, ...raw })
      }
    }
    for (const profile of new Set(layers.filter(layer => layer.scope !== 'project').map(layer => layer.data.profile).filter(name => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name)))) {
      const source = join(configHome, `${profile}.config.toml`)
      capabilitySources.push({ source, kind: 'external profile configuration', ...read(source) })
    }
    const requirements = parsed('/etc/codex/requirements.toml')
    if (requirements) {
      for (const [key, values] of Object.entries(requirements)) {
        if (key === 'allowed_approval_policies' && Array.isArray(values) && values.includes('never')) continue
        if (key === 'allowed_sandbox_modes' && Array.isArray(values) && values.includes(spec.sandbox || 'workspace-write')) continue
        unknown.push('codex: incompatible mandatory requirement')
      }
    }
  }
  if (vendor === 'claude') {
    for (const path of new Set([join(repo, '.mcp.json'), join(spec.cwd, '.mcp.json')])) {
      const data = parsed(path)
      if (data) mcpSources.push({ source: path, servers: data.mcpServers || data })
    }
    const statePath = join(home, '.claude.json'), state = parsed(statePath)
    if (state) {
      if (state.mcpServers !== undefined) mcpSources.push({ source: statePath, servers: state.mcpServers })
      for (const [path, project] of Object.entries(state.projects || {})) {
        if (!isAbsolute(path) || (!within(physical(path), physical(spec.cwd)) && !within(physical(path), physical(repo)))) continue
        if (!project || typeof project !== 'object') { unknown.push('claude: unsupported project capability source'); continue }
        if (project.mcpServers !== undefined) mcpSources.push({ source: `${statePath}:projects:${path}`, servers: project.mcpServers })
        if (project.allowedTools !== undefined) layers.push({ source: `${statePath}:projects:${path}`, scope: 'project', base: path, data: { permissions: { allow: project.allowedTools } } })
      }
      if (state.apiKeyHelper !== undefined) layers.push({ source: statePath, scope: 'user', base: repo, data: { apiKeyHelper: state.apiKeyHelper } })
    }
    const enabled = Object.assign(Object.create(null), ...layers.map(l => l.data.enabledPlugins || {}))
    const active = Object.keys(enabled).filter(key => enabled[key] === true)
    if (active.length) {
      const registryPath = join(claudeHome, 'plugins/installed_plugins.json'), registry = parsed(registryPath)
      for (const name of active) {
        const candidates = registry?.version === 2 ? registry.plugins?.[name] : null
        const installations = Array.isArray(candidates) ? candidates.filter(x => x?.scope === 'user' || (['project', 'local'].includes(x?.scope) && x.projectPath && physical(x.projectPath) === physical(repo))) : []
        const installation = installations.at(-1), location = installation?.installPath
        const plugin = { source: name, inspected: false, executable: [], activation: {}, unknown: [] }
        plugins.push(plugin)
        if (typeof location !== 'string' || !isAbsolute(location)) continue
        const manifest = parsed(join(location, '.claude-plugin/plugin.json'))
        if (!manifest) continue
        plugin.inspected = true
        const pluginSettings = read(join(location, 'settings.json'))
        if (pluginSettings.status !== 'absent') {
          try { const data = JSON.parse(pluginSettings.text); plugin.startup = !!Object.keys(data).length } catch { plugin.startup = true }
        }
        for (const key of Object.keys(manifest)) if (!['name', 'description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords', 'commands', 'agents', 'skills', 'outputStyles', 'hooks', 'mcpServers', 'lspServers'].includes(key)) plugin.unknown.push(`unsupported component: ${key}`)
        plugin.hooks = !!manifest.hooks; plugin.mcp = !!manifest.mcpServers; plugin.lsp = !!manifest.lspServers
        for (const [path, key] of [['hooks/hooks.json', 'hooks'], ['.mcp.json', 'mcp'], ['.lsp.json', 'lsp']]) {
          const raw = read(join(location, path))
          if (raw.status !== 'absent') plugin[key] = true
        }
        // Inventory passive executables without loading them. Declarative components are inactive.
        const walk = (path, presentation = false) => {
          const raw = read(path)
          if (raw.status === 'absent') return
          if (raw.status === 'directory') {
            for (const entry of raw.entries) {
              if (entry === '.' || entry === '..' || entry.includes('/')) { plugin.unknown.push('invalid component path'); continue }
              walk(join(path, entry), presentation)
            }
          } else if (raw.status === 'file') {
            if (/^\s*(hooks|mcpServers|agent):/m.test(raw.text) && /\.md$/.test(path)) plugin.unknown.push('executable component frontmatter')
            if (!presentation) plugin.executable.push([relative(location, path), sha256(raw.text), raw.mode ?? null])
          } else plugin.unknown.push(`unreadable component: ${path}`)
        }
        for (const path of ['bin', 'lib', 'workflows', 'skills', 'commands', 'agents']) walk(join(location, path))
        walk(join(location, 'output-styles'), true)
        for (const key of ['commands', 'agents', 'skills', 'outputStyles']) if (manifest[key]) {
          const paths = Array.isArray(manifest[key]) ? manifest[key] : [manifest[key]]
          for (const path of paths) {
            if (typeof path !== 'string' || !path.startsWith('./') || !within(location, resolve(location, path))) plugin.unknown.push(`invalid component path: ${key}`)
            else walk(resolve(location, path), key === 'outputStyles')
          }
        }
        plugin.activation = { hooks: plugin.hooks, mcp: plugin.mcp, lsp: plugin.lsp, slashCommands: false, delegation: false }
      }
    }
  }
  const config = providerConfiguration({}, { vendor, roles: spec.roles || [spec.role || 'seat'], facts, layers, plugins, capabilitySources, mcpSources, trust: trust.filter(([path]) => within(path, physical(spec.cwd))), shellBounded: vendor === 'claude' && facts.hooks, statusLineOverride: true, permissionMode: spec.sandbox === 'read-only' ? 'plan' : 'acceptEdits',
    tools: spec.sandbox === 'read-only' ? ['Read', 'Glob', 'Grep'] : ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write'] })
  unknown.push(...config.unknown)
  for (const grant of config.grants) {
    let value = grant.value
    if (value.startsWith('~/')) value = join(home, value.slice(2))
    // Claude // denotes an absolute filesystem pattern; / denotes project-relative.
    else if (vendor === 'claude' && grant.pattern) {
      if (value.startsWith('//')) value = value.slice(1)
      else if (value.startsWith('/')) value = '.' + value
    }
    const bases = isAbsolute(value) ? [repo] : [...new Set([grant.base || repo, spec.cwd, repo])]
    for (const base of bases) {
      try { roots.push(physical(resolve(base, value))) } catch { unknown.push('unreadable write-root capability') }
    }
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const normalizedRoots = [...new Set(roots.map(physical))].sort()
  const settingsHash = sha256(JSON.stringify(canonical({ ...config.security, roots: normalizedRoots })))
  const overlaps = isolationIssues(dirname(pin.root), [repo, ...normalizedRoots]), settingsChanged = !!spec.settingsHash && spec.settingsHash !== settingsHash
  const issues = pinnedOperationIssues({}, pin, { executor, unknown, overlaps, settingsChanged })
  diagnostic(issues.length ? 'refused' : 'admitted', { ...config.diagnostic, status: issues.length ? 'refused' : 'admitted', sources: sources.map(([path, status], index) => ({ index, scope: scope(path), name: label(path), status: ['file', 'absent', 'directory'].includes(status) ? status : 'unknown' })), reasons: [...(unknown.length ? ['unknown-capabilities'] : []), ...(overlaps.length ? ['write-root-overlap'] : []), ...(settingsChanged ? ['capabilities-changed'] : [])] })
  if (issues.length) throw drift(issues.join('; '))
  return { diagnostic: config.diagnostic, settingsHash, settingsVersion: 1, sources, roots: normalizedRoots, facts }
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
        if (spec.settingsHash) providerSettings.push({ job, kind: spec.kind, ...(spec.settingsVersion ? { settingsVersion: spec.settingsVersion } : {}), hash: spec.settingsHash, sources: spec.settingsSources })
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
      // Before creating an executable export, prove the committed source and conservative
      // provider bounds. Actual seats are checked again with their concrete grants.
      const committed = committedInventory(source)
      if (textGit(source, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'plugins/dark-factory') ||
          JSON.stringify(packageInventory(pluginRoot)) !== JSON.stringify(committed.entries)) throw drift('Committed plugin export requires clean shipped inputs')
      validateImports(pluginRoot, committed.entries)
      const { parseCLI } = await import('./cli-options.mjs')
      const options = parseCLI(rest)
      const { reachableProviders } = await import('./policy.mjs')
      const routes = reachableProviders({}, { workflow: options.workflow, args: options.args, help: options.help })
      const provisional = { version: 1, algorithm: ALGORITHM, mode: 'pinned', packageDigest: inventoryDigest(committed.entries), sourceRevision: committed.commit, root: join(directory, 'plugin'), runtimeVersions: { node: process.version, python: 'not-observed', git: 'not-observed' } }
      for (const kind of new Set(routes.map(r => r.vendor))) await inspectBounds(provisional, { kind, roles: routes.filter(route => route.vendor === kind).map(route => route.role), cwd: options.cwd, writable: [] }, process.env)

      pin = exportEngine(source, directory, options.cwd)
    }
  } else if (pin) pin = validateExport(dirname(pin.root), pin)
  if (pin && physical(pluginRoot) !== pin.root) {
    const child = spawnSync(process.execPath, [join(pin.root, entry), ...rest], { env: { ...process.env, DARK_FACTORY_PIN: JSON.stringify(pin) }, stdio: ['inherit', 'inherit', 'inherit'] })
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
    if (request.hook_event_name === 'ConfigChange') return {}
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
