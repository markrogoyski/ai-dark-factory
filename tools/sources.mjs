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
  'src/lib/report.js',
  'src/lib/tiers.js',
]
const SHARED = [
  'src/boot.js',
  'src/schemas.js',
  'src/turns.js',
  'src/council.js',
]
// meta first: the runtime reads `export const meta` from the top of the file.
export const TARGETS = {
  council: { output: 'plugins/dark-factory/workflows/council.js', order: ['src/00-meta.js', ...LIB, ...SHARED, 'src/main-council.js'] },
  factory: { output: 'plugins/dark-factory/workflows/factory.js', order: ['src/00-meta-factory.js', ...LIB, ...SHARED, 'src/simple.js', 'src/feature.js', 'src/architecture.js', 'src/main-factory.js'] },
}
