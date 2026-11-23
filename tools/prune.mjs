// Drops the top-level declarations a workflow body never reaches, so each workflow ships only the
// shared code it uses. A workflow is one concatenated body (tools/sources.mjs), and the shared files
// carry every flow's helpers.
//
// The pass is conservative: a name counts as used wherever it appears as an identifier, whatever
// scope it is in, so a declaration is kept if anything kept could refer to it. Only function
// declarations and variable declarations whose initialisers run nothing (no call, construction,
// assignment or await outside a nested function) can be dropped; every other top-level statement
// runs, and is kept with everything it names.
import { createRequire } from 'node:module'
const { parse } = createRequire(import.meta.url)('../plugins/dark-factory/lib/vendor/acorn.cjs')

const IMPURE = new Set(['CallExpression', 'NewExpression', 'TaggedTemplateExpression', 'AwaitExpression', 'YieldExpression',
  'AssignmentExpression', 'UpdateExpression', 'ImportExpression', 'ClassExpression'])
const FUNCTION = new Set(['FunctionExpression', 'ArrowFunctionExpression'])

function children(node, each) {
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) { for (const v of value) if (v && typeof v.type === 'string') each(v, node, key) }
    else if (value && typeof value.type === 'string') each(value, node, key)
  }
}

// Every identifier name in the subtree, except property names and labels, which name no binding.
function names(node, out = new Set()) {
  const visit = (n, parent, key) => {
    if (n.type === 'Identifier') {
      const property = (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
        (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && key === 'key' && !parent.computed)
      const label = ['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type) && key === 'label'
      if (!property && !label) out.add(n.name)
      return
    }
    children(n, visit)
  }
  visit(node, null, null)
  return out
}

function pure(node) {
  if (!node) return true
  if (IMPURE.has(node.type) || (node.type === 'UnaryExpression' && node.operator === 'delete')) return false
  if (FUNCTION.has(node.type)) return true
  let ok = true
  children(node, n => { if (ok && !pure(n)) ok = false })
  return ok
}

// What a top-level statement declares, or null when it must run.
function droppable(node) {
  if (node.type === 'FunctionDeclaration') return [node.id.name]
  if (node.type === 'VariableDeclaration' && node.declarations.every(d => d.id.type === 'Identifier' && pure(d.init))) {
    return node.declarations.map(d => d.id.name)
  }
  return null
}

// body: a workflow body, which may return and await at the top level. Returns {code, dropped},
// dropped being the names removed.
export function prune(body) {
  const ast = parse(body, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  const statements = ast.body.map(node => ({ node, declares: droppable(node), uses: names(node) }))
  if (statements.some(s => s.uses.has('eval'))) throw new Error('prune: a workflow uses eval, so its references cannot be followed')
  const byName = new Map()
  for (const s of statements) for (const name of s.declares || []) {
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(s)
  }
  const kept = new Set(), queue = statements.filter(s => !s.declares)
  while (queue.length) {
    const s = queue.pop()
    if (kept.has(s)) continue
    kept.add(s)
    for (const name of s.uses) for (const d of byName.get(name) || []) if (!kept.has(d)) queue.push(d)
  }
  let code = '', at = 0
  const dropped = []
  for (const s of statements) {
    if (kept.has(s)) continue
    code += body.slice(at, s.node.start)
    at = s.node.end
    dropped.push(...s.declares)
  }
  return { code: code + body.slice(at), dropped }
}
