import { readFileSync, appendFileSync } from 'node:fs'
const descriptor = /*DESCRIPTOR*/ null
function state() { return JSON.parse(readFileSync(descriptor, 'utf8')) }
function trace(operation, path) {
  const d = state()
  appendFileSync(d.trace, JSON.stringify({ pid: process.pid, ppid: process.ppid, module: import.meta.url, argv: process.argv, operation, path }) + '\n')
}
export function readHostSource(path) {
  const d = state(); trace('source', path)
  if (Object.hasOwn(d.sources, path)) return d.sources[path]
  if (d.absentPaths.includes(path)) return { status: 'absent' }
  if (path.startsWith(d.dir + '/')) {
    try { return { status: 'file', text: readFileSync(path, 'utf8') } }
    catch (e) { return { status: e.code === 'ENOENT' ? 'absent' : 'unknown' } }
  }
  const managed = ['/etc/codex/managed_config.toml', '/Library/Preferences/com.openai.codex.plist', '/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.d']
  if (managed.includes(path) || /^\/(?:private\/)?tmp\/(?:\.claude\/settings(?:\.local)?\.json|\.codex\/config\.toml)$/.test(path) || /^\/(?:private\/)?(?:\.claude\/settings(?:\.local)?\.json|\.codex\/config\.toml)$/.test(path)) return { status: 'absent' }
  throw new Error(`Unlisted host observation (no real filesystem fallback): ${path}`)
}
export function providerDefaults(vendor) {
  const d = state(); trace('defaults', vendor)
  return d.defaults
}
export function providerFacts(vendor) {
  const d = state(); trace('facts', vendor)
  return { version: 'synthetic-local-provider', unknown: [], defaults: d.defaults, immutable: vendor !== 'claude', hooks: vendor === 'claude' }
}
