// Token accounting for a run: every model turn, per role and per model, in one shape whatever the
// vendor. No models, network or prices. docs/results.md#token-use describes the fields.
//
// Where each turn's usage comes from:
//   helper-usage       <runDir>/usage.jsonl, one record per vendor CLI turn (dark_factory_cli
//                      record_usage): Codex turn.completed, the claude CLI's result envelope (also
//                      OpenRouter seats), agy's answer. A record with `missing` (or an empty usage)
//                      had no usage from its CLI: a timeout, a lost envelope.
//   codex-rollout      such a Codex turn, read back from its rollout's token_count totals for the
//                      turn's window ($CODEX_HOME/sessions, by thread)
//   claude-transcript  such a claude or OpenRouter turn, read back from its session transcript
//                      ($CLAUDE_CONFIG_DIR/projects/*/<session>.jsonl) for the turn's window
//   native-transcript  a native workflow's own agent() turns (Claude Code), from the workflow's
//                      transcript directory (subagents/workflows/wf_<id>/agent-*.jsonl), found by
//                      an agent that names one of the run's directories; every agent of that
//                      workflow counts, intake included
// A turn none of these covers is listed in `missing`, and the total is marked partial
// (complete: false): a missing turn is never counted as zero.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultHomes, rolloutIndex, transcriptFiles, workflowDirs } from './sessions.mjs'

export const USAGE_FIELDS = ['input', 'cachedInput', 'cacheCreation', 'output']
const count = v => Number.isFinite(v) && v >= 0 ? v : 0

export function vendorOfModel(model) {
  const m = String(model || '')
  return /^(gpt-|o\d|codex)/i.test(m) ? 'codex' : /^gemini/i.test(m) ? 'gemini' : /^openrouter:|\//.test(m) ? 'openrouter' : 'claude'
}

// One shape for every vendor: input is every prompt token the model read (uncached, cache reads
// and cache writes together), cachedInput the cache reads, cacheCreation the cache writes, and
// output includes reasoning. Codex counts cached tokens inside input_tokens; Claude and agy count
// them beside it.
export function normalizeUsage(raw, vendor = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const n = key => count(raw[key]), has = key => Object.hasOwn(raw, key)
  if (USAGE_FIELDS.some(has)) return Object.fromEntries(USAGE_FIELDS.map(key => [key, n(key)]))
  if (has('cached_input_tokens') || has('reasoning_output_tokens') || has('cache_write_input_tokens') || (vendor === 'codex' && !has('cache_read_input_tokens')))
    return { input: n('input_tokens'), cachedInput: n('cached_input_tokens'), cacheCreation: n('cache_write_input_tokens'), output: n('output_tokens') }
  if (has('cache_read_tokens') || has('thinking_tokens') || (vendor === 'gemini' && !has('cache_read_input_tokens')))
    return { input: n('input_tokens') + n('cache_read_tokens'), cachedInput: n('cache_read_tokens'), cacheCreation: 0, output: n('output_tokens') }
  return { input: n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens'),
    cachedInput: n('cache_read_input_tokens'), cacheCreation: n('cache_creation_input_tokens'), output: n('output_tokens') }
}

const emptyRow = () => ({ turns: 0, input: 0, cachedInput: 0, cacheCreation: 0, output: 0, seconds: 0 })
function addTo(row, usage, seconds = 0, turns = 1) {
  row.turns += turns
  for (const key of USAGE_FIELDS) row[key] += count(usage?.[key])
  row.seconds = Math.round((row.seconds + count(seconds)) * 10) / 10
  return row
}
const hasTokens = usage => !!usage && USAGE_FIELDS.some(key => usage[key] > 0)

// What a label (a native agent's, or a helper job key) says about its role, when no host event
// names it. The Codex host's events name every role exactly.
export function roleOfLabel(label) {
  const s = String(label || '')
  for (const [role, pattern] of [['relay', /\(relay/], ['transport', /transport$/], ['setup', /^setup/], ['retro', /^retro$/], ['intake', /^intake$/],
    ['record', /^record$/], ['checker', /^check /], ['panel', /^panel /], ['questions', /^questions /], ['ballot', /^b\d+:/],
    ['spec', /^spec\b|^pair-spec|^spec-/], ['reviewer', /^review[ -]|^review-pair-/], ['auditor', /^(re)?audit[ -]/],
    ['author', /^pair-(design|code)-|^author/], ['measure', /^measure /], ['compare', /^compare$/],
    ['seat', /^(r\d+|final\d?|ratify|inc\d+):|^[A-Z]-(r\d+|final|ratify|inc\d+|synth|fix)/]]) {
    if (pattern.test(s)) return role
  }
  return 'other'
}

function lines(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// A Claude Code transcript: each API message once (a message's streamed parts repeat its usage;
// the last one wins), by model, within an optional time window, and the span of its records.
export function claudeTranscriptUsage(text, { from = -Infinity, to = Infinity } = {}) {
  const messages = new Map()
  let firstAt = null, lastAt = null
  for (const r of lines(text)) {
    const at = Date.parse(r?.timestamp)
    if (Number.isFinite(at)) {
      if (at < from || at > to) continue
      firstAt = firstAt === null ? at : Math.min(firstAt, at); lastAt = lastAt === null ? at : Math.max(lastAt, at)
    }
    const m = r?.message
    if (m && m.role === 'assistant' && m.usage && typeof m.usage === 'object') messages.set(m.id || `#${messages.size}`, m)
  }
  const byModel = {}
  for (const m of messages.values()) {
    const row = byModel[m.model || '?'] || (byModel[m.model || '?'] = { messages: 0, ...Object.fromEntries(USAGE_FIELDS.map(k => [k, 0])) })
    row.messages++
    const u = normalizeUsage(m.usage, 'claude')
    for (const key of USAGE_FIELDS) row[key] += u[key]
  }
  return { messages: messages.size, byModel, firstAt, lastAt }
}

// A Codex rollout: token_count events carry the thread's running total. A turn's usage is the
// total at its end less the total before it started.
export function codexRolloutUsage(text, { from = -Infinity, to = Infinity } = {}) {
  let before = null, atEnd = null
  for (const r of lines(text)) {
    const total = r?.type === 'event_msg' && r.payload?.type === 'token_count' ? r.payload.info?.total_token_usage : null
    if (!total) continue
    const at = Date.parse(r.timestamp)
    if (!Number.isFinite(at) || at > to) continue
    if (at < from) before = total
    else atEnd = total
  }
  if (!atEnd) return null
  const end = normalizeUsage(atEnd, 'codex'), start = normalizeUsage(before || {}, 'codex')
  return Object.fromEntries(USAGE_FIELDS.map(key => [key, Math.max(0, end[key] - start[key])]))
}

// usage.jsonl of one run directory; unreadable lines are reported, not fatal.
export function usageRecords(runDir) {
  const path = join(runDir, 'usage.jsonl'), records = [], problems = []
  if (!existsSync(path)) return { records, problems }
  String(readFileSync(path, 'utf8')).split('\n').forEach((line, i) => {
    if (!line.trim()) return
    try { const r = JSON.parse(line); if (r && typeof r === 'object') records.push({ ...r, runDir }) } catch { problems.push(`${path} line ${i + 1} is not JSON`) }
  })
  return { records, problems }
}

// The Codex host's turn.started events: role and label by job key, for every run directory.
export function hostRoles(hostRunDir) {
  const roles = new Map(), path = hostRunDir && join(hostRunDir, 'events.jsonl')
  if (!path || !existsSync(path)) return roles
  for (const e of lines(readFileSync(path, 'utf8'))) if (e.type === 'turn.started' && e.job) roles.set(e.job, { role: e.role || null, label: e.label || null })
  return roles
}

const baseJob = job => String(job || '').replace(/-resume\d+$/, '')
function roleFor(roles, job) {
  return roles.get(job)?.role || roles.get(baseJob(job))?.role || roleOfLabel(baseJob(job))
}

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

const SLACK_MS = 2000
// A helper record that had no usage from its CLI, read back from the vendor's session log.
function recover(record, homes) {
  const vendor = record.vendor || readJson(join(record.runDir, 'jobs', record.job, 'spec.json'))?.kind || vendorOfModel(record.model)
  const from = Date.parse(record.startedAt) - SLACK_MS, to = Date.parse(record.endedAt) + SLACK_MS
  if (!record.thread) return { reason: 'no thread or session ID was recorded, so its session log cannot be found' }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { reason: 'the record has no time window to read its session log by' }
  if (vendor === 'codex') {
    const files = rolloutIndex(homes.codex, { startedAt: record.startedAt, finishedAt: record.endedAt })(record.thread)
    for (const file of files) {
      const usage = codexRolloutUsage(readFileSync(file, 'utf8'), { from, to })
      if (usage) return { usage, source: 'codex-rollout' }
    }
    return { reason: files.length ? 'its rollout has no token count in the turn\'s window' : `no Codex rollout for thread ${record.thread}` }
  }
  if (vendor === 'claude' || vendor === 'openrouter') {
    const spec = readJson(join(record.runDir, 'jobs', record.job, 'spec.json'))
    const config = vendor === 'openrouter' && spec?.claudeConfigDir ? spec.claudeConfigDir : homes.claude
    const file = transcriptFiles(config, record.thread).find(f => f.kind === 'transcript' && f.file.endsWith(`/${record.thread}.jsonl`))
    if (!file) return { reason: `no Claude transcript for session ${record.thread}` }
    const read = claudeTranscriptUsage(readFileSync(file.file, 'utf8'), { from, to })
    if (!read.messages) return { reason: 'its transcript has no message in the turn\'s window' }
    const usage = Object.fromEntries(USAGE_FIELDS.map(key => [key, Object.values(read.byModel).reduce((n, row) => n + row[key], 0)]))
    return { usage, source: 'claude-transcript' }
  }
  return { reason: `${vendor} keeps no readable usage outside its answer` }
}

// The native workflow agents of the runs that name one of these directories: every agent in the
// matching workflow transcript directories, by model, with its wall time.
export function nativeAgents(runDirs, { configDir, since = 0 } = {}) {
  const needles = [...new Set(runDirs.filter(Boolean))].map(dir => Buffer.from(dir))
  const agents = [], matched = []
  for (const wf of workflowDirs(configDir)) {
    let names
    try { names = readdirSync(wf.dir).filter(n => n.startsWith('agent-') && n.endsWith('.jsonl')) } catch { continue }
    const named = names.some(name => {
      try {
        const path = join(wf.dir, name)
        if (statSync(path).mtimeMs < since) return false
        const data = readFileSync(path)
        return needles.some(needle => data.includes(needle))
      } catch { return false }
    })
    if (!named) continue
    matched.push(wf.dir)
    const state = readJson(wf.state)
    const durations = new Map((state?.workflowProgress || []).filter(e => e?.agentId).map(e => [e.agentId, e.durationMs]))
    for (const name of names) {
      const id = name.slice('agent-'.length, -'.jsonl'.length)
      let read
      try { read = claudeTranscriptUsage(readFileSync(join(wf.dir, name), 'utf8')) } catch { continue }
      const meta = readJson(join(wf.dir, `agent-${id}.meta.json`)) || {}
      const ms = Number.isFinite(durations.get(id)) ? durations.get(id) : read.firstAt !== null ? read.lastAt - read.firstAt : 0
      agents.push({ agent: id, label: meta.description || '', role: roleOfLabel(meta.description), byModel: read.byModel, messages: read.messages, seconds: Math.round(ms / 100) / 10 })
    }
  }
  return { agents, workflowDirs: matched }
}

export function hostRunOf(runDir) {
  const m = basename(String(runDir || '')).match(/^(host-[A-Za-z0-9]+)(?:-|$)/)
  const host = m && join(dirname(runDir), m[1])
  return host && existsSync(join(host, 'host.json')) ? host : null
}

function runCreated(runDirs) {
  const times = []
  for (const dir of runDirs) {
    try { times.push(statSync(join(dir, 'run.json')).mtimeMs) } catch {}
    const created = Date.parse(readJson(join(dir, 'run.json'))?.created)
    if (Number.isFinite(created)) times.push(created)
  }
  return times.length ? Math.min(...times) : 0
}

// The whole run's token use. runDirs: every directory the run used (the Codex host passes its host
// run directory and every run it owned). roles: job key -> {role}, from the host's events.
// native: also count the workflow's own Claude Code agents (a native run).
export function accountRun({ runDirs = [], hostRunDir = null, roles = null, homes = defaultHomes(), native = false } = {}) {
  // A run the standalone runner made (<repo>/.council/host-<id>-..., beside host-<id>/host.json)
  // ran every turn through the helper: there is no native workflow to look for, and its host
  // events name the roles.
  const hosted = runDirs.map(hostRunOf).find(Boolean)
  if (hosted) { native = false; hostRunDir ||= hosted }
  const dirs = [...new Set([hostRunDir, ...runDirs].filter(Boolean))]
  roles ||= hostRoles(hostRunDir)
  const turns = [], missing = [], problems = []
  for (const dir of dirs) {
    const read = usageRecords(dir)
    problems.push(...read.problems)
    for (const r of read.records) {
      const vendor = r.vendor || vendorOfModel(r.model)
      const base = { job: r.job, seat: r.seat || null, role: roleFor(roles, r.job), vendor, model: r.model || '?', seconds: count(r.seconds) }
      let usage = normalizeUsage(r.usage, vendor), source = 'helper-usage'
      if (r.missing || !r.usage || !Object.keys(r.usage).length) {
        const back = recover(r, homes)
        if (!back.usage) { missing.push({ ...base, reason: `${r.missing || 'no usage recorded'}; ${back.reason}` }); continue }
        usage = back.usage; source = back.source
      }
      turns.push({ ...base, ...usage, source })
    }
  }
  let workflows = []
  if (native) {
    const found = nativeAgents(dirs, { configDir: homes.claude, since: runCreated(dirs) - 60_000 })
    workflows = found.workflowDirs
    if (!found.workflowDirs.length) missing.push({ job: null, role: 'native', vendor: 'claude', model: null, reason: `no Claude Code workflow transcript under ${join(homes.claude, 'projects')} names this run, so the workflow's own Claude turns are not counted` })
    for (const a of found.agents) {
      const models = Object.entries(a.byModel)
      if (!models.length) { missing.push({ job: `agent-${a.agent}`, role: a.role, vendor: 'claude', model: null, reason: `the transcript of ${a.label || a.agent} holds no usage` }); continue }
      // An agent that used several models (a fallback) is split; its wall time goes with the first.
      models.forEach(([model, usage], i) => turns.push({ job: `agent-${a.agent}`, label: a.label, seat: null, role: a.role, vendor: 'claude', model,
        seconds: i ? 0 : a.seconds, ...Object.fromEntries(USAGE_FIELDS.map(k => [k, usage[k]])), source: 'native-transcript' }))
    }
  }
  return summarize(turns, missing, { problems, workflowDirs: workflows })
}

export function summarize(turns, missing = [], extra = {}) {
  const total = emptyRow(), byModel = {}, byRole = {}, byVendor = {}, sources = {}
  for (const t of turns) {
    addTo(total, t, t.seconds)
    addTo(byModel[t.model] || (byModel[t.model] = emptyRow()), t, t.seconds)
    addTo(byRole[t.role] || (byRole[t.role] = emptyRow()), t, t.seconds)
    addTo(byVendor[t.vendor] || (byVendor[t.vendor] = emptyRow()), t, t.seconds)
    sources[t.source] = (sources[t.source] || 0) + 1
  }
  const problems = extra.problems || []
  return { version: 2, complete: !missing.length && !problems.length, records: turns.length, total, byModel, byRole, byVendor, sources,
    missing, ...(problems.length ? { problems } : {}), ...(extra.workflowDirs?.length ? { workflowDirs: extra.workflowDirs } : {}), turns }
}

// Any recorded metrics.tokens (this version, the older {records, byModel} of raw vendor counters,
// or the {external, claude} of earlier native facts) in this module's shape: {complete, total,
// byModel}. complete is false when the record says so or cannot say (the older shapes did not list
// missing turns, and native ones left out the workflow's own Claude turns).
export function tokenTotals(tokens, { nativeClaudeTurnsIncluded = true } = {}) {
  if (!tokens || typeof tokens !== 'object') return null
  if (tokens.version === 2 && tokens.total) return { complete: tokens.complete === true, total: tokens.total, byModel: tokens.byModel || {}, missing: (tokens.missing || []).length }
  const groups = tokens.byModel ? [tokens.byModel] : [tokens.external, tokens.claude?.byModel || tokens.claude].filter(Boolean)
  const total = emptyRow(), byModel = {}
  for (const models of groups) for (const [model, raw] of Object.entries(models || {})) {
    const usage = normalizeUsage(raw, vendorOfModel(model))
    if (!usage) continue
    const turns = count(raw.turns) || count(raw.messages) || 0
    addTo(total, usage, raw.seconds, turns)
    addTo(byModel[model] || (byModel[model] = emptyRow()), usage, raw.seconds, turns)
  }
  if (!hasTokens(total)) return null
  return { complete: false, total, byModel, missing: null, legacy: true, nativeClaudeTurnsIncluded }
}

// The running total while a run goes on: reads only what each usage.jsonl gained since the last
// call, so a milestone costs a few small reads. roles(job) gives a turn's role when it is known.
export function liveUsage({ roles = () => null } = {}) {
  const offsets = new Map(), turns = [], missing = []
  return function read(runDirs) {
    for (const dir of new Set(runDirs.filter(Boolean))) {
      const path = join(dir, 'usage.jsonl')
      let size
      try { size = statSync(path).size } catch { continue }
      const from = offsets.get(path) || 0
      if (size <= from) continue
      const fd = openSync(path, 'r'), buffer = Buffer.alloc(size - from)
      try { readSync(fd, buffer, 0, buffer.length, from) } finally { closeSync(fd) }
      const text = buffer.toString('utf8'), end = text.lastIndexOf('\n')
      if (end < 0) continue
      offsets.set(path, from + Buffer.byteLength(text.slice(0, end + 1)))
      for (const r of lines(text.slice(0, end + 1))) {
        const vendor = r.vendor || vendorOfModel(r.model)
        const base = { job: r.job, role: roles(r.job) || roleOfLabel(baseJob(r.job)), vendor, model: r.model || '?', seconds: count(r.seconds) }
        if (r.missing || !r.usage || !Object.keys(r.usage).length) missing.push({ ...base, reason: r.missing || 'no usage recorded' })
        else turns.push({ ...base, ...normalizeUsage(r.usage, vendor), source: 'helper-usage' })
      }
    }
    const { turns: _, ...summary } = summarize(turns, missing)
    return summary
  }
}

// `node usage.mjs --run-dir DIR [--run-dir DIR ...] [--host-run-dir DIR] [--native] [--no-turns]`:
// the accountant's report as JSON, for `dark-factory usage`.
export function usageMain(argv) {
  const runDirs = [], options = { native: false, turns: true, hostRunDir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') runDirs.push(argv[++i])
    else if (argv[i] === '--host-run-dir') options.hostRunDir = argv[++i]
    else if (argv[i] === '--native') options.native = true
    else if (argv[i] === '--no-turns') options.turns = false
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!runDirs.length && !options.hostRunDir) throw new Error('usage.mjs needs --run-dir')
  const report = accountRun({ runDirs, hostRunDir: options.hostRunDir, native: options.native })
  if (!options.turns) delete report.turns
  process.stdout.write(JSON.stringify(report) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { usageMain(process.argv.slice(2)) } catch (error) { process.stdout.write(JSON.stringify({ status: 'error', error: error.message }) + '\n'); process.exitCode = 1 }
}
