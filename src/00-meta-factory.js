export const meta = {
  name: 'factory',
  description: 'Routes one task to the process it needs: a simple change gets one implementer and one reviewer, harder work the council; escalates on evidence',
  whenToUse: 'Use for implementation work the user wants done end to end with independent review, when it is not obvious how much process it needs. An Opus intake reads the task and the code and picks a tier: simple (Sonnet implements, Codex Astra reviews, at most one fix pass: about 6-9 agent turns), fix (a subtle bug: Opus and Astra attempt it blind and debate, through /council), feature (Opus and Astra each plan it blind and debate the plans; the chosen plan, merged with the best of the other, is built by its author in at most 4 checked increments, then audited for correctness, design and tests: about 25-40 agent turns) or architecture (a request for a design or plan, or one connected piece of work too big for one feature: Opus, Astra and Sonnet design it blind and debate the designs; the chosen design\'s author writes a milestone plan, reviewed for grounding (Astra), sequencing (Opus) and risk and alternatives (Gemini Flash) and revised once; nothing is built: about 35-50 agent turns). The lowest tier that plausibly suffices is chosen, because a run whose tier the evidence shows is too low hands the work to a higher tier automatically, in the same run: Simple on failing verification after its fix pass, an upheld design finding, a change over its size budget, or the implementer saying so; Feature when its chosen plan needs more than 4 increments, which goes to architecture before anything is built. An architecture result lists milestones[], each with a task, draft criteria, the earlier milestones it builds on, a tier and ready-made args: show them, then offer to run each as its own /factory run with Workflow({name: "factory", args: milestones[i].args}), one at a time and in order, committing each before the next; never start one unasked. When the user names a tier, pass it in `tier` (or prefix a string task with --tier simple); if intake disagrees, the run stops with status needs-tier before creating anything, and you ask the user once: rerun with tierConfirmed: true to keep their tier, or with intake\'s. A kept tier is where the run starts, not a ceiling. When the task bundles separate pieces of work (a checklist, several fixes with their own causes, one commit per item), intake stops the run with status needs-split and lists them: ask the user once whether to run each piece as its own /factory run, in order and committing each before the next, or the whole task as one (rerun with noSplit: true). Seats work in git worktrees checked out from HEAD, so they cannot see uncommitted files: if the work follows a plan or other document that is not committed (a plan from plan mode under ~/.claude/plans/, an untracked PLAN.md, a checklist), pass its absolute path in `plan`, e.g. {task: "Do item 13 on the bug checklist", plan: ["/abs/path/BUG_CHECK_LIST.md"]}, and say in the task which part to do; do not paste the document. `simple: {implementer, reviewer, maxLines, maxFiles}` changes the Simple tier; every /council argument (seats, spec, audit, rounds, ...) passes through to the council tiers, audit: {tests: <model>} swaps the Feature tier\'s tests auditor (Sonnet), and audit: {risk: <model>} the Architecture tier\'s risk reviewer (Gemini Flash; swap it for "sonnet" if the Antigravity CLI is unavailable).',
  phases: [
    { title: 'Intake', detail: 'reads the task and the code, and picks the tier the work needs', model: 'opus' },
    { title: 'Setup', detail: 'worktrees, room, and acceptance criteria fixed before anyone starts', model: 'opus' },
    { title: 'Spec', detail: 'council tiers: two reviewers attack the acceptance criteria before work begins' },
    { title: 'Solve', detail: 'the change, the plans or designs, or every seat working alone and blind; neutral checks' },
    { title: 'Round 1', detail: 'critique, challenge, adopt, revise, vote; neutral checks and adjudication' },
    { title: 'Round 2', detail: 'critique, challenge, adopt, revise, vote; neutral checks and adjudication' },
    { title: 'Round 3', detail: 'critique, challenge, adopt, revise, vote; neutral checks and adjudication' },
    { title: 'Synthesize', detail: 'the winning author folds in amendments and fixes standing findings, or writes the final plan or the milestone plan' },
    { title: 'Ratify', detail: 'the other seats sign off or object; one fix pass for upheld objections' },
    { title: 'Build', detail: 'feature: the chosen plan, built one increment a turn, each checked' },
    { title: 'Audit', detail: 'the review of the change, the council\'s independent audit, or the review of the milestone plan; one fix pass or revision for what is upheld' },
    { title: 'Retro', detail: 'one agent reviews the process notes and suggests changes to the workflow', model: 'sonnet' },
    { title: 'Record', detail: 'the run facts are saved for tuning the router', model: 'haiku' },
  ],
}

// GENERATED by tools/build.mjs from the files under src/: edit those, then `make build` (install.sh does).

// factory — routes one task to the process it needs, and hands it up when the evidence says so.
//
//   /factory <task>            /factory --tier simple <task>
//   args: {task, tier, tierConfirmed, noSplit, simple, plan, ...every /council argument}
//   tier:  'simple' | 'fix' | 'feature' | 'architecture'; unset, the Opus intake picks it. A pinned tier
//          intake disagrees with stops the run (needs-tier) until it is confirmed (tierConfirmed: true).
//   noSplit: run a task intake would split into separate runs (needs-split) as one.
//   simple: {implementer: 'sonnet', reviewer: 'astra', maxLines: 200, maxFiles: 8}
//
// Shape: Intake -> [needs-plan | needs-split | needs-tier] ->
//   simple:  Setup (1 seat) -> Solve -> check -> Review (-> panel) -> one fix pass -> check -> facts
//            (handed up to fix or feature when simpleTrigger fires: a fresh state and that tier's flow)
//   feature: Setup -> Spec -> plans (Solve, Rounds) -> final plan (Synthesize) -> Build, one increment
//            a turn, each checked -> Audit (correctness, design, tests) -> one fix pass -> re-review
//            (handed up to architecture, before the build, when the plan needs more than 4 increments)
//   architecture: Setup -> Spec -> designs (Solve, Rounds) -> final design and milestone plan
//            (Synthesize) -> Audit (grounding, sequencing, risk) -> one revision -> re-review; nothing built
//   fix: the council (see council.js), with Opus and Astra.
// Every factory run records its facts (lib/tiers.js runFacts) for `council retro --summary`; the
// model retro runs only on notable runs.
