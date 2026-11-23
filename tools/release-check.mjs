// Checks that the plugin's version can ship. Claude Code updates an installed plugin only when its
// version changes, so shipped files that changed since the last release need a new version, and that
// version needs a tag of its own. Run it before tagging; it is not part of `make check`.
//   node tools/release-check.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SHIPPED = 'plugins/dark-factory'

export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text))
  return m ? m.slice(1).map(Number) : null
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// version: plugin.json's. tags: the repository's tag names. changedSince(tag): whether a shipped
// file differs between that tag and HEAD. marketplaceVersion: the marketplace entry's, if set.
// dirty: shipped files with uncommitted changes. Returns {ok, message}.
export function releaseVerdict({ version, tags, changedSince, marketplaceVersion, dirty }) {
  const own = parseVersion(version)
  if (!own) return { ok: false, message: `plugin.json version "${version}" is not MAJOR.MINOR.PATCH` }
  if (marketplaceVersion !== undefined) return { ok: false, message: 'the marketplace entry sets a version; keep it only in plugin.json, which wins' }
  if (dirty) return { ok: false, message: `uncommitted changes under ${SHIPPED}/; commit them first` }
  const released = tags.filter(t => /^v\d+\.\d+\.\d+$/.test(t)).sort((a, b) => compare(parseVersion(b), parseVersion(a)))
  const tag = `v${version}`
  if (released.includes(tag)) {
    return changedSince(tag)
      ? { ok: false, message: `${SHIPPED}/ changed since ${tag}, but plugin.json still says ${version}: users would not get the change. Bump the version.` }
      : { ok: true, message: `${tag} is released and nothing shipped has changed since` }
  }
  const latest = released[0]
  if (latest && compare(own, parseVersion(latest)) <= 0) return { ok: false, message: `plugin.json version ${version} is not above the latest release ${latest}` }
  return { ok: true, message: `ready to release ${tag}${latest ? ` (after ${latest})` : ''}: tag HEAD with \`git tag ${tag}\` and push the commit and the tag` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
  const version = JSON.parse(readFileSync(join(root, SHIPPED, '.claude-plugin/plugin.json'), 'utf8')).version
  const entry = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8')).plugins.find(p => p.name === 'dark-factory')
  const verdict = releaseVerdict({
    version,
    tags: git('tag', '--list').split('\n').filter(Boolean),
    changedSince: tag => git('diff', '--name-only', tag, 'HEAD', '--', SHIPPED).trim() !== '',
    marketplaceVersion: entry?.version,
    dirty: git('status', '--porcelain', '--', SHIPPED).trim() !== '',
  })
  console.log(`release-check: ${verdict.message}`)
  process.exit(verdict.ok ? 0 : 1)
}
