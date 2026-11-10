import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const api = () => import(pathToFileURL(join(root, 'plugins/dark-factory/lib/engine.mjs')))
export const subjectEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => !['DARK_FACTORY_PIN', 'DARK_FACTORY_INVOCATION', 'DARK_FACTORY_SEAT_SPEC'].includes(k)))
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function init(repo) {
  mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
}
export function commit(repo) { git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'Record fixture'); return git(repo, 'rev-parse', 'HEAD') }
export function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pin-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'), target = join(dir, 'target'), output = join(dir, 'export')
  init(source); init(target)
  const plugin = join(source, 'plugins/dark-factory')
  cpSync(join(root, 'plugins/dark-factory'), plugin, { recursive: true })
  writeFileSync(join(target, 'value'), 'base\n'); commit(target); commit(source)
  return { dir, source, target, output, plugin }
}
export function jsonResult(r) {
  try { return JSON.parse(r.stdout) } catch { throw new Error(`Invalid JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`) }
}
export function cli(f, args, env = {}) {
  return spawnSync(process.execPath, [join(f.plugin, 'bin/dark-factory-codex'), '--cwd', f.target, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...subjectEnv(process.env), ...env }
  })
}
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
