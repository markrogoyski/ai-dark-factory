// Checks that Claude Code loads every dark-factory workflow. It skips one it cannot load (one over
// its size limit, for example) with only a warning, so a workflow can vanish from the list unnoticed.
// One headless Haiku turn asks the Workflow tool for a workflow that does not exist; the error lists
// the workflows the session loaded. Part of `make installed`, which needs the `claude` CLI.
//   node tools/loader-check.mjs
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from './sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MISSING = 'dark-factory:does-not-exist'
export const EXPECTED = Object.entries(TARGETS).filter(([name]) => name !== 'policy')
  .map(([, { output }]) => `dark-factory:${basename(output, '.js')}`).sort()

// stream: the CLI's stream-json output. Returns {ok, message}.
export function loaderVerdict(stream, expected = EXPECTED) {
  let listed = null
  for (const line of stream.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    for (const part of event?.type === 'user' && Array.isArray(event.message?.content) ? event.message.content : []) {
      const text = part?.type === 'tool_result' ? [part.content].flat().map(c => typeof c === 'string' ? c : c?.text || '').join('') : ''
      const m = /not found\. Available: ([^<\n]*)/.exec(text)
      if (m) listed = m[1].split(',').map(s => s.trim()).filter(Boolean)
    }
  }
  if (!listed) return { ok: false, message: `no Workflow error listing the loaded workflows; the turn may not have called the tool, or Claude Code changed the message` }
  const missing = expected.filter(name => !listed.includes(name))
  return missing.length
    ? { ok: false, message: `Claude Code did not load ${missing.join(', ')} (it loaded ${listed.join(', ') || 'none'}); run \`claude --debug\` and look for "Plugin workflow" warnings` }
    : { ok: true, message: `Claude Code loads all ${expected.length} workflows` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = spawnSync('claude', ['-p', '--model', 'haiku', '--allowedTools', 'Workflow', '--output-format', 'stream-json', '--verbose',
    `Call the Workflow tool once with name "${MISSING}" and no other arguments. Do not call any other tool. Then reply "done".`],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
  const verdict = r.error ? { ok: false, message: `could not run claude: ${r.error.message}` } : loaderVerdict(r.stdout || '')
  console.log(`loader: ${verdict.message}`)
  process.exit(verdict.ok ? 0 : 1)
}
