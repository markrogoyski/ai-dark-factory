// The token accountant (lib/usage.mjs) and the run history (lib/history.mjs): each source's parsing,
// read-back of turns their CLI did not report, partial marking, the live reader. Fixture files only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRun, claudeTranscriptUsage, codexRolloutUsage, liveUsage, normalizeUsage, roleOfLabel, tokenTotals } from '../plugins/dark-factory/lib/usage.mjs'
import { pastRun, runHistory } from '../plugins/dark-factory/lib/history.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'df-usage-'))
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }

test('every vendor\'s counters are read as input (cache included), cached input, cache writes and output', () => {
  // Codex counts cached tokens inside input_tokens; output includes reasoning.
  assert.deepEqual(normalizeUsage({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 5, output_tokens: 9, reasoning_output_tokens: 4 }, 'codex'),
    { input: 100, cachedInput: 80, cacheCreation: 5, output: 9 })
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 2 }, 'codex'), { input: 10, cachedInput: 0, cacheCreation: 0, output: 2 })
  // Claude (the CLI envelope, transcripts, OpenRouter through claude) counts them beside it.
  assert.deepEqual(normalizeUsage({ input_tokens: 3, cache_read_input_tokens: 70, cache_creation_input_tokens: 30, output_tokens: 9, service_tier: 'standard' }, 'claude'),
    { input: 103, cachedInput: 70, cacheCreation: 30, output: 9 })
  // agy: cache reads beside input; output already includes thinking (total = input + output).
  assert.deepEqual(normalizeUsage({ input_tokens: 40, output_tokens: 13, thinking_tokens: 8, cache_read_tokens: 130, total_tokens: 53 }, 'gemini'),
    { input: 170, cachedInput: 130, cacheCreation: 0, output: 13 })
  assert.deepEqual(normalizeUsage({ input: 5, cachedInput: 1, output: 2 }), { input: 5, cachedInput: 1, cacheCreation: 0, output: 2 })
  assert.equal(normalizeUsage(null), null)
  assert.deepEqual(['check r1:A', 'A-r0', 'review-pair-code-2', 'pair-design-1', 'intake', 'r1:B (relay)', 'something'].map(roleOfLabel),
    ['checker', 'seat', 'reviewer', 'author', 'intake', 'relay', 'other'])
})

test('a Claude transcript counts each message once, by model, inside a window', () => {
  const at = s => `2026-11-20T10:00:${String(s).padStart(2, '0')}.000Z`
  const msg = (s, id, model, out) => ({ timestamp: at(s), message: { id, role: 'assistant', model, usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: out } } })
  const text = jsonl([{ timestamp: at(0), message: { role: 'user', content: 'go' } }, msg(5, 'a', 'opus', 3), msg(6, 'a', 'opus', 4), msg(20, 'b', 'haiku', 1), msg(50, 'c', 'opus', 100)]) + 'not json\n'
  const all = claudeTranscriptUsage(text)
  assert.deepEqual(all.byModel, { opus: { messages: 2, input: 20, cachedInput: 18, cacheCreation: 0, output: 104 }, haiku: { messages: 1, input: 10, cachedInput: 9, cacheCreation: 0, output: 1 } })
  assert.equal(all.lastAt - all.firstAt, 50_000)
  const window = claudeTranscriptUsage(text, { from: Date.parse(at(1)), to: Date.parse(at(30)) })
  assert.deepEqual(Object.keys(window.byModel), ['opus', 'haiku'])
  assert.equal(window.byModel.opus.output, 4, 'the last record of a streamed message wins')
})

test('a Codex rollout gives a turn its share of the thread total', () => {
  const tc = (s, input, cached, output) => ({ timestamp: `2026-11-20T10:${String(s).padStart(2, '0')}:00.000Z`, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } })
  const text = jsonl([{ type: 'session_meta', payload: {} }, tc(1, 100, 50, 10), tc(5, 300, 200, 30), tc(9, 1000, 800, 90)])
  const window = t => ({ from: Date.parse(`2026-11-20T10:${t[0]}:00.000Z`), to: Date.parse(`2026-11-20T10:${t[1]}:00.000Z`) })
  assert.deepEqual(codexRolloutUsage(text, window(['03', '06'])), { input: 200, cachedInput: 150, cacheCreation: 0, output: 20 })
  assert.deepEqual(codexRolloutUsage(text, window(['00', '02'])), { input: 100, cachedInput: 50, cacheCreation: 0, output: 10 })
  assert.equal(codexRolloutUsage(text, window(['10', '12'])), null, 'no count inside the window')
})

test('turns without reported usage are read back from session logs, or listed as missing and the total marked partial', () => {
  const dir = temp(), run = join(dir, 'run'), codex = join(dir, 'codex'), claude = join(dir, 'claude')
  const window = { startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:10:00.000Z' }
  write(join(run, 'usage.jsonl'), jsonl([
    { job: 'A-r0', seat: 'A', model: 'gpt-6.2-astra', vendor: 'codex', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 }, seconds: 12 },
    { job: 'A-r1', seat: 'A', model: 'gpt-6.2-astra', vendor: 'codex', usage: {}, missing: 'timed out before turn.completed', thread: 'T1', seconds: 600, ...window },
    { job: 'review-pair-code-1', seat: 'PR', model: 'opus', vendor: 'claude', usage: {}, missing: 'timed out before its result envelope', thread: 'S1', seconds: 600, ...window },
    { job: 'B-r0', seat: 'B', model: 'gemini-4-hydrogen-high', vendor: 'gemini', usage: {}, missing: 'no answer from agy', thread: 'C1', seconds: 3, ...window },
    { job: 'C-r0', seat: 'C', model: 'gpt-6-astra', usage: {}, seconds: 1 },
  ]))
  write(join(codex, 'sessions', '2026', '11', '20', 'rollout-2026-11-20T10-00-00-T1.jsonl'), jsonl([
    { timestamp: '2026-11-20T09:59:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 } } } },
    { timestamp: '2026-11-20T10:04:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 110, output_tokens: 25 } } } }]))
  write(join(claude, 'projects', '-x', 'S1.jsonl'), jsonl([
    { timestamp: '2026-11-20T10:02:00.000Z', message: { id: 'm', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 40, output_tokens: 7 } } }]))
  const report = accountRun({ runDirs: [run], homes: { codex, claude, agy: join(dir, 'agy') } })
  assert.equal(report.complete, false)
  assert.deepEqual(report.sources, { 'helper-usage': 1, 'codex-rollout': 1, 'claude-transcript': 1 })
  assert.deepEqual(report.turns.find(t => t.job === 'A-r1'), { job: 'A-r1', seat: 'A', role: 'seat', vendor: 'codex', model: 'gpt-6.2-astra', seconds: 600, input: 200, cachedInput: 100, cacheCreation: 0, output: 20, source: 'codex-rollout' })
  assert.deepEqual(report.byRole.reviewer, { turns: 1, input: 42, cachedInput: 0, cacheCreation: 40, output: 7, seconds: 600 })
  assert.deepEqual(report.missing.map(m => [m.job, m.vendor]), [['B-r0', 'gemini'], ['C-r0', 'codex']])
  assert.match(report.missing[0].reason, /no answer from agy; gemini keeps no readable usage/)
  assert.match(report.missing[1].reason, /no usage recorded; no thread/)
  assert.deepEqual(report.total, { turns: 3, input: 292, cachedInput: 110, cacheCreation: 40, output: 32, seconds: 1212 })
  // Roles from the Codex host's events win over the job key.
  write(join(dir, 'host', 'events.jsonl'), jsonl([{ type: 'turn.started', job: 'A-r0', role: 'author' }]))
  assert.equal(accountRun({ runDirs: [run], hostRunDir: join(dir, 'host'), homes: { codex, claude } }).turns[0].role, 'author')
})

test('a run the standalone runner made has no native workflow to look for, and takes roles from its host events', () => {
  const council = join(temp(), '.council'), host = join(council, 'host-Ab12'), run = join(council, 'host-Ab12-pair')
  write(join(host, 'host.json'), '{}')
  write(join(host, 'events.jsonl'), jsonl([{ type: 'turn.started', job: 'host-3-setup', role: 'setup' }]))
  write(join(run, 'usage.jsonl'), jsonl([{ job: 'host-3-setup', model: 'opus', vendor: 'claude', usage: { input_tokens: 4, output_tokens: 1 }, seconds: 3 }]))
  const report = accountRun({ runDirs: [run], native: true, homes: { codex: join(council, 'none'), claude: join(council, 'none') } })
  assert.deepEqual([report.complete, report.byRole.setup.turns, report.sources], [true, 1, { 'helper-usage': 1 }])
  // A native run directory with no workflow transcript naming it is partial, and says why.
  const native = join(temp(), '20261120-101500')
  write(join(native, 'usage.jsonl'), jsonl([{ job: 'A-r0', model: 'gpt-6.2-astra', vendor: 'codex', usage: { input_tokens: 4, output_tokens: 1 }, seconds: 3 }]))
  const partial = accountRun({ runDirs: [native], native: true, homes: { codex: join(native, 'none'), claude: join(native, 'none') } })
  assert.deepEqual([partial.complete, partial.missing[0].role], [false, 'native'])
})

test('the live reader reads only what usage.jsonl gained and waits for a whole line', () => {
  const run = temp(), path = join(run, 'usage.jsonl')
  const read = liveUsage({ roles: job => job === 'a' ? 'author' : null })
  assert.equal(read([run]).records, 0)
  writeFileSync(path, jsonl([{ job: 'a', model: 'gpt-6-luna', vendor: 'codex', usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 3 }, seconds: 2 }]) + '{"job":"b","mod')
  let u = read([run])
  assert.deepEqual([u.records, u.total.input, u.byRole.author.turns, u.missing.length], [1, 100, 1, 0])
  appendFileSync(path, 'el":"opus","usage":{},"missing":"timed out before its result envelope"}\n')
  u = read([run, run])
  assert.deepEqual([u.records, u.total.input, u.complete, u.missing[0].reason], [1, 100, false, 'timed out before its result envelope'])
})

test('older recorded totals are read in the same shape and counted as partial', () => {
  const legacy = tokenTotals({ records: 7, byModel: { 'gpt-6-luna': { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 20 }, haiku: { input_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 8, output_tokens: 6 } } })
  assert.deepEqual([legacy.complete, legacy.total.input, legacy.total.cachedInput, legacy.total.output], [false, 1060, 950, 26])
  const current = tokenTotals({ version: 2, complete: true, total: { turns: 1, input: 5, cachedInput: 0, cacheCreation: 0, output: 1, seconds: 1 }, byModel: {}, missing: [] })
  assert.equal(current.complete, true)
  assert.equal(tokenTotals({ records: 0, byModel: {} }), null)
})

test('history reads each host run\'s result once, skips explanations and copies, and searches DARK_FACTORY_HISTORY', () => {
  const dir = temp(), repo = join(dir, 'repo'), other = join(dir, 'bench', 'work', 't', 'v', 'rep-1', 'repo')
  const metrics = (over = {}) => ({ version: 1, workflow: 'pair', tier: 'pair', strategy: 'pair', readiness: 'ready', turns: 7, elapsedMs: 1_800_000,
    tokens: { version: 2, complete: true, total: { turns: 7, input: 2_000_000, cachedInput: 1_800_000, cacheCreation: 0, output: 40_000, seconds: 900 }, byModel: {}, missing: [] }, ...over })
  const plan = { participants: [{ model: 'luna' }], reviewers: [{ model: 'haiku' }] }
  const host = (base, name, result, owned = false) => {
    write(join(base, '.council', name, 'result.json'), JSON.stringify(result))
    if (!owned) writeFileSync(join(base, '.council', name, 'host.json'), '{}')
  }
  host(repo, 'host-a', { status: 'done', plan, metrics: metrics() })
  host(repo, 'host-a-pair', { status: 'done', plan, metrics: metrics() }, true)
  host(repo, 'host-b', { status: 'explained', plan, metrics: metrics() })
  host(repo, 'host-c', { status: 'failed', metrics: metrics({ tokens: null, elapsedMs: 60_000, readiness: 'incomplete' }) })
  host(other, 'host-d', { status: 'done', plan, metrics: metrics({ elapsedFrom: 'setup' }) })
  const runs = runHistory({ repo, env: {} })
  assert.deepEqual(runs.map(r => [r.lineup, r.tokens?.input ?? null, r.elapsedMs]), [['luna / haiku', 2_000_000, 1_800_000], [null, null, 60_000]])
  const both = runHistory({ repo, env: { DARK_FACTORY_HISTORY: join(dir, 'bench') } })
  assert.equal(both.length, 3)
  assert.equal(both.find(r => r.file.includes('host-d')).elapsedMs, null, 'an elapsed time measured from setup is not a run\'s active time')
  assert.equal(pastRun({ status: 'preflight', metrics: metrics() }, 'x'), null)
  assert.deepEqual(runHistory({ repo: join(dir, 'none'), env: {} }), [])
})
