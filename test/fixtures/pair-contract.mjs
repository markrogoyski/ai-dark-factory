export const contract = () => ({ testRoots: [{ path: 'tests', evidence: 'Base tests/ contains existing regression tests.' }], checks: [
  { id: 'T1', criteria: ['C1'], kind: 'test', purpose: 'changed', scenario: 'Call the requested operation at its boundary.',
    expected: 'The correct boundary value is returned.', boundaries: 'Zero and the adjacent value.',
    file: 'tests/changed.cjs', command: 'node tests/changed.cjs', fixtures: [], inspection: '', reason: '' },
  { id: 'T2', criteria: ['C1'], kind: 'test', purpose: 'preserved', scenario: 'Call the established ordinary operation.',
    expected: 'The existing value is retained.', boundaries: 'Ordinary nonzero input.',
    file: 'tests/preserved.cjs', command: 'node tests/preserved.cjs', fixtures: [], inspection: '', reason: '' },
] })
export const mapping = () => contract().checks.map(c => ({ file: c.file, command: c.command, checkIds: [c.id], fixtures: c.fixtures }))
export const challenges = () => [{ criterion: 'C1', wrongImplementation: 'Return the adjacent value instead of the boundary.', rejectingCheckIds: ['T1'] }]
export const replay = tree => ({ base: 'b'.repeat(40), snapshot: 'c'.repeat(40), snapshotTree: tree,
  testRoots: ['tests'], mapping: mapping(), changes: [], exclusions: [], elapsedSec: 1,
  records: mapping().flatMap((m, i) => ['base', 'final'].map(side => ({
    side, revision: (side === 'base' ? 'b' : 'c').repeat(40), tree: side === 'base' ? 'd'.repeat(40) : tree,
    file: m.file, command: m.command, checkIds: m.checkIds, attempted: true, ran: true,
    passed: side === 'final' || i === 1, hasExitCode: true, exitCode: side === 'base' && i === 0 ? 1 : 0,
    signal: 0, timedOut: false, seconds: 0.1, log: `/logs/${side}-${i}.log`, launchError: '', mutated: [], reused: false,
  }))) })

// What `dark-factory measure` records beyond the engine's view: the Codex runtime returns this whole.
export const helperRecord = m => ({ ...m, job: 'measure-A-x', seat: 'A', tree: m.snapshot?.tree, verification: { command: 'node test.cjs', env: {} },
  scratch: true, postWords: 12, crossTests: [], elapsedSec: 3.5, evidence: null, reused: false,
  snapshot: m.snapshot && { ...m.snapshot, commit: 'c'.repeat(40), files: 2 },
  suite: m.suite && { ...m.suite, tail: 'OK (3 tests)', exitCode: 0, timedOut: false, seconds: 1.5, cwd: '/scratch/gate', env: {}, attempts: [{ exitCode: 0 }] },
  replay: m.replay && { ...m.replay, records: (m.replay.records || []).map((r, i) => ({ ...r, cwd: `/scratch/${r.side}/${i}`, logSha256: 'e'.repeat(64), tail: `raw output ${i}` })) } })
