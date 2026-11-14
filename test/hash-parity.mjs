// Prompt-hash parity between the workflow (JS), bin/dark-factory (Python) and the Codex runner.
// The runner has no copy of its own: it imports promptHash from plugins/dark-factory/lib/policy.mjs,
// which is built from src/lib/util.js. The JS side here is the function lifted out of src/lib/util.js
// (what the workflows are built from); the policy side is the built module the runner imports.
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'lib', 'util.js'), 'utf8')
const start = source.indexOf('function fnv(')
const endMarker = 'function promptHash(text) {'
const end = source.indexOf('\n', source.indexOf(endMarker))
if (start < 0 || end < 0) { console.error('FAIL: fnv/normalize/promptHash not found in src/lib/util.js'); process.exit(1) }
const promptHash = new Function(`${source.slice(start, end)}\nreturn promptHash`)()

const runnerSource = readFileSync(join(root, 'plugins', 'dark-factory', 'lib', 'codex-runner.mjs'), 'utf8')
if (!/import \{[^}]*\bpromptHash\b[^}]*\} from '\.\/policy\.mjs'/.test(runnerSource) || /function promptHash\(/.test(runnerSource)) {
  console.error('FAIL: codex-runner.mjs must import promptHash from ./policy.mjs and keep no copy of its own'); process.exit(1)
}
const { promptHash: runnerPromptHash } = await import(pathToFileURL(join(root, 'plugins', 'dark-factory', 'lib', 'policy.mjs')).href)

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
  const runner = runnerPromptHash(c)
  const ok = py === js && py === runner
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} case ${i}: js=${js} py=${py} runner=${runner}`)
}
process.exit(bad ? 1 : 0)
