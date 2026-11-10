// Raw host observations only. Configuration interpretation and decisions live in the adapter/policy.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

export function readHostSource(path) {
  try { return { status: 'file', text: readFileSync(path, 'utf8') } }
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
  return { version, unknown: supported ? [] : ['unsupported provider configuration version'],
    defaults: providerDefaults(), immutable: vendor === 'codex', hooks: vendor === 'claude' }
}
