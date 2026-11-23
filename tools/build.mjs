// Builds each workflow in tools/sources.mjs (plugins/dark-factory/workflows/council.js, ...) from src/.
//   node tools/build.mjs           write them
//   node tools/build.mjs --check   fail if a committed file differs from its build
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
import { POLICY_EXPORTS, TARGETS } from './sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Claude Code skips a plugin workflow over 524288 bytes. The margin is warning room: a build that
// crosses it still loads, but the next feature may not.
export const WORKFLOW_LIMIT = 524288
export const WORKFLOW_BUDGET = 480000

function esbuild() {
  try { return createRequire(join(root, 'package.json'))('esbuild') }
  catch { throw new Error('build: esbuild is not installed; run `npm ci` in the repository root') }
}

const read = f => readFileSync(join(root, f), 'utf8').replace(/\n+$/, '\n')

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

export function build(target) {
  if (target === 'policy') assertPolicy(TARGETS.policy.order.map(file => ({ file, text: readFileSync(join(root, file), 'utf8') })), POLICY_EXPORTS, TARGETS.policy.trailer)
  const [first, ...rest] = TARGETS[target].order
  if (target === 'policy') return [first, ...rest].map(read).join('\n') + (TARGETS[target].trailer || '')
  return read(first) + minify(prune(rest.map(read).join('\n')).code)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stale = 0
  try {
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
