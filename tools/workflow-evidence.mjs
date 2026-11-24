import { isDeepStrictEqual } from 'node:util'

export const RUN_ID = /^wf_[A-Za-z0-9_-]+$/
// The L2 verdict IDs, shared by the Factory checker and the candidate's verdict check.
export const L2_REQUIRED = Object.freeze(['L2-i', 'L2-ii', 'L2-iii', 'L2-iv', 'L3'])
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

export function launched(call) {
  const output = call?.output
  return !call?.error && output?.status === 'async_launched' &&
    typeof output.taskId === 'string' && output.taskId !== '' && RUN_ID.test(output.runId ?? '')
}

export function journalGrowth(before, after) {
  const original = new Map()
  for (const row of before) {
    if (!original.has(row.directory)) original.set(row.directory, [])
    original.get(row.directory).push(row)
  }
  const offsets = new Map()
  const fresh = []
  for (const row of after) {
    const offset = offsets.get(row.directory) ?? 0
    const old = original.get(row.directory) ?? []
    if (offset >= old.length) fresh.push(row)
    else if (!isDeepStrictEqual(row, old[offset])) return null
    offsets.set(row.directory, offset + 1)
  }
  return [...original].every(([directory, rows]) => (offsets.get(directory) ?? 0) >= rows.length) ? fresh : null
}

// Keep native task state distinct from the Factory result embedded in it.
export function factoryResultFor(call, state, terminal) {
  if (!launched(call)) return null
  const { runId, taskId } = call.output
  if (terminal && (terminal.session !== call.session || terminal.taskId !== taskId ||
      (terminal.toolUseId && terminal.toolUseId !== call.toolUseId) || !(terminal.line > call.line))) terminal = null
  if (state?.taskId !== taskId) return null
  if ((state.runId && state.runId !== runId) || (terminal && terminal.status !== state.status)) {
    throw new Error('Conflicting native Factory task state')
  }
  if (state.status !== 'completed') return null
  const decode = result => {
    const value = typeof result === 'string' ? parseJson(result) : result
    return isObject(value) && typeof value.status === 'string' ? value : null
  }
  const saved = decode(state.result)
  const notified = decode(terminal?.result)
  if (saved && notified && !isDeepStrictEqual(saved, notified)) throw new Error('Conflicting Factory results')
  return saved ?? notified
}
