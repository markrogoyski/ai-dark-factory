// Static checks on the workflow scripts, none of which the scenario runs would catch:
//   - each script parses the way the runtime loads it (an async function body, no imports)
//   - `meta` is a plain literal: sim.mjs rewrites `export const meta` to ordinary code and runs it,
//     so a computed value there would pass every test and fail when Claude Code scans the workflow
//   - src/lib stays pure: no runtime calls, and a function that reads the state object `S` takes it
//     as a parameter rather than reaching for the script's global one
//   node test/static.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { LIB } from '../tools/sources.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const PARAMS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow']

// The text of the object literal after `export const meta =`, by balanced braces outside strings.
export function metaLiteral(source) {
  const m = source.match(/^export const meta\s*=\s*/m)
  assert.ok(m, 'no `export const meta =` at the start of a line')
  const start = m.index + m[0].length
  assert.equal(source[start], '{', 'meta must be an object literal')
  let depth = 0, quote = null
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error('meta literal is not closed')
}

// Strings (without interpolation), numbers, true/false/null, keys, arrays and objects; nothing else.
export function assertPlainLiteral(text) {
  let rest = '', quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (quote === '`' && c === '$' && text[i + 1] === '{') throw new Error('meta has a template interpolation')
      else if (c === quote) { quote = null; rest += '""' }
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else rest += c
  }
  assert.ok(!/[()+*/=<>?!&|%~^]/.test(rest.replace(/-?\d+(\.\d+)?/g, '')), `meta has an expression: ${rest.replace(/\s+/g, ' ').slice(0, 200)}`)
  for (const [, word, after] of rest.matchAll(/(?<![\w"])([A-Za-z_$][\w$]*)\s*(:?)/g)) {
    assert.ok(after === ':' || ['true', 'false', 'null'].includes(word), `meta refers to \`${word}\`, which is not a literal`)
  }
}

let failed = 0
for (const file of readdirSync(join(root, 'plugins', 'dark-factory', 'workflows')).filter(f => f.endsWith('.js')).sort()) {
  const source = readFileSync(join(root, 'plugins', 'dark-factory', 'workflows', file), 'utf8')
  try {
    new AsyncFunction(...PARAMS, source.replace(/^export const meta\s*=/m, 'const meta ='))
    assertPlainLiteral(metaLiteral(source))
    const meta = new Function(`return ${metaLiteral(source)}`)()
    assert.equal(meta.name + '.js', file, 'meta.name matches the file name')
    assert.ok(meta.description && meta.whenToUse && Array.isArray(meta.phases) && meta.phases.every(p => p.title), 'meta has description, whenToUse and titled phases')
    console.log(`ok   ${file}: parses, meta is a plain literal`)
  } catch (e) {
    failed++
    console.log(`FAIL ${file}: ${e.message}`)
  }
}

// src/lib: top-level functions are found by their column-0 `function` line up to the column-0 `}`.
// A body that mentions `S` must have it as a parameter (a nested callback may not shadow it).
for (const file of LIB) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  const bad = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async )?function (\w+)\(([^)]*)\)/)
    if (!m) continue
    let j = i
    while (j < lines.length && lines[j] !== '}' && !(j === i && lines[j].endsWith('}'))) j++
    const body = j === i ? lines[i].slice(lines[i].indexOf('{')) : lines.slice(i + 1, j).join('\n')
    const takesS = /^S\b/.test(m[2])
    if (!takesS && /\bS\.\w|\(S[,)]/.test(body.replace(/'[^'\n]*'/g, "''"))) bad.push(`${file}:${i + 1} ${m[1]} uses S without taking it`)
  }
  const runtime = lines.map((l, i) => [l, i + 1]).filter(([l]) => !/^\s*\/\//.test(l) && /(?<![\w.])(agent|parallel|pipeline|phase|log|budget|workflow)\(/.test(l))
  for (const [l, n] of runtime) bad.push(`${file}:${n} calls the runtime: ${l.trim().slice(0, 80)}`)
  if (bad.length) { failed++; console.log(`FAIL ${file}:\n  ${bad.join('\n  ')}`) } else console.log(`ok   ${file}: pure (state passed in, no runtime calls)`)
}

// The checker itself: it must reject what it is there to reject.
for (const [label, text, ok] of [
  ['strings and arrays', "{ a: 'x', b: [{ c: 1, d: true }], e: \"it's\" }", true],
  ['a call', "{ a: 'x'.repeat(3) }", false],
  ['a variable', '{ a: SOMETHING }', false],
  ['concatenation', "{ a: 'x' + 'y' }", false],
  ['interpolation', '{ a: `x${1}` }', false],
  ['a plain template', '{ a: `x` }', true],
]) {
  try { assertPlainLiteral(text); assert.ok(ok, `${label}: accepted`) } catch (e) {
    if (ok || /: accepted$/.test(e.message)) { failed++; console.log(`FAIL checker, ${label}: ${e.message}`) }
  }
}
process.exit(failed ? 1 : 0)
