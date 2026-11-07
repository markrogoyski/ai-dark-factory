// Loads src/lib/*.js, the pure half of the workflow, for direct tests.
//
// The files are plain script fragments with no imports (the runtime allows none), so they are
// concatenated, wrapped in a function and handed back by name. The wrapper defines no `S` and no
// runtime globals: a lib function that reads either without being given it throws.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIB, PAIR_LIB } from '../tools/sources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadLib() {
  const source = [...LIB, ...PAIR_LIB].map(f => readFileSync(join(root, f), 'utf8')).join('\n')
  const names = [...source.matchAll(/^(?:async )?function (\w+)|^const (\w+)/gm)].map(m => m[1] || m[2])
  return new Function(`'use strict';\n${source}\nreturn { ${[...new Set(names)].join(', ')} }`)()
}

// A run in progress: config from `args`, a lineup such as 'A:claude B:claude C:codex D:gemini',
// positions and behaviour records for each seat, and a run directory. Returns {L, S}.
export function makeRun({ args = {}, lineup = 'A:claude B:claude C:codex D:gemini', criteria = ['C1', 'C2'] } = {}) {
  const L = loadLib()
  const S = L.newState(L.parseConfig({ task: 'Fix the parser', mode: 'implement', ...args }))
  S.run = { runId: 'run-1', runDir: '/r', repoRoot: '/repo', room: '/r/room' }
  S.seats = lineup.split(' ').map(x => {
    const [letter, vendor] = x.split(':')
    return { L: letter, key: letter.toLowerCase(), vendor, model: 'm', name: `${vendor}-${letter}`, effort: 'high', wt: `/r/wt/${letter}`, active: true }
  })
  S.criteria = criteria.map(id => ({ id, text: `criterion ${id}` }))
  for (const s of S.seats) {
    S.pos[s.L] = { round: 1, summary: `position ${s.L}`, opening: `position ${s.L}`, post: `/r/room/r1/${s.L}.md`, stats: null,
      delta: null, deltaRound: null, suite: null, criteria: null, gated: false, gateReasons: [] }
    S.behaviour[s.L] = { turns: [], capitulations: [], ignored: [] }
  }
  return { L, S }
}

// Adds a ledger item and sets the fields a ruling would: {round, author, kind, target, severity, status, ...}.
export function addItem(L, S, o) {
  const c = L.addClaim(S, { round: 1, kind: 'fact', target: o.author, statement: 'a claim', evidence: 'x', ...o })
  for (const k of ['status', 'fixed', 'conceded', 'withdrawn', 'note', 'ruledBy']) if (o[k] !== undefined) c[k] = o[k]
  return c
}
