// The native driver snapshots each boundary before running the next invocation.
// Judges use those snapshots so manual and automatic captures can share the checks.
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RUN_ID, factoryResultFor, journalGrowth, launched } from './workflow-evidence.mjs'

const FACTORY = 'dark-factory:factory'
const BUDGET_REASON = 'Run turn budget exhausted (2).'
const ROUTES = {
  'L2-i': { tier: 'simple', strategy: 'independent' },
  'L2-ii': { tier: 'simple', strategy: 'pair' },
  'L2-iii': { tier: 'fix', strategy: 'independent' },
  'L2-iv': { tier: 'simple', strategy: 'independent' },
  L3: { tier: 'simple', strategy: 'pair' },
}
const isText = value => typeof value === 'string' && value.trim() !== ''
const same = isDeepStrictEqual

function pathAt(path) {
  if (!isText(path) || !isAbsolute(path)) throw new Error('Expected an absolute setup path')
  return realpathSync(path)
}

function runLayout(root, dir = '') {
  const entries = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other'
    entries.push({ path, type })
    if (entry.isDirectory()) entries.push(...runLayout(root, path))
  }
  return entries
}

export function snapshotRunDirectory(path, { repo, head }) {
  const fixture = pathAt(repo)
  const runDir = pathAt(path)
  const runId = basename(runDir)
  if (runDir !== join(fixture, '.council', runId) || !statSync(runDir).isDirectory()) {
    throw new Error('Setup directory is outside its fixture .council directory')
  }
  const runFile = join(runDir, 'run.json')
  if (!lstatSync(runFile).isFile()) throw new Error('Setup run.json is not a regular file')
  const record = JSON.parse(readFileSync(runFile, 'utf8'))
  if (!isText(head) || record.head !== head || record.runId !== runId || pathAt(record.repoRoot) !== fixture ||
      pathAt(record.runDir) !== runDir || pathAt(record.room) !== join(runDir, 'room') || !statSync(record.room).isDirectory()) {
    throw new Error('Setup run.json does not match the fixture root, seed HEAD or run directory')
  }
  return { repo: fixture, head, runId, runDir, room: join(runDir, 'room'), layout: runLayout(runDir) }
}

const attemptKey = row => JSON.stringify([row.directory, row.key, row.agentId])
const settles = row => row.type === 'result' || row.type === 'failed'
const success = row => row?.type === 'result' && row.result != null
const payload = row => {
  if (typeof row?.result !== 'string') return row?.result
  try { return JSON.parse(row.result) } catch { return null }
}

function attemptsIn(rows) {
  if (!Array.isArray(rows)) throw new Error('Missing native attempt journal')
  const attempts = new Map()
  rows.forEach((row, index) => {
    if (row.type !== 'started' && !settles(row)) return
    if (![row.key, row.agentId, row.directory].every(isText)) throw new Error('Missing attempt identity')
    const key = attemptKey(row)
    const attempt = attempts.get(key)
    if (row.type === 'started') {
      if (!isText(row.label) || attempt) throw new Error('Unlabelled or duplicate agent start')
      attempts.set(key, { start: row, index })
    } else {
      if (!attempt || attempt.end) throw new Error('Missing start or contradictory agent result')
      attempt.end = row
      attempt.endIndex = index
    }
  })
  return [...attempts.values()]
}

function launchIs(call, fresh) {
  return launched(call) && isText(call.session) && call.input?.name === FACTORY &&
    (fresh ? call.input.resumeFromRunId === undefined : isText(call.input.resumeFromRunId))
}

function completedResult(id, snapshot) {
  if (snapshot.observationError) throw new Error(snapshot.observationError)
  const result = factoryResultFor(snapshot.call, snapshot.state, snapshot.terminal)
  if (!result || !Number.isSafeInteger(result.metrics?.turns) || result.metrics.turns < 0) {
    throw new Error('Missing completed Factory result or metrics.turns')
  }
  const { tier, strategy } = ROUTES[id]
  if (result.metrics.workflow !== 'factory' || result.metrics.tier !== tier || result.metrics.strategy !== strategy) {
    throw new Error(`Factory result did not stay on the ${tier}/${strategy} route`)
  }
  return result
}

function namesRun(result, directory) {
  return isText(result?.runDir) && (result.runDir === directory.runDir || pathAt(result.runDir) === directory.runDir)
}

function setupDirectory(attempts, directory) {
  const [intake, setup] = attempts
  const detail = payload(setup?.end)
  if (!directory?.layout?.length || intake?.start.label !== 'intake' || setup?.start.label !== 'setup' ||
      !success(intake.end) || payload(intake.end)?.status !== 'ok' || intake.endIndex >= setup.index ||
      !success(setup.end) || detail?.status !== 'ok' || detail.runId !== directory.runId ||
      pathAt(detail.repoRoot) !== directory.repo || !namesRun(detail, directory)) {
    throw new Error('Missing successful intake and setup with a matching on-disk run directory')
  }
  return setup
}

function budgetStop(result) {
  return result.status === 'blocked' && result.stopReason === BUDGET_REASON && result.metrics.turns === 2
}

const parentResume = text => /\bWorkflow\(\{\s*name:\s*["']dark-factory:factory["']\s*,\s*resumeFromRunId:/.test(text)
const questionsIn = result => Array.isArray(result.questions) && result.questions.length > 0 &&
  result.questions.every(question => isText(question.id) && isText(question.question)) &&
  new Set(result.questions.map(question => question.id)).size === result.questions.length

const stopped = status => status === 'killed' || status === 'stopped'
const solveLabel = /^r0:A\s+\S+/

export function factoryCancelBoundary(rows) {
  const attempts = attemptsIn(rows)
  const [intake, setup, solve] = attempts
  if (attempts.length !== 3 || intake?.start.label !== 'intake' || setup?.start.label !== 'setup' ||
      payload(intake.end)?.status !== 'ok' || payload(setup.end)?.status !== 'ok' ||
      intake.endIndex >= setup.index || setup.endIndex >= solve.index || !solveLabel.test(solve.start.label) || solve.end) return null
  return { start: solve.start, runDir: payload(setup.end).runDir }
}

function cancelledAttempt(snapshot, attempts, setup) {
  const { call, state, terminal, active } = snapshot
  const { taskId, runId } = call.output
  if (state?.taskId !== taskId || (state.runId && state.runId !== runId) || !stopped(state.status) ||
      (terminal && (terminal.session !== call.session || terminal.taskId !== taskId ||
        (terminal.toolUseId && terminal.toolUseId !== call.toolUseId) || terminal.line <= call.line || !stopped(terminal.status)))) {
    throw new Error('Missing correlated native cancellation')
  }
  const solve = attempts[2]
  if (attempts.length !== 3 || setup.endIndex >= solve.index || !solveLabel.test(solve.start.label) ||
      active?.transcript !== true || !active.start || attemptKey(active.start) !== attemptKey(solve.start) || solve.end) {
    throw new Error('The first post-setup agent was not observed active before cancellation')
  }
  return solve
}

// Only the current invocation's workflowProgress shows what it replayed: a retained journal
// still holds every earlier attempt even when this invocation recovered only part of the prefix.
function requireCachedReplay(state, replay, fresh) {
  const progress = Array.isArray(state?.workflowProgress)
    ? state.workflowProgress.filter(entry => entry?.type === 'workflow_agent') : null
  if (!progress) throw new Error('Missing native workflowProgress for the resumed invocation')
  const cached = progress.filter(entry => entry.cached === true)
  const matches = (entry, start) => entry.label === start.label && (entry.agentId == null || entry.agentId === start.agentId)
  if (cached.length !== replay.length || !replay.every(({ start }, index) =>
    cached.filter(entry => entry.index === index + 1 && matches(entry, start)).length === 1)) {
    throw new Error('The resumed invocation did not report every prior position as cached')
  }
  const live = progress.filter(entry => entry.cached !== true)
  if (live.length !== fresh.length || !fresh.every(({ start }) => live.some(entry => matches(entry, start))) ||
      !live.every(entry => fresh.some(({ start }) => matches(entry, start)))) {
    throw new Error('The resumed invocation\'s fresh agents do not match its journal growth')
  }
}

const positions = (attempts, offset = 0) => attempts.map(({ start }, index) => ({ position: offset + index + 1, label: start.label }))

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// The execution plan (src/lib/controls.js executionPlan): participants, reviewers, panel, spec
// reviewers and roles with their models and efforts, required CLIs, verification and limits.
// Its intake is the intake agent's own answer, so it is left out.
const planOf = ({ intake, ...plan }) => plan

// The full observation is saved with each judgment; compareLegs reads only its protocol fields.
function observation(id, snapshot, result, replayed, newStarts) {
  const { call, directory, rows } = snapshot
  const childIds = rows.map(row => basename(row.directory ?? '')).filter(id => RUN_ID.test(id))
  return {
    scenario: id,
    status: result?.status ?? 'canceled',
    stop: { stage: result?.stage ?? null, round: result?.round ?? null,
      questionKinds: Array.isArray(result?.questions) ? result.questions.map(question => question?.kind ?? null) : [] },
    stopReason: result?.stopReason ?? null,
    resumeText: result?.resumeSteps ?? (result?.status === 'needs-user' ? result.forTheOrchestrator ?? null : null),
    replayed, newStarts,
    runDirectory: { path: directory.runDir, layout: directory.layout },
    metrics: result ? { turns: result.metrics.turns } : null,
    // What the run was configured to do, from args rather than models: a handoff that dropped an
    // arg (audit: false, pair.maxReviews) shows here even when both legs end done.
    route: result ? { workflow: result.metrics.workflow, tier: result.metrics.tier, strategy: result.metrics.strategy,
      limits: result.metrics.limits ?? null } : null,
    plan: isObject(result?.plan) ? planOf(result.plan) : null,
    identities: {
      repo: directory.repo, room: directory.room, runDir: directory.runDir, runId: directory.runId,
      nativeIds: [call.session, call.output.runId, call.output.taskId, ...childIds, ...rows.map(row => row.agentId)].filter(isText),
    },
  }
}

function firstBoundary(id, snapshot) {
  if (!Object.hasOwn(ROUTES, id)) throw new Error(`Unknown Factory scenario ${id}`)
  if (!launchIs(snapshot.call, true)) throw new Error(snapshot.observationError ?? 'Missing fresh Factory launch')
  if (snapshot.observationError || snapshot.directoryError) {
    throw new Error(snapshot.observationError ?? snapshot.directoryError)
  }
  const attempts = attemptsIn(snapshot.rows)
  const setup = setupDirectory(attempts, snapshot.directory)
  if (id === 'L2-iv') {
    return { attempts, interrupted: cancelledAttempt(snapshot, attempts, setup), result: null }
  }

  const result = completedResult(id, snapshot)
  if (!namesRun(result, snapshot.directory) || attempts.some(attempt => !attempt.end)) {
    throw new Error('Missing same-directory result or unfinished first-leg attempt')
  }
  if (id === 'L2-i') {
    if (attempts.length !== 2 || !budgetStop(result)) throw new Error('Expected the two-turn blocked result immediately after setup')
  } else if (id === 'L2-iii') {
    if (result.status !== 'needs-user' || result.round !== 'spec' || !questionsIn(result) || !parentResume(result.forTheOrchestrator)) {
      throw new Error('Expected a Fix spec question and parent Factory resume')
    }
  } else if (result.status !== 'needs-user' || result.workflow !== 'factory' || result.strategy !== 'pair' ||
      result.tier !== ROUTES[id].tier || result.stage !== 'design' ||
      result.resumable !== true || !questionsIn(result) || !result.questions.every(question => isText(question.kind)) ||
      !parentResume(result.resumeSteps)) {
    // Any Pair question before the implementation will do (setup's, the author's, the reviewer's
    // or the design allowance's): the fixture reserves a decision for the maintainer.
    throw new Error('Expected a resumable Pair question at the design stage and parent Factory resume')
  }
  return { attempts, result }
}

export function judgeFirstLeg(id, snapshot) {
  try {
    const { attempts, result } = firstBoundary(id, snapshot)
    return { status: 'pass', observed: observation(id, snapshot, result, [], positions(attempts)) }
  } catch (error) {
    return { status: 'inconclusive', reason: error.message }
  }
}

function resumeArgs(original, call, firstResult) {
  const before = original.input.args
  if (!firstResult?.questions) {
    if (!same(before, call.input.args)) throw new Error('Resume changed the original arguments')
    return []
  }
  const { clarifications, ...base } = call.input.args
  const { clarifications: earlier = [], ...initial } = before
  if (!same(base, initial) || !Array.isArray(clarifications) || !same(clarifications.slice(0, earlier.length), earlier)) {
    throw new Error('Resume changed arguments other than appending clarifications')
  }
  const added = clarifications.slice(earlier.length)
  if (added.length !== firstResult.questions.length || !firstResult.questions.every(question =>
    added.filter(answer => answer.id === question.id && isText(answer.answer) &&
      // Pair accepts implement only on a design-allowance question, and it is required there.
      (question.kind === 'design' ? answer.implement === true : answer.implement === undefined)).length === 1)) {
    throw new Error('Resume did not answer the questions at this boundary')
  }
  return added
}

function requireAnsweredSuffix(id, result, fresh, answers) {
  const first = fresh[0]
  if (id === 'L2-iii') {
    if (first?.start.label !== 'spec amend' || !success(first.end) || !payload(first.end)?.criteria?.length ||
        !answers.every(answer => result.spec?.answered?.includes(answer.id))) {
      throw new Error('Resume did not complete spec amendment with the recorded answers')
    }
  } else if (first?.start.label !== `resume-check ${answers[0].id}` || payload(first.end)?.status !== 'ok' ||
      !answers.every(answer => result.decisions?.some(decision => decision.id === answer.id &&
        decision.answer === answer.answer && (decision.implement === true) === (answer.implement === true)))) {
    throw new Error('Resume did not complete the Pair check and apply the answer')
  }
}

export function judgeResume(id, first, resumed) {
  try {
    const boundary = firstBoundary(id, first)
    const original = first.call
    const { call, directory } = resumed
    if (!launchIs(call, false)) throw new Error(resumed.observationError ?? 'Missing Factory resume launch')
    if (call.session !== original.session || call.input.resumeFromRunId !== original.output.runId ||
        call.output.taskId === original.output.taskId || !(call.line > original.resultLine) ||
        (first.terminal && !(call.line > first.terminal.line))) throw new Error('Resume is not of the original parent in its session')
    const answers = resumeArgs(original, call, boundary.result)
    const result = completedResult(id, resumed)
    if (resumed.directoryError) throw new Error(resumed.directoryError)
    const initial = first.directory
    if (!directory?.layout?.length || directory.runDir !== initial.runDir || directory.repo !== initial.repo ||
        directory.head !== initial.head || !namesRun(result, initial)) throw new Error('Resume did not reuse its original setup directory')

    const freshRows = journalGrowth(first.rows, resumed.rows)
    if (!freshRows) throw new Error('Resume journal does not extend the original journal')
    const fresh = attemptsIn(freshRows)
    const replay = boundary.attempts.filter(attempt => attempt !== boundary.interrupted)
    const oldKeys = new Set(replay.map(attempt => attempt.start.key))
    const oldAgentIds = new Set(boundary.attempts.map(attempt => attempt.start.agentId))
    if (fresh.some(({ start, end }) => oldKeys.has(start.key) || oldAgentIds.has(start.agentId) ||
        start.label === 'intake' || /^setup(?:$|-answered)/.test(start.label) || !end)) {
      throw new Error('Resume restarted a prior position or left a new attempt incomplete')
    }
    requireCachedReplay(resumed.state, replay, fresh)
    if (id === 'L2-i') {
      if (fresh.length || !budgetStop(result)) throw new Error('Budget resume must replay intake/setup and start no agents')
    } else {
      if (result.status === 'failed' || result.status === 'error' || !fresh.length) {
        throw new Error('Missing continued Factory outcome')
      }
      if (id === 'L2-iv') {
        const old = boundary.interrupted.start, restart = fresh[0]
        if (restart.start.key !== old.key || restart.start.agentId === old.agentId ||
            restart.start.label !== old.label || !success(restart.end)) throw new Error('Interrupted agent did not restart and complete')
      } else requireAnsweredSuffix(id, result, fresh, answers)
    }
    return { status: 'pass', observed: observation(id, resumed, result, positions(replay), positions(fresh, replay.length)) }
  } catch (error) {
    return { status: 'fail', reason: error.message }
  }
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const timestamp = /(?<!\d)\d{8}-\d{6}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g
// Content-addressed names, such as evidence/A-<sha256>, follow whatever bytes the model wrote.
const contentHash = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/g

function normalizeObservation(observed) {
  const { identities, ...fields } = observed
  const { repo, room, runDir, runId, nativeIds } = identities
  const paths = new Map([[room, '<room>'], [runDir, '<run-dir>'], [repo, '<fixture>']])
  const ids = new Map([[runId, '<run-id>'], ...nativeIds.map(id => [id, '<native-id>'])])
  const alternatives = values => [...values.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const pathPattern = new RegExp(`(?:${alternatives(paths)})(?![A-Za-z0-9_.-])`, 'g')
  const idPattern = new RegExp(`(?<![A-Za-z0-9_])(?:${alternatives(ids)})(?![A-Za-z0-9_])`, 'g')
  const normalize = value => {
    if (typeof value === 'string') {
      return value.replace(pathPattern, path => paths.get(path))
        .replace(idPattern, id => ids.get(id)).replace(timestamp, '<timestamp>').replace(contentHash, '<sha>')
    }
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
    }
    return value
  }
  const normalized = normalize(fields)
  normalized.runDirectory.layout.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type))
  return normalized
}

// The candidate and its inline control are independent model runs, so parity compares the
// protocol the handoff must keep, not what the models did. Stop reasons carry model-dependent
// finding counts, and a leg that runs to completion varies in review rounds, turns, later agent
// labels and the files under wt/; a model-decided stop varies in how many questions it asks and
// in the probes and jobs before it. Compared: the status; the stop's kind (stage, round, and the
// set of question kinds); the route and limits in metrics and the execution plan (models, efforts, reviewers,
// limits), which follow the args the handoff carried; whether the resume text names the parent
// Factory; the replayed prefix (positions and labels); on a resume, the first fresh agent after
// it; and the run-directory layout without wt/, with IDs,
// timestamps and content hashes normalised. L2-i is deterministic (a budget stop after setup and
// a resume that only replays), so its stop reason, turns, question kinds and full layout are
// compared exactly; elsewhere only the layout's top level is, since the models' probes and review
// rounds add room and job entries.
const DETERMINISTIC = new Set(['L2-i'])

function protocolOf(observed, phase) {
  const normalized = normalizeObservation(observed)
  const fixed = DETERMINISTIC.has(observed.scenario)
  const layout = normalized.runDirectory.layout.filter(entry => entry.path.split(sep)[0] !== 'wt')
  return {
    status: normalized.status,
    stop: fixed ? normalized.stop : { ...normalized.stop, questionKinds: [...new Set(normalized.stop.questionKinds)].sort() },
    route: normalized.route ?? null,
    plan: normalized.plan ?? null,
    ...(fixed ? { stopReason: normalized.stopReason, turns: normalized.metrics?.turns ?? null } : {}),
    resumeNamesFactory: typeof observed.resumeText === 'string' && observed.resumeText.includes(FACTORY),
    replayed: normalized.replayed,
    // A first leg always starts with intake; after a resume the first fresh agent is the handoff's.
    ...(phase === 'resume' ? { firstFresh: normalized.newStarts[0]?.label ?? null } : {}),
    runDirectory: fixed ? layout : [...new Set(layout.map(entry => entry.path.split(sep)[0]))].sort(),
  }
}

// Each leg contains the independent first-leg and resume judgments. Both phases must pass on
// both legs; only the named phases are compared. L3 compares only the resume: its inline first
// stop and the control's are two independent runs, each judged on its own.
export function compareLegs(control, candidate, { phases = ['first', 'resume'] } = {}) {
  for (const [mode, leg] of [['inline', control], ['candidate', candidate]]) {
    for (const phase of ['first', 'resume']) {
      const check = leg?.[phase]
      if (check?.status !== 'pass') {
        const status = phase === 'first' && check?.status === 'inconclusive' ? 'inconclusive' : 'fail'
        return { status, reason: `${mode} ${phase}: ${check?.reason ?? 'missing passing evidence'}` }
      }
    }
  }
  const differences = []
  for (const phase of phases) {
    const inline = protocolOf(control[phase].observed, phase)
    const split = protocolOf(candidate[phase].observed, phase)
    for (const field of Object.keys(inline)) {
      if (!same(inline[field], split[field])) differences.push({ field: `${phase}.${field}`, inline: inline[field], candidate: split[field] })
    }
  }
  return differences.length
    ? { status: 'fail', reason: `Parity differs in ${differences.map(item => item.field).join(', ')}`, differences }
    : { status: 'pass' }
}
