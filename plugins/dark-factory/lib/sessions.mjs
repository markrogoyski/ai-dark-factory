// Where each vendor CLI keeps its own session logs, found by the IDs the helper records. Shared by
// the token accountant (usage.mjs) and the benchmark's contamination scan (tools/bench-scan.mjs).
//   codex       $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl (or archived_sessions/)
//   claude      $CLAUDE_CONFIG_DIR/projects/<escaped cwd>/<session>.jsonl, and <session>/ beside it
//               (subagents, large tool results); a native workflow's agents are under
//               <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl with agent-<id>.meta.json
//   openrouter  the same transcript under the seat's own configuration (spec.claudeConfigDir)
//   gemini      ~/.gemini/antigravity-cli/conversations/<conversation>.db (SQLite, binary steps)
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultHomes(env = process.env) {
  const home = env.HOME || homedir()
  return { codex: env.CODEX_HOME || join(home, '.codex'), claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    agy: join(home, '.gemini', 'antigravity-cli') }
}

export function walkDirs(root) {
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    out.push(dir)
    for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name))
  }
  walk(root)
  return out
}

// Codex rollouts by thread, from the file names only, in the date directories the run spans
// (both the UTC and the local date of each day, since Codex names them by local time).
export function rolloutIndex(codexHome, { startedAt, finishedAt } = {}) {
  const index = new Map()
  const add = (dir, name) => { if (name.startsWith('rollout-') && name.endsWith('.jsonl')) index.set(name, join(dir, name)) }
  const sessions = join(codexHome, 'sessions')
  const from = Date.parse(startedAt), to = Date.parse(finishedAt || startedAt)
  const days = Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from < 400 * 864e5
    ? Array.from({ length: Math.round((to - from) / 864e5) + 3 }, (_, i) => new Date(from + (i - 1) * 864e5))
    : null
  const dirs = days ? [...new Set(days.flatMap(d => [d, new Date(d.getTime() - d.getTimezoneOffset() * 6e4)]).map(d => {
    const iso = d.toISOString()
    return join(sessions, iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10))
  }))] : walkDirs(sessions)
  for (const dir of [...dirs, join(codexHome, 'archived_sessions')]) {
    try { for (const name of readdirSync(dir)) add(dir, name) } catch {}
  }
  return thread => [...index.entries()].filter(([name]) => name.endsWith(`-${thread}.jsonl`)).map(([, path]) => path)
}

// A Claude session's transcript and the files kept beside it (subagents, large tool results).
export function transcriptFiles(configDir, session) {
  const projects = join(configDir, 'projects'), out = []
  let dirs = []
  try { dirs = readdirSync(projects) } catch { return out }
  for (const dir of dirs) {
    const file = join(projects, dir, `${session}.jsonl`)
    if (existsSync(file)) out.push({ file, kind: 'transcript' })
    const side = join(projects, dir, session)
    if (existsSync(side) && statSync(side).isDirectory()) {
      for (const sub of walkDirs(side)) for (const name of readdirSync(sub)) {
        const path = join(sub, name)
        if (statSync(path).isFile()) out.push({ file: path, kind: name.endsWith('.jsonl') ? 'transcript' : 'text' })
      }
    }
  }
  return out
}

// Every native workflow transcript directory: projects/<p>/<session>/subagents/workflows/wf_<id>/,
// with the workflow's state file (<session>/workflows/wf_<id>.json, written when the run ends).
export function workflowDirs(configDir) {
  const projects = join(configDir, 'projects'), out = []
  const list = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] } }
  for (const project of list(projects)) {
    for (const session of list(join(projects, project))) {
      const base = join(projects, project, session, 'subagents', 'workflows')
      for (const wf of list(base).filter(name => name.startsWith('wf_'))) {
        out.push({ dir: join(base, wf), runId: wf, state: join(projects, project, session, 'workflows', `${wf}.json`) })
      }
    }
  }
  return out
}
