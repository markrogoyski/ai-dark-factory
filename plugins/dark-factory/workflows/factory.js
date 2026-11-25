export const meta = {
  name: 'factory',
  description: 'Routes one task to the process it needs: a simple change gets one implementer and one reviewer, harder work the council; escalates on evidence',
  whenToUse: 'Use for implementation work the user wants done end to end with independent review, when it is not obvious how much process it needs. A shaper and a fresh challenger clarify the goal before intake; a groomed ticket from the dark-factory:groom skill gets one re-check instead. Pass brief: false (--no-brief) to skip or an absolute brief file path in brief to reuse it (re-checked once when context, plan, criteria or mode also bear on the goal). An Opus intake reads the task and the code and picks a tier: simple (Sonnet implements, Codex Astra reviews, at most one fix pass: about 8-11 agent turns), fix (a subtle bug: Opus and Astra attempt it blind and debate, through /council), feature (Opus and Astra each plan it blind and debate the plans; the chosen plan, merged with the best of the other, is built by its author in at most 4 checked increments, then audited for correctness, design and tests: about 27-42 agent turns) or architecture (a request for a design or plan, or one connected piece of work too big for one feature: Opus, Astra and Sonnet design it blind and debate the designs; the chosen design\'s author writes a milestone plan, reviewed for grounding (Astra), sequencing (Opus) and risk and alternatives (Gemini Hydrogen) and revised once; nothing is built: about 37-52 agent turns). The lowest tier that plausibly suffices is chosen, because a run whose tier the evidence shows is too low hands the work to a higher tier automatically, in the same run: Simple on failing verification after its fix pass, an upheld design finding, a change over its size budget, or the implementer saying so; Feature when its chosen plan needs more than 4 increments, which goes to architecture before anything is built. An architecture result lists milestones[], each with a task, draft criteria, the earlier milestones it builds on, a tier and ready-made args: show them, then offer to run each as its own /factory run with Workflow({name: "dark-factory:factory", args: milestones[i].args}), one at a time and in order, committing each before the next; never start one unasked. When the user names a tier, pass it in `tier` (or prefix a string task with --tier simple); if intake disagrees, the run stops with status needs-tier before tier work, and you ask the user once: rerun with tierConfirmed: true to keep their tier, or with intake\'s. A kept tier is where the run starts, not a ceiling. When the task bundles separate pieces of work (a checklist, several fixes with their own causes, one commit per item), intake stops the run with status needs-split and lists them: ask the user once whether to run each piece as its own /factory run, in order and committing each before the next, or the whole task as one (rerun with noSplit: true). Seats work in git worktrees checked out from HEAD, so they cannot see uncommitted files: if the work follows a plan or other document that is not committed (a plan from plan mode under ~/.claude/plans/, an untracked PLAN.md, a checklist), pass its absolute path in `plan`, e.g. {task: "Do item 13 on the bug checklist", plan: ["/abs/path/BUG_CHECK_LIST.md"]}, and say in the task which part to do; do not paste the document. `simple: {implementer, reviewer, maxLines, maxFiles}` changes the Simple tier; every /council argument (seats, spec, audit, rounds, ...) passes through to the council tiers, audit: {tests: <model>} swaps the Feature tier\'s tests auditor (Sonnet), and audit: {risk: <model>} the Architecture tier\'s risk reviewer (Gemini Hydrogen; swap it for "sonnet" if the Antigravity CLI is unavailable).',
  phases: [
    { title: 'Brief', detail: 'shape the outcome and purpose, then challenge unresolved readings before routing', model: 'opus' },
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
// Shape: Brief -> [needs-user] -> Intake -> [needs-plan | needs-split | needs-tier] ->
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
function qe(e,t){const n=String(e??"");return n.length<=t?n:n.slice(0,t)+" […]"}function g(e,t){
return qe(String(e??"").replace(/\s+/g," ").trim(),t)}function te(e){return`dark-factory:${e}`}function k(e){return`'${String(
e).replace(/'/g,`'\\''`)}'`}function ne(e){return/^[\w./:@%+=,-]+$/.test(String(e))?String(e):k(e)}function O(e){if(!e||
typeof e!=="object")return e;const t={...e};if(t.type==="object"&&t.properties){t.properties=Object.fromEntries(Object.entries(
t.properties).map(([n,r])=>[n,O(r)]));t.required=Object.keys(t.properties);t.additionalProperties=false}if(t.type==="arr\
ay"&&t.items)t.items=O(t.items);return t}const Be=(e,t)=>`${e} ${t}${e===1?"":"s"}`;function Pe(e){if(!e||typeof e!=="ob\
ject"||!("resumable"in e)||e.status==="needs-user")return e;const t=typeof e.resumeSteps==="string"?e.resumeSteps:"";for(const n of[
e,e.summary]){if(!n||typeof n!=="object")continue;if(t&&typeof n.forTheOrchestrator==="string")n.forTheOrchestrator=n.forTheOrchestrator.
split(` ${t}`).join("").split(t).join("");delete n.resumable;delete n.resumeSteps}return e}function re(e,t={}){if(typeof e!==
"string")return e||{};const n={},r={seats:"seats",tier:"tier",strategy:"strategy",author:"author",reviewer:"reviewer","m\
ax-reviews":"maxReviews","max-design-reviews":"maxDesignReviews","max-turns":"maxTurns","max-run-min":"maxRunMin",candidates:"\
candidates",reviewers:"reviewers",mode:"mode",runtime:"runtime"};let i=e,a;while(true){if(/^\s*--explain(?:\s|$)/.test(i)){
n.explain=true;i=i.replace(/^\s*--explain(?:\s+|$)/,"");continue}const s=i.match(/^\s*--([\w-]+)(?:\s+([\s\S]*))?$/);if(s&&
Object.hasOwn(t,s[1])){n[t[s[1]][0]]=t[s[1]][1];i=s[2]||"";continue}a=i.match(/^\s*--([\w-]+)[= ]\s*([^\s]+)(?:\s+([\s\S]*))?$/);
if(!a||!r[a[1]]&&a[1]!=="repair-passes")break;if(a[1]==="repair-passes")n.repair={maxPasses:a[2]};else n[r[a[1]]]=a[2];i=
a[3]||""}return{task:i,...n}}const We=/\b(implement|fix|add|writ(e|ing)|build|refactor|migrat\w*|port|rename|remove|delete|optimi[sz]\w*|patch|introduce|support)\b/i;
const Ge=/\b(design|architect\w*|propos(e|al)|approach(es)?|trade-?offs?|strategy|plan)\b/i;const W=["implement","invest\
igate","design"];const Ue={implement:800,investigate:1500,design:4e3,plan:1500};const G={opus:{vendor:"claude",model:"op\
us",name:"Claude Opus"},sonnet:{vendor:"claude",model:"sonnet",name:"Claude Sonnet"},fable:{vendor:"claude",model:"fable",
name:"Claude Fable"},haiku:{vendor:"claude",model:"haiku",name:"Claude Haiku"},astra:{vendor:"codex",model:"gpt-6.2-astr\
a",name:"Codex Astra"},sol:{vendor:"codex",model:"gpt-6.2-sol",name:"Codex Sol"},luna:{vendor:"codex",model:"gpt-6-luna",
name:"Codex Luna"},terra:{vendor:"codex",model:"gpt-6.1-terra",name:"Codex Terra"},gemini:{vendor:"gemini",model:"gemini\
-4-hydrogen",name:"Gemini Hydrogen",efforts:["low","medium","high","xhigh"]},argon:{vendor:"gemini",model:"gemini-4-argo\
n",name:"Gemini Argon",efforts:["low","medium","high"]},neon:{vendor:"gemini",model:"gemini-4-neon",name:"Gemini Neon",efforts:[
"low","medium","high","xhigh"]}};const He=["opus","sonnet","astra","gemini"];const Xe=["opus","astra","sol"];const Ke=/^(?=.*[A-Za-z0-9])[A-Za-z0-9._~:@+\/-]{1,128}$/;
const Je=e=>e.external===true||e.vendor!=="claude";const E=(e,t)=>e==="codex"?{...t,external:true}:t;const U={intake:"as\
tra",setup:"astra",checker:"astra",questions:"luna",spec:"astra",retro:"astra",record:"luna"};const ze={intake:"medium",
setup:"medium",checker:"medium",questions:"low",spec:"medium",retro:"medium",record:"low"};function Se(e){if(e.host!=="c\
odex")return{};const t=e.roles&&typeof e.roles==="object"?e.roles:{};for(const n of Object.keys(t))if(!(n in U))throw new Error(
`factory: unknown role '${n}'. Known: ${Object.keys(U).join(", ")}.`);return Object.fromEntries(Object.entries(U).map(([
n,r])=>{const i=t[n];const a=i&&typeof i==="object"?i:{model:i};const s=a.model||n==="checker"&&e.checkModel||r;return[n,
x(s,a.effort||ze[n])]}))}function ie(e,t,n){return e.roles&&e.roles[t]?e.roles[t]:{vendor:"claude",model:n.model,name:n.
model,effort:n.effort}}const oe=["low","medium","high","xhigh","max"];const Ve=[...oe,"ultra"];function x(e,t){const n=String(
e).trim(),r=n.toLowerCase();let i;if(G[r])i={key:r,...G[r]};else if(r.startsWith("codex:")&&r.length>6)i={key:r,vendor:"\
codex",model:r.slice(6),name:`Codex ${r.slice(6)}`};else if(r.startsWith("gemini:")&&r.length>7)i={key:r,vendor:"gemini",
model:r.slice(7),name:`Gemini ${r.slice(7)}`,slug:true};else if(r.startsWith("openrouter:")&&Ke.test(n.slice(11))){const c=n.
slice(11);i={key:`openrouter:${c}`,vendor:"openrouter",model:c,name:`OpenRouter ${c}`}}else throw new Error(`council: un\
known seat '${e}'. Known: ${Object.keys(G).join(", ")}, codex:<model-id>, gemini:<model-id> or openrouter:<model-id>.`);
const a=t&&typeof t==="object"?t[i.key]:t;i.effort=a?String(a).toLowerCase():"high";const s=i.vendor==="codex"?Ve:oe;if(!s.
includes(i.effort))throw new Error(`council: effort '${i.effort}' is not valid for ${i.name}. Valid: ${s.join(", ")}.`);
if(i.vendor==="gemini"&&!i.slug){const c=["low","medium","high","xhigh","max","ultra"];const l=c.indexOf(i.effort);i.effort=
i.efforts.reduce((d,f)=>Math.abs(c.indexOf(f)-l)<=Math.abs(c.indexOf(d)-l)?f:d);i.model=`${i.model}-${i.effort}`}delete i.
efforts;delete i.slug;return i}const Ze=e=>e.vendor==="openrouter"?`openrouter:${e.model}`:e.vendor;const F=e=>(Array.isArray(
e)?e:typeof e==="string"?e.split(","):[]).map(t=>String(t).trim()).filter(Boolean);const H={correctness:{model:"astra",id:"\
XC"},design:{model:"opus",id:"XD"}};const se={tests:{model:"sonnet",id:"XT"}};const ae=4;const ce={review:{model:"astra",
id:"XR"}};const le={grounding:{model:"astra",id:"XG"},sequencing:{model:"opus",id:"XS"},risk:{model:"gemini",id:"XK"}};const Ye={
correctness:{model:"astra",id:"XC"},design:{model:"astra",id:"XD"}};const Qe={tests:{model:"luna",id:"XT"}};const et={grounding:{
model:"astra",id:"XG"},sequencing:{model:"astra",id:"XS"},risk:{model:"luna",id:"XK"}};function tt(e,t=H){if(e===false)return[];
const n=e&&typeof e==="object"?e:{};return Object.entries(t).map(([r,i])=>({lens:r,id:i.id,...x(n[r]||i.model,n.effort||
"high")}))}const ue={coverage:"astra",intent:"opus"};function nt(e,t=ue){if(e===false)return{reviewers:[],ask:false};const n=e&&
typeof e==="object"?e:{};return{reviewers:Object.entries(t).map(([r,i])=>({lens:r,...x(n[r]||i,n.effort||"high")})),ask:e===
"ask"||n.ask===true}}function rt(e,t={}){const n=re(e);const r=n.host==="codex"?"codex":"claude";const i=Se(n);const a=String(
n.task||n.prompt||n.question||"").trim();if(!a){throw new Error("council: no task given. Pass args as a string, or {task\
, mode?, seats?, rounds?, ...}.")}const s=t.tier==="simple"?pe(n).simple:null;const c=!!s||W.includes(n.mode);const l=s?
"implement":c?n.mode:We.test(a)?"implement":Ge.test(a)?"design":"investigate";const d=(s?[x(s.implementer,n.effort)]:(F(
n.seats).length?F(n.seats):r==="codex"?Xe:He).map(u=>x(u,n.effort))).map(u=>E(r,u));if(!s&&(d.length<2||d.length>6))throw new Error(
"council: use between 2 and 6 seats.");const f=r==="codex"?Ye:H;const $=r==="codex"?Qe:se;const D=r==="codex"?et:le;const N=s?
{reviewers:[],ask:false}:nt(n.spec,r==="codex"?{coverage:"astra",intent:"astra"}:ue);return{raw:n,host:r,roles:i,task:a,
modeGiven:c,mode:l,controls:Mt(n),rounds:Math.max(1,Math.min(3,Number(n.rounds)||2)),context:String(n.context||"").trim(),
plan:(Array.isArray(n.plan)?n.plan:n.plan?[n.plan]:[]).map(u=>String(u).trim()).filter(Boolean),cli:String(n.cli||"dark-\
factory"),allowDirty:n.allowDirty===true,evidence:n.evidence===true,narrow:n.narrow!==false,retro:n.retro!==false,approval:n.
approval===true,ballot:n.ballot===true,clarifications:(Array.isArray(n.clarifications)?n.clarifications:[]).filter(u=>u&&
u.id&&u.answer).map(u=>({id:String(u.id),answer:String(u.answer),afterRound:Number.isInteger(u.afterRound)?u.afterRound:
-1})),lineup:d,panel:(F(n.panel).length?F(n.panel):r==="codex"?["astra","sol"]:["opus","astra"]).map(u=>E(r,x(u,"high"))),
auditors:s?[{lens:"review",id:ce.review.id,...x(s.reviewer,"high")}].map(u=>E(r,u)):tt(n.audit,t.tier==="feature"?{...f,
...$}:t.tier==="architecture"?D:f).map(u=>E(r,u)),specReviewers:s?[]:N.reviewers.map(u=>E(r,u)),specAsk:s?false:N.ask,workflowName:t.
workflow||"council",tier:t.tier||null,simple:s,escalation:t.escalation||null,checkModel:r==="codex"?i.checker.key:["sonn\
et","opus","haiku","fable"].includes(n.checkModel)?n.checkModel:"sonnet",letters:"ABCDEF".slice(0,d.length).split("")}}function it(e){
return{...e,postWords:Ue[e.mode],run:null,seats:[],criteria:[],verify:"",refs:[],baselineOk:true,baselineNote:"",ledger:[],
byId:{},challenges:[],adoptions:[],votes:{},ballots:{},questions:[],pendingQ:[],pos:{},behaviour:{},testResults:{},notes:[],
seatNotes:{},processNotes:[],turnLog:[],relayFailures:[],longPosts:[],inContention:null,dropped:[],declined:[],lastRound:0,
blocked:{},vendorTimes:[],spec:{ran:false,reviews:{},findings:[],applied:[],assumptions:[],answered:[],before:null},auditedTag:null,
factory:null,build:null,milestones:null}}function de(e){return{turnLog:e.turnLog.slice(),processNotes:e.processNotes.slice(),
notes:e.notes.slice(),relayFailures:e.relayFailures.slice(),vendorTimes:e.vendorTimes.slice()}}function ot(e){return[...e.
lineup,...e.panel,...e.specReviewers,...e.auditors,...e.ensemble?[e.ensemble.compare]:[],...e.host==="codex"?Object.values(
e.roles).map(t=>E(e.host,t)):[]].filter(Je)}function fe(e){return[...new Set(ot(e).map(Ze))]}function st(e){if(e.host!==
"codex"||e.raw.hostRunId===void 0||e.raw.hostRunId===null)return null;const t=e.raw.hostRunId;const n=e.pair?.setupAttempt||
0;const r=`${t}-${e.tier||e.workflowName}${n?`-answered${n>1?`-${n}`:""}`:""}`;if(typeof t!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.
test(t)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r)){throw new Error("factory: hostRunId must contain only letters, digits,\
 dots, underscores and hyphens, starting with a letter or digit.")}return r}function at(e,t){return e.auditors.find(n=>n.
id===t)}function ct(e,t){return e.seats.find(n=>n.L===t)}function lt(e){return e.seats.filter(t=>t.active)}function ut(e,t){
return e.seats.some(n=>n.L===t&&n.active)}function dt(e,t){const n=lt(e).length||e.seats.length;const r=Number(t);return r?
Math.max(1,Math.min(n,r)):Math.max(2,Math.ceil(2*n/3))}function ft(e){return dt(e,e.raw.escalateAt)}const pt=e=>(Object.
entries({...H,...se,...ce,...le}).find(([,t])=>t.id===e)||[])[0];function ht(e,t,n=Infinity){return e.clarifications.some(
r=>r.id===t&&!(Number(r.afterRound)>n))}function mt(e,t){return new Set([...t.raisedBy,...t.seconds].filter(n=>ut(e,n))).
size}function gt(e){const t=e.raw.intakeLimits||{};return`Choose collaboration separately from complexity: strategy=pair\
 for a scoped implementation with one clear approach that benefits from repeated review; strategy=independent for compet\
ing root causes or plans. Keep the tier based on task complexity. Architecture and investigations always use independent\
 attempts.

You are the intake for a software factory. A task arrives, and you decide how much process it needs, before anyone works\
 on it. Read; don't change anything, don't attempt the task, and don't run tests or builds. A few minutes of reading is \
enough: the task, any document it names, and the code it touches.

# Task

${e.task}
${me(e,true)}${e.context?`
# Context from the user

${e.context}
`:""}${e.plan.length?`
# Documents the user gave

${e.plan.map(n=>`- ${n}`).join("\n")}
`:""}
# The documents the work follows

If the task depends on a plan, checklist or other document, find it: the paths above, or a file the task names (resolved\
 against the repository root, and ~/.claude/plans/ for a plan named there). If it depends on one you can't identify or f\
ind, including "the plan" with no file named, return status "needs-plan" with planMissing saying what is missing. Never \
pick a plan yourself. Otherwise planMissing is "", and status is "ok" (or "needs-split", below).

${t.maxRunMin||t.maxTurns?`# Execution budget
The entire task has ${t.maxRunMin||"unlimited"} minutes and ${t.maxTurns||"unlimited"} model turns, including verificati\
on, audits and delivery. If the chosen process is unlikely to fit, explicitly warn in reasons. Preserve all required che\
cks; do not call a risky task simple to fit a deadline. A fully specified implementation can use Pair at Feature complex\
ity.

`:""}# The tiers, cheapest first

- "simple": a change to the code that is small, contained and unambiguous: roughly 3 files or fewer and about 100 change\
d lines, no public API or schema change, no design choice the request leaves open, and for a bug, a cause that is alread\
y clear. One implementer, one reviewer.
- "fix": a bug or a question whose cause is unknown or subtle, where the obvious answer may be wrong, but the eventual c\
hange is contained. Two independent attempts, cross-checked.
- "feature": new behaviour with real design choices, a public API change, work across several modules, or a request that\
 is ambiguous. Two independent plans, debated and merged, then built in at most ${ae} checked increments and audited for\
 correctness, design and tests.
- "architecture": the request asks for a design or a plan (with milestones, options, trade-offs) rather than the change \
itself, or the work is too big for one feature: one connected change that needs more than about ${ae} reviewable increme\
nts, or one where a design decision must be settled before its increments can be planned. Three independent designs, deb\
ated; the chosen one is broken into milestones, each built later by a run of its own.

Pick the lowest tier that plausibly suffices. A run whose tier proves too low hands the work up automatically, on eviden\
ce, and that costs a few turns; a tier too high costs dozens. A request that is ambiguous is never simple.

# One task or several

Some requests bundle pieces of work that stand on their own: a checklist of bugs, a list of fixes that each have their o\
wn cause, a task that asks for one commit per item. One run debates and reviews them all together, so the whole costs th\
e tier of its hardest piece, and each piece is reviewed as part of a crowd. When the request is two or more such pieces,\
 each with its own cause or deliverable and each reviewable and committable by itself, return status "needs-split" and l\
ist the pieces in \`split\`, in the order to do them:
- \`task\`: the piece as a task of its own, for someone who has not seen this request: what to change and why, what to rea\
d (the same documents, by path, and the part that applies) and what done means. Bookkeeping the request asks for on each\
 piece, such as a tracker row or a changelog entry, goes with that piece.
- \`tier\`: your estimate for that piece alone, from the tiers above.
- \`after\`: the numbers (from 1) of earlier pieces it builds on, since each run starts from the committed code; [] if non\
e.

Don't split one change that touches many files, steps of one feature that only make sense together, or a request whose p\
ieces are simple together. Pieces that stand on their own are a split; one connected piece of work too big to build at o\
nce is architecture. List at most 12 pieces, grouping small related ones when there are more. With "needs-split", still \
give the tier, mode, reasons and signals for the request as a whole, since it may be run as one anyway. Otherwise \`split\
\` is [].

The mode is what the work delivers: "implement" (a change someone commits), "investigate" (an answer, with nothing in th\
e repository changed) or "design" (a design or plan). Architecture is always design.

# Your answer

Return the tier, the mode, and in \`reasons\` up to three sentences on why, naming what in the code or the task decided it\
. Fill \`signals\` from what you read: the kind of request; your estimate of how many files the change touches (0 for an i\
nvestigation or a design); whether it changes a public API or schema; whether it crosses modules; whether existing tests\
 cover the area ("yes", "no" or "unknown"); whether the request is ambiguous; and whether a plan or other document was g\
iven or named.`}function xn(e,t){const n=ft(e);return e.questions.filter(r=>!ht(e,r.id,t)&&mt(e,r)>=n)}function wt(e,t){
return{version:1,executor:t?.executor||null,evaluator:t?.evaluator||null,invocation:t?.invocation||null,candidate:t?.candidate||
null,inputs:t?.inputs||null}}function En(e,t){const n=ct(e,t),r=at(e,t);return n?`${t} (${n.name})`:r?`the ${r.lens} aud\
itor (${r.name})`:String(t)}function j(e,t,n){return{status:"needs-plan",reason:`the task depends on a document the coun\
cil couldn't find: ${t||"unspecified"}`,mode:e.mode,task:e.task,runDir:n||null,notes:e.notes,forTheOrchestrator:`The cou\
ncil stopped before any seat started: the task depends on a plan or document it couldn't find (${g(t,300)||"unspecified"}\
). Seats work in worktrees checked out from HEAD and can't see uncommitted files, so the document has to be passed in. F\
ind it yourself: `+(e.host==="codex"?"look in the repository and the documents named in this conversation. Then rerun th\
e runner with the original args and the document's absolute path in plan. ":`a plan made in this conversation is under ~\
/.claude/plans/; otherwise look in the repository for the file the user named. Then rerun with object args and its absol\
ute path: Workflow({name: "${te(e.workflowName)}", args: {task: <the task, saying which part to do>, plan: ["/abs/path"]\
, …the other args}}). `)+"Don't paste the document into the task. If you can't tell which document is meant, ask the u\
ser."+(n?` Remove the partial run with \`${e.cli} cleanup --run-dir ${ne(n)} --all\`.`:"")}}function v(e,t,n,r){return{status:t,
reason:n,mode:e.mode,task:e.task,runDir:e.run?e.run.runDir:null,notes:e.notes,...r||{},forTheOrchestrator:`The council s\
topped early (${t}): ${n}. Tell the user plainly; nothing was applied to their tree.`+(e.run?` Clean up with \`${e.cli} \
cleanup --run-dir ${ne(e.run.runDir)} --all\` unless they want to inspect it.`:"")}}function yt(e,t){const n=t.final||{};
const r=n.snapshotRef?.match(/\/([A-Z])-([^/]+)$/);return{artifactType:"dark-factory-summary",artifactVersion:1,status:t.
status,workflow:t.workflow||e.workflowName,...t.provenance?{provenance:wt(e,t.provenance)}:{},runDir:t.runDir,stopReason:t.
stopReason||t.error||"",final:{readiness:n.readiness,snapshotRef:n.snapshotRef||null,snapshotTree:n.snapshotTree||null,post:n.
post||null,diff:n.diff||null,worktree:n.worktree||null,suite:n.suite?{ran:n.suite.ran,passed:n.suite.passed,command:n.suite.
command||e.verify,log:n.suite.log||null,...n.suite.failureKind?{failureKind:n.suite.failureKind}:{},...n.suite.overrides?
{overrides:n.suite.overrides}:{}}:null},findings:(t.findings||[]).filter(i=>i.status==="open").map(i=>({id:i.id,severity:i.
severity,statement:i.statement})),questions:t.questions||[],delivery:t.delivery||null,artifacts:{room:t.room||e.run?.room||
null,verification:t.runDir?`${t.runDir}/verification.json`:null,measurement:r?`${t.runDir}/jobs/measure-${r[1]}-${r[2]}/\
status.json`:null},cleanupAfterDelivery:`dark-factory cleanup --run-dir ${k(t.runDir)}`}}const R=["simple","fix","featur\
e","architecture"];const C={implementer:"sonnet",reviewer:"astra",maxLines:200,maxFiles:8};const bt={...C,implementer:"a\
stra"};function pe(e){const t=e.tier===void 0||e.tier===null||e.tier===""?null:String(e.tier).toLowerCase();if(t&&!R.includes(
t))throw new Error(`factory: unknown tier '${e.tier}'. Known: ${R.join(", ")}.`);const n=e.simple&&typeof e.simple==="ob\
ject"?e.simple:{};const r=e.host==="codex"?bt:C;const i=(a,s)=>Number.isInteger(Number(a))&&Number(a)>0?Number(a):s;return{
tier:t,tierConfirmed:e.tierConfirmed===true,noSplit:e.noSplit===true,simple:{implementer:String(n.implementer||r.implementer),
reviewer:String(n.reviewer||r.reviewer),maxLines:i(n.maxLines,C.maxLines),maxFiles:i(n.maxFiles,C.maxFiles)}}}function M(e){
const t=e&&R.includes(e.tier)?e.tier:"feature";if((t==="simple"||t==="feature")&&e&&e.mode&&e.mode!=="implement")return e.
mode==="design"?"architecture":"fix";return t}function kt(e){const t=e&&e.status==="needs-split"&&Array.isArray(e.split)?
e.split.filter(n=>n&&String(n.task||"").trim()):[];if(t.length<2)return[];return t.map((n,r)=>({n:r+1,title:g(n.title,120)||
`Piece ${r+1}`,task:String(n.task).trim(),tier:R.includes(n.tier)?n.tier:"feature",after:[...new Set((Array.isArray(n.after)?
n.after:[]).filter(i=>Number.isInteger(i)&&i>=1&&i<=r))]}))}function vt(e,t){const n=e.factory;if(!n.asked||n.tierConfirmed)
return null;const r=M(t);return r===n.asked?null:{asked:n.asked,recommended:r}}function $t(e,t,n){return{status:"needs-t\
ier",task:e.task,asked:t.asked,recommended:t.recommended,reasons:n.reasons||"",signals:n.signals||null,notes:e.notes,forTheOrchestrator:`\
The factory stopped before ${e.factory?.brief?"tier work":"creating anything"}: the user asked for the ${t.asked} tier, \
and intake recommends ${t.recommended} (${g(n.reasons,400)||"no reason given"}). Ask the user in one short message wheth\
er to keep ${t.asked} or switch to ${t.recommended}, with intake's reason. `+(e.host==="codex"?`Rerun the runner with th\
e original args file and tierConfirmed: true to keep it, or tier: "${t.recommended}" to switch. This starts a new run. `:
`To keep it: Workflow({name: "dark-factory:factory", resumeFromRunId: <this run's id>, args: <exactly the args you launc\
hed with, as an object>, plus tierConfirmed: true}). To switch: the same call with tier: "${t.recommended}" instead. Int\
ake replays from cache either way. `)+"A kept tier is only where the run starts: if the evidence shows it is too low, th\
e run still hands the work up."}}function xt(e,t,n){const r=M(n);const i=e.factory&&e.factory.asked;return{status:"needs\
-split",task:e.task,items:t,tier:r,reasons:n.reasons||"",signals:n.signals||null,notes:e.notes,forTheOrchestrator:`The f\
actory stopped before ${e.factory?.brief?"tier work":"creating anything"}: intake found ${t.length} separate pieces of w\
ork in this task (${g(n.reasons,400)||"no reason given"}). One run would debate and review them all together, at the cos\
t of the hardest piece. Show the user the pieces (items[]: title, estimated tier, and the earlier pieces each builds on)\
 and ask in one short message: run them one at a time (recommended), or the whole task as one ${i||r} run. `+(e.host==="\
codex"?"One at a time: rerun the runner for each piece in order, preserving the original args and replacing task with th\
at piece's task, so plan, context and the rest carry over. ":`One at a time: for each piece in order, Workflow({name: "d\
ark-factory:factory", args: <the args you launched with>, with task replaced by the piece's task}), so plan, context and\
 the rest carry over. `)+`Each run starts from HEAD and stops on a dirty tree, so present each result as usual and wait \
for the user to commit it before the next piece starts. Don't pin the estimated tiers: each run's intake picks its own${i?
`. The user pinned ${i} for the whole task; ask whether it applies to each piece`:""}. `+(e.host==="codex"?"As one: reru\
n the runner with the original args and noSplit: true. This starts a new run.":`As one: Workflow({name: "dark-factory:fa\
ctory", resumeFromRunId: <this run's id>, args: <exactly the args you launched with, as an object>, plus noSplit: true})\
. Intake replays from cache.`)}}function Et(e){return`Original task: ${e.task}
Context: ${e.context||"(none)"}
Documents: ${JSON.stringify(e.plan)}
Explicit constraints: ${JSON.stringify({mode:e.raw.mode,criteria:e.raw.criteria,verify:e.raw.verify})}
Inspect the repository${e.raw.repo?" at "+e.raw.repo:""} and the documents relevant to this request. Read only, apart fr\
om saving the requested brief. Preserve the user's wording and decisions. If a required document cannot be found, name i\
t in planMissing where provided. Include "testing", "implementation" and "internal design" in delegated. Keep the brief \
short.`}function y(e){return typeof e==="string"&&!!e.trim()}function A(e){return e&&["outcome","purpose","scope","nonGo\
als","verification"].every(t=>y(e[t]))&&Array.isArray(e.acceptanceExamples)&&e.acceptanceExamples.length&&e.acceptanceExamples.
every(y)&&Array.isArray(e.delegated)&&e.delegated.every(y)}function he(e,t){return e?.version===1&&e.state===t&&Array.isArray(
e.decisions)&&e.decisions.every(n=>n&&[n.id,n.question,n.answer].every(y))&&!!A(e.brief)}function me(e,t=false){const n=L(
e);if(!n)return"";const r=n.brief;const i=[`Outcome: ${r.outcome}`,`Purpose: ${r.purpose}`];if(t)i.push(`Scope: ${r.scope}`,
`Non-goals: ${r.nonGoals}`,"Acceptance examples:",...r.acceptanceExamples.map(a=>"- "+a),`Verification: ${r.verification}`,
`Delegated decisions: ${r.delegated.join(", ")}.`,...n.decisions.map(a=>`User decision ${a.id} (${a.question}): ${a.answer}`));
return"\n# Goal brief\n\n"+i.join("\n")+"\n"}function Rt(e,t){const n=ke(e);if(!n||!t)return false;return t.source===n||
!!e.run?.runDir&&t.path===`${e.run.runDir}/refs/${n.slice(n.lastIndexOf("/")+1)}`}function Tt(e,t){const n=L(e);if(!n)return t;
const r=e.refs.find(f=>Rt(e,f));const i=r?.path||ke(e);const a=(b(e).droppedDecisions||[]).map(f=>`Earlier decision ${f.
id} no longer applies (${f.status}): ${g(f.reason,300)}`);const s=me(e,true).replace("\n# Goal brief\n\n","").trimEnd()+
(a.length?"\n"+a.join("\n"):"")+"\nBrief file: "+i;let c=t.report?.markdown||"";const l=/^(?:### )?How the run went:?$/m;
c=l.test(c)?c.replace(l,f=>f+"\n\n"+s):"### How the run went\n\n"+s+(c?"\n\n"+c:"");const d=b(e).ticketTitle;return{...t,
brief:n,briefFile:i,...d?{ticket:Nt(d,n)}:{},report:{...t.report,markdown:c}}}const ge="Groomed by dark-factory";const X=[
{field:"outcome",heading:"Outcome"},{field:"purpose",heading:"Why"},{field:"scope",heading:"Scope"},{field:"nonGoals",heading:"\
Out of scope"},{field:"acceptanceExamples",heading:"Acceptance examples",list:true},{field:"verification",heading:"How w\
e'll know it's done"},{field:"delegated",heading:"Left to the implementers",list:true},{field:"decisions",heading:"Decis\
ions",list:true,optional:true}];function Ot(e){const t=e.trim().replace(/^#{1,6}\s+/,"").replace(/^h[1-6]\.\s+/i,"").replace(
/^[*_]+|[*_]+$/g,"").replace(/:$/,"").trim().replace(/[‘’]/g,"'").toLowerCase();return X.find(n=>n.heading.toLowerCase()===
t)||null}function At(e){return e.trim().replace(/^[*_]+|[*_]+$/g,"").toLowerCase().startsWith(ge.toLowerCase())}const we=/^\s*(?:[-*•]|#|\d+[.)])\s+/;
function ye(e){const t=[];for(const n of e){if(!n.trim())continue;if(we.test(n))t.push(n.replace(we,"").trim());else if(t.
length)t[t.length-1]+=" "+n.trim();else t.push(n.trim())}return t}function It(e){const t=/^([A-Z][1-9][0-9]*)\s*[:.]\s*(.+?)\s+(?:→|->)\s+(.+)$/.
exec(e);return t?{id:t[1],question:t[2].trim(),answer:t[3].trim()}:null}function Dt(e){const t=String(e||"").replace(/\r\n?/g,
"\n").split("\n");const n=t.findIndex(At);if(n<0)return null;const r={},i=[];let a=null;for(const l of t.slice(0,n)){if(/^\s*-{3,}\s*$/.
test(l))continue;const d=Ot(l);if(d){if(r[d.field])return null;a=d;r[d.field]=[];continue}if(a)r[a.field].push(l);else if(l.
trim())i.push(l.trim().replace(/^#{1,6}\s+/,"").replace(/^h[1-6]\.\s+/i,""))}const s={};let c=[];for(const l of X){const d=r[l.
field];if(!d){if(l.optional)continue;return null}if(l.field==="decisions"){const f=ye(d).filter($=>!/^none\.?$/i.test($));
c=f.map(It);if(c.some($=>!$))return null}else s[l.field]=l.list?ye(d):d.map(f=>f.trim()).filter(Boolean).join("\n")}if(!A(
s)||!s.delegated.length)return null;if(new Set(c.map(l=>l.id)).size!==c.length)return null;return{title:i.join(" "),brief:s,
decisions:c}}function Nt(e,t){const n=t.brief;const r=s=>s.map(c=>`- ${c}`).join("\n");const i=t.decisions.length?t.decisions.
map(s=>`- ${s.id}: ${s.question} → ${s.answer}`).join("\n"):"None.";const a={...n,acceptanceExamples:r(n.acceptanceExamples),
delegated:r(n.delegated),decisions:i};return`# ${e}

`+X.map(s=>`## ${s.heading}

${a[s.field]}`).join("\n\n")+`

---

${ge}
`}function Ft(e){return g(String(e||"").split("\n").find(t=>t.trim())||"Untitled",100)}function jt(e,t,n){const r=Math.max(
0,...e.map(i=>String(i.id)).filter(i=>i.startsWith(t)).map(i=>Number(i.slice(t.length))||0));return Array.from({length:n},
(i,a)=>`${t}${r+a+1}`)}const be=["holds","superseded","obsolete"];function Ct(e,t){if(!Array.isArray(t)||t.length!==e.length)
return null;const n=new Map;for(const r of t){if(!r||typeof r.id!=="string"||n.has(r.id)||!be.includes(r.status)||!y(r.reason))
return null;n.set(r.id,r)}if(!e.every(r=>n.has(r.id)))return null;return e.filter(r=>n.get(r.id).status==="holds")}function b(e){
return e.factory||e.goal||null}function L(e){return b(e)?.brief||null}function ke(e){return b(e)?.briefFile||""}function K(e,t,n,r=1e4){
if(e===void 0)return t;const i=Number(e);if(!Number.isSafeInteger(i)||i<1||i>r)throw new Error(`${n} must be an integer \
from 1 to ${r}.`);return i}function Mt(e){const t=e.repair===void 0?null:e.repair;if(t!==null&&(!t||typeof t!=="object"||
Array.isArray(t)))throw new Error("repair must be an object.");if(t?.minor!==void 0&&!["block","report"].includes(t.minor))
throw new Error("repair.minor must be block or report.");return{maxTurns:K(e.maxTurns,null,"maxTurns"),maxRunMin:K(e.maxRunMin,
null,"maxRunMin",10080),repair:t&&{maxPasses:K(t.maxPasses,2,"repair.maxPasses",20),minor:t.minor||"block"}}}function Lt(e,t){
const n=e.raw.strategy||"auto";if(!["auto","pair","independent"].includes(n))throw new Error("strategy must be auto, pai\
r, or independent.");const r=["seats","simple","panel","spec","audit","roles","evidence"].filter(s=>e.raw[s]!==void 0&&!(s===
"spec"&&e.raw[s]==="ask"));if(n==="pair"&&r.length)throw new Error(`Pair strategy does not accept ${r.join(", ")}; confi\
gure participants with pair: {author, reviewer, maxReviews}.`);const i=e.factory.tier;const a=e.raw.mode||t.mode;if(n===
"pair"&&(a!=="implement"||i==="architecture"))throw new Error("Pair strategy requires an implementation below Architectu\
re.");return n==="pair"||n==="auto"&&!r.length&&t.strategy==="pair"&&a==="implement"&&i!=="architecture"?"pair":"indepen\
dent"}function _t(e){const t=n=>n.map(r=>({model:r.key,vendor:r.vendor,effort:r.effort}));return{workflow:e.factory?"fac\
tory":e.workflowName,tier:e.factory?.tier||e.tier,strategy:e.factory?.strategy||(e.pairOptions?"pair":"independent"),mode:e.
mode,output:e.workflowName==="ensemble"?"measured, independently reviewed candidates and advisory ranking; no automatic \
selection":e.mode==="implement"?"reviewed implementation in a worktree; delivery pending":e.tier==="architecture"?"revie\
wed design and milestones; no implementation":e.mode,participants:t(e.lineup),reviewers:t(e.auditors),panel:t(e.panel),specification:t(
e.specReviewers),roles:Object.fromEntries(Object.entries(e.roles||{}).map(([n,r])=>[n,{model:r.key,vendor:r.vendor}])),requiredCLIs:fe(
e).map(n=>n==="gemini"?"agy":n),verification:e.verify||e.raw.verify||"discovered during setup; not yet run",limits:{...e.
controls,repair:e.controls.repair||(e.tier==="simple"?{maxPasses:1,minor:"block"}:null),maxReviews:e.pairOptions?.maxReviews||
null,rounds:e.pairOptions?null:e.rounds},effort:e.pairOptions?`Setup${e.specReviewers.length?", a spec review":""}, ${e.
pairOptions.design===false?"no design stage; ":"design and "}code turns, up to the review budget; measurements between c\
ode revisions.`:"Depends on findings, retries and escalation. Limits are caps, not cost forecasts.",intake:e.factory?.intake||
null}}function qt(e,t,n,r){const i={};for(const s of e.spec.findings){const c=i.specification||(i.specification={found:0,
upheld:0,refuted:0,amended:0});c.found++;if(s.status==="accepted")c.upheld++;if(s.status==="rejected")c.refuted++;if(e.spec.
applied.some(l=>l.id===s.id))c.amended++}for(const s of e.ledger.filter(c=>c.kind==="finding")){const c=pt(s.author)?"au\
dit":typeof s.round==="number"?"debate":"ratification";const l=i[c]||(i[c]={found:0,upheld:0,refuted:0,fixed:0});l.found++;
if(s.status==="verified")l.upheld++;if(s.status==="refuted")l.refuted++;if(s.fixed)l.fixed++}for(const s of e.pair?.findings||
[]){const c=i[s.stage]||(i[s.stage]={found:0,upheld:0,refuted:0,fixed:0});c.found++;if(s.status==="fixed"){c.fixed++;c.upheld++}
;if(s.status==="refuted")c.refuted++}const a=t.candidates;if(a)i.ensembleReview={found:a.reduce((s,c)=>s+c.reviews.reduce(
(l,d)=>l+(d.defects?.length||0),0),0)};return{version:1,taskId:e.raw.evaluation?.taskId||null,variant:e.raw.evaluation?.
variant||null,repetition:e.raw.evaluation?.repetition||null,workflow:e.factory?"factory":e.workflowName,tier:e.factory?.
tier||e.tier,strategy:e.factory?.strategy||(e.pair?"pair":"independent"),host:e.host,elapsedMs:n,turns:r,turnsByRole:e.turnLog.
reduce((s,c)=>({...s,[c.role]:(s[c.role]||0)+1}),{}),failedTurns:e.turnLog.filter(s=>!s.ok).length,findingsByStage:i,...a?
{candidates:{total:a.length,ready:a.filter(s=>s.final.readiness.state==="ready").length}}:{},readiness:t.final?.readiness?.
state||null,delivery:t.delivery?.status||"not-recorded",escalated:!!e.factory?.escalation,requestedImplementation:e.factory?.
intake?.mode==="implement"||e.mode==="implement",deliveredImplementation:false,tokens:null,cost:null,limits:{maxTurns:e.
controls.maxTurns,maxRunMin:e.controls.maxRunMin},...e.pair?{userDecisions:{asked:e.pair.asked?.length||0,answered:e.pair.
decisions?.length||0,unused:(t.unusedAnswers||[]).length}}:{}}}function I(e){if(!Number.isFinite(e))return"?";const t=n=>String(
n<10?Math.round(n*10)/10:Math.round(n));return e<1e3?String(Math.round(e)):e<1e6?`${t(e/1e3)}k`:`${t(e/1e6)}M`}const Bt=e=>Math.
round(e/6e4);function ve(e,t){if(!t)return"";if(t.meter!==void 0){return t.meter>0?`

### Token use

Claude Code's budget meter counted about ${I(t.meter)} output tokens while this workflow ran (its own agents and anythin\
g else in the session). Input, cache and per-model counts, Codex and Gemini turns included: \`${e.cli} usage --run-dir ${k(
e.run?.runDir||"RUN")}\`.`:""}const n=Object.entries(t.byModel||{});const r=t.missing||[];if(!n.length&&!r.length)return"";
const i=(c,l)=>`| ${c} | ${l.turns} | ${I(l.input)} | ${I(l.cachedInput)} | ${I(l.cacheCreation)} | ${I(l.output)} | ${Bt(
l.seconds*1e3)} min |`;const a=n.length?["| Model | Turns | Input | Cached | Cache writes | Output | Turn time |","|---|\
---|---|---|---|---|---|",...n.sort((c,l)=>l[1].input-c[1].input).map(([c,l])=>i(c,l)),i("**Total**",t.total)].join("\n"):
"";const s=r.length?`

${Be(r.length,"turn")} reported no usage (${[...new Set(r.map(c=>c.reason))].slice(0,3).join("; ")}): the result's metri\
cs.tokens reads them back from the vendors' logs where it can, and lists the rest as missing.`:"";return`

### Token use

${a}${s}`}const Pt=1;const Wt={pair:"pair",independent:"council"};const Gt=["turnLog","processNotes","notes","relayFailu\
res","vendorTimes"];function $e(e){return te(Wt[e.strategy])}function Ut(e,t){return{version:Pt,strategy:e.factory.strategy,
tier:e.factory.tier,factory:e.factory,carried:de(e),control:t}}const J="$factoryWire";const Rn=Object.freeze({});function z(e){
if(e===void 0||typeof e==="number"&&(!Number.isFinite(e)||Object.is(e,-0))){return{[J]:Object.is(e,-0)?"-0":String(e)}}if(e===
null||typeof e!=="object")return e;if(Array.isArray(e))return Array.from(e,z);const t=Object.fromEntries(Object.entries(
e).map(([n,r])=>[n,z(r)]));return Object.hasOwn(e,J)?{[J]:"object",value:t}:t}function Ht(e,t){return{started:e.started??
null,turns:e.turns,maxTurns:e.maxTurns??null,maxRunMin:e.maxRunMin??null,meterStart:Number.isFinite(t)?t:null}}function T(e){
return e!==null&&typeof e==="object"&&!Array.isArray(e)}function xe(e,t){return e==="simple"&&(t==="fix"||t==="feature")||
e==="feature"&&t==="architecture"}function Xt(e,t){for(let n=e;n!==null&&n!==void 0;n=n.earlier){if(!T(n)||!xe(n.from,n.
to))return"illegal escalation edge";if(n.to!==t)return"escalation chain does not lead to this tier";t=n.from}return""}function Kt(e){
if(!T(e))return"carried must be an object";const t=Gt.find(n=>!Array.isArray(e[n]));return t?`carried.${t} must be an ar\
ray`:""}function S(e,t){const n=Reflect.ownKeys(e);return n.length===t.length&&n.every(r=>t.includes(r))}function Ee(e,t,n=new WeakMap){
if(Object.is(e,t))return true;if(!e||!t||typeof e!=="object"||typeof t!=="object")return false;if(Array.isArray(e)!==Array.
isArray(t))return false;const r=n.get(e)??new WeakSet;if(r.has(t))return true;r.add(t);n.set(e,r);const i=Reflect.ownKeys(
e);return i.length===Reflect.ownKeys(t).length&&i.every(a=>Object.hasOwn(t,a)&&Ee(e[a],t[a],n))}function Jt(e,t){const n=l=>{
throw new Error(`factory: unexpected result from ${$e(e)} (${l}).`)};if(!T(t)||t.factoryChild!==1)n("invalid child resul\
t marker");if(S(t,["factoryChild","final","usage"])){if(!T(t.final))n("final must be an object");if(typeof t.usage!=="bo\
olean")n("usage must be a boolean");return t}if(!S(t,["factoryChild","handUp"]))n("invalid child result fields");const r=t.
handUp;if(!T(r)||!S(r,["to","trigger","why","escalation","carried","turns"])){n("invalid handUp fields")}if(typeof r.trigger!==
"string"||typeof r.why!=="string")n("trigger and why must be strings");if(e.strategy!=="independent")n("only independent\
 children can hand up");if(!xe(e.tier,r.to))n("illegal hand-up edge");if(!T(r.escalation)||r.escalation.from!==e.tier||r.
escalation.to!==r.to){n("escalation does not match hand-up edge")}const i=r.escalation;const a=l=>Array.isArray(l)&&l.every(
d=>typeof d==="string");if(!a(i.findings)||!a(i.tests)||!a(i.criteria)){n("escalation findings, tests and criteria must \
be arrays of strings")}if(["trigger","why","runDir","suiteTail"].some(l=>typeof i[l]!=="string")){n("escalation trigger,\
 why, runDir and suiteTail must be strings")}const s=Xt(r.escalation,r.to);if(s)n(s);if(!Ee(e.factory.escalation??null,r.
escalation.earlier??null)){n("escalation.earlier does not match incoming escalation")}if(!Number.isInteger(r.turns)||r.turns<
e.control.turns)n("turns must be an integer at least as large as the incoming count");const c=Kt(r.carried);if(c)n(c);return t}
function zt(e,t){return{version:e.version,strategy:e.strategy,tier:t.to,factory:{...e.factory,tier:t.to,escalation:t.escalation},
carried:de(t.carried),control:{...e.control,turns:t.turns}}}function St(e){const t=e.factory.args;return String((e.strategy===
"pair"?{...t,...t.pair}:t).cli||"dark-factory")}let o=it(rt(re(args,{"no-brief":["brief",false]}),{workflow:"factory"}));
const h=typeof factoryRuntime==="undefined"?null:factoryRuntime;const w={started:Qt(),turns:0,...o.controls};const Re=e=>({
type:"string",description:`Feedback on the ${e} process, not on the task: at most two sentences on anything in this turn\
's instructions, inputs or tools that got in your way, such as an unclear or conflicting instruction, missing context, w\
asted effort, a limit that cut you short, or a command that failed. Name the instruction or input. "" if nothing did; do\
n't invent feedback.`});const Vt=Re("council"),Zt=Re("pair");function Yt(e){if(!o.retro||!e)return e;return{...e,properties:{
...e.properties,process:o.pair?Zt:Vt},required:[...e.required||[],"process"]}}const Te=Oe();function Oe(){try{return typeof budget!==
"undefined"&&budget&&typeof budget.spent==="function"?budget.spent():null}catch{return null}}function Ae(){if(h?.usage){
try{return h.usage()}catch{return null}}const e=Oe();const t=w.delegated?w.meterStart:Te;return e===null||t===null?null:
{meter:Math.max(0,e-t)}}function Qt(){if(o.controls.maxRunMin&&!h?.now)throw new Error("maxRunMin requires the standalon\
e dark-factory-codex runner; the native workflow runtime has no replay-safe clock. Use maxTurns for native runs.");return h?.
now?h.now()-(h.elapsedBefore||0):null}function en(e){return e?.code==="CHECKPOINT_MISMATCH"||e?.code==="RUN_LIMIT"||e?.code===
"ENGINE_DRIFT"}function tn(){const e=w;if(e.maxTurns&&e.turns>=e.maxTurns||e.maxRunMin&&h.now()-e.started>=e.maxRunMin*6e4){
const t=new Error(e.maxTurns&&e.turns>=e.maxTurns?`Run turn budget exhausted (${e.maxTurns}).`:`Run time budget exhauste\
d (${e.maxRunMin} minutes).`);e.stop=t.message;t.code="RUN_LIMIT";throw t}e.turns++}async function nn(e){try{return await e()}catch(t){
if(t.code!=="RUN_LIMIT")throw t;return{status:"blocked",stopReason:t.message,task:o.task,runDir:o.run?.runDir||null,final:{
readiness:{state:"incomplete",blocked:[],incomplete:[t.message]}}}}}function rn(e){if(w.stop&&e.final?.readiness?.state!==
"ready"){e.status="blocked";e.stopReason=w.stop;e.final={...e.final,readiness:{state:"incomplete",blocked:e.final?.readiness?.
blocked||[],incomplete:[...e.final?.readiness?.incomplete||[],w.stop]}}}Pe(e);e.plan=e.plan||_t(o);e.metrics=qt(o,e,w.started!==
null?h.now()-w.started:null,w.turns);if(!w.delegated&&o.workflowName!=="council"&&e.report&&typeof e.report.markdown==="\
string"){const t=ve(o,Ae());if(t)e.report={...e.report,markdown:`${e.report.markdown}${t}`}}if((o.factory||o.pairOptions)&&
e.runDir){e.artifactType="dark-factory-result";e.artifactVersion=1;const{summary:t,...n}=e;return{summary:yt(o,e),...n}}
return e}function on(e,t,n,r){const i=r&&typeof r.process==="string"?g(r.process,400):"";if(o.retro&&i&&!/^(none|n\/a|nothing)\.?$/i.
test(i))o.processNotes.push({turn:e,role:t,who:n,text:i})}function sn(e,t){const n=t&&t.permissionDenials;if(n)o.notes.push(
`${e}: ${n.count} tool permission denial(s) (${n.tools.join(", ")}). ${t.status==="done"?"The completed submission was a\
ccepted for verification and review":"The submission was not accepted"}. Denied checks are not evidence of passing; deta\
ils: ${n.source}`)}async function Ie(e,t,n,r){tn();const i=ie(o,n,t);const{copies:a,...s}=t;const{measures:c,...l}=s;const d=a?
t.schema:Yt(t.schema);const f=h?await an(e,{...s,schema:d},n,r):await agent(e,{...l,schema:d});o.turnLog.push({turn:t.label,
role:n,vendor:h?i.vendor:"claude",ok:!!f});on(t.label,n,r||(h?i.name:t.model),f);return f}async function an(e,t,n,r,i={}){
const a=ie(o,n,t);try{return await h.agent({...t,prompt:e,vendor:a.vendor,model:a.model,effort:a.effort,role:n,who:r||a.
name,run:o.run,fresh:true,onResult:s=>{sn(t.label,s);if(s.status!=="done")o.notes.push(`${n} turn ${t.label} failed: ${g(
s.error||s.status,300)}`)},timeoutMin:cn(n),...n==="setup"?{preflightVendors:fe(o),setupRunId:st(o)}:{},...i})}catch(s){
if(en(s))throw s;o.notes.push(`${n} turn ${t.label} failed: ${g(s&&s.message||s,300)}`);return null}}function cn(e){const t=o.
raw.timeoutMin;const n=t&&typeof t==="object"?t[e]:t;const r=Math.round(Number(n));return r>0?r:null}const p={type:"stri\
ng"};const ln=["testing","implementation","internal design"];const V={type:"object",properties:{outcome:p,purpose:p,scope:p,
nonGoals:p,acceptanceExamples:{type:"array",items:p},verification:p,delegated:{type:"array",items:p}}};const _={brief:V,
planMissing:p};const De={type:"object",properties:{id:p,question:p,answer:p}};const Ne={type:"object",properties:{version:{
type:"integer"},state:p,brief:V,decisions:{type:"array",items:De}}};const Z={type:"object",properties:{question:p,wording:p,
outcomeA:p,outcomeB:p,evidence:p,recommendation:p,changes:p}};const un={type:"object",properties:{id:p,status:{type:"str\
ing",enum:be},reason:p}};const Fe={type:"array",items:{type:"object",properties:{title:p,task:p}}};const je="For each, g\
ive the competing outcomes, evidence considered, a recommended answer and what the answer changes. Write the question, b\
oth outcomes, the recommendation and what changes for the user who asked, in their terms: what they would see, receive o\
r be able to do. Name internal components, roles or mechanisms only where the user's own wording does. Do not ask about \
testing, implementation, internal design, preferences or speculative cases. There is no completeness checklist.";function q(){
return o.workflowName==="brief"}function dn(){return o.roles?.intake||!o.roles?.setup?"intake":"setup"}function B(e,t,n){
return Ie(t+"\n\n"+Et(o),{label:e,phase:"Brief",model:"opus",effort:"medium",schema:O({type:"object",properties:n})},dn())}
function Y(e,t=false){if(h)return"Return briefFile as an empty string. The runner saves the file.";const n=t?"STATE":"se\
ttled";const r=e==="held";return`Write the object you return in brief as UTF-8 JSON to a temporary file with the file to\
ol. Save it by running this helper, substituting the quoted temporary file path for FILE${t?" and provisional for STATE \
if questions survive, otherwise settled":""}${r?", and for DECISIONS the quoted JSON array of the carried decisions you \
mark holds, unchanged and in their order":""}:
${o.cli} brief --repo ${o.raw.repo?k(o.raw.repo):'"$PWD"'} --content FILE --state ${n} --decisions ${r?"DECISIONS":k(JSON.
stringify(e))}
Copy the printed briefFile and document.brief exactly. On helper failure leave briefFile empty.`}async function Ce(e,t,n,r){
const i={version:1,state:t,brief:e,decisions:n};const a=h?await h.brief({document:i}):{document:i,briefFile:r};return P(
a,t)}function P(e,t){const n=e?.document;const r=t==="settled"?"/BRIEF.json":"/BRIEF.provisional.json";if(typeof e?.briefFile!==
"string"||!e.briefFile.startsWith("/")||!e.briefFile.endsWith(r)||!he(n,t))return v(o,"failed",e?.error||"Factory could \
not read or save a valid goal brief.");const i=b(o);i.brief={...n,brief:{...n.brief,delegated:fn(n.brief.delegated)}};i.
briefFile=e.briefFile;return null}function fn(e){const t=ln.filter(n=>!e.some(r=>r.trim().toLowerCase().startsWith(n)));
return[...e,...t]}function Me(e){return A(e?.brief)&&Array.isArray(e.questions)&&e.questions.every(t=>t&&Object.keys(Z.properties).
every(n=>y(t[n]))&&t.outcomeA.trim()!==t.outcomeB.trim())}function pn(e){const t=e.raw.criteria;return!!e.context||e.plan.
length>0||W.includes(e.raw.mode)||(Array.isArray(t)?t.length>0:!!String(t||"").trim())}async function hn(){const e=o.raw;
if(!b(o))o.goal={};if(e.brief===false)return null;if(e.brief!==void 0){if(typeof e.brief!=="string"||!e.brief.startsWith(
"/"))return v(o,"failed","brief must be false or an absolute path to a settled brief.");if(o.factory&&!pn(o)){if(h)return P(
await h.brief({source:e.brief}),"settled");return null}if(h){const n=await h.brief({source:e.brief});const r=P(n,"settle\
d");if(r)return r;return await Q(L(o),"","")}return await Q(null,e.brief,"")}const t=Dt(o.task);if(t){const n=t.title||g(
t.brief.outcome,100);b(o).ticketTitle=n;return await Q({version:1,state:"settled",brief:t.brief,decisions:t.decisions},"",
n)}return await mn()}async function mn(){phase("Brief");const e=q();const t=await B("brief shape","Shape the requested g\
oal into a short brief. State the user-visible outcome and its purpose, scope and non-goals, concrete acceptance example\
s and the observable evidence that would verify delivery. Delegate testing, implementation and internal design explicitl\
y. Do not ask the user questions or decide a tier."+(e?' Give the ticket a short title in title. If the text names no ou\
tcome anyone could deliver, say why in notActionable and return your best draft; otherwise return notActionable as "".':
""),e?{..._,title:p,notActionable:p}:_);if(t?.planMissing)return j(o,t.planMissing,null);if(e&&y(t?.notActionable))return gn(
t.notActionable);if(!A(t?.brief))return v(o,"failed","The shaper returned no usable goal brief.");if(e)b(o).ticketTitle=
y(t.title)?g(t.title,100):Ft(o.task);const n=await B("brief challenge",`Independently challenge the draft against the or\
iginal wording. Try to show two plausible outcomes the wording permits that the user would judge differently. Quote the \
wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each difference from r\
epository evidence: read the relevant code, docs, git log, retros and available issues. Correct the draft where evidence\
 settles it. An unavailable source is not itself a reason to ask.
Return all and only unresolved what/why differences in questions. ${je} Return [] on a clear goal, including a clear one\
-line goal. No criteria or harness review.${e?`
${Le}`:""}
Draft: ${JSON.stringify(t.brief)}
${Y([],true)}`,{..._,questions:{type:"array",items:Z},briefFile:p,...e?{split:Fe}:{}});if(n?.planMissing)return j(o,n.planMissing,
null);if(!Me(n))return v(o,"failed","The brief challenger returned no usable verdict.");return await _e(n,[],[],n.questions,
n.briefFile)}const Le="If the text bundles standalone pieces of work that should be separate tickets (fixes with separat\
e causes, unrelated features, one change per item of a list), list each in split with a short title and the piece as a t\
ask complete for someone who has not seen this text; otherwise return []. A goal with several acceptance examples is one\
 ticket.";async function Q(e,t,n){phase("Brief");const r=q();const i=t?`Load the settled brief first. Run this exact com\
mand:
${o.cli} brief --repo ${o.raw.repo?k(o.raw.repo):'"$PWD"'} --reuse ${k(t)}
Its document.brief is the brief to check and its document.decisions the carried decisions. Copy that document into docum\
ent.`:`Brief: ${JSON.stringify(e.brief)}
Carried decisions: ${JSON.stringify(e.decisions)}`;const a=await B("brief recheck",`Independently re-check a goal brief \
settled earlier${n?" from a groomed ticket":""} against the original task and every explicit input below. Try to show tw\
o plausible outcomes that the task, its context, its documents or its explicit constraints now permit and the user would\
 judge differently: wording the brief no longer matches, an input that conflicts with it, or a question an edit opened. \
Quote the wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each differe\
nce from repository evidence: read the relevant code, docs, git log, retros and available issues. Correct the brief wher\
e evidence settles it. An unavailable source is not itself a reason to ask.
Give a verdict on every carried decision in decisionReview, with its id: holds when it still applies as answered; supers\
eded when one of your questions replaces it (name that question in reason); obsolete when the task no longer contains wh\
at it was about. Keep the decisions that hold; never ask again what one of them settles.
Return all and only unresolved what/why differences in questions. ${je} Return [] when the brief still captures the goal\
. No criteria or harness review.${r?`
${Le}`:""}
${i}
${Y("held",true)}${h?"":"\nCopy the printed document.decisions into savedDecisions."}`,{..._,questions:{type:"array",items:Z},
decisionReview:{type:"array",items:un},briefFile:p,...t?{document:Ne}:{},...h?{}:{savedDecisions:{type:"array",items:De}},
...r?{split:Fe}:{}});if(a?.planMissing)return j(o,a.planMissing,null);const s=t?a?.document:e;if(t&&!he(s,"settled"))return v(
o,"failed","Factory could not read or save a valid goal brief.");const c=s.decisions;const l=Me(a)?Ct(c,a.decisionReview):
null;if(!l)return v(o,"failed","The brief re-check returned no usable verdict.");const d=b(o);d.droppedDecisions=a.decisionReview.
filter(f=>f.status!=="holds");return await _e(a,c,l,a.questions,a.briefFile)}async function _e(e,t,n,r,i){const a=q()?"G":
"B";const s=jt(t,a,r.length);const c=r.map((u,m)=>({...u,id:s[m],kind:"brief"}));if(q())b(o).split=Array.isArray(e.split)?
e.split.filter(u=>u&&y(u.title)&&y(u.task)):[];const l=await Ce(e.brief,c.length?"provisional":"settled",n,i);if(l)return l;
const d=u=>JSON.stringify((Array.isArray(u)?u:[]).map(m=>[m?.id,m?.question,m?.answer]));if(!h&&e.savedDecisions!==void 0&&
d(e.savedDecisions)!==d(n))return v(o,"failed","The saved goal brief does not keep exactly the carried decisions that ho\
ld.");if(!c.length)return null;const f=[...n],$=[];for(const u of c){const m=o.clarifications.filter($n=>$n.id===u.id);if(m.
length!==1||!m[0].answer.trim())$.push(u);else f.push({id:u.id,question:u.question,answer:m[0].answer})}if($.length){const u=h?
"Resume the saved hostRunDir with --resume and an args file":`Resume this dark-factory:${o.workflowName} workflow in the\
 same session using resumeFromRunId and the original arguments`;const m=`${u}, appending {id, answer} entries to clarifi\
cations. Keep earlier answers unchanged.`;return{status:"needs-user",task:o.task,questions:$,decisions:f,resumable:true,
resumeSteps:m,forTheOrchestrator:"Ask all questions together. Show both outcomes, the recommendation and what the answer\
 changes. "+m}}const D=await B("brief answered",`Revise the brief so its outcome, scope and acceptance examples follow t\
he user's answers. The answers settle the challenge.
Brief: ${JSON.stringify(e.brief)}
Questions: ${JSON.stringify(c)}
User decisions: ${JSON.stringify(f)}
${Y(f)}`,{brief:V,briefFile:p});if(!A(D?.brief))return v(o,"failed","The shaper returned no usable answered brief.");const N=await Ce(
D.brief,"settled",f,D.briefFile);if(!N){const u=new Set(f.map(m=>m.id));o.raw={...o.raw,clarifications:o.raw.clarifications.
filter(m=>!u.has(m?.id))};o.clarifications=o.clarifications.filter(m=>!u.has(m.id));if(o.pairOptions)o.pairOptions={...o.
pairOptions,answers:o.pairOptions.answers.filter(m=>!u.has(m?.id))}}return N}function gn(e){return{status:"not-actionabl\
e",task:o.task,reason:g(e,600),forTheOrchestrator:`The text names no outcome anyone could deliver: ${g(e,600)} Tell the \
writer what is missing and groom again once the ticket says what it should achieve.`}}const wn=O({type:"object",properties:{
strategy:{type:"string",enum:["independent","pair"],description:"Pair for scoped implementation with one clear approach \
and iterative review; independent for competing hypotheses or plans. Architecture and investigations require independent\
."},status:{type:"string",enum:["ok","needs-plan","needs-split"]},tier:{type:"string",enum:R},mode:{type:"string",enum:W},
reasons:{type:"string",description:"Up to three sentences: what in the task or the code decided the tier."},planMissing:{
type:"string",description:'With status "needs-plan": the document the task depends on that you could not find. Otherwise\
 "".'},signals:{type:"object",properties:{kind:{type:"string",enum:["bug","feature","change","question","design"]},files:{
type:"integer",description:"Your estimate of the files the change touches; 0 for an investigation or a design."},publicApi:{
type:"boolean",description:"Does it change a public API or schema?"},crossModule:{type:"boolean"},testsCover:{type:"stri\
ng",enum:["yes","no","unknown"]},ambiguous:{type:"boolean"},planGiven:{type:"boolean"}}},split:{type:"array",description:'\
With status "needs-split": the separate pieces of work, in the order to do them. Otherwise [].',items:{type:"object",properties:{
title:{type:"string",description:"A few words naming the piece."},task:{type:"string",description:"The piece as a task o\
f its own, complete for someone who has not seen this request."},tier:{type:"string",enum:R,description:"Your estimate f\
or this piece alone."},after:{type:"array",items:{type:"integer"},description:"The numbers (from 1) of earlier pieces th\
is one builds on; [] if none."}}}}}});async function yn(){let e=gt(o),t=wn;const n=typeof o.raw.brief==="string"&&!h&&!L(
o);if(n){e=`Before choosing a tier, load the supplied settled brief. Run this exact command:
${o.cli} brief --repo ${o.raw.repo?k(o.raw.repo):'"$PWD"'} --reuse ${k(o.raw.brief)}
Use its document with the original task. Copy its document and briefFile into your result. On failure leave briefFile em\
pty.

${e}`;t=O({type:"object",properties:{...t.properties,document:Ne,briefFile:p}})}const r=await Ie(e,{label:"intake",phase:"\
Intake",schema:t,model:"opus",effort:"medium"},"intake");if(n){const i=P(r,"settled");if(i)return{error:i};const{document:a,
briefFile:s,...c}=r;return{intake:c}}return{intake:r}}async function bn(){const e=o.raw;const t=pe(e);o.factory={};const n=await hn();
if(n)return n;phase("Intake");const{intake:r,error:i}=await yn();if(i)return i;if(!r)return v(o,"failed","the intake age\
nt returned nothing");if(r.status==="needs-plan")return j(o,r.planMissing,null);const a=kt(r);o.factory={...o.factory,tier:null,
asked:t.tier,tierConfirmed:t.tierConfirmed,chosenBy:"intake",recommended:M(r),intake:r,escalation:null,args:o.raw,split:a.
length?{pieces:a.length,declined:true}:null};if(a.length&&!t.noSplit)return xt(o,a,r);const s=vt(o,r);if(s)return $t(o,s,
r);const c=t.tier||M(r);o.factory.tier=c;o.factory.chosenBy=!t.tier?"intake":c===o.factory.recommended?"pinned":"overrul\
ed";o.factory.strategy=Lt(o,r);log(`factory: tier ${c} (${o.factory.chosenBy}${o.factory.chosenBy==="intake"?"":`; intak\
e recommends ${o.factory.recommended}`}): ${g(r.reasons,200)}`);return await kn(c,r)}const ee=await nn(bn);if(!ee?.handoff)
return Tt(o,rn(ee));return await vn(ee.handoff);async function kn(){return{handoff:Ut(o,Ht(w,h?null:Te))}}async function vn(e){
const t=n=>{const r=ve({cli:St(e),run:n.runDir?{runDir:n.runDir}:void 0},Ae());return r?{...n,report:{...n.report,markdown:`${n.
report.markdown}${r}`}}:n};for(;;){const n=Jt(e,await workflow($e(e),{factoryHandoff:z(e)}));if(n.final)return n.usage?t(
n.final):n.final;const r=n.handUp;log(`factory: escalating from ${r.escalation.from} to ${r.to} (${r.trigger}): ${r.why}`);
e=zt(e,r)}}
