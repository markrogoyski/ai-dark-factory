import { createRequire } from 'node:module'
const { parse } = createRequire(import.meta.url)('../plugins/dark-factory/lib/vendor/acorn.cjs')

const members = {
  Object: ['keys', 'values', 'entries', 'fromEntries', 'hasOwn', 'assign', 'freeze', 'create'],
  Array: ['from', 'isArray'], JSON: ['parse', 'stringify'],
  Number: ['isInteger', 'isSafeInteger', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'EPSILON', 'MAX_VALUE', 'MIN_VALUE', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY', 'NaN'],
  Math: ['abs', 'ceil', 'floor', 'round', 'trunc', 'min', 'max', 'imul', 'E', 'PI', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT1_2', 'SQRT2'],
}
const intrinsic = new Set(['undefined', 'NaN', 'Infinity', 'Object', 'Array', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'BigInt', 'RegExp', 'Error', 'TypeError', 'Set', 'Map', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'])
const namespace = new Set(['Object', 'Array', 'Math', 'JSON'])
const runtime = new Set(['agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow'])

// Resolve the policy target alone. Native-only declarations cannot satisfy a missing dependency.
export function assertPolicy(sources, exports = [], trailer = undefined) {
  if (trailer !== undefined && trailer !== `export { ${exports.join(', ')} }\n`) throw new Error('Unsupported policy export trailer')
  const text = sources.map(s => s.text).join('\n'), starts = []
  let offset = 0
  for (const source of sources) { starts.push({ start: offset, ...source }); offset += source.text.length + 1 }
  const fail = (node, message) => {
    const source = starts.findLast(s => s.start <= node.start) || starts[0]
    const line = text.slice(source.start, node.start).split('\n').length
    throw new Error(`${source.file}:${line}: ${message}`)
  }
  let ast
  try { ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) }
  catch (e) { throw new Error(`Policy syntax: ${e.message}`) }
  const scope = (parent, fn = false) => ({ parent, fn, names: new Map() })
  const root = scope(null, true), refs = []
  const declare = (s, name, node) => {
    if (s.names.has(name) && s === root) fail(node, `Duplicate policy binding: ${name}`)
    s.names.set(name, node)
  }
  function pattern(node, s) {
    if (!node) return
    if (node.type === 'Identifier') declare(s, node.name, node)
    else if (node.type === 'RestElement') pattern(node.argument, s)
    else if (node.type === 'AssignmentPattern') { pattern(node.left, s); visit(node.right, s, node) }
    else if (node.type === 'ArrayPattern') node.elements.forEach(n => pattern(n, s))
    else if (node.type === 'ObjectPattern') node.properties.forEach(p => { if (p.computed) visit(p.key, s, p); pattern(p.type === 'RestElement' ? p.argument : p.value, s) })
    else fail(node, `Unsupported policy binding: ${node.type}`)
  }
  function visit(node, s, parent = null, write = false) {
    if (!node) return
    switch (node.type) {
      case 'Program': node.body.forEach(n => visit(n, s, node)); return
      case 'Identifier': refs.push({ node, s, parent, write }); return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.type === 'FunctionDeclaration') declare(s, node.id.name, node)
        const f = scope(s, true)
        if (node.id) declare(f, node.id.name, node)
        if (node.type !== 'ArrowFunctionExpression') f.names.set('arguments', node)
        node.params.forEach(p => pattern(p, f)); visit(node.body, f, node); return
      }
      case 'BlockStatement': { const b = scope(s); node.body.forEach(n => visit(n, b, node)); return }
      case 'VariableDeclaration': {
        let target = s
        if (node.kind === 'var') while (!target.fn) target = target.parent
        node.declarations.forEach(d => { pattern(d.id, target); visit(d.init, s, d) }); return
      }
      case 'CatchClause': { const b = scope(s); pattern(node.param, b); visit(node.body, b, node); return }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const b = scope(s)
        for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) visit(node[key], b, node)
        return
      }
      case 'MemberExpression':
        if ((!node.computed && node.property.name === 'runtime') || (node.computed && node.property.type === 'Literal' && node.property.value === 'runtime')) fail(node, 'Policy runtime access')
        if ((!node.computed && node.property.name === 'constructor') || (node.computed && node.property.type === 'Literal' && node.property.value === 'constructor')) fail(node, 'Policy constructor evaluation')
        visit(node.object, s, node, write); if (node.computed) visit(node.property, s, node); return
      case 'Property': if (node.computed) visit(node.key, s, node); visit(node.value, s, node); return
      case 'SwitchStatement': { const b = scope(s); visit(node.discriminant, s, node); node.cases.forEach(n => visit(n, b, node)); return }
      case 'UnaryExpression': if (node.operator === 'delete') { visit(node.argument, s, node, true); return }; break
      case 'AssignmentExpression': visit(node.left, s, node, true); visit(node.right, s, node); return
      case 'UpdateExpression': visit(node.argument, s, node, true); return
      case 'CallExpression':
      case 'NewExpression':
        if (node.callee.type === 'Identifier' && (runtime.has(node.callee.name) || ['eval', 'Function', 'require'].includes(node.callee.name))) fail(node, 'Policy calls I/O or ambient runtime')
        break
      case 'ThisExpression': case 'Super': case 'MetaProperty': case 'ImportExpression':
      case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': case 'ExportAllDeclaration':
      case 'ClassDeclaration': case 'ClassExpression': case 'WithStatement':
        fail(node, `Unsupported ambient policy syntax: ${node.type}`); break
      case 'LabeledStatement': visit(node.body, s, node); return
      case 'BreakStatement': case 'ContinueStatement': case 'Literal': case 'TemplateElement': return
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'type'].includes(key)) continue
      if (Array.isArray(child)) child.forEach(n => { if (n?.type) visit(n, s, node) })
      else if (child?.type) visit(child, s, node)
    }
  }
  visit(ast, root)
  for (const { node, s, parent, write } of refs) {
    let owner = s
    while (owner && !owner.names.has(node.name)) owner = owner.parent
    if (owner) continue
    if (!intrinsic.has(node.name)) fail(node, `Unresolved or ambient policy identifier: ${node.name}`)
    if (write) fail(node, `Policy mutates intrinsic: ${node.name}`)
    if (parent?.type === 'MemberExpression' && parent.object === node) {
      const member = parent.computed ? parent.property.type === 'Literal' ? parent.property.value : null : parent.property.name
      if (!members[node.name]?.includes(member)) fail(node, `Unsupported policy intrinsic member: ${node.name}.${member ?? '<computed>'}`)
    } else if (namespace.has(node.name) && !(['CallExpression', 'NewExpression'].includes(parent?.type) && parent.callee === node && ['Object', 'Array'].includes(node.name))) fail(node, `Policy aliases intrinsic namespace: ${node.name}`)
  }
  for (const name of exports) if (!root.names.has(name)) throw new Error(`Missing policy export: ${name}`)
  return true
}
