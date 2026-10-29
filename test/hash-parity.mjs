// Prompt-hash parity between the workflow (JS) and bin/dark-factory (Python). The JS side is the function
// as it appears in src/lib/util.js, which is what workflows/council.js is built from, lifted out of
// the source, not a copy kept here.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'lib', 'util.js'), 'utf8')
const start = source.indexOf('function fnv(')
const endMarker = 'function promptHash(text) {'
const end = source.indexOf('\n', source.indexOf(endMarker))
if (start < 0 || end < 0) { console.error('FAIL: fnv/normalize/promptHash not found in src/lib/util.js'); process.exit(1) }
const promptHash = new Function(`${source.slice(start, end)}\nreturn promptHash`)()

const dir = mkdtempSync(join(tmpdir(), 'council-hash-'))
const cases = [
  'plain ascii',
  'trailing spaces and newlines   \n\n\t\n',
  'CRLF\r\nline two\r\n',
  'unicode — → … − “quotes” 中文 emoji 🎲 surrogate pair',
  '<<<OUTPUT_SCHEMA\n{"type":"object"}\nOUTPUT_SCHEMA>>>\n',
  'x'.repeat(50000) + ' tail',
]
let bad = 0
for (const [i, c] of cases.entries()) {
  const f = join(dir, `c${i}.txt`)
  writeFileSync(f, c, 'utf8')
  const py = JSON.parse(execFileSync(join(root, 'plugins', 'dark-factory', 'bin', 'dark-factory'), ['hash', '--file', f]).toString().trim().split('\n').pop()).hash
  const js = promptHash(c)
  const ok = py === js
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} case ${i}: js=${js} py=${py}`)
}
process.exit(bad ? 1 : 0)
