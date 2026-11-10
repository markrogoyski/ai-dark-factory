// Builds each workflow in tools/sources.mjs (plugins/dark-factory/workflows/council.js, ...) from src/. No dependencies.
//   node tools/build.mjs           write them
//   node tools/build.mjs --check   fail if a committed file differs from its build
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from './sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function build(target) {
  return TARGETS[target].order.map(f => readFileSync(join(root, f), 'utf8').replace(/\n+$/, '\n')).join('\n') + (TARGETS[target].trailer || '')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let stale = 0
  for (const [name, { output }] of Object.entries(TARGETS)) {
    const out = join(root, output), text = build(name)
    if (process.argv.includes('--check')) {
      let have = ''
      try { have = readFileSync(out, 'utf8') } catch {}
      if (have !== text) { console.error(`build: ${output} is out of date with src/; run \`make build\``); stale++ }
    } else {
      writeFileSync(out, text)
      console.log(`built ${output} (${text.split('\n').length} lines)`)
    }
  }
  if (stale) process.exit(1)
  if (process.argv.includes('--check')) console.log('build: ok')
}
