// Identity is supplied by adapters; policy never opens files or discovers authority.
function engineIdentityIssues(S, expected, observed) {
  const issues = []
  const valid = x => x && x.version === 1 && x.algorithm === 'sha256-path-content-mode-v1' &&
    /^[a-f0-9]{64}$/.test(x.packageDigest || '') && ['live', 'pinned'].includes(x.mode) &&
    typeof x.root === 'string' && ['node', 'python', 'git'].every(k => typeof x.runtimeVersions?.[k] === 'string') &&
    (x.mode !== 'pinned' || /^[a-f0-9]{40,64}$/.test(x.sourceRevision || ''))
  if (!valid(observed)) issues.push('Unsupported or missing executor identity')
  if (expected) {
    if (!valid(expected)) issues.push('Unsupported saved executor identity')
    for (const key of ['packageDigest', 'algorithm', 'mode']) {
      if (expected[key] !== observed?.[key]) issues.push(`Executor ${key} changed`)
    }
    if (expected.mode === 'pinned' && observed?.mode === 'pinned' && expected.sourceRevision !== observed.sourceRevision) issues.push('Executor sourceRevision changed')
    if (expected.mode === 'pinned' && observed?.mode === 'pinned' && JSON.stringify(expected.runtimeVersions) !== JSON.stringify(observed.runtimeVersions)) issues.push('Executor runtime changed')
  }
  return issues
}

function pinnedOperationIssues(S, expected, observed) {
  const issues = engineIdentityIssues(S, expected, observed?.executor)
  if (observed?.unknown?.length) issues.push(...observed.unknown.map(x => `Unknown write bounds: ${x}`))
  // Configured roots are private; the refusal names the reason, never the path.
  if (observed?.overlaps?.length) issues.push('Export overlaps writable root')
  if (observed?.settingsChanged) issues.push('Admitted provider settings changed')
  return issues
}

function provenanceFacts(S, facts) {
  return { version: 1, executor: facts?.executor || null, evaluator: facts?.evaluator || null,
    invocation: facts?.invocation || null, candidate: facts?.candidate || null,
    inputs: facts?.inputs || null }
}
