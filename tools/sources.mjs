// The source files of each built workflow, in the order they are concatenated. The script runtime
// allows no imports, so each workflow is one file; src/ is how they are kept.
//   lib/*  pure functions of the state object: no runtime globals, so test/lib.mjs can load them.
//   the rest uses the runtime (agent, parallel, log, phase, args) or runs a flow.
export const LIB = [
  'src/lib/util.js',
  'src/lib/config.js',
  'src/lib/state.js',
  'src/lib/prompts.js',
  'src/lib/ledger.js',
  'src/lib/provenance.js',
  'src/lib/report.js',
  'src/lib/tiers.js',
  'src/lib/tier-simple.js',
  'src/lib/tier-feature.js',
  'src/lib/tier-architecture.js',
  'src/lib/controls.js',
  'src/lib/repair-prompts.js',
  'src/lib/evaluation.js',
  'src/lib/cost.js',
  'src/lib/ensemble.js',
]
// The runtime files a target is assembled from. Boot differs per workflow; the rest is shared.
const BOOT = 'src/boot.js'
const SCHEMAS = 'src/schemas.js'
const TURNS_CORE = 'src/turns-core.js'
const TURNS = 'src/turns.js'
const REPAIR = 'src/repair.js'
const COUNCIL_FLOW = 'src/council.js'
const PAIR_SCHEMAS = 'src/pair-schemas.js'
const PAIR_FLOW = 'src/pair.js'
// The debate engine: the council runs it, and the factory's tiers and the ensemble build on it.
const DEBATE = [SCHEMAS, TURNS_CORE, TURNS, REPAIR, COUNCIL_FLOW]
export const PAIR_LIB = ['src/lib/pair.js', 'src/lib/pair-prompts.js']
export const HANDOFF_LIB = ['src/lib/handoff.js']
export const RUN_PLAN_LIB = ['src/lib/run-plan.js']
export const POLICY_LIB = [...new Set([...LIB, ...PAIR_LIB, 'src/lib/provider-policy.js'])]
export const POLICY_EXPORTS = ['engineIdentityIssues', 'launchReport', 'launchRequirements', 'pairAnswerMessage', 'pairResumeAnswerCheck', 'pinnedOperationIssues', 'promptHash', 'provenanceFacts', 'providerConfiguration', 'reachableProviders', 'withdrawResume']
// meta first: the runtime reads `export const meta` from the top of the file.
export const TARGETS = {
  policy: { output: 'plugins/dark-factory/lib/policy.mjs', order: POLICY_LIB, trailer: `export { ${POLICY_EXPORTS.join(', ')} }\n` },
  'run-plan': { output: 'plugins/dark-factory/workflows/run-plan.js', order: ['src/00-meta-run-plan.js', ...RUN_PLAN_LIB, 'src/main-run-plan.js'] },
  ensemble: { output: 'plugins/dark-factory/workflows/ensemble.js', order: [
    'src/00-meta-ensemble.js', ...LIB, 'src/boot-ensemble.js', SCHEMAS, 'src/ensemble-schemas.js', TURNS_CORE, TURNS, REPAIR, COUNCIL_FLOW, 'src/main-ensemble.js'] },
  council: { output: 'plugins/dark-factory/workflows/council.js', order: [
    'src/00-meta.js', ...LIB, ...HANDOFF_LIB, BOOT, ...DEBATE, 'src/simple.js', 'src/feature.js', 'src/architecture.js', 'src/delegated.js', 'src/main-council.js'] },
  factory: { output: 'plugins/dark-factory/workflows/factory.js', order: [
    'src/00-meta-factory.js', ...LIB, ...PAIR_LIB, 'src/boot-factory.js', ...DEBATE, PAIR_SCHEMAS, PAIR_FLOW, 'src/simple.js', 'src/feature.js', 'src/architecture.js', 'src/brief.js', 'src/main-factory.js'] },
  pair: { output: 'plugins/dark-factory/workflows/pair.js', order: [
    'src/00-meta-pair.js', ...LIB, ...PAIR_LIB, ...HANDOFF_LIB, 'src/boot-pair.js', SCHEMAS, PAIR_SCHEMAS, TURNS_CORE, TURNS, PAIR_FLOW, 'src/main-pair.js'] },
}
