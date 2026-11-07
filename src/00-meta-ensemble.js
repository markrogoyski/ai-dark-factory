export const meta = {
  name: 'ensemble',
  description: 'Solve one task N independent ways, cross-review every candidate, return them ranked for you to pick or merge',
  whenToUse: 'Use for a task worth more than one attempt: a subtle bug, a design with real trade-offs, or an investigation where the obvious answer may be wrong. Runs N independent solvers with distinct stances, reviews each through several lenses, and hands the ranked candidates back to the main agent to pick or merge. Not for mechanical or already-understood work.',
  phases: [
    { title: 'Solve', detail: 'N independent attempts, each with a different stance', model: 'sonnet' },
    { title: 'Review', detail: 'each candidate judged through several blind lenses; judgement lenses on Opus, checking lenses on Sonnet' },
    { title: 'Compare', detail: 'head-to-head ranking and merge plan (advisory)', model: 'opus' },
  ],
}
