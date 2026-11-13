# Council

[Documentation index](README.md) · [Project README](../README.md)

The council is the multi-model debate behind `/dark-factory:council` and the Fix tier of the factory.

## How a council run goes

This is the council flow that `/dark-factory:council` and the factory's Fix tier run. The Feature
and Architecture tiers reuse its setup, spec review and debate stages.

```text
  setup (Opus)        preflight, run dir, a worktree per seat, gate, baseline, criteria
     |
  spec review         coverage (Astra) + intent (Opus) --> panel rules --> amend criteria,
     |                assume the conservative reading, or stop and ask (spec: 'ask')
     v
  round 0, blind      each seat solves alone in its own worktree
     |
  neutral checks      snapshot each position; run the gate and published tests in a
     |                disposable checkout; rule VERIFIED / REFUTED / FABRICATED / UNRESOLVED
     |
     +-- every tree identical and passing (implement)? ---------------------+
     v                                                                      |
  +-> debate round k  read the others and the ledger; file findings,        |
  |      |            concede, adopt, revise, vote                          |
  |   neutral checks  + a two-vendor panel on disputed load-bearing claims  |
  |      |                                                                  |
  |   stop rule       consensus: ceil(2N/3) votes, two vendors ------------>|
  |      |            no change from round 2, or last round: scorecard ---->|
  +------+ narrow the field, next round                                     |
                                                                            v
  synthesis           the chosen author folds in amendments and adopted ideas; checked
     |
  ratification        other seats endorse or object; panel on blocking objections;
     |                one fix pass for upheld ones
     |
  audit (implement)   correctness (Astra) + design (Opus), never saw the debate
     |                --> triage --> one fix pass --> re-review of the fix only
     v
  readiness           ready / blocked / incomplete: reported, never changes the choice
     |
  report, scorecards, retro

  after round 0 or any debate round: ceil(2N/3) seats raise the same question
  about the request --> stop with needs-user
```

1. **Setup.** One Opus agent first runs `dark-factory preflight` for the Codex and Gemini CLIs the
   lineup and panel need, and stops the run, before anything is created, if one can't start
   from this session (with the fix, or the seat to swap). Then it creates the run directory and
   a git worktree per seat, finds the verification command, measures the baseline, and writes
   3–7 acceptance criteria *before anyone starts*, so nobody can redefine success halfway
   through. Each criterion must be checkable from inside a seat's sandbox.
2. **Spec review** (every mode; `spec: false` skips it). Every later check measures against the
   criteria, so a criterion that is wrong lets a wrong result pass all of them. Before any seat
   starts, two reviewers who see only the task, the code and the setup's criteria look for
   problems, each through one lens: **coverage** (Codex Astra: missed edge cases and error
   paths, regressions the criteria would allow, criteria wrong about the code, a verification
   command that wouldn't catch a breakage) and **intent** (Claude Opus: ambiguity,
   contradictions, scope creep or gaps against the task, uncheckable criteria). Each finding is a
   *fact* (the code, documents or task settle it) or a *decision* (only you can).
   - **The panel rules** on every finding: accept, reject, or decision. A finding is amended
     only if every adjudicator accepts it; any decision vote makes it a question; accept against
     reject is disputed and left alone. Widening the scope counts as a defect.
   - **One Opus turn amends** the criteria (and the verification command, re-measuring the
     baseline if it changes). It never rewords criteria you passed in `criteria`.
   - **Questions only you can answer** are settled autonomously on the most conservative reading
     (keeps existing behaviour, easiest to undo, closes off the fewest options). The criteria
     follow it, seats are told it, and the report opens with an "Assumptions to check" section,
     one yes-or-no line each. With `spec: 'ask'` the run instead stops with `needs-user` before
     any seat starts, and resumes from cache with your answers as `clarifications`.

   A clean review costs 3 turns (two reviewers and a relay); one with findings adds the panel
   (3 turns with its relay) and the amendment. The report gets a "Specification review" section.
3. **Solve, blind.** Each seat works alone in its own worktree and posts to the shared room.
   Seats are anonymous letters, assigned by a per-run shuffle. In implement mode, if every
   seat's checked snapshot is the same tree and the verification command passes on it, there is
   nothing to debate: the council skips to synthesis by the copy highest on the scorecard.
4. **Debate rounds** (default 2, max 3). Each seat reads the other positions and the ledger,
   then files findings, challenges claims, concedes, adopts ideas (credited), revises, and votes
   on which position should ship. From round 2 it starts from what changed since it last looked.
5. **Neutral checks after every round.** A Sonnet checker per position re-runs the
   verification command and every published test against it, in a disposable checkout of the
   snapshot it just took (never the seat's live worktree), and rules on each claim:
   VERIFIED, REFUTED, FABRICATED or UNRESOLVED. Disputed load-bearing claims go to a two-vendor
   panel (a fresh Opus and a fresh Astra by default; set `panel`). If the panel splits, the claim is UNRESOLVED.
   A checker that returns nothing gets one retry.
6. **Stop rule** (code, not a model): consensus when ⌈2N/3⌉ seats vote for the same
   non-disqualified position, with votes from at least two vendors among them. If a round changes
   nothing, or the last round ends without consensus, a scorecard picks the base.
   Otherwise the field narrows before the next round (see below). Two experiments, both off
   unless you turn them on per run, change when or how agreement counts: `ballot` and
   `approval` (see [Arguments](#arguments)).
7. **Synthesis.** The winning author folds in amendments, fixes standing findings and
   credits adopted ideas.
8. **Ratification.** The other seats endorse or object. Blocking fact objections go to the
   panel, and upheld ones get one fix pass. Judgment objections are reported as dissent.
9. **Readiness.** Separately from how it was chosen, the final version is reported as
   *ready*, *blocked* (an unmet criterion, a failing suite or published test, a fabricated
   verification, an upheld blocker or major) or *incomplete* (no check, an unrun suite, an
   unjudged criterion, an unresolved or one-adjudicator ruling, a missing review). Readiness is
   reported only; it never changes which position was chosen.
10. **Audit** (implement mode; `audit: false` skips it). Every reviewer so far took part in the
   debate, or ruled only on claims somebody made, so a problem nobody raised gets past them all,
   and agreement among seats that share a frame proves little. Two auditors who never saw the
   debate now review the final version, each through one lens: **correctness** (Codex Astra:
   edge cases, regressions, error paths, whether the tests would catch the change's loss) and
   **design** (Claude Opus: abstractions, simplicity, fit with the codebase, test level, and a
   change-tolerance probe that traces where two or three plausible next changes would land).
   Each gets the task, the criteria, the final diff and its own checkout. The room is off limits.
   A correctness finding should come with a failing test, published like a seat's.
   - **Triage** reuses the checks: a checker re-measures the final version with the auditors'
     tests and rules on minor fact findings, and the panel rules on blocker and major ones. A
     judgment finding the panel agrees on becomes a fact, upheld or refuted. A split leaves it
     a judgment call. Minor judgment findings go to the author as suggestions.
   - **One fix pass** when anything is upheld, disputed or failing. The winning author fixes
     it, or declines with evidence, and the final version is checked again.
   - **Re-review of the fix only.** The auditors read the fix's delta for defects it introduced.
     Blocker and major ones go to the panel and are reported, never fixed: the loop is capped
     at one cycle, so it ends.

   A clean audit costs 3 turns (two auditors and a relay; nothing to rule on, so no re-check);
   one with findings, about 10 more, plus their relays. Readiness then reflects the last check, and an auditor that
   returned nothing leaves it *incomplete*. The report gets an "Independent audit" section listing each finding and how it
   ended. The default panel is also Opus and Astra, but fresh ones: an adjudicator never sees
   the audit it rules on.

Escalation: the council settles judgment calls itself. It stops to ask you only when ⌈2N/3⌉
seats (3 of 4) raise or second the same question about the request itself. Questions that
don't reach that bar are reported as assumptions.

## Working from a plan

Seats work in git worktrees checked out from HEAD, so they can't see anything uncommitted: a
plan from plan mode (saved under `~/.claude/plans/`), an untracked `PLAN.md`, a bug checklist.
The council handles that in three layers:

1. **The launching session passes the plan.** The workflow's description tells the main
   session to call it with the plan's absolute path and to say in the task which part to do,
   without pasting the document:

       Workflow({name: 'council', args: {task: 'Do item 13 on the bug checklist',
                                         plan: ['/abs/path/BUG_CHECK_LIST.md']}})

2. **Setup snapshots it.** `dark-factory init --ref` copies each document into `<run>/refs/`, byte
   for byte, with no model retyping it, and records whether the worktrees have it. Setup also
   looks for documents the task names, such as "item 13 on BUG_CHECK_LIST.md", and snapshots
   those too. The acceptance criteria are written from the documents as well as the task.
   Every seat, checker, panel member and the final author is pointed at the snapshots. Seats
   are told not to copy them into the worktree, and not to cite them (file names, step or item
   numbers) in code, comments or tests.
3. **No guessing.** If the task depends on a plan the council can't find, including "the plan"
   with no file named, it stops before any seat starts. The main session is told to find the
   plan (one made in the same conversation is under `~/.claude/plans/`) and rerun with `plan`,
   or to ask you if it can't tell which plan is meant.

## Scoring

All scores are computed by the script from the checkers' and panel's rulings.

**Positions** (deciding what ships when there is no consensus) are ranked in strict order:

1. Disqualified last: the verification command fails (when it passed at baseline), or the
   round's verification claim was fabricated.
2. Fewest standing blocker findings, then fewest standing major findings.
3. Highest pass rate on valid published tests.
4. Most acceptance criteria met.
5. Fewest standing minor findings.
6. Votes from other seats.
7. Author credibility.
8. Smaller diff.

**Seats** (whom to trust) record:

- fabricated and wrong claims
- findings upheld and refuted
- challenges won and lost
- a refutation score, where upheld findings earn by severity and refuted ones cost 1.5× as much
- ideas adopted by others and ideas that made it into the final version
- tests published and valid
- capitulations (changed position with nothing verified behind it)
- ignored findings (left a verified blocker or major unaddressed)

## Keeping context focused

Reading three rival solutions every round is where context would grow, so the moderator keeps
each seat's reading to what the decision needs:

- **Pointers, not pastes.** Prompts list the paths of posts and diffs. Seats open what they
  need. The ledger digest is capped: one line per position, ledger entries cut to about 260
  characters, and at most 30 refuted and 30 other checked claims.
- **What changed, from round 2.** Each checker run snapshots the seat's tree and writes
  `rN/<seat>.delta.diff`, the change since the seat's previous round. Readers start from that
  and the post's "Changes this round" section, and open the full post or diff only when needed.
  Ratifiers also get `final/<seat>.delta.diff`, the change since the version they last reviewed.
- **The field narrows.** After a debate round without consensus, the two positions ranked
  highest on the scorecard stay in contention, as does any position another seat voted for and
  any whose author has a verified blocker or major finding against one that stays. The other
  authors become reviewers: they stop revising, and they critique, publish tests and vote for a
  contender. Reviewers' positions are no longer measured or read, and findings against them
  are no longer filed. With 2 or 3 seats this rarely triggers; turn it off with `narrow: false`.
- **Memory for Claude seats.** Claude seats are fresh agents each turn, so each one returns
  private notes of under about 400 words (key file:line references, what it verified, its read
  on each position). The notes are pasted into that seat's next prompt and nobody else sees
  them. Codex and Gemini seats keep their own thread instead.
- **Length limits.** Posts should stay under about 800 words (implement), 1,500
  (investigate) or 2,000 (design). Only the post file counts: long material the task asks for,
  such as exact edits or logs, goes in separate files in the room. Checkers count the words, and
  the digest flags a post that runs over.
- **Fewer, sharper claims.** Each turn records at most 12 claims: every verification claim, plus
  the facts that name an acceptance criterion they bear on. Checkers verify every claim, and
  incidental facts nearly always came back verified, so they stay in the post, unchecked. A diff of more than 400 changed lines is offered with its per-file summary
  (`rN/<seat>.stat`) first.
- **Narrow neutral roles.** Each checker sees only the claims about one position; each panel
  member sees only the disputed claims.

## Arguments

`/dark-factory:council <task>` passes a string. From a session, `Workflow({name: 'council', args: {...}})`
accepts:

| arg | default | |
|---|---|---|
| `task` | required | |
| `plan` | | path or list of paths: a plan or other document the work follows; snapshotted for every seat |
| `mode` | auto | `implement`, `investigate` or `design`. Unless given, setup picks it after reading the task and its documents: a bug fix or "do the next item" on a checklist is implement |
| `seats` | `['opus','sonnet','astra','gemini']` | a list or a comma-separated string; see [Choosing the models](models.md). A string task may start with `--seats a,b,c,d` |
| `rounds` | 2 | debate rounds, 1–3 |
| `effort` | `high` | for every seat, or per seat: `{astra: 'xhigh'}`. Codex also accepts `ultra`. Gemini maps the level to the nearest one the model has (Flash: low, medium, high), since agy names it in the model slug |
| `context` | | extra context for every seat |
| `criteria` | written by setup | your own acceptance criteria, as a list of strings |
| `verify` | found by setup | the verification command |
| `repo` | session cwd | run against another repository |
| `consensusAt`, `escalateAt` | ⌈2N/3⌉ | |
| `panel` | `['opus','astra']` | adjudicators for disputed load-bearing claims |
| `checkModel` | `sonnet` | |
| `allowDirty` | false | implement mode refuses uncommitted tracked changes, since worktrees branch from HEAD |
| `narrow` | true | after a round without consensus, positions with no support leave contention and their authors review |
| `retro` | true | every agent may leave a process note, and a retro agent suggests workflow changes at the end; see [Process retro](process-retro.md) |
| `timeoutMin` | 90 | deadline for a Codex or Gemini turn, in minutes: one number, or per phase `{spec, solve, debate, final, ratify, panel, ballot, audit}`. A turn that hits it is not retried |
| `spec` | `{coverage: 'astra', intent: 'opus'}` | the spec review before any seat starts (step 2). `'ask'` stops for your answer on questions only you can settle instead of assuming; an object swaps a lens's model, sets `effort`, or `ask: true`; `false` skips it |
| `audit` | `{correctness: 'astra', design: 'opus'}` | implement mode: the independent audit of the final version (step 10). Swap a lens's model, e.g. `{design: 'sonnet'}`, or set `effort` for both; `false` skips it |
| `ballot` | false | experiment: when a round ends one vote short of consensus (and another round is left), every seat votes again once that round's checks are in, instead of debating a full round more |
| `approval` | false | experiment: seats also list the other positions they could accept. With no strict consensus, a position chosen first by another seat, and chosen or accepted by ⌈2N/3⌉ seats from two vendors, with no verified blocker or major, carries the round; acceptors' amendments go to the final author |
| `clarifications` | | `[{id, answer, afterRound}]`, used when resuming after an escalation, or `[{id, answer}]` after the spec review asked |

## After a run

The main session reads the final version, spot-checks its load-bearing claims, and reports:

1. **A summary in its own words**: which model's work the council went with and why, what
   the other models proposed, and how it ended, followed by the debate topics, one line each
   saying how each was settled.
2. **The council's report** (`report.markdown`), computed by the script from the ledger, the
   votes and the rulings, with every seat named by its model:
   - **Assumptions to check**, first, when the spec review settled a question about the request
     without you: the result is built on them.
   - **Chosen, and why.** Consensus (who voted for it, with every seat's stated reason) or the
     scorecard. Also the criterion that put it above the runner-up, or, when the vote overrode a
     higher-ranked position, which one and on what. And its evidence when chosen.
   - **The positions.** Each seat's opening and closing position and its fate: chosen, its
     rank, or when it left contention.
   - **How the debate went.** Round by round: findings filed and how they were ruled,
     disputes, revisions, adopted ideas, votes, narrowing, and how it ended.
   - **The debates.** Up to 10, most severe first. Each one gives the point, who disputed it and
     why, the ruling (checker, panel, or judgment call), and the outcome (conceded, fixed, or
     still standing).
   - **How it turned out.** Readiness first, then the final version, ideas folded in from other seats, what the
     author declined and why, the neutral check, ratification and objections, and what is
     still open.
   - **Problems during the run**, such as a seat that failed, Codex or agy blocked by the sandbox,
     or a Gemini turn that agy cut short.
3. **The scorecards.**
4. **What the spot-check found.**
5. **A suggested commit message** (implement mode), written by the main session from the final
   diff in the repository's own style: concise, one imperative subject line, a body only when
   needed. It describes the change itself, with no references to plan documents, to the
   council, or to models, and no attribution lines. If the author committed (the task asked for
   commits), the main session cherry-picks those commits instead of applying the diff.
6. **The process retro** (`retro.markdown`): what the council suggests changing in this
   workflow. It's about the council workflow itself, not your project; see [Process retro](process-retro.md).

If the council stops to ask you a question, you get the debate so far with it.

Nothing touches your tree until you approve; then the final diff is applied with `git apply`.

    dark-factory usage   --run-dir <runDir>   # tokens: Codex and Gemini per model, Claude agents per model and role
    dark-factory jobs    --run-dir <runDir>   # job status, for debugging
    dark-factory cleanup --run-dir <runDir>   # drop worktrees + refs, keep the room
    dark-factory cleanup --run-dir <runDir> --all

## Smoke test, 2026-10-11

On a toy `median()` bug (even-length lists wrong; the function also sorts the caller's list in
place), with all four seats at `effort: 'low'` and `rounds: 1`:

- Setup wrote five criteria before any seat started.
- All four fixes passed every published test.
- The seats split on a genuine judgment call, which they recorded as judgment, not as a defect:
  - Astra and Sol kept the in-place sort ("out of scope").
  - Opus and Sonnet sorted a copy.
- The 2–2 vote went to the scorecard, which ranked Opus's position first.
- Opus wrote the final version and adopted Astra's extra tests.
- All three others endorsed it, with their preference recorded as dissent.
