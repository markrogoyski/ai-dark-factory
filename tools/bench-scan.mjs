// Contamination check for a benchmark run: did any agent touch the places that hold the answer
// (the task's source repository, the bench records, the fix commit)? It reads only what records
// what the run's agents did on the standalone runner, attributed to the run, never all of ~/.codex
// or ~/.claude. docs/evaluation.md#contamination-check describes what counts. Development only.
//
// Where each kind of turn records its tool calls and outputs (dark_factory_cli/providers.py):
//   every turn            <runDir>/jobs/<key>/  spec.json names its vendor (kind) and cwd; status.json
//                         and out.json hold its output and thread; prompt.md, schema.json and
//                         <key>.host.prompt.md are what the harness sent
//   codex                 jobs/<key>/events.jsonl (`codex exec --json`: every command, its output and
//                         file change) and the session rollout $CODEX_HOME/sessions/YYYY/MM/DD/
//                         rollout-<time>-<thread>.jsonl, found by the thread in thread.started
//   claude                out.json is only the final envelope; the transcript is
//                         $CLAUDE_CONFIG_DIR/projects/<escaped cwd>/<session>.jsonl, by the session ID
//   openrouter            the same transcript under the seat's own config (spec.claudeConfigDir)
//   gemini (agy)          ~/.gemini/antigravity-cli/conversations/<conversation>.db, SQLite with binary steps
//   host                  <hostRunDir>/events.jsonl, result.json, checkpoint.json; its turns name every runDir
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { defaultHomes, rolloutIndex, transcriptFiles } from '../plugins/dark-factory/lib/sessions.mjs'

export { defaultHomes }

export const CONTAMINATION_CAP = 20
const VENDORS = ['codex', 'claude', 'openrouter', 'gemini']
// The job files the harness wrote, not the agent: what it was asked, never what it did.
const HARNESS_JOB_FILES = new Set(['prompt.md', 'schema.json', 'spec.json', 'pid', 'runner.err', 'codex.pid', 'claude.pid', 'agy.pid'])
// Fields of a result the harness copied from its own arguments.
const HARNESS_RESULT_FIELDS = ['/task', '/provenance', '/summary/provenance', '/args', '/plan', '/refs']
const AGY_USER_INPUT = 14   // steps.step_type of the prompt in an agy conversation

function tilde(path) {
  const h = homedir()
  return path === h || path.startsWith(h + '/') ? '~' + path.slice(h.length) : null
}

// A path in each spelling an agent might use: as given, with ~, and resolved through links.
function spellings(path) {
  if (!path) return []
  const out = new Set([path])
  try { out.add(realpathSync(path)) } catch {}
  for (const p of [...out]) { const t = tilde(p); if (t) out.add(t) }
  return [...out].filter(p => p.length > 1)
}

export function contaminationNeedles({ source, records, fixCommit, allowed = [] }) {
  return { paths: [...spellings(source).map(text => ({ text, match: 'source repository' })), ...spellings(records).map(text => ({ text, match: 'bench records' }))],
    fixCommit: String(fixCommit || '').toLowerCase(), allowed: allowed.flatMap(spellings) }
}

const PATH_CHAR = /[A-Za-z0-9._~\/-]/
const NAME_CHAR = /[A-Za-z0-9_-]/
// A path ends where the next character can't continue its last name; a final '.' ends a sentence.
function endsAt(text, i) {
  const c = text[i]
  if (c === undefined || !NAME_CHAR.test(c) && c !== '.') return true
  return c === '.' && (text[i + 1] === undefined || !NAME_CHAR.test(text[i + 1]) && text[i + 1] !== '.')
}

function occurrences(text, needle) {
  const out = []
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if ((i === 0 || !PATH_CHAR.test(text[i - 1])) && endsAt(text, i + needle.length)) out.push([i, i + needle.length])
  }
  return out
}

// Every needle in one string, except inside a path that is allowed (the run's own clone).
export function findHits(text, needles) {
  if (typeof text !== 'string' || text.length < 7) return []
  const allowed = needles.allowed.flatMap(p => occurrences(text, p))
  const hits = []
  const add = (start, end, match) => { if (!allowed.some(([a, b]) => a <= start && end <= b)) hits.push({ start, end, match }) }
  for (const { text: path, match } of needles.paths) for (const [start, end] of occurrences(text, path)) add(start, end, match)
  if (needles.fixCommit.length === 40) {
    for (const m of text.matchAll(/(?<![0-9A-Za-z_])[0-9a-fA-F]{7,40}(?![0-9A-Za-z_])/g)) {
      if (needles.fixCommit.startsWith(m[0].toLowerCase())) add(m.index, m.index + m[0].length, 'fix commit')
    }
  }
  return hits
}

function excerpt(text, { start, end }) {
  const from = Math.max(0, start - 60), to = Math.min(text.length, end + 60)
  return ((from ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')).replace(/\s+/g, ' ').trim().slice(0, 240)
}

const pointerPart = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1')

// Every string in a JSON value, keys included, with its JSON pointer; `skip` prunes pointers.
function* strings(value, pointer = '', skip = () => false) {
  if (skip(pointer)) return
  if (typeof value === 'string') yield [pointer, value]
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${pointer}/${i}`, skip)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'encrypted_content') continue
      yield [`${pointer}/${pointerPart(key)}`, key]
      yield* strings(item, `${pointer}/${pointerPart(key)}`, skip)
    }
  }
}

// What of a Codex rollout record the agent produced: tool calls, their output, its own messages.
// The session header, turn context and user or developer messages are the harness's prompt.
export function rolloutParts(record) {
  const p = record?.payload
  if (['session_meta', 'turn_context'].includes(record?.type)) return []
  if (record?.type === 'response_item' && p?.type === 'message' && p.role !== 'assistant') return []
  if (record?.type === 'event_msg' && p?.type === 'user_message') return []
  return [['', record]]
}

// What of a Claude transcript record the agent produced: assistant turns (tool calls, text) and
// tool results. The prompt (a user message as text), queued prompts, request copies, hook
// attachments and system records come from the harness or the environment.
export function transcriptParts(record) {
  if (record?.type === 'assistant') return [['/message/content', record.message?.content]]
  if (record?.type !== 'user' || !Array.isArray(record.message?.content)) return []
  const parts = record.message.content.map((part, i) => part?.type === 'tool_result' ? [`/message/content/${i}`, part] : null).filter(Boolean)
  if (record.toolUseResult !== undefined) parts.push(['/toolUseResult', record.toolUseResult])
  return parts
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readLines(path) {
  return readFileSync(path, 'utf8').split('\n')
}

// Scan state: the files read, the evidence that could not be read or attributed, and the hits.
function scanner(needles) {
  const files = new Set(), missing = [], hits = []
  const record = (file, at, text) => { for (const hit of findHits(text, needles)) hits.push({ file, at, match: hit.match, excerpt: excerpt(text, hit) }) }
  const json = (file, { skip } = {}) => {
    let value
    try { value = JSON.parse(readFileSync(file, 'utf8')) } catch {
      if (!existsSync(file)) return null
      files.add(file)
      return text(file)
    }
    files.add(file)
    for (const [pointer, s] of strings(value, '', skip)) record(file, pointer || '/', s)
    return value
  }
  const text = file => {
    files.add(file)
    readLines(file).forEach((line, i) => record(file, `line ${i + 1}`, line))
  }
  const jsonl = (file, parts = r => [['', r]]) => {
    files.add(file)
    const values = []
    readLines(file).forEach((line, i) => {
      if (!line.trim()) return
      let r
      try { r = JSON.parse(line) } catch { record(file, `line ${i + 1}`, line); return }
      values.push(r)
      for (const [base, value] of parts(r)) for (const [pointer, s] of strings(value, base)) record(file, `line ${i + 1} ${pointer || '/'}`, s)
    })
    return values
  }
  return { files, missing, hits, json, text, jsonl, record }
}

async function agySteps(file, s) {
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch { s.missing.push(`${file}: this Node has no node:sqlite to read an agy conversation`); return }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    s.files.add(file)
    for (const row of db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all()) {
      if (row.step_type === AGY_USER_INPUT || !row.step_payload) continue
      const bytes = Buffer.from(row.step_payload)
      s.record(file, `steps idx ${row.idx}`, bytes.toString('latin1').replace(/[^\x20-\x7e\n]+/g, ' '))
    }
  } catch (error) { s.missing.push(`${file}: ${error.message}`) } finally { try { db?.close() } catch {} }
}

// Scans one run. `homes` are the CLI homes the run used (its run record has them), `allowed` the
// run's own clone and the pristine clone. Returns {status, hits, contamination, files, missing, sources}.
export async function scanRun({ hostRunDir, runDirs = [], source, records, fixCommit, allowed = [], homes = defaultHomes(), startedAt = null, finishedAt = null }) {
  const needles = contaminationNeedles({ source, records, fixCommit, allowed })
  const s = scanner(needles)
  const sources = { jobs: 0, codexRollouts: 0, claudeTranscripts: 0, agyConversations: 0 }
  const dirs = new Set(runDirs.filter(Boolean))
  if (!hostRunDir || !existsSync(hostRunDir)) s.missing.push(`the host run directory ${hostRunDir || '(none recorded)'} is not on disk`)
  else {
    dirs.add(hostRunDir)
    const events = join(hostRunDir, 'events.jsonl')
    if (!existsSync(events)) s.missing.push(`${events}: the host's events, which name the run directories, are missing`)
    else for (const e of s.jsonl(events)) {
      if (e.type === 'run.started') startedAt ||= e.at
      if (e.type === 'run.completed') finishedAt = e.at
      if (e.runDir) dirs.add(e.runDir)
    }
    const result = s.json(join(hostRunDir, 'result.json'), { skip: p => HARNESS_RESULT_FIELDS.includes(p) })
    if (result?.runDir) dirs.add(result.runDir)
    const checkpoint = join(hostRunDir, 'checkpoint.json')
    const saved = readJsonOrNull(checkpoint)
    if (saved?.entries) { s.files.add(checkpoint); for (const [p, v] of strings(saved.entries, '/entries')) s.record(checkpoint, p, v) }
  }
  const codexThreads = new Map(), claudeSessions = new Map(), agyConversations = new Map()
  const note = (map, id, job) => { if (id) map.set(id, [...(map.get(id) || []), job]) }
  for (const dir of dirs) {
    const jobs = join(dir, 'jobs')
    if (!existsSync(dir)) { s.missing.push(`the run directory ${dir} is not on disk`); continue }
    let entries = []
    try { entries = readdirSync(jobs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.filter(e => e.isDirectory())) {
      const jd = join(jobs, entry.name), spec = readJsonOrNull(join(jd, 'spec.json'))
      if (!spec) { s.missing.push(`${jd}: no spec.json, so its vendor is unknown`); continue }
      if (!VENDORS.includes(spec.kind)) continue   // helper work (measurements), not a model turn
      sources.jobs++
      let thread = null
      for (const name of readdirSync(jd).sort()) {
        const file = join(jd, name)
        if (HARNESS_JOB_FILES.has(name) || !statSync(file).isFile()) continue
        if (name === 'events.jsonl') { for (const e of s.jsonl(file)) if (e.type === 'thread.started') thread ||= e.thread_id }
        else if (name.endsWith('.json')) {
          const value = s.json(file)
          if (name === 'status.json') thread ||= value?.thread
          if (name === 'out.json') thread ||= value?.session_id || value?.conversation_id
        } else s.text(file)
      }
      thread ||= spec.resumeSession || null
      if (!thread) {
        const file = { codex: 'thread', claude: 'claude-session', openrouter: 'claude-session', gemini: 'conversation' }[spec.kind]
        try { thread = readFileSync(join(dir, 'seats', spec.seat, file), 'utf8').trim() || null } catch {}
      }
      const job = `${basename(dir)}/jobs/${entry.name}`
      if (!thread) { s.missing.push(`${job}: no ${spec.kind} thread or session ID, so its transcript can't be found`); continue }
      if (spec.kind === 'codex') note(codexThreads, thread, job)
      else if (spec.kind === 'gemini') note(agyConversations, thread, job)
      else note(claudeSessions, `${spec.kind === 'openrouter' && spec.claudeConfigDir ? spec.claudeConfigDir : homes.claude}\0${thread}`, job)
    }
  }
  if (codexThreads.size) {
    const rollouts = rolloutIndex(homes.codex, { startedAt, finishedAt })
    for (const [thread, jobs] of codexThreads) {
      const found = rollouts(thread)
      if (!found.length) s.missing.push(`no Codex rollout for thread ${thread} (${jobs.join(', ')}) under ${join(homes.codex, 'sessions')}`)
      for (const file of found) { sources.codexRollouts++; s.jsonl(file, rolloutParts) }
    }
  }
  for (const [key, jobs] of claudeSessions) {
    const [configDir, session] = key.split('\0')
    const found = transcriptFiles(configDir, session)
    if (!found.some(f => f.kind === 'transcript' && basename(f.file) === `${session}.jsonl`)) s.missing.push(`no Claude transcript for session ${session} (${jobs.join(', ')}) under ${join(configDir, 'projects')}`)
    for (const { file, kind } of found) {
      if (kind === 'transcript') { if (basename(file) === `${session}.jsonl`) sources.claudeTranscripts++; s.jsonl(file, transcriptParts) }
      else s.text(file)
    }
  }
  for (const [conversation, jobs] of agyConversations) {
    const file = join(homes.agy, 'conversations', `${conversation}.db`)
    if (!existsSync(file)) { s.missing.push(`no agy conversation ${conversation} (${jobs.join(', ')}) at ${file}`); continue }
    sources.agyConversations++
    await agySteps(file, s)
    // Its steps are protocol buffers whose tool outputs may be compressed: only their readable text
    // is searched, so an agy turn never counts as fully read.
    s.missing.push(`${file}: agy steps are binary records; only their readable text was searched`)
  }
  const status = s.hits.length ? 'contaminated' : s.missing.length ? 'partial' : 'clean'
  return { status, hits: s.hits.length, contamination: s.hits.slice(0, CONTAMINATION_CAP).map(({ file, at, match, excerpt }) => ({ file, at, match, excerpt })),
    files: s.files.size, missing: s.missing, sources }
}
