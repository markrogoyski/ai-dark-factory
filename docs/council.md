# Council

[Documentation index](README.md) · [Project README](../README.md)

The council is the multi-model debate behind `/dark-factory:council` and the Fix tier of the
factory. Unlike [`/dark-factory:ensemble`](ensemble.md), which returns ranked candidates for you
to pick from, the council argues until it agrees and falls back to an evidence scorecard when it
can't.

## How a council run goes

The Feature and Architecture tiers reuse this flow's setup, spec review and debate stages.

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

1. **Setup.** One Opus agent runs `dark-factory preflight` for the Codex, Gemini and OpenRouter
   CLIs the lineup and panel need; if one can't start from this session, the run stops before
   anything is created, naming the fix or the seat to swap. It then creates the run directory and
   a worktree per seat, finds the verification command, measures the baseline, and writes 3–7
   acceptance criteria *before anyone starts*. Each must be checkable from inside a seat's sandbox.
2. **Spec review** (every mode; `spec: false` skips it). Every later check measures against the
   criteria, so a wrong criterion lets a wrong result pass. Two reviewers who see only the task,
   the code and the criteria each use one lens: **coverage** (Codex Astra: missed edge cases and
   error paths, regressions the criteria allow, criteria wrong about the code, a verification
   command that wouldn't catch a breakage) and **intent** (Claude Opus: ambiguity,
   contradictions, scope creep or gaps against the task, uncheckable criteria). Each finding is a
   *fact* (code, documents or task settle it) or a *decision* (only you can).
   - **The panel rules** on each finding: accept, reject, or decision. A finding is amended only
     if every adjudicator accepts it; any decision vote makes it a question; accept against
     reject is disputed and left alone. Widening the scope counts as a defect.
   - **One Opus turn amends** the criteria and the verification command (re-measuring the
     baseline if it changes). It never rewords criteria you passed in `criteria`.
   - **Questions only you can answer** are settled on the most conservative reading (keeps
     existing behaviour, easiest to undo, closes off the fewest options). The criteria follow it,
     seats are told it, and the report opens with "Assumptions to check", one yes-or-no line each.
     With `spec: 'ask'` the run instead stops with `needs-user` before any seat starts and resumes
     from cache with your answers as `clarifications`.

   Cost: 3 turns when clean (two reviewers and a relay); findings add the panel (3 turns) and the
   amendment. The report gets a "Specification review" section.
3. **Solve, blind.** Each seat works alone in its own worktree and posts to the shared room.
   Seats are anonymous letters, shuffled per run. In implement mode, if every seat's checked
   snapshot is the same tree and the verification command passes on it, the council skips to
   synthesis by the copy highest on the scorecard.
4. **Debate rounds** (default 2, max 3). Each seat reads the other positions and the ledger, then
   files findings, challenges claims, concedes, adopts ideas (credited), revises, and votes on
   which position should ship. From round 2 it starts from what changed since it last looked.
5. **Neutral checks after every round.** A Sonnet checker per position re-runs the verification
   command and every published test in a disposable checkout of the snapshot it just took (never
   the seat's live worktree), and rules on each claim: VERIFIED, REFUTED, FABRICATED or
   UNRESOLVED. Disputed load-bearing claims go to a two-vendor panel (a fresh Opus and a fresh
   Astra by default; set `panel`); a split leaves the claim UNRESOLVED. A checker that returns
   nothing gets one retry.
6. **Stop rule** (code, not a model). Consensus is ⌈2N/3⌉ seats voting for the same
   non-disqualified position, with votes from at least two vendors. If a round changes nothing,
   or the last round ends without consensus, a scorecard picks the base. Otherwise the field
   narrows (see [Keeping context focused](#keeping-context-focused)). The experiments `ballot`
   and `approval` (off by default) change how agreement counts; see [Arguments](#arguments).
7. **Synthesis.** The winning author folds in amendments, fixes standing findings and credits
   adopted ideas.
8. **Ratification.** The other seats endorse or object. Blocking fact objections go to the panel,
   and upheld ones get one fix pass. Judgment objections are reported as dissent.
9. **Readiness.** The final version is reported as *ready*, *blocked* (an unmet criterion, a
   failing suite or published test, a fabricated verification, an upheld blocker or major) or
   *incomplete* (no check, an unrun suite, a suite that passed only in the seat's worktree and
   failed in the snapshot's clean checkout, an unjudged criterion, an unresolved or
   one-adjudicator ruling, a missing review). A partly met criterion is left to the scorecard; in
   the factory's tiers it blocks. It never changes which position was chosen. Setup must keep the
   criteria and verification command the user supplied; a run whose setup dropped one stops there.
10. **Audit** (implement mode; `audit: false` skips it). Earlier reviewers took part in the
    debate or ruled only on claims somebody made, so a problem nobody raised gets past them all.
    Two auditors who never saw the debate review the final version, each through one lens:
    **correctness** (Codex Astra: edge cases, regressions, error paths, whether the tests would
    catch the change's loss) and **design** (Claude Opus: abstractions, simplicity, fit with the
    codebase, test level, and where two or three plausible next changes would land). Each gets the
    task, the criteria, the final diff and its own checkout; the room is off limits. A correctness
    finding should come with a failing test, published like a seat's.
    - **Triage.** A checker re-measures the final version with the auditors' tests and rules on
      minor fact findings; the panel rules on blocker and major ones. A judgment finding the panel
      agrees on becomes a fact, upheld or refuted; a split leaves it a judgment call. Minor
      judgment findings go to the author as suggestions.
    - **One fix pass** when anything is upheld, disputed or failing. The winning author fixes it
      or declines with evidence, and the final version is checked again.
    - **Re-review of the fix only.** The auditors read the fix's delta for new defects. Blocker
      and major ones go to the panel and are reported, never fixed: the loop is capped at one
      cycle.

    Cost: 3 turns when clean (two auditors and a relay); findings add about 10, plus relays.
    Readiness reflects the last check; an auditor that returned nothing leaves it *incomplete*.
    The report gets an "Independent audit" section listing each finding and how it ended. The
    default panel is again Opus and Astra, but fresh ones: an adjudicator never sees the audit it
    rules on.

**Escalation.** The council settles judgment calls itself. It stops to ask you only when ⌈2N/3⌉
seats (3 of 4) raise or second the same question about the request itself; questions below that
bar are reported as assumptions.

## Working from a plan

Seats work in worktrees checked out from HEAD, so they can't see anything uncommitted: a plan from
plan mode (under `~/.claude/plans/`), an untracked `PLAN.md`, a bug checklist.

1. **Pass it.** The workflow's description tells the main session to pass the plan's absolute
   path in `plan` and say in the task which part to do, without pasting the document:

       Workflow({name: 'dark-factory:council', args: {task: 'Do item 13 on the bug checklist',
                                         plan: ['/abs/path/BUG_CHECK_LIST.md']}})

2. **Setup snapshots it.** `dark-factory init --ref` copies each document byte for byte into
   `<run>/refs/` and records whether the worktrees have it. Setup also snapshots documents the
   task names (such as "item 13 on BUG_CHECK_LIST.md") and writes the criteria from them as well
   as the task. Every seat, checker, panel member and the final author is pointed at the
   snapshots. Seats are told not to copy them into the worktree or cite them (file names, step or
   item numbers) in code, comments or tests.
3. **No guessing.** If the task depends on a plan the council can't find, including "the plan"
   with no file named, it stops before any seat starts. The main session is told to find the plan
   (one made in the same conversation is under `~/.claude/plans/`) and rerun with `plan`, or to
   ask you if it can't tell which.

## Scoring

The script computes all scores from the checkers' and panel's rulings.

**Positions** (what ships when there is no consensus) rank in strict order:

1. Disqualified last: the verification command fails (when it passed at baseline), or the
   round's verification claim was fabricated.
2. Fewest standing blocker findings, then fewest standing major findings.
3. Highest pass rate on valid published tests.
4. Most acceptance criteria met.
5. Fewest standing minor findings.
6. Votes from other seats.
7. Author credibility.
8. Smaller diff.

**Seats** (whom to trust) record: fabricated and wrong claims; findings upheld and refuted;
challenges won and lost; a refutation score (upheld findings earn by severity, refuted ones cost
1.5× as much); ideas adopted by others and ideas that reached the final version; tests published
and valid; capitulations (changed position with nothing verified behind it); and ignored findings
(left a verified blocker or major unaddressed).

## Keeping context focused

The moderator limits what each seat reads:

- **Pointers, not pastes.** Prompts list paths of posts and diffs. The ledger digest is capped:
  one line per position, entries cut to about 260 characters, at most 30 refuted and 30 other
  checked claims.
- **What changed, from round 2.** Each checker run writes `rN/<seat>.delta.diff`, the change since
  the seat's previous round; readers start from it and the post's "Changes this round" section.
  Ratifiers also get `final/<seat>.delta.diff`, the change since the version they last reviewed.
- **The field narrows.** After a debate round without consensus, the two top-ranked positions stay
  in contention, as does any position another seat voted for and any whose author has a verified
  blocker or major finding against one that stays. The other authors become reviewers: they stop
  revising, and critique, publish tests and vote for a contender. Their positions are no longer
  measured or read, and findings against them are no longer filed. With 2 or 3 seats this rarely
  triggers; turn it off with `narrow: false`.
- **Memory for Claude seats.** Claude seats are fresh agents each turn, so each returns private
  notes of under about 400 words (key file:line references, what it verified, its read on each
  position), pasted into its own next prompt only. Codex, Gemini and OpenRouter seats keep their
  own thread.
- **Length limits.** Posts stay under about 800 words (implement), 1,500 (investigate) or 2,000
  (design). Only the post file counts: long material the task asks for, such as exact edits or
  logs, goes in separate files in the room. Checkers count words, and the digest flags overruns.
- **Fewer claims.** Each turn records at most 12: every verification claim, plus the facts that
  name an acceptance criterion they bear on. Other facts stay in the post, unchecked. A diff over
  400 changed lines is offered with its per-file summary (`rN/<seat>.stat`) first.
- **Narrow neutral roles.** Each checker sees only the claims about one position; each panel
  member only the disputed claims.

## Arguments

`/dark-factory:council <task>` passes a string. From a session, `Workflow({name: 'dark-factory:council', args: {...}})`
accepts:

| arg | default | |
|---|---|---|
| `task` | required | |
| `plan` | | path or list of paths: a plan or other document the work follows; snapshotted for every seat |
| `mode` | auto | `implement`, `investigate` or `design`. Unless given, setup picks it after reading the task and its documents: a bug fix or "do the next item" on a checklist is implement |
| `seats` | `['opus','sonnet','astra','gemini']` | a list or a comma-separated string; see [Choosing the models](models.md). A string task may start with `--seats a,b,c,d` |
| `rounds` | 2 | debate rounds, 1–3 |
| `effort` | `high` | for every seat, or per seat: `{astra: 'xhigh'}`; it doesn't reach the panel, spec review or audit (see [Effort](models.md#effort)). Codex also accepts `ultra`. Gemini maps the level to the nearest one the model has (Hydrogen and Neon: low, medium, high, xhigh; Argon: low, medium, high), since agy puts the level in the model ID (for example `gemini-4-hydrogen-high`) |
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
| `timeoutMin` | 90 | deadline for a Codex, Gemini or OpenRouter turn, in minutes: one number, or per phase `{spec, solve, debate, final, ratify, panel, ballot, audit}`. A turn that hits it is not retried |
| `spec` | `{coverage: 'astra', intent: 'opus'}` | the spec review before any seat starts (step 2). `'ask'` stops for your answer on questions only you can settle instead of assuming; an object swaps a lens's model, sets `effort`, or `ask: true`; `false` skips it |
| `audit` | `{correctness: 'astra', design: 'opus'}` | implement mode: the independent audit of the final version (step 10). Swap a lens's model, e.g. `{design: 'sonnet'}`, or set `effort` for both; `false` skips it |
| `ballot` | false | experiment: when a round ends one vote short of consensus (and another round is left), every seat votes again once that round's checks are in, instead of debating a full round more |
| `approval` | false | experiment: seats also list the other positions they could accept. With no strict consensus, a position chosen first by another seat, and chosen or accepted by ⌈2N/3⌉ seats from two vendors, with no verified blocker or major, carries the round; acceptors' amendments go to the final author |
| `clarifications` | | `[{id, answer, afterRound}]`, used when resuming after an escalation, or `[{id, answer}]` after the spec review asked |

## After a run

The main session reads the final version, spot-checks its load-bearing claims, and reports:

1. **A summary in its own words**: whose work the council went with and why, what the others
   proposed, how it ended, and each debate topic in one line on how it was settled.
2. **The council's report** (`report.markdown`), computed by the script from the ledger, votes and
   rulings, with every seat named by its model. Its sections:
   - **Assumptions to check**, first, when the spec review settled a question without you.
   - **Chosen, and why:** consensus (who voted, with each seat's reason) or the scorecard; the
     criterion that put it above the runner-up, or which higher-ranked position the vote
     overrode; and its evidence.
   - **The positions:** each seat's opening and closing position and its fate (chosen, rank, or
     when it left contention).
   - **How the debate went:** round by round, findings and rulings, disputes, revisions, adopted
     ideas, votes and narrowing.
   - **The debates:** up to 10, most severe first: the point, who disputed it and why, the ruling
     (checker, panel, or judgment call), and the outcome (conceded, fixed, or standing).
   - **How it turned out:** readiness first, then the final version, ideas folded in, what the
     author declined and why, the neutral check, ratification and objections, and what is open.
   - **Problems during the run:** a failed seat, Codex or agy blocked by the sandbox, a Gemini
     turn that agy cut short.
3. **The scorecards** and **what the spot-check found.**
4. **A suggested commit message** (implement mode), written from the final diff in the
   repository's style: one imperative subject line, a body only when needed, no references to
   plan documents, the council or models, and no attribution lines. If the author committed (the
   task asked for commits), the main session cherry-picks those commits instead of applying the
   diff.
5. **The process retro** (`retro.markdown`): suggested changes to this workflow, not your
   project; see [Process retro](process-retro.md).

If the council stops to ask you a question, you get the debate so far with it.

Nothing touches your tree until you approve; then the final diff is applied with `git apply`.

    dark-factory usage   --run-dir <runDir>   # tokens: Codex, Gemini and OpenRouter per model, Claude agents per model and role
    dark-factory jobs    --run-dir <runDir>   # job status, for debugging
    dark-factory cleanup --run-dir <runDir>   # drop worktrees + refs, keep the room
    dark-factory cleanup --run-dir <runDir> --all

## Smoke test, 2026-10-11

A toy `median()` bug (even-length lists wrong; the function also sorts the caller's list in
place), all four seats at `effort: 'low'`, `rounds: 1`. Setup wrote five criteria and all four
fixes passed every published test. The seats split 2–2 on a judgment call, recorded as judgment
rather than a defect: Astra and Sol kept the in-place sort ("out of scope"), Opus and Sonnet
sorted a copy. The scorecard ranked Opus first; Opus wrote the final version, adopted Astra's
extra tests, and the other three endorsed it with their preference recorded as dissent.

Cost: 22 agents, about 840k Claude subagent tokens, and 525k Codex input tokens (6k output) over
six Codex turns, in 4.3 minutes. A Codex turn used 74–101k input tokens (65–78% cached), nearly
all Codex's own fixed overhead; the whole room was about 5k tokens.
