// OpenRouter seats in the workflow's turns and the Codex-host runtime: job, thread and
// configuration keys on both hosts, the role boundary, the preflight list and recovery. The helper
// is a fake that records its argv; no model, CLI or network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LIB, PAIR_LIB } from '../tools/sources.mjs'
import { createRuntime } from '../plugins/dark-factory/lib/codex-runner.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD_RE = /=====BEGIN PAYLOAD (\S+)=====\n([\s\S]*)\n=====END PAYLOAD \1=====/
const schemaIn = text => JSON.parse(text.split('<<<OUTPUT_SCHEMA\n')[1].split('\nOUTPUT_SCHEMA>>>')[0])

// A value of the schema's shape: one-value enums (the turn tag) kept, a non-empty statement, and
// one item in a spec review's findings so the spec panel runs.
function fill(schema, key = '', top = true) {
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, fill(v, k, false)]))
  if (schema.type === 'array') return key === 'findings' && top === false ? [fill(schema.items, '', false)] : []
  if (schema.type === 'string') return 'x'
  if (schema.type === 'boolean') return false
  return 0
}

// `extra` is appended to the loaded sources: a later function declaration replaces an earlier one,
// which lets ensembleRun run with the setup and the checks (not under test here) stubbed out.
const ENSEMBLE_STUBS = 'async function councilSetup() { return null }\nasync function runChecks() {}'
function harness({ boot = 'src/boot.js', args, runtime, agent, extra = '' }) {
  const bootSource = readFileSync(join(root, boot), 'utf8')
  const lib = [...LIB, ...PAIR_LIB].map(f => readFileSync(join(root, f), 'utf8')).join('\n')
  const rest = ['src/schemas.js', 'src/ensemble-schemas.js', 'src/pair-schemas.js', 'src/turns.js', 'src/repair.js', 'src/pair.js', 'src/main-ensemble.js']
    .map(f => readFileSync(join(root, f), 'utf8').replace(/^return await .*$/m, '')).join('\n')
  const load = new Function('factoryRuntime', 'agent', 'parallel', 'log', 'phase', 'args', `${lib}\n${bootSource}\n${rest}\n${extra}
    return { get S() { return S }, seatTurn, panelRun, auditTurn, specTurn, runSpecReview, boundedReview, externalTurn, ensembleReview, ensembleRun,
      pairAuthorTurn: typeof pairAuthorTurn === 'function' ? pairAuthorTurn : null, pairReviewTurn: typeof pairReviewTurn === 'function' ? pairReviewTurn : null }`)
  const parallel = jobs => Promise.all(jobs.map(f => f()))
  return runtime ? load(runtime, () => { throw new Error('no native agent on the Codex host') }, parallel, () => {}, () => {}, args)
    : load(undefined, agent, parallel, () => {}, () => {}, args)
}

// A Codex-host repository: .council/host-abc123 (the host run) and its run host-abc123-council.
function codexRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'or-host-')))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  const hostRunDir = join(repo, '.council', 'host-abc123'), runDir = join(repo, '.council', 'host-abc123-council')
  mkdirSync(hostRunDir, { recursive: true }); mkdirSync(join(runDir, 'room'), { recursive: true })
  writeFileSync(join(hostRunDir, 'host.json'), '{}')
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ runId: 'host-abc123-council', runDir, repoRoot: repo }))
  const run = { runId: 'host-abc123-council', runDir, repoRoot: repo, room: join(runDir, 'room') }
  return { dir, repo, hostRunDir, runDir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// The real runtime, with a helper that records argv and answers every turn in the schema's shape.
function recordingRuntime(env, extra = {}) {
  const calls = []
  const execute = async (argv) => {
    calls.push(argv)
    if (argv[0] === 'preflight') return extra.preflight ? extra.preflight(argv) : { status: 'ok', vendors: {} }
    const prompt = readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8')
    const job = argv[argv.indexOf('--job') + 1]
    if (extra.turn) { const r = extra.turn(job, argv); if (r) return r }
    return { status: 'done', seconds: 3, result: fill(schemaIn(prompt)) }
  }
  const runtime = createRuntime({ repo: env.repo, hostRunDir: env.hostRunDir, execute, gitDirs: [join(env.repo, '.git')], ...(extra.options || {}) })
  return { runtime, calls }
}

const value = (argv, flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined
const PANEL = ['openrouter:' + 'A'.repeat(32) + 'ABCDefghIjkLMnOPqrstuvwx', 'openrouter:' + 'A'.repeat(32) + 'aBCdEFGhiJklmnOpQrstuvwx',
  'openrouter:a/b', 'openrouter:a-b', 'openrouter:a/b', 'openrouter:' + 'x'.repeat(128), 'astra']

function nativeAgent(log) {
  return async (prompt, opts) => {
    const m = prompt.match(PAYLOAD_RE)
    if (!m) { log.push({ label: opts.label, cmd: null }); return null }
    const cmd = prompt.split('\n').find(l => l.startsWith('dark-factory seat-run'))
    log.push({ label: opts.label, cmd })
    const tag = (m[2].match(/Set `turn` in your output to exactly "([^"]+)"\./) || [])[1]
    return { status: 'done', seconds: 4, result: { ...fill(schemaIn(m[2])), turn: tag } }
  }
}
const relayFlag = (cmd, flag) => { const m = cmd.match(new RegExp(`${flag} '([^']*)'`)); return m ? m[1] : (cmd.match(new RegExp(`${flag} (\\S+)`)) || [])[1] }

test('panel key', async () => {
  const env = codexRepo()
  try {
    const { runtime, calls } = recordingRuntime(env)
    const captured = []
    const spy = { ...runtime, turn: request => { if (String(request.key).startsWith('panel-')) captured.push(request); return runtime.turn(request) } }
    const h = harness({ args: { task: 'Fix it', host: 'codex', panel: PANEL, spec: { coverage: 'astra', intent: 'astra' } }, runtime: spy })
    h.S.run = env.run
    h.S.criteria = [{ id: 'C1', text: 'c' }]
    await h.panelRun(1, []); await h.panelRun(12, []); await h.runSpecReview()
    const panelCalls = calls.filter(a => a[0] === 'seat-run' && value(a, '--job').startsWith('panel-'))
    const keys = panelCalls.map(a => value(a, '--job'))
    assert.ok(keys.includes('panel-or3-a-b-r1') && keys.includes('panel-or4-a-b-r1') && keys.includes('panel-or5-a-b-r12') && keys.includes('panel-or5-a-b-spec'), keys.join(' '))
    assert.ok(keys.includes('panel-astra-r1') && keys.includes('panel-astra-spec'))
    assert.equal(new Set(keys).size, keys.length, 'distinct keys')
    for (const a of panelCalls) {
      const job = value(a, '--job')
      assert.equal(value(a, '--seat'), job, 'the thread key is the job key')
      assert.match(job, /^[a-z0-9-]+$/)
      assert.ok(`${job}-recover-resume1`.length <= 63, job)
      execFileSync('git', ['check-ref-format', `refs/council/run/${job}-recover-resume1`])
      if (job.startsWith('panel-or')) assert.equal(value(a, '--config-key'), job.replace(/-(r\d+|spec)$/, ''))
    }
    // Every panel request and its -recover variant, through the real runtime on a fresh and a resumed
    // attempt: the helper's --job is the request key (plus -resume1), --seat its thread key, unchanged.
    const replayed = []
    for (const attempt of [0, 1]) {
      const rt = recordingRuntime(env, { options: { attempt } })
      for (const req of captured) {
        for (const suffix of ['', '-recover']) {
          const request = { ...req, key: req.key + suffix }
          await rt.runtime.turn(request)
          const argv = rt.calls.at(-1)
          const job = request.key + (attempt ? '-resume1' : '')
          assert.equal(value(argv, '--job'), job)
          assert.equal(value(argv, '--seat'), req.threadKey)
          if (req.vendor === 'openrouter') assert.equal(value(argv, '--config-key'), req.configKey)
          else assert.equal(argv.includes('--config-key'), false)
          assert.match(job, /^[a-z0-9-]+$/); assert.ok(job.length <= 63, job)
          execFileSync('git', ['check-ref-format', `refs/council/run/${job}`])
          replayed.push(job)
        }
      }
    }
    assert.equal(new Set(replayed).size, replayed.length, 'every key and suffix is distinct')
    assert.equal(replayed.length, captured.length * 4)

    // An OpenRouter seat's real -recover turn: its post exists, so the runtime offers the session.
    const recovering = recordingRuntime(env, { turn: (job, argv) => {
      if (job !== 'A-r0') return null
      mkdirSync(join(env.runDir, 'jobs', job), { recursive: true }); writeFileSync(join(env.runDir, 'jobs', job, 'prompt.md'), 'p')
      mkdirSync(join(env.run.room, 'r0'), { recursive: true }); writeFileSync(join(env.run.room, 'r0', 'A.md'), 'post')
      return { status: 'error', error: 'no structured output', errorClass: 'vendor', thread: 'session-1' }
    } })
    const sr = harness({ args: { task: 'Fix it', host: 'codex', seats: ['openrouter:a/b', 'astra'] }, runtime: recovering.runtime })
    sr.S.run = env.run; sr.S.criteria = [{ id: 'C1', text: 'c' }]
    sr.S.seats = sr.S.lineup.map((s, i) => ({ ...s, L: 'AB'[i], wt: join(env.runDir, 'wt', 'AB'[i]), active: true }))
    for (const s of sr.S.seats) sr.S.pos[s.L] = { summary: '', post: '', criteria: [] }
    await sr.seatTurn(sr.S.seats[0], 0, 'solve', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] })
    const recover = recovering.calls.find(a => value(a, '--job') === 'A-r0-recover')
    assert.ok(recover, recovering.calls.map(a => value(a, '--job')).join(' '))
    assert.deepEqual([value(recover, '--seat'), value(recover, '--config-key'), value(recover, '--resume-session'), recover.includes('--config-root')], ['A', 'A', 'session-1', false])
    execFileSync('git', ['check-ref-format', 'refs/council/run/A-r0-recover-resume1'])

    // The -resume suffix fits the runtime's job key unchanged.
    const resumed = recordingRuntime(env, { options: { attempt: 1 } })
    const r = harness({ args: { task: 'Fix it', host: 'codex', panel: PANEL }, runtime: resumed.runtime })
    r.S.run = env.run
    await r.panelRun(1, [])
    assert.deepEqual(resumed.calls.map(a => value(a, '--job')), keys.filter(k => k.endsWith('-r1')).map(k => `${k}-resume1`))
    // Claude host: the relay command carries the same keys.
    const log = []
    const n = harness({ args: { task: 'Fix it', panel: PANEL }, agent: nativeAgent(log) })
    n.S.run = { runId: 'r', runDir: '/x/.council/r', repoRoot: '/x', room: '/x/.council/r/room' }
    await n.panelRun(1, [])
    const relays = log.filter(c => c.cmd)
    assert.ok(relays.some(c => relayFlag(c.cmd, '--job') === 'panel-or1-' + 'a'.repeat(32) + '-r1'), relays.map(c => c.cmd).join('\n'))
    assert.deepEqual(relays.map(c => relayFlag(c.cmd, '--job')).sort(), keys.filter(k => k.endsWith('-r1')).sort())
  } finally { env.cleanup() }
})

test('config key', async () => {
  const env = codexRepo()
  try {
    const OR = 'openrouter:z-ai/glm-5'
    const { runtime, calls } = recordingRuntime(env)
    const h = harness({ args: { task: 'Fix it', host: 'codex', seats: [OR, 'astra'], panel: [OR, 'astra'], audit: { correctness: OR, design: 'astra' }, spec: { coverage: OR, intent: 'astra' } }, runtime })
    h.S.run = env.run
    h.S.criteria = [{ id: 'C1', text: 'c' }]
    h.S.seats = h.S.lineup.map((s, i) => ({ ...s, L: 'AB'[i], wt: join(env.runDir, 'wt', 'AB'[i]), active: true }))
    h.S.auditedTag = 'final'
    for (const s of h.S.seats) h.S.pos[s.L] = { summary: '', post: '', criteria: [] }
    const A = h.S.seats[0], auditor = h.S.auditors.find(a => a.lens === 'correctness')
    await h.seatTurn(A, 0, 'solve', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] })
    await h.seatTurn(A, 1, 'debate', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] })
    await h.seatTurn(A, 'F', 'final', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] })
    await h.panelRun(1, []); await h.panelRun(2, []); await h.runSpecReview()
    await h.auditTurn(auditor, A, 'H'); await h.auditTurn(auditor, A, 'I')
    await h.boundedReview(auditor, A, 'review0', 'final')
    await h.specTurn(h.S.specReviewers.find(r => r.lens === 'coverage'))
    const by = job => calls.filter(a => a[0] === 'seat-run' && value(a, '--job') === job)
    const seatRuns = calls.filter(a => a[0] === 'seat-run')
    const key = job => { const [a] = by(job); assert.ok(a, job); return value(a, '--config-key') }
    for (const job of ['A-r0', 'A-r1', 'A-final']) assert.equal(key(job), 'A')
    for (const job of ['panel-or1-z-ai-glm-5-r1', 'panel-or1-z-ai-glm-5-r2', 'panel-or1-z-ai-glm-5-spec']) assert.equal(key(job), 'panel-or1-z-ai-glm-5')
    for (const job of ['audit-correctness', 'final3-correctness', 'review0-correctness']) assert.equal(key(job), 'audit-correctness')
    assert.equal(key('spec-coverage'), 'spec-coverage')
    for (const a of seatRuns) {
      assert.equal(a.includes('--config-root'), false, 'seats send no --config-root')
      if (value(a, '--vendor') !== 'openrouter') assert.equal(a.includes('--config-key'), false, value(a, '--job'))
    }
    assert.equal(value(by('A-r1')[0], '--seat'), 'A'); assert.equal(by('A-r1')[0].includes('--fresh'), false)
    assert.equal(value(by('review0-correctness')[0], '--seat'), 'audit-review0-correctness'); assert.ok(by('review0-correctness')[0].includes('--fresh'))

    // Pair author and reviewer, and an ensemble lens reviewer, on the Codex host.
    const pair = recordingRuntime(env)
    const p = harness({ boot: 'src/boot-pair.js', args: { task: 'Fix it', host: 'codex', author: OR, reviewer: OR }, runtime: pair.runtime })
    p.S.run = env.run; p.S.criteria = [{ id: 'C1', text: 'c' }]
    p.S.seats = [{ L: 'A', ...p.S.lineup[0], wt: join(env.runDir, 'wt', 'A'), active: true }]
    for (const label of ['design-1', 'design-2']) await p.pairAuthorTurn(label)
    p.S.pair.stage = 'design'; p.S.pair.author = { addressed: [] }
    for (const label of ['design-1', 'design-2']) await p.pairReviewTurn(label)
    const pairKeys = pair.calls.filter(a => a[0] === 'seat-run').map(a => [value(a, '--job'), value(a, '--config-key'), value(a, '--seat')])
    assert.ok(pairKeys.some(([j, k, s]) => j === 'design-1' && k === 'pair-author' && s === 'pair-author'), JSON.stringify(pairKeys))
    assert.ok(pairKeys.some(([j, k]) => j === 'design-2' && k === 'pair-author'))
    assert.ok(pairKeys.some(([j, k, s]) => j === 'review-design-1' && k === 'pair-reviewer' && s === 'review-design-1'))
    assert.ok(pairKeys.some(([j, k]) => j === 'review-design-2' && k === 'pair-reviewer'))

    // A whole ensemble run (setup and checks stubbed): solvers, every lens reviewer and the comparison.
    const ens = recordingRuntime(env)
    const ensembleArgs = { task: 'Fix it', mode: 'investigate', seats: ['sonnet', 'sonnet'], models: { review: OR, compare: OR } }
    const e = harness({ boot: 'src/boot-ensemble.js', args: { ...ensembleArgs, host: 'codex' }, runtime: ens.runtime, extra: ENSEMBLE_STUBS })
    e.S.run = env.run; e.S.criteria = [{ id: 'C1', text: 'c' }]
    e.S.seats = e.S.lineup.map((s, i) => ({ ...s, L: 'AB'[i], wt: join(env.runDir, 'wt', 'AB'[i]), active: true }))
    const ensembleOut = await e.ensembleRun()
    assert.ok(ensembleOut.advisor, 'the comparison ran: ' + JSON.stringify(e.S.notes))
    const lenses = e.S.ensemble.lenses.map(a => a.lens)
    const ensRuns = ens.calls.filter(a => a[0] === 'seat-run')
    const expectEnsemble = [...['A', 'B'].flatMap(L => lenses.map(lens => [`ensemble-${L}-${lens}`, `ensemble-${L}-${lens}`, `ensemble-review-${lens}`])), ['compare', 'compare', 'compare']]
    assert.deepEqual(ensRuns.filter(a => value(a, '--vendor') === 'openrouter').map(a => [value(a, '--job'), value(a, '--seat'), value(a, '--config-key')]).sort(), expectEnsemble.sort())
    assert.ok(ensRuns.filter(a => value(a, '--vendor') === 'openrouter').every(a => a.includes('--fresh') && !a.includes('--config-root')))
    assert.ok(ensRuns.filter(a => value(a, '--vendor') !== 'openrouter').every(a => !a.includes('--config-key') && !a.includes('--config-root')))
    assert.equal(ensRuns.filter(a => value(a, '--vendor') === 'claude').length, 2, 'the two solvers ran on the runtime as claude')

    // Codex-host roles: one configuration per role, under the host run directory.
    const roles = recordingRuntime(env)
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    for (const role of ['checker', 'checker', 'retro']) await roles.runtime.agent({ prompt: 'p', schema, vendor: 'openrouter', model: 'z-ai/glm-5', role, run: env.run, label: role })
    const roleArgs = roles.calls.filter(a => a[0] === 'seat-run')
    assert.deepEqual(roleArgs.map(a => [value(a, '--config-key'), value(a, '--config-root')]),
      [['role-checker', env.hostRunDir], ['role-checker', env.hostRunDir], ['role-retro', env.hostRunDir]])
    assert.ok(roleArgs.every(a => a.includes('--fresh')))

    // Claude host: every OpenRouter turn is a relay with --vendor openrouter and the same configuration
    // key as on the Codex host, at every call site; no native agent call is made for one.
    const log = []
    const n = harness({ args: { task: 'Fix it', seats: [OR, 'astra'], panel: [OR, 'astra'], audit: { correctness: OR, design: 'astra' }, spec: { coverage: OR, intent: 'astra' } }, agent: nativeAgent(log) })
    const claudeRun = { runId: 'r', runDir: '/x/.council/r', repoRoot: '/x', room: '/x/.council/r/room' }
    n.S.run = claudeRun
    n.S.criteria = [{ id: 'C1', text: 'c' }]
    n.S.seats = n.S.lineup.map((s, i) => ({ ...s, L: 'AB'[i], wt: `/x/.council/r/wt/${'AB'[i]}`, active: true }))
    n.S.auditedTag = 'final'
    for (const s of n.S.seats) n.S.pos[s.L] = { summary: '', post: '', criteria: [] }
    const summary = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    await n.seatTurn(n.S.seats[0], 0, 'solve', summary)
    await n.seatTurn(n.S.seats[0], 1, 'debate', summary)
    await n.seatTurn(n.S.seats[0], 'F', 'final', summary)
    await n.panelRun(1, []); await n.panelRun(2, []); await n.runSpecReview()
    const nAuditor = n.S.auditors.find(a => a.lens === 'correctness')
    await n.auditTurn(nAuditor, n.S.seats[0], 'H'); await n.auditTurn(nAuditor, n.S.seats[0], 'I')
    await n.boundedReview(nAuditor, n.S.seats[0], 'review0', 'final')

    const np = harness({ boot: 'src/boot-pair.js', args: { task: 'Fix it', author: OR, reviewer: OR }, agent: nativeAgent(log) })
    np.S.run = claudeRun; np.S.criteria = [{ id: 'C1', text: 'c' }]
    np.S.seats = [{ L: 'A', ...np.S.lineup[0], wt: '/x/.council/r/wt/A', active: true }]
    for (const label of ['design-1', 'design-2']) await np.pairAuthorTurn(label)
    np.S.pair.stage = 'design'; np.S.pair.author = { addressed: [] }
    for (const label of ['design-1', 'design-2']) await np.pairReviewTurn(label)

    const ne = harness({ boot: 'src/boot-ensemble.js', args: { ...ensembleArgs, seats: ['astra', 'astra'] }, agent: nativeAgent(log), extra: ENSEMBLE_STUBS })
    ne.S.run = claudeRun; ne.S.criteria = [{ id: 'C1', text: 'c' }]
    ne.S.seats = ne.S.lineup.map((s, i) => ({ ...s, L: 'AB'[i], wt: `/x/.council/r/wt/${'AB'[i]}`, active: true }))
    assert.ok((await ne.ensembleRun()).advisor, 'the Claude-host comparison ran')

    const relays = log.filter(c => c.cmd)
    assert.deepEqual(log.filter(c => !c.cmd), [], 'no native agent call: every turn here is a relay')
    const orRelays = relays.filter(c => c.cmd.includes('--vendor openrouter'))
    const got = orRelays.map(c => [relayFlag(c.cmd, '--job'), relayFlag(c.cmd, '--config-key')])
    const want = [['A-r0', 'A'], ['A-r1', 'A'], ['A-final', 'A'],
      ['panel-or1-z-ai-glm-5-r1', 'panel-or1-z-ai-glm-5'], ['panel-or1-z-ai-glm-5-r2', 'panel-or1-z-ai-glm-5'], ['panel-or1-z-ai-glm-5-spec', 'panel-or1-z-ai-glm-5'],
      ['spec-coverage', 'spec-coverage'], ['audit-correctness', 'audit-correctness'], ['final3-correctness', 'audit-correctness'], ['review0-correctness', 'audit-correctness'],
      ['design-1', 'pair-author'], ['design-2', 'pair-author'], ['review-design-1', 'pair-reviewer'], ['review-design-2', 'pair-reviewer'],
      ...['A', 'B'].flatMap(L => lenses.map(lens => [`ensemble-${L}-${lens}`, `ensemble-review-${lens}`])), ['compare', 'compare']]
    assert.deepEqual(got.sort(), want.sort())
    // The same jobs and configuration keys as the Codex-host requests above.
    const codexSide = [...seatRuns, ...pair.calls.filter(a => a[0] === 'seat-run'), ...ensRuns].filter(a => value(a, '--vendor') === 'openrouter')
      .map(a => [value(a, '--job'), value(a, '--config-key')])
    assert.deepEqual([...new Map(codexSide.map(x => [x.join(' '), x])).values()].sort(), want.sort())
    assert.ok(relays.every(c => !c.cmd.includes('--config-root')))
    assert.ok(relays.filter(c => !c.cmd.includes('--vendor openrouter')).every(c => !c.cmd.includes('--config-key')))
  } finally { env.cleanup() }
})

test('role boundary', async () => {
  const env = codexRepo()
  try {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    const argvFor = async (vendor, model, role) => {
      const { runtime, calls } = recordingRuntime(env)
      await runtime.agent({ prompt: 'p', schema, vendor, model, role, run: role === 'setup' ? null : env.run, label: role,
        setupRunId: role === 'setup' ? 'host-abc123-council' : undefined })
      return calls.find(a => a[0] === 'seat-run')
    }
    rmSync(env.runDir, { recursive: true, force: true })
    const setup = await argvFor('openrouter', 'z-ai/glm-5', 'setup')
    const writable = setup.flatMap((x, i) => x === '--writable' ? [setup[i + 1]] : [])
    assert.deepEqual(writable, [join(env.repo, '.council', 'host-abc123-council'), join(env.repo, '.git')])
    assert.ok(existsSync(join(env.repo, '.council', 'host-abc123-council')), 'the setup run directory exists before the turn')
    assert.ok(value(setup, '--cwd').startsWith(join(env.hostRunDir, 'scratch') + '/'))
    assert.deepEqual([value(setup, '--config-root'), value(setup, '--config-key')], [env.hostRunDir, 'role-setup'])
    const config = join(env.hostRunDir, 'openrouter', 'role-setup')
    for (const w of [value(setup, '--cwd'), ...writable]) assert.ok(!config.startsWith(w + '/') && !w.startsWith(config + '/'), w)
    const claudeSetup = await argvFor('claude', 'opus', 'setup')
    assert.equal(value(claudeSetup, '--cwd'), env.repo, 'a Claude setup keeps the repository as its cwd')
    assert.deepEqual(claudeSetup.flatMap((x, i) => x === '--writable' ? [claudeSetup[i + 1]] : []), [join(env.repo, '.git')])
    mkdirSync(join(env.runDir, 'room'), { recursive: true })
    writeFileSync(join(env.runDir, 'run.json'), JSON.stringify({ runId: 'host-abc123-council', runDir: env.runDir, repoRoot: env.repo }))
    for (const role of ['checker', 'retro', 'record', 'questions']) {
      const strip = a => a.map(x => x.replace(/host-\d+-/, 'host-N-').replace(/-[0-9a-f]{8}\b/, '-H'))
      const o = await argvFor('openrouter', 'z-ai/glm-5', role), c = await argvFor('claude', 'opus', role)
      const expect = strip(c).map(x => x === 'claude' ? 'openrouter' : x === 'opus' ? 'z-ai/glm-5' : x)
      const i = o.indexOf('--config-key')
      assert.deepEqual(o.slice(i, i + 4), ['--config-key', `role-${role}`, '--config-root', env.hostRunDir], role)
      const rest = strip([...o.slice(0, i), ...o.slice(i + 4)])
      assert.deepEqual(rest.filter(x => !x.startsWith('/') || !x.includes('.prompt.md')), expect.filter(x => !x.startsWith('/') || !x.includes('.prompt.md')), role)
    }
    const { runtime } = recordingRuntime(env)
    await assert.rejects(runtime.agent({ prompt: 'p', schema, vendor: 'openrouter', model: 'x', role: 'setup', run: null, label: 'setup' }),
      e => e.message === 'An OpenRouter setup turn needs a host-assigned run ID')
  } finally { env.cleanup() }
})

test('prepare', async t => {
  const policy = await import('../plugins/dark-factory/lib/policy.mjs')
  const args = { task: 'Fix it', seats: ['opus', 'astra', 'openrouter:a/b'], panel: ['opus', 'astra'] }
  const req = policy.launchRequirements({}, { workflow: 'council', args })
  assert.deepEqual(req.vendors['openrouter:a/b'], ['author'])
  const report = policy.launchReport({}, req, { vendors: { claude: { ok: true }, codex: { ok: true }, 'openrouter:a/b': { ok: false, error: 'OpenRouter has no model a/b (GET https://openrouter.ai/api/v1/models)' } } })
  assert.equal(report.status, 'blocked')
  assert.deepEqual(report.blocking, ['openrouter:a/b CLI (author): OpenRouter has no model a/b (GET https://openrouter.ai/api/v1/models)'])
  const routes = policy.reachableProviders({}, { workflow: 'council', args })
  assert.ok(routes.some(r => r.vendor === 'openrouter' && r.model === 'a/b'))
  for (const r of policy.reachableProviders({}, { workflow: 'council', args: { task: 'Fix it', seats: ['opus', 'astra'] } })) assert.equal('model' in r, false)

  // The setup preflight on the runtime lists the entries; a failure stops before any model turn.
  const env = codexRepo()
  try {
    const failing = argv => ({ status: 'error', vendors: { codex: { ok: true }, 'openrouter:a/b': { ok: false, error: 'OpenRouter has no model a/b (GET https://openrouter.ai/api/v1/models)' } } })
    const { runtime, calls } = recordingRuntime(env, { preflight: failing })
    const schema = { type: 'object', properties: { status: { type: 'string' }, preflight: { type: 'array', items: { type: 'object' } } }, required: ['status'] }
    const result = await runtime.agent({ prompt: 'p', schema, vendor: 'codex', model: 'gpt-6-astra', role: 'setup', run: null, label: 'setup', setupRunId: 'host-abc123-council', preflightVendors: ['codex', 'openrouter:a/b'] })
    assert.deepEqual(calls, [['preflight', '--vendors', 'codex,openrouter:a/b']])
    assert.equal(result.status, 'preflight')
    assert.deepEqual(result.preflight.find(p => p.vendor === 'openrouter:a/b'), { vendor: 'openrouter:a/b', ok: false, error: 'OpenRouter has no model a/b (GET https://openrouter.ai/api/v1/models)' })
  } finally { env.cleanup() }

  // A pinned runtime (an exported engine) with OpenRouter in its admission: the setup preflight
  // checks the admitted routes, with the model, and an OpenRouter turn is admitted.
  const { api, fixture } = await import('./fixtures/engine-package.mjs')
  const E = await api(), f = fixture(t), pin = E.exportEngine(f.source, f.output, f.target)
  const pinned = await import(pathToFileURL(join(pin.root, 'lib/codex-runner.mjs')).href)
  const pinEnv = codexRepo()
  try {
    const admission = [{ vendor: 'codex' }, { vendor: 'openrouter', model: 'a/b' }]
    const make = preflight => {
      const calls = []
      const execute = async argv => {
        calls.push(argv)
        if (argv[0] === 'preflight') return preflight
        return { status: 'done', seconds: 2, result: { ok: true } }
      }
      const runtime = pinned.createRuntime({ repo: pinEnv.repo, hostRunDir: pinEnv.hostRunDir, execute, gitDirs: [join(pinEnv.repo, '.git')], admission,
        env: { ...process.env, DARK_FACTORY_PIN: JSON.stringify(pin) } })
      return { runtime, calls }
    }
    const failed = make({ status: 'error', vendors: { codex: { ok: true }, 'openrouter:a/b': { ok: false, error: 'OPENROUTER_API_KEY is not set' } } })
    const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }
    const stopped = await failed.runtime.agent({ prompt: 'p', schema, vendor: 'codex', model: 'gpt-6-astra', role: 'setup', run: null, label: 'setup',
      setupRunId: 'host-abc123-council', preflightVendors: ['codex'] })
    assert.deepEqual(failed.calls, [['preflight', '--vendors', 'codex,openrouter:a/b']], 'the admitted routes, not the request, decide the list')
    assert.equal(stopped.status, 'preflight')
    assert.deepEqual(stopped.preflight.find(p => p.vendor === 'openrouter:a/b'), { vendor: 'openrouter:a/b', ok: false, error: 'OPENROUTER_API_KEY is not set' })
    const ok = make({ status: 'ok', vendors: {} })
    const turnSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    const admitted = await ok.runtime.turn({ key: 'A-r0', threadKey: 'A', configKey: 'A', vendor: 'openrouter', model: 'a/b', effort: 'high', role: 'seat',
      sandbox: 'read-only', cwd: pinEnv.repo, writable: [], run: pinEnv.run, prompt: 'p', schema: turnSchema })
    assert.equal(admitted.status, 'done', JSON.stringify(admitted))
    const argv = ok.calls.find(a => a[0] === 'seat-run')
    assert.deepEqual([value(argv, '--vendor'), value(argv, '--model'), value(argv, '--config-key')], ['openrouter', 'a/b', 'A'])
    // A vendor outside the admission is still refused as drift.
    await assert.rejects(ok.runtime.turn({ key: 'B-r0', vendor: 'claude', model: 'opus', run: pinEnv.run, prompt: 'p', schema: turnSchema }),
      e => e.code === 'ENGINE_DRIFT' && /Provider is outside pinned admission: claude/.test(e.message))
  } finally { pinEnv.cleanup() }

  // --prepare with the preflight failing: no model turn.
  const { runWorkflow } = await import('../plugins/dark-factory/lib/codex-runner.mjs')
  const prepEnv = codexRepo()
  try {
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: prepEnv.repo })
    const seen = []
    const prepare = async (options, repo) => {
      const r = policy.launchRequirements({}, { workflow: options.workflow, args: options.args })
      seen.push(Object.keys(r.vendors))
      return policy.launchReport({}, r, { vendors: Object.fromEntries(Object.keys(r.vendors).map(v => [v, v.startsWith('openrouter') ? { ok: false, error: 'OPENROUTER_API_KEY is not set' } : { ok: true }])) })
    }
    const out = await runWorkflow({ workflow: 'council', cwd: prepEnv.repo, prepare: true, args: { task: 'Fix it', seats: ['opus', 'astra', 'openrouter:a/b'] } }, { prepare })
    assert.equal(out.status, 'preflight')
    assert.ok(seen[0].includes('openrouter:a/b'))
    assert.ok(out.prepared.blocking.some(b => b.startsWith('openrouter:a/b CLI (author): OPENROUTER_API_KEY is not set')))
    assert.ok(!existsSync(join(prepEnv.repo, '.council', 'host-')), 'no host run was made')
  } finally { prepEnv.cleanup() }
})

test('recovery', async () => {
  for (const errorClass of ['model', 'leak', 'auth', 'quota', 'vendor']) {
    const requests = []
    const runtime = { turn: async r => { requests.push(r); return requests.length === 1 ? { status: 'error', error: 'failed', errorClass, recoverySession: 's' } : { status: 'error', error: 'again' } } }
    const h = harness({ args: { task: 'Fix it', host: 'codex', seats: ['openrouter:a/b', 'astra'] }, runtime })
    h.S.run = { runId: 'r', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
    const o = { key: 'A-r0', threadKey: 'A', configKey: 'A', vendor: 'openrouter', model: 'a/b', effort: 'high', role: 'seat', sandbox: 'workspace-write', cwd: '/r/wt/A', writable: ['/r/room'], fresh: false, recoveryPost: '/r/room/r0/A.md' }
    await h.externalTurn(o, 'solve', { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }, 'r0:A x', 'Solve')
    assert.equal(requests.length, errorClass === 'vendor' ? 2 : 1, errorClass)
    if (errorClass === 'vendor') assert.equal(requests[1].key, 'A-r0-recover')
    else assert.ok(h.S.notes.some(n => n.includes(`[${errorClass}]`)), h.S.notes.join('\n'))
  }
})
