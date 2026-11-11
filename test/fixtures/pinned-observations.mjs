import { readFileSync, appendFileSync, lstatSync, readdirSync } from 'node:fs'
const descriptor = /*DESCRIPTOR*/ null
function state() { return JSON.parse(readFileSync(descriptor, 'utf8')) }
function trace(operation, path) {
  const d = state()
  appendFileSync(d.trace, JSON.stringify({ pid: process.pid, ppid: process.ppid, module: import.meta.url, argv: process.argv, operation, path }) + '\n')
}
export function readHostSource(path) {
  const d = state(); trace('source', path)
  if (Object.hasOwn(d.sources, path)) return d.sources[path]
  if (d.absentPaths.includes(path) || d.absentPaths.some(p => p.endsWith('/.codex/config.toml') && ['rules', 'hooks.json', 'plugins'].some(name => path === p.slice(0, -11) + name))) return { status: 'absent' }
  if (path.startsWith(d.dir + '/')) {
    try { const stat = lstatSync(path); if (stat.isSymbolicLink()) return { status: 'unknown' }; if (stat.isDirectory()) return { status: 'directory', entries: readdirSync(path).sort() }; return { status: 'file', mode: stat.mode & 0o111, text: readFileSync(path, 'utf8') } }
    catch (e) { return { status: e.code === 'ENOENT' ? 'absent' : 'unknown' } }
  }
  const managed = ['/.codex/rules', '/.codex/hooks.json', '/.codex/plugins', '/private/.codex/rules', '/private/.codex/hooks.json', '/private/.codex/plugins','/Library/Managed Preferences/com.anthropic.claudecode.plist', '/etc/codex/config.toml', '/etc/codex/requirements.toml','/etc/codex/managed_config.toml', '/Library/Preferences/com.openai.codex.plist', '/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d', '/Library/Application Support/ClaudeCode/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.d']
  if (managed.includes(path) || /^\/(?:private\/)?tmp\/(?:\.claude\/settings(?:\.local)?\.json|\.codex\/config\.toml)$/.test(path) || /^\/(?:private\/)?(?:\.claude\/settings(?:\.local)?\.json|\.codex\/config\.toml)$/.test(path)) return { status: 'absent' }
  throw new Error(`Unlisted host observation (no real filesystem fallback): ${path}`)
}
export function providerDefaults(vendor) {
  const d = state(); trace('defaults', vendor)
  return d.defaults
}
export function providerFacts(vendor) {
  const d = state(); trace('facts', vendor)
  return { version: 'synthetic-local-provider', deliveryKnown: true, catalogsBounded: true, unknown: [], defaults: d.defaults, immutable: vendor !== 'claude', hooks: vendor === 'claude', ...(d.facts?.[vendor] || {}) }
}
