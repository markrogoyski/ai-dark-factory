// Builds each workflow in tools/sources.mjs (plugins/dark-factory/workflows/council.js, ...) from src/.
//   node tools/build.mjs           write them
//   node tools/build.mjs --check   fail if a committed file differs from its build
//   node tools/build.mjs --candidates   build each unshipped candidate in memory and report its size
// Claude Code skips a plugin workflow over 512 KiB, so each workflow drops the top-level declarations
// it never reaches (tools/prune.mjs) and is minified with esbuild (a development dependency:
// `npm ci`). The meta file stays as written, since the runtime reads `export const meta` from the
// top; the rest is minified and its strings, prompts included, are kept. policy.mjs is neither
// pruned nor minified. Read src/, not a built workflow.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPolicy } from './policy-static.mjs'
import { prune } from './prune.mjs'
import { CANDIDATES, POLICY_EXPORTS, TARGETS } from './sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Claude Code skips a plugin workflow over 524288 bytes. The margin is warning room: a build that
// crosses it still loads, but the next feature may not.
export const WORKFLOW_LIMIT = 524288
export const WORKFLOW_BUDGET = 480000

function esbuild() {
  try { return createRequire(join(root, 'package.json'))('esbuild') }
  catch { throw new Error('build: esbuild is not installed; run `npm ci` in the repository root') }
}

const readSource = f => readFileSync(join(root, f), 'utf8')
const trimmed = text => text.replace(/\n+$/, '\n')

// A workflow body returns and awaits at the top level, which no esbuild format accepts in one file,
// so it is minified as the body of a function and the wrapper is taken off again.
function minify(body) {
  const open = 'async function __workflow(){', close = '}'
  const code = esbuild().transformSync(`${open}\n${body}\n${close}`, {
    minifyWhitespace: true, minifyIdentifiers: true, charset: 'utf8', legalComments: 'none', target: 'esnext', lineLimit: 120,
  }).code.trimEnd()
  if (!code.startsWith(open) || !code.endsWith(close)) throw new Error('build: esbuild changed the workflow wrapper')
  return code.slice(open.length, -close.length).replace(/^\n/, '') + '\n'
}

// target: a TARGETS or candidates key. read(file) supplies each source's text, from src/ by default;
// candidates, the unshipped builds, defaults to CANDIDATES (tests pass their own).
function sourcesOf(target, { read = readSource, candidates = CANDIDATES } = {}) {
  const spec = Object.hasOwn(TARGETS, target) ? TARGETS[target] : Object.hasOwn(candidates, target) ? candidates[target] : null
  if (!spec) throw new Error(`build: unknown target ${target}`)
  return { spec, sources: spec.order.map(file => ({ file, text: read(file) })) }
}

// A workflow's meta source as written, and the rest of its sources concatenated and pruned: the
// body build() minifies.
export function prunedBody(target, options = {}) {
  const [first, ...rest] = sourcesOf(target, options).sources.map(s => trimmed(s.text))
  return { meta: first, code: prune(rest.join('\n')).code }
}

export function build(target, options = {}) {
  if (target === 'policy') {
    const { spec, sources } = sourcesOf(target, options)
    assertPolicy(sources, POLICY_EXPORTS, spec.trailer)
    return sources.map(s => trimmed(s.text)).join('\n') + (spec.trailer || '')
  }
  const { meta, code } = prunedBody(target, options)
  return meta + minify(code)
}

// The unshipped candidates, built in memory: a line per candidate, its size on stdout or its
// overrun on stderr, then exit 1 if any is over the budget, else 0. Nothing is written.
export function reportCandidates({ budget = WORKFLOW_BUDGET, candidates = CANDIDATES } = {}) {
  let failures = 0
  for (const name of Object.keys(candidates)) {
    const size = Buffer.byteLength(build(name, { candidates }))
    if (size > budget) { console.error(`build: candidate ${name} is ${size} bytes, over the ${budget}-byte budget`); failures++ }
    else console.log(`built ${name} (${size} bytes, ${budget - size} under the ${budget}-byte budget)`)
  }
  process.exit(failures ? 1 : 0)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stale = 0
  try {
    if (process.argv.includes('--candidates')) reportCandidates()
    for (const [name, { output }] of Object.entries(TARGETS)) {
      const out = join(root, output), text = build(name), size = Buffer.byteLength(text)
      if (name !== 'policy' && size > WORKFLOW_BUDGET) {
        console.error(`build: ${output} is ${size} bytes, over the ${WORKFLOW_BUDGET}-byte budget; Claude Code skips a plugin workflow over ${WORKFLOW_LIMIT}`)
        stale++
      }
      if (process.argv.includes('--check')) {
        let have = ''
        try { have = readFileSync(out, 'utf8') } catch {}
        if (have !== text) { console.error(`build: ${output} is out of date with src/; run \`make build\``); stale++ }
      } else {
        writeFileSync(out, text)
        console.log(`built ${output} (${size} bytes${name === 'policy' ? '' : `, ${WORKFLOW_BUDGET - size} under the ${WORKFLOW_BUDGET}-byte budget`})`)
      }
    }
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  if (stale) process.exit(1)
  if (process.argv.includes('--check')) console.log('build: ok')
}
