// Raw host observations only. Configuration interpretation and decisions live in the adapter/policy.
import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

export function readHostSource(path) {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return { status: 'unknown', error: 'settings source symlink' }
    if (stat.isDirectory()) return { status: 'directory', entries: readdirSync(path).sort() }
    return { status: 'file', mode: stat.mode & 0o111, text: readFileSync(path, 'utf8') }
  }
  catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unknown', error: error.code } }
}

// These conservative grants exist independently of executable/version observations.
export function providerDefaults() {
  return [...new Set(['/tmp', tmpdir()])]
}

export function providerFacts(vendor) {
  const exe = { codex: 'codex', claude: 'claude', gemini: 'agy' }[vendor]
  let version = ''
  try { version = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { return { unknown: ['provider version unavailable'], defaults: providerDefaults() } }
  // Only these local configuration families are understood. Opaque/remote policy refuses below.
  const supported = vendor === 'claude' ? /^2\.\d+\.\d+.*Claude Code/.test(version)
    : vendor === 'codex' ? /^codex(?:-cli)? 0\.\d+\.\d+/.test(version) : false
  const hookVersion = /^2\.1\.(\d+)/.exec(version)
  const hooks = vendor === 'claude' && supported && !!hookVersion && Number(hookVersion[1]) >= 49
  const unknown = supported ? [] : ['unsupported provider configuration version']
  if (vendor === 'claude' && !hooks) unknown.push('ConfigChange enforcement unavailable in provider version')
  // Local version/configuration files do not establish server/MDM delivery absence.
  // Do not infer that an invocation-local hook can block mandatory remote policy.
  return { version, unknown, deliveryKnown: vendor !== 'claude',
    defaults: providerDefaults(), immutable: vendor === 'codex', hooks }
}
