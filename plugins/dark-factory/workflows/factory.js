export const meta = {
  name: 'factory',
  description: 'Routes one task to the process it needs: a simple change gets one implementer and one reviewer, harder work the council; escalates on evidence',
  whenToUse: 'Use for implementation work the user wants done end to end with independent review, when it is not obvious how much process it needs. A shaper and a fresh challenger clarify the goal before intake. Pass brief: false (--no-brief) to skip or an absolute brief file path in brief to reuse it. An Opus intake reads the task and the code and picks a tier: simple (Sonnet implements, Codex Astra reviews, at most one fix pass: about 8-11 agent turns), fix (a subtle bug: Opus and Astra attempt it blind and debate, through /council), feature (Opus and Astra each plan it blind and debate the plans; the chosen plan, merged with the best of the other, is built by its author in at most 4 checked increments, then audited for correctness, design and tests: about 27-42 agent turns) or architecture (a request for a design or plan, or one connected piece of work too big for one feature: Opus, Astra and Sonnet design it blind and debate the designs; the chosen design\'s author writes a milestone plan, reviewed for grounding (Astra), sequencing (Opus) and risk and alternatives (Gemini Hydrogen) and revised once; nothing is built: about 37-52 agent turns). The lowest tier that plausibly suffices is chosen, because a run whose tier the evidence shows is too low hands the work to a higher tier automatically, in the same run: Simple on failing verification after its fix pass, an upheld design finding, a change over its size budget, or the implementer saying so; Feature when its chosen plan needs more than 4 increments, which goes to architecture before anything is built. An architecture result lists milestones[], each with a task, draft criteria, the earlier milestones it builds on, a tier and ready-made args: show them, then offer to run each as its own /factory run with Workflow({name: "dark-factory:factory", args: milestones[i].args}), one at a time and in order, committing each before the next; never start one unasked. When the user names a tier, pass it in `tier` (or prefix a string task with --tier simple); if intake disagrees, the run stops with status needs-tier before tier work, and you ask the user once: rerun with tierConfirmed: true to keep their tier, or with intake\'s. A kept tier is where the run starts, not a ceiling. When the task bundles separate pieces of work (a checklist, several fixes with their own causes, one commit per item), intake stops the run with status needs-split and lists them: ask the user once whether to run each piece as its own /factory run, in order and committing each before the next, or the whole task as one (rerun with noSplit: true). Seats work in git worktrees checked out from HEAD, so they cannot see uncommitted files: if the work follows a plan or other document that is not committed (a plan from plan mode under ~/.claude/plans/, an untracked PLAN.md, a checklist), pass its absolute path in `plan`, e.g. {task: "Do item 13 on the bug checklist", plan: ["/abs/path/BUG_CHECK_LIST.md"]}, and say in the task which part to do; do not paste the document. `simple: {implementer, reviewer, maxLines, maxFiles}` changes the Simple tier; every /council argument (seats, spec, audit, rounds, ...) passes through to the council tiers, audit: {tests: <model>} swaps the Feature tier\'s tests auditor (Sonnet), and audit: {risk: <model>} the Architecture tier\'s risk reviewer (Gemini Hydrogen; swap it for "sonnet" if the Antigravity CLI is unavailable).',
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
function we(e,t){const n=String(e??"");return n.length<=t?n:n.slice(0,t)+" […]"}function g(e,t){
return we(String(e??"").replace(/\s+/g," ").trim(),t)}function U(e){return`dark-factory:${e}`}function w(e){return`'${String(
e).replace(/'/g,`'\\''`)}'`}function H(e){return/^[\w./:@%+=,-]+$/.test(String(e))?String(e):w(e)}function x(e){if(!e||typeof e!==
"object")return e;const t={...e};if(t.type==="object"&&t.properties){t.properties=Object.fromEntries(Object.entries(t.properties).
map(([n,r])=>[n,x(r)]));t.required=Object.keys(t.properties);t.additionalProperties=false}if(t.type==="array"&&t.items)t.
items=x(t.items);return t}const ye=(e,t)=>`${e} ${t}${e===1?"":"s"}`;function be(e){if(!e||typeof e!=="object"||!("resum\
able"in e)||e.status==="needs-user")return e;const t=typeof e.resumeSteps==="string"?e.resumeSteps:"";for(const n of[e,e.
summary]){if(!n||typeof n!=="object")continue;if(t&&typeof n.forTheOrchestrator==="string")n.forTheOrchestrator=n.forTheOrchestrator.
split(` ${t}`).join("").split(t).join("");delete n.resumable;delete n.resumeSteps}return e}function X(e,t={}){if(typeof e!==
"string")return e||{};const n={},r={seats:"seats",tier:"tier",strategy:"strategy",author:"author",reviewer:"reviewer","m\
ax-reviews":"maxReviews","max-design-reviews":"maxDesignReviews","max-turns":"maxTurns","max-run-min":"maxRunMin",candidates:"\
candidates",reviewers:"reviewers",mode:"mode",runtime:"runtime"};let i=e,s;while(true){if(/^\s*--explain(?:\s|$)/.test(i)){
n.explain=true;i=i.replace(/^\s*--explain(?:\s+|$)/,"");continue}const o=i.match(/^\s*--([\w-]+)(?:\s+([\s\S]*))?$/);if(o&&
Object.hasOwn(t,o[1])){n[t[o[1]][0]]=t[o[1]][1];i=o[2]||"";continue}s=i.match(/^\s*--([\w-]+)[= ]\s*([^\s]+)(?:\s+([\s\S]*))?$/);
if(!s||!r[s[1]]&&s[1]!=="repair-passes")break;if(s[1]==="repair-passes")n.repair={maxPasses:s[2]};else n[r[s[1]]]=s[2];i=
s[3]||""}return{task:i,...n}}const ke=/\b(implement|fix|add|writ(e|ing)|build|refactor|migrat\w*|port|rename|remove|delete|optimi[sz]\w*|patch|introduce|support)\b/i;
const ve=/\b(design|architect\w*|propos(e|al)|approach(es)?|trade-?offs?|strategy|plan)\b/i;const G=["implement","invest\
igate","design"];const $e={implement:800,investigate:1500,design:4e3,plan:1500};const D={opus:{vendor:"claude",model:"op\
us",name:"Claude Opus"},sonnet:{vendor:"claude",model:"sonnet",name:"Claude Sonnet"},fable:{vendor:"claude",model:"fable",
name:"Claude Fable"},haiku:{vendor:"claude",model:"haiku",name:"Claude Haiku"},astra:{vendor:"codex",model:"gpt-6.2-astr\
a",name:"Codex Astra"},sol:{vendor:"codex",model:"gpt-6.2-sol",name:"Codex Sol"},luna:{vendor:"codex",model:"gpt-6-luna",
name:"Codex Luna"},terra:{vendor:"codex",model:"gpt-6.1-terra",name:"Codex Terra"},gemini:{vendor:"gemini",model:"gemini\
-4-hydrogen",name:"Gemini Hydrogen",efforts:["low","medium","high","xhigh"]},argon:{vendor:"gemini",model:"gemini-4-argo\
n",name:"Gemini Argon",efforts:["low","medium","high"]},neon:{vendor:"gemini",model:"gemini-4-neon",name:"Gemini Neon",efforts:[
"low","medium","high","xhigh"]}};const xe=["opus","sonnet","astra","gemini"];const Ee=["opus","astra","sol"];const Re=/^(?=.*[A-Za-z0-9])[A-Za-z0-9._~:@+\/-]{1,128}$/;
const Te=e=>e.external===true||e.vendor!=="claude";const b=(e,t)=>e==="codex"?{...t,external:true}:t;const F={intake:"as\
tra",setup:"astra",checker:"astra",questions:"luna",spec:"astra",retro:"astra",record:"luna"};const Oe={intake:"medium",
setup:"medium",checker:"medium",questions:"low",spec:"medium",retro:"medium",record:"low"};function Ae(e){if(e.host!=="c\
odex")return{};const t=e.roles&&typeof e.roles==="object"?e.roles:{};for(const n of Object.keys(t))if(!(n in F))throw new Error(
`factory: unknown role '${n}'. Known: ${Object.keys(F).join(", ")}.`);return Object.fromEntries(Object.entries(F).map(([
n,r])=>{const i=t[n];const s=i&&typeof i==="object"?i:{model:i};const o=s.model||n==="checker"&&e.checkModel||r;return[n,
y(o,s.effort||Oe[n])]}))}function K(e,t,n){return e.roles&&e.roles[t]?e.roles[t]:{vendor:"claude",model:n.model,name:n.model,
effort:n.effort}}const z=["low","medium","high","xhigh","max"];const Ie=[...z,"ultra"];function y(e,t){const n=String(e).
trim(),r=n.toLowerCase();let i;if(D[r])i={key:r,...D[r]};else if(r.startsWith("codex:")&&r.length>6)i={key:r,vendor:"cod\
ex",model:r.slice(6),name:`Codex ${r.slice(6)}`};else if(r.startsWith("gemini:")&&r.length>7)i={key:r,vendor:"gemini",model:r.
slice(7),name:`Gemini ${r.slice(7)}`,slug:true};else if(r.startsWith("openrouter:")&&Re.test(n.slice(11))){const c=n.slice(
11);i={key:`openrouter:${c}`,vendor:"openrouter",model:c,name:`OpenRouter ${c}`}}else throw new Error(`council: unknown \
seat '${e}'. Known: ${Object.keys(D).join(", ")}, codex:<model-id>, gemini:<model-id> or openrouter:<model-id>.`);const s=t&&
typeof t==="object"?t[i.key]:t;i.effort=s?String(s).toLowerCase():"high";const o=i.vendor==="codex"?Ie:z;if(!o.includes(
i.effort))throw new Error(`council: effort '${i.effort}' is not valid for ${i.name}. Valid: ${o.join(", ")}.`);if(i.vendor===
"gemini"&&!i.slug){const c=["low","medium","high","xhigh","max","ultra"];const u=c.indexOf(i.effort);i.effort=i.efforts.
reduce((d,h)=>Math.abs(c.indexOf(h)-u)<=Math.abs(c.indexOf(d)-u)?h:d);i.model=`${i.model}-${i.effort}`}delete i.efforts;
delete i.slug;return i}const De=e=>e.vendor==="openrouter"?`openrouter:${e.model}`:e.vendor;const T=e=>(Array.isArray(e)?
e:typeof e==="string"?e.split(","):[]).map(t=>String(t).trim()).filter(Boolean);const j={correctness:{model:"astra",id:"\
XC"},design:{model:"opus",id:"XD"}};const J={tests:{model:"sonnet",id:"XT"}};const V=4;const Z={review:{model:"astra",id:"\
XR"}};const Y={grounding:{model:"astra",id:"XG"},sequencing:{model:"opus",id:"XS"},risk:{model:"gemini",id:"XK"}};const Fe={
correctness:{model:"astra",id:"XC"},design:{model:"astra",id:"XD"}};const je={tests:{model:"luna",id:"XT"}};const Ne={grounding:{
model:"astra",id:"XG"},sequencing:{model:"astra",id:"XS"},risk:{model:"luna",id:"XK"}};function Ce(e,t=j){if(e===false)return[];
const n=e&&typeof e==="object"?e:{};return Object.entries(t).map(([r,i])=>({lens:r,id:i.id,...y(n[r]||i.model,n.effort||
"high")}))}const Q={coverage:"astra",intent:"opus"};function Me(e,t=Q){if(e===false)return{reviewers:[],ask:false};const n=e&&
typeof e==="object"?e:{};return{reviewers:Object.entries(t).map(([r,i])=>({lens:r,...y(n[r]||i,n.effort||"high")})),ask:e===
"ask"||n.ask===true}}function qe(e,t={}){const n=X(e);const r=n.host==="codex"?"codex":"claude";const i=Ae(n);const s=String(
n.task||n.prompt||n.question||"").trim();if(!s){throw new Error("council: no task given. Pass args as a string, or {task\
, mode?, seats?, rounds?, ...}.")}const o=t.tier==="simple"?te(n).simple:null;const c=!!o||G.includes(n.mode);const u=o?
"implement":c?n.mode:ke.test(s)?"implement":ve.test(s)?"design":"investigate";const d=(o?[y(o.implementer,n.effort)]:(T(
n.seats).length?T(n.seats):r==="codex"?Ee:xe).map(f=>y(f,n.effort))).map(f=>b(r,f));if(!o&&(d.length<2||d.length>6))throw new Error(
"council: use between 2 and 6 seats.");const h=r==="codex"?Fe:j;const Xt=r==="codex"?je:J;const Gt=r==="codex"?Ne:Y;const ge=o?
{reviewers:[],ask:false}:Me(n.spec,r==="codex"?{coverage:"astra",intent:"astra"}:Q);return{raw:n,host:r,roles:i,task:s,modeGiven:c,
mode:u,controls:at(n),rounds:Math.max(1,Math.min(3,Number(n.rounds)||2)),context:String(n.context||"").trim(),plan:(Array.
isArray(n.plan)?n.plan:n.plan?[n.plan]:[]).map(f=>String(f).trim()).filter(Boolean),cli:String(n.cli||"dark-factory"),allowDirty:n.
allowDirty===true,evidence:n.evidence===true,narrow:n.narrow!==false,retro:n.retro!==false,approval:n.approval===true,ballot:n.
ballot===true,clarifications:(Array.isArray(n.clarifications)?n.clarifications:[]).filter(f=>f&&f.id&&f.answer).map(f=>({
id:String(f.id),answer:String(f.answer),afterRound:Number.isInteger(f.afterRound)?f.afterRound:-1})),lineup:d,panel:(T(n.
panel).length?T(n.panel):r==="codex"?["astra","sol"]:["opus","astra"]).map(f=>b(r,y(f,"high"))),auditors:o?[{lens:"revie\
w",id:Z.review.id,...y(o.reviewer,"high")}].map(f=>b(r,f)):Ce(n.audit,t.tier==="feature"?{...h,...Xt}:t.tier==="architec\
ture"?Gt:h).map(f=>b(r,f)),specReviewers:o?[]:ge.reviewers.map(f=>b(r,f)),specAsk:o?false:ge.ask,workflowName:t.workflow||
"council",tier:t.tier||null,simple:o,escalation:t.escalation||null,checkModel:r==="codex"?i.checker.key:["sonnet","opus",
"haiku","fable"].includes(n.checkModel)?n.checkModel:"sonnet",letters:"ABCDEF".slice(0,d.length).split("")}}function Le(e){
return{...e,postWords:$e[e.mode],run:null,seats:[],criteria:[],verify:"",refs:[],baselineOk:true,baselineNote:"",ledger:[],
byId:{},challenges:[],adoptions:[],votes:{},ballots:{},questions:[],pendingQ:[],pos:{},behaviour:{},testResults:{},notes:[],
seatNotes:{},processNotes:[],turnLog:[],relayFailures:[],longPosts:[],inContention:null,dropped:[],declined:[],lastRound:0,
blocked:{},vendorTimes:[],spec:{ran:false,reviews:{},findings:[],applied:[],assumptions:[],answered:[],before:null},auditedTag:null,
factory:null,build:null,milestones:null}}function S(e){return{turnLog:e.turnLog.slice(),processNotes:e.processNotes.slice(),
notes:e.notes.slice(),relayFailures:e.relayFailures.slice(),vendorTimes:e.vendorTimes.slice()}}function _e(e){return[...e.
lineup,...e.panel,...e.specReviewers,...e.auditors,...e.ensemble?[e.ensemble.compare]:[],...e.host==="codex"?Object.values(
e.roles).map(t=>b(e.host,t)):[]].filter(Te)}function ee(e){return[...new Set(_e(e).map(De))]}function Pe(e){if(e.host!==
"codex"||e.raw.hostRunId===void 0||e.raw.hostRunId===null)return null;const t=e.raw.hostRunId;const n=e.pair?.setupAttempt||
0;const r=`${t}-${e.tier||e.workflowName}${n?`-answered${n>1?`-${n}`:""}`:""}`;if(typeof t!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.
test(t)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r)){throw new Error("factory: hostRunId must contain only letters, digits,\
 dots, underscores and hyphens, starting with a letter or digit.")}return r}function Be(e,t){return e.auditors.find(n=>n.
id===t)}function We(e,t){return e.seats.find(n=>n.L===t)}function Ue(e){return e.seats.filter(t=>t.active)}function He(e,t){
return e.seats.some(n=>n.L===t&&n.active)}function Xe(e,t){const n=Ue(e).length||e.seats.length;const r=Number(t);return r?
Math.max(1,Math.min(n,r)):Math.max(2,Math.ceil(2*n/3))}function Ge(e){return Xe(e,e.raw.escalateAt)}const Ke=e=>(Object.
entries({...j,...J,...Z,...Y}).find(([,t])=>t.id===e)||[])[0];function ze(e,t,n=Infinity){return e.clarifications.some(r=>r.
id===t&&!(Number(r.afterRound)>n))}function Je(e,t){return new Set([...t.raisedBy,...t.seconds].filter(n=>He(e,n))).size}
function Ve(e){const t=e.raw.intakeLimits||{};return`Choose collaboration separately from complexity: strategy=pair for \
a scoped implementation with one clear approach that benefits from repeated review; strategy=independent for competing r\
oot causes or plans. Keep the tier based on task complexity. Architecture and investigations always use independent atte\
mpts.

You are the intake for a software factory. A task arrives, and you decide how much process it needs, before anyone works\
 on it. Read; don't change anything, don't attempt the task, and don't run tests or builds. A few minutes of reading is \
enough: the task, any document it names, and the code it touches.

# Task

${e.task}
${ne(e,true)}${e.context?`
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
 is ambiguous. Two independent plans, debated and merged, then built in at most ${V} checked increments and audited for \
correctness, design and tests.
- "architecture": the request asks for a design or a plan (with milestones, options, trade-offs) rather than the change \
itself, or the work is too big for one feature: one connected change that needs more than about ${V} reviewable incremen\
ts, or one where a design decision must be settled before its increments can be planned. Three independent designs, deba\
ted; the chosen one is broken into milestones, each built later by a run of its own.

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
iven or named.`}function Kt(e,t){const n=Ge(e);return e.questions.filter(r=>!ze(e,r.id,t)&&Je(e,r)>=n)}function Ze(e,t){
return{version:1,executor:t?.executor||null,evaluator:t?.evaluator||null,invocation:t?.invocation||null,candidate:t?.candidate||
null,inputs:t?.inputs||null}}function zt(e,t){const n=We(e,t),r=Be(e,t);return n?`${t} (${n.name})`:r?`the ${r.lens} aud\
itor (${r.name})`:String(t)}function N(e,t,n){return{status:"needs-plan",reason:`the task depends on a document the coun\
cil couldn't find: ${t||"unspecified"}`,mode:e.mode,task:e.task,runDir:n||null,notes:e.notes,forTheOrchestrator:`The cou\
ncil stopped before any seat started: the task depends on a plan or document it couldn't find (${g(t,300)||"unspecified"}\
). Seats work in worktrees checked out from HEAD and can't see uncommitted files, so the document has to be passed in. F\
ind it yourself: `+(e.host==="codex"?"look in the repository and the documents named in this conversation. Then rerun th\
e runner with the original args and the document's absolute path in plan. ":`a plan made in this conversation is under ~\
/.claude/plans/; otherwise look in the repository for the file the user named. Then rerun with object args and its absol\
ute path: Workflow({name: "${U(e.workflowName)}", args: {task: <the task, saying which part to do>, plan: ["/abs/path"],\
 …the other args}}). `)+"Don't paste the document into the task. If you can't tell which document is meant, ask the us\
er."+(n?` Remove the partial run with \`${e.cli} cleanup --run-dir ${H(n)} --all\`.`:"")}}function k(e,t,n,r){return{status:t,
reason:n,mode:e.mode,task:e.task,runDir:e.run?e.run.runDir:null,notes:e.notes,...r||{},forTheOrchestrator:`The council s\
topped early (${t}): ${n}. Tell the user plainly; nothing was applied to their tree.`+(e.run?` Clean up with \`${e.cli} \
cleanup --run-dir ${H(e.run.runDir)} --all\` unless they want to inspect it.`:"")}}function Ye(e,t){const n=t.final||{};
const r=n.snapshotRef?.match(/\/([A-Z])-([^/]+)$/);return{artifactType:"dark-factory-summary",artifactVersion:1,status:t.
status,workflow:t.workflow||e.workflowName,...t.provenance?{provenance:Ze(e,t.provenance)}:{},runDir:t.runDir,stopReason:t.
stopReason||t.error||"",final:{readiness:n.readiness,snapshotRef:n.snapshotRef||null,snapshotTree:n.snapshotTree||null,post:n.
post||null,diff:n.diff||null,worktree:n.worktree||null,suite:n.suite?{ran:n.suite.ran,passed:n.suite.passed,command:n.suite.
command||e.verify,log:n.suite.log||null,...n.suite.failureKind?{failureKind:n.suite.failureKind}:{},...n.suite.overrides?
{overrides:n.suite.overrides}:{}}:null},findings:(t.findings||[]).filter(i=>i.status==="open").map(i=>({id:i.id,severity:i.
severity,statement:i.statement})),questions:t.questions||[],delivery:t.delivery||null,artifacts:{room:t.room||e.run?.room||
null,verification:t.runDir?`${t.runDir}/verification.json`:null,measurement:r?`${t.runDir}/jobs/measure-${r[1]}-${r[2]}/\
status.json`:null},cleanupAfterDelivery:`dark-factory cleanup --run-dir ${w(t.runDir)}`}}const v=["simple","fix","featur\
e","architecture"];const O={implementer:"sonnet",reviewer:"astra",maxLines:200,maxFiles:8};const Qe={...O,implementer:"a\
stra"};function te(e){const t=e.tier===void 0||e.tier===null||e.tier===""?null:String(e.tier).toLowerCase();if(t&&!v.includes(
t))throw new Error(`factory: unknown tier '${e.tier}'. Known: ${v.join(", ")}.`);const n=e.simple&&typeof e.simple==="ob\
ject"?e.simple:{};const r=e.host==="codex"?Qe:O;const i=(s,o)=>Number.isInteger(Number(s))&&Number(s)>0?Number(s):o;return{
tier:t,tierConfirmed:e.tierConfirmed===true,noSplit:e.noSplit===true,simple:{implementer:String(n.implementer||r.implementer),
reviewer:String(n.reviewer||r.reviewer),maxLines:i(n.maxLines,O.maxLines),maxFiles:i(n.maxFiles,O.maxFiles)}}}function A(e){
const t=e&&v.includes(e.tier)?e.tier:"feature";if((t==="simple"||t==="feature")&&e&&e.mode&&e.mode!=="implement")return e.
mode==="design"?"architecture":"fix";return t}function Se(e){const t=e&&e.status==="needs-split"&&Array.isArray(e.split)?
e.split.filter(n=>n&&String(n.task||"").trim()):[];if(t.length<2)return[];return t.map((n,r)=>({n:r+1,title:g(n.title,120)||
`Piece ${r+1}`,task:String(n.task).trim(),tier:v.includes(n.tier)?n.tier:"feature",after:[...new Set((Array.isArray(n.after)?
n.after:[]).filter(i=>Number.isInteger(i)&&i>=1&&i<=r))]}))}function et(e,t){const n=e.factory;if(!n.asked||n.tierConfirmed)
return null;const r=A(t);return r===n.asked?null:{asked:n.asked,recommended:r}}function tt(e,t,n){return{status:"needs-t\
ier",task:e.task,asked:t.asked,recommended:t.recommended,reasons:n.reasons||"",signals:n.signals||null,notes:e.notes,forTheOrchestrator:`\
The factory stopped before ${e.factory?.brief?"tier work":"creating anything"}: the user asked for the ${t.asked} tier, \
and intake recommends ${t.recommended} (${g(n.reasons,400)||"no reason given"}). Ask the user in one short message wheth\
er to keep ${t.asked} or switch to ${t.recommended}, with intake's reason. `+(e.host==="codex"?`Rerun the runner with th\
e original args file and tierConfirmed: true to keep it, or tier: "${t.recommended}" to switch. This starts a new run. `:
`To keep it: Workflow({name: "dark-factory:factory", resumeFromRunId: <this run's id>, args: <exactly the args you launc\
hed with, as an object>, plus tierConfirmed: true}). To switch: the same call with tier: "${t.recommended}" instead. Int\
ake replays from cache either way. `)+"A kept tier is only where the run starts: if the evidence shows it is too low, th\
e run still hands the work up."}}function nt(e,t,n){const r=A(n);const i=e.factory&&e.factory.asked;return{status:"needs\
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
. Intake replays from cache.`)}}function rt(e){return`Original task: ${e.task}
Context: ${e.context||"(none)"}
Documents: ${JSON.stringify(e.plan)}
Explicit constraints: ${JSON.stringify({mode:e.raw.mode,criteria:e.raw.criteria,verify:e.raw.verify})}
Inspect the repository${e.raw.repo?" at "+e.raw.repo:""} and the documents relevant to this request. Read only, apart fr\
om saving the requested brief. Preserve the user's wording and decisions. If a required document cannot be found, name i\
t in planMissing where provided. Include "testing", "implementation" and "internal design" in delegated. Keep the brief \
short.`}function E(e){return typeof e==="string"&&!!e.trim()}function I(e){return e&&["outcome","purpose","scope","nonGo\
als","verification"].every(t=>E(e[t]))&&Array.isArray(e.acceptanceExamples)&&e.acceptanceExamples.length&&e.acceptanceExamples.
every(E)&&Array.isArray(e.delegated)&&e.delegated.every(E)}function it(e,t){return e?.version===1&&e.state===t&&Array.isArray(
e.decisions)&&e.decisions.every(n=>n&&[n.id,n.question,n.answer].every(E))&&!!I(e.brief)}function ne(e,t=false){const n=e.
factory?.brief;if(!n)return"";const r=n.brief;const i=[`Outcome: ${r.outcome}`,`Purpose: ${r.purpose}`];if(t)i.push(`Sco\
pe: ${r.scope}`,`Non-goals: ${r.nonGoals}`,"Acceptance examples:",...r.acceptanceExamples.map(s=>"- "+s),`Verification: ${r.
verification}`,`Delegated decisions: ${r.delegated.join(", ")}.`,...n.decisions.map(s=>`User decision ${s.id} (${s.question}\
): ${s.answer}`));return"\n# Goal brief\n\n"+i.join("\n")+"\n"}function ot(e,t){const n=e.factory?.briefFile;if(!n||!t)return false;
return t.source===n||!!e.run?.runDir&&t.path===`${e.run.runDir}/refs/${n.slice(n.lastIndexOf("/")+1)}`}function st(e,t){
if(!e.factory?.brief)return t;const n=e.refs.find(c=>ot(e,c));const r=n?.path||e.factory.briefFile;const i=ne(e,true).replace(
"\n# Goal brief\n\n","").trimEnd()+"\nBrief file: "+r;let s=t.report?.markdown||"";const o=/^(?:### )?How the run went:?$/m;
s=o.test(s)?s.replace(o,c=>c+"\n\n"+i):"### How the run went\n\n"+i+(s?"\n\n"+s:"");return{...t,brief:e.factory.brief,briefFile:r,
report:{...t.report,markdown:s}}}function C(e,t,n,r=1e4){if(e===void 0)return t;const i=Number(e);if(!Number.isSafeInteger(
i)||i<1||i>r)throw new Error(`${n} must be an integer from 1 to ${r}.`);return i}function at(e){const t=e.repair===void 0?
null:e.repair;if(t!==null&&(!t||typeof t!=="object"||Array.isArray(t)))throw new Error("repair must be an object.");if(t?.
minor!==void 0&&!["block","report"].includes(t.minor))throw new Error("repair.minor must be block or report.");return{maxTurns:C(
e.maxTurns,null,"maxTurns"),maxRunMin:C(e.maxRunMin,null,"maxRunMin",10080),repair:t&&{maxPasses:C(t.maxPasses,2,"repair\
.maxPasses",20),minor:t.minor||"block"}}}function ct(e,t){const n=e.raw.strategy||"auto";if(!["auto","pair","independent"].
includes(n))throw new Error("strategy must be auto, pair, or independent.");const r=["seats","simple","panel","spec","au\
dit","roles","evidence"].filter(o=>e.raw[o]!==void 0&&!(o==="spec"&&e.raw[o]==="ask"));if(n==="pair"&&r.length)throw new Error(
`Pair strategy does not accept ${r.join(", ")}; configure participants with pair: {author, reviewer, maxReviews}.`);const i=e.
factory.tier;const s=e.raw.mode||t.mode;if(n==="pair"&&(s!=="implement"||i==="architecture"))throw new Error("Pair strat\
egy requires an implementation below Architecture.");return n==="pair"||n==="auto"&&!r.length&&t.strategy==="pair"&&s===
"implement"&&i!=="architecture"?"pair":"independent"}function ut(e){const t=n=>n.map(r=>({model:r.key,vendor:r.vendor,effort:r.
effort}));return{workflow:e.factory?"factory":e.workflowName,tier:e.factory?.tier||e.tier,strategy:e.factory?.strategy||
(e.pairOptions?"pair":"independent"),mode:e.mode,output:e.workflowName==="ensemble"?"measured, independently reviewed ca\
ndidates and advisory ranking; no automatic selection":e.mode==="implement"?"reviewed implementation in a worktree; deli\
very pending":e.tier==="architecture"?"reviewed design and milestones; no implementation":e.mode,participants:t(e.lineup),
reviewers:t(e.auditors),panel:t(e.panel),specification:t(e.specReviewers),roles:Object.fromEntries(Object.entries(e.roles||
{}).map(([n,r])=>[n,{model:r.key,vendor:r.vendor}])),requiredCLIs:ee(e).map(n=>n==="gemini"?"agy":n),verification:e.verify||
e.raw.verify||"discovered during setup; not yet run",limits:{...e.controls,repair:e.controls.repair||(e.tier==="simple"?
{maxPasses:1,minor:"block"}:null),maxReviews:e.pairOptions?.maxReviews||null,rounds:e.pairOptions?null:e.rounds},effort:e.
pairOptions?`Setup${e.specReviewers.length?", a spec review":""}, ${e.pairOptions.design===false?"no design stage; ":"de\
sign and "}code turns, up to the review budget; measurements between code revisions.`:"Depends on findings, retries and \
escalation. Limits are caps, not cost forecasts.",intake:e.factory?.intake||null}}function dt(e,t,n,r){const i={};for(const o of e.
spec.findings){const c=i.specification||(i.specification={found:0,upheld:0,refuted:0,amended:0});c.found++;if(o.status===
"accepted")c.upheld++;if(o.status==="rejected")c.refuted++;if(e.spec.applied.some(u=>u.id===o.id))c.amended++}for(const o of e.
ledger.filter(c=>c.kind==="finding")){const c=Ke(o.author)?"audit":typeof o.round==="number"?"debate":"ratification";const u=i[c]||
(i[c]={found:0,upheld:0,refuted:0,fixed:0});u.found++;if(o.status==="verified")u.upheld++;if(o.status==="refuted")u.refuted++;
if(o.fixed)u.fixed++}for(const o of e.pair?.findings||[]){const c=i[o.stage]||(i[o.stage]={found:0,upheld:0,refuted:0,fixed:0});
c.found++;if(o.status==="fixed"){c.fixed++;c.upheld++};if(o.status==="refuted")c.refuted++}const s=t.candidates;if(s)i.ensembleReview=
{found:s.reduce((o,c)=>o+c.reviews.reduce((u,d)=>u+(d.defects?.length||0),0),0)};return{version:1,taskId:e.raw.evaluation?.
taskId||null,variant:e.raw.evaluation?.variant||null,repetition:e.raw.evaluation?.repetition||null,workflow:e.factory?"f\
actory":e.workflowName,tier:e.factory?.tier||e.tier,strategy:e.factory?.strategy||(e.pair?"pair":"independent"),host:e.host,
elapsedMs:n,turns:r,turnsByRole:e.turnLog.reduce((o,c)=>({...o,[c.role]:(o[c.role]||0)+1}),{}),failedTurns:e.turnLog.filter(
o=>!o.ok).length,findingsByStage:i,...s?{candidates:{total:s.length,ready:s.filter(o=>o.final.readiness.state==="ready").
length}}:{},readiness:t.final?.readiness?.state||null,delivery:t.delivery?.status||"not-recorded",escalated:!!e.factory?.
escalation,requestedImplementation:e.factory?.intake?.mode==="implement"||e.mode==="implement",deliveredImplementation:false,
tokens:null,cost:null,limits:{maxTurns:e.controls.maxTurns,maxRunMin:e.controls.maxRunMin},...e.pair?{userDecisions:{asked:e.
pair.asked?.length||0,answered:e.pair.decisions?.length||0,unused:(t.unusedAnswers||[]).length}}:{}}}function R(e){if(!Number.
isFinite(e))return"?";const t=n=>String(n<10?Math.round(n*10)/10:Math.round(n));return e<1e3?String(Math.round(e)):e<1e6?
`${t(e/1e3)}k`:`${t(e/1e6)}M`}const lt=e=>Math.round(e/6e4);function re(e,t){if(!t)return"";if(t.meter!==void 0){return t.
meter>0?`

### Token use

Claude Code's budget meter counted about ${R(t.meter)} output tokens while this workflow ran (its own agents and anythin\
g else in the session). Input, cache and per-model counts, Codex and Gemini turns included: \`${e.cli} usage --run-dir ${w(
e.run?.runDir||"RUN")}\`.`:""}const n=Object.entries(t.byModel||{});const r=t.missing||[];if(!n.length&&!r.length)return"";
const i=(c,u)=>`| ${c} | ${u.turns} | ${R(u.input)} | ${R(u.cachedInput)} | ${R(u.cacheCreation)} | ${R(u.output)} | ${lt(
u.seconds*1e3)} min |`;const s=n.length?["| Model | Turns | Input | Cached | Cache writes | Output | Turn time |","|---|\
---|---|---|---|---|---|",...n.sort((c,u)=>u[1].input-c[1].input).map(([c,u])=>i(c,u)),i("**Total**",t.total)].join("\n"):
"";const o=r.length?`

${ye(r.length,"turn")} reported no usage (${[...new Set(r.map(c=>c.reason))].slice(0,3).join("; ")}): the result's metri\
cs.tokens reads them back from the vendors' logs where it can, and lists the rest as missing.`:"";return`

### Token use

${s}${o}`}const ft=1;const pt={pair:"pair",independent:"council"};const mt=["turnLog","processNotes","notes","relayFailu\
res","vendorTimes"];function ie(e){return U(pt[e.strategy])}function ht(e,t){return{version:ft,strategy:e.factory.strategy,
tier:e.factory.tier,factory:e.factory,carried:S(e),control:t}}const M="$factoryWire";const Jt=Object.freeze({});function q(e){
if(e===void 0||typeof e==="number"&&(!Number.isFinite(e)||Object.is(e,-0))){return{[M]:Object.is(e,-0)?"-0":String(e)}}if(e===
null||typeof e!=="object")return e;if(Array.isArray(e))return Array.from(e,q);const t=Object.fromEntries(Object.entries(
e).map(([n,r])=>[n,q(r)]));return Object.hasOwn(e,M)?{[M]:"object",value:t}:t}function gt(e,t){return{started:e.started??
null,turns:e.turns,maxTurns:e.maxTurns??null,maxRunMin:e.maxRunMin??null,meterStart:Number.isFinite(t)?t:null}}function $(e){
return e!==null&&typeof e==="object"&&!Array.isArray(e)}function oe(e,t){return e==="simple"&&(t==="fix"||t==="feature")||
e==="feature"&&t==="architecture"}function wt(e,t){for(let n=e;n!==null&&n!==void 0;n=n.earlier){if(!$(n)||!oe(n.from,n.
to))return"illegal escalation edge";if(n.to!==t)return"escalation chain does not lead to this tier";t=n.from}return""}function yt(e){
if(!$(e))return"carried must be an object";const t=mt.find(n=>!Array.isArray(e[n]));return t?`carried.${t} must be an ar\
ray`:""}function L(e,t){const n=Reflect.ownKeys(e);return n.length===t.length&&n.every(r=>t.includes(r))}function se(e,t,n=new WeakMap){
if(Object.is(e,t))return true;if(!e||!t||typeof e!=="object"||typeof t!=="object")return false;if(Array.isArray(e)!==Array.
isArray(t))return false;const r=n.get(e)??new WeakSet;if(r.has(t))return true;r.add(t);n.set(e,r);const i=Reflect.ownKeys(
e);return i.length===Reflect.ownKeys(t).length&&i.every(s=>Object.hasOwn(t,s)&&se(e[s],t[s],n))}function bt(e,t){const n=u=>{
throw new Error(`factory: unexpected result from ${ie(e)} (${u}).`)};if(!$(t)||t.factoryChild!==1)n("invalid child resul\
t marker");if(L(t,["factoryChild","final","usage"])){if(!$(t.final))n("final must be an object");if(typeof t.usage!=="bo\
olean")n("usage must be a boolean");return t}if(!L(t,["factoryChild","handUp"]))n("invalid child result fields");const r=t.
handUp;if(!$(r)||!L(r,["to","trigger","why","escalation","carried","turns"])){n("invalid handUp fields")}if(typeof r.trigger!==
"string"||typeof r.why!=="string")n("trigger and why must be strings");if(e.strategy!=="independent")n("only independent\
 children can hand up");if(!oe(e.tier,r.to))n("illegal hand-up edge");if(!$(r.escalation)||r.escalation.from!==e.tier||r.
escalation.to!==r.to){n("escalation does not match hand-up edge")}const i=r.escalation;const s=u=>Array.isArray(u)&&u.every(
d=>typeof d==="string");if(!s(i.findings)||!s(i.tests)||!s(i.criteria)){n("escalation findings, tests and criteria must \
be arrays of strings")}if(["trigger","why","runDir","suiteTail"].some(u=>typeof i[u]!=="string")){n("escalation trigger,\
 why, runDir and suiteTail must be strings")}const o=wt(r.escalation,r.to);if(o)n(o);if(!se(e.factory.escalation??null,r.
escalation.earlier??null)){n("escalation.earlier does not match incoming escalation")}if(!Number.isInteger(r.turns)||r.turns<
e.control.turns)n("turns must be an integer at least as large as the incoming count");const c=yt(r.carried);if(c)n(c);return t}
function kt(e,t){return{version:e.version,strategy:e.strategy,tier:t.to,factory:{...e.factory,tier:t.to,escalation:t.escalation},
carried:S(t.carried),control:{...e.control,turns:t.turns}}}function vt(e){const t=e.factory.args;return String((e.strategy===
"pair"?{...t,...t.pair}:t).cli||"dark-factory")}let a=Le(qe(X(args,{"no-brief":["brief",false]}),{workflow:"factory"}));
const p=typeof factoryRuntime==="undefined"?null:factoryRuntime;const m={started:Rt(),turns:0,...a.controls};const ae=e=>({
type:"string",description:`Feedback on the ${e} process, not on the task: at most two sentences on anything in this turn\
's instructions, inputs or tools that got in your way, such as an unclear or conflicting instruction, missing context, w\
asted effort, a limit that cut you short, or a command that failed. Name the instruction or input. "" if nothing did; do\
n't invent feedback.`});const $t=ae("council"),xt=ae("pair");function Et(e){if(!a.retro||!e)return e;return{...e,properties:{
...e.properties,process:a.pair?xt:$t},required:[...e.required||[],"process"]}}const ce=ue();function ue(){try{return typeof budget!==
"undefined"&&budget&&typeof budget.spent==="function"?budget.spent():null}catch{return null}}function de(){if(p?.usage){
try{return p.usage()}catch{return null}}const e=ue();const t=m.delegated?m.meterStart:ce;return e===null||t===null?null:
{meter:Math.max(0,e-t)}}function Rt(){if(a.controls.maxRunMin&&!p?.now)throw new Error("maxRunMin requires the standalon\
e dark-factory-codex runner; the native workflow runtime has no replay-safe clock. Use maxTurns for native runs.");return p?.
now?p.now()-(p.elapsedBefore||0):null}function Tt(e){return e?.code==="CHECKPOINT_MISMATCH"||e?.code==="RUN_LIMIT"||e?.code===
"ENGINE_DRIFT"}function Ot(){const e=m;if(e.maxTurns&&e.turns>=e.maxTurns||e.maxRunMin&&p.now()-e.started>=e.maxRunMin*6e4){
const t=new Error(e.maxTurns&&e.turns>=e.maxTurns?`Run turn budget exhausted (${e.maxTurns}).`:`Run time budget exhauste\
d (${e.maxRunMin} minutes).`);e.stop=t.message;t.code="RUN_LIMIT";throw t}e.turns++}async function At(e){try{return await e()}catch(t){
if(t.code!=="RUN_LIMIT")throw t;return{status:"blocked",stopReason:t.message,task:a.task,runDir:a.run?.runDir||null,final:{
readiness:{state:"incomplete",blocked:[],incomplete:[t.message]}}}}}function It(e){if(m.stop&&e.final?.readiness?.state!==
"ready"){e.status="blocked";e.stopReason=m.stop;e.final={...e.final,readiness:{state:"incomplete",blocked:e.final?.readiness?.
blocked||[],incomplete:[...e.final?.readiness?.incomplete||[],m.stop]}}}be(e);e.plan=e.plan||ut(a);e.metrics=dt(a,e,m.started!==
null?p.now()-m.started:null,m.turns);if(!m.delegated&&a.workflowName!=="council"&&e.report&&typeof e.report.markdown==="\
string"){const t=re(a,de());if(t)e.report={...e.report,markdown:`${e.report.markdown}${t}`}}if((a.factory||a.pairOptions)&&
e.runDir){e.artifactType="dark-factory-result";e.artifactVersion=1;const{summary:t,...n}=e;return{summary:Ye(a,e),...n}}
return e}function Dt(e,t,n,r){const i=r&&typeof r.process==="string"?g(r.process,400):"";if(a.retro&&i&&!/^(none|n\/a|nothing)\.?$/i.
test(i))a.processNotes.push({turn:e,role:t,who:n,text:i})}function Ft(e,t){const n=t&&t.permissionDenials;if(n)a.notes.push(
`${e}: ${n.count} tool permission denial(s) (${n.tools.join(", ")}). ${t.status==="done"?"The completed submission was a\
ccepted for verification and review":"The submission was not accepted"}. Denied checks are not evidence of passing; deta\
ils: ${n.source}`)}async function le(e,t,n,r){Ot();const i=K(a,n,t);const{copies:s,...o}=t;const{measures:c,...u}=o;const d=s?
t.schema:Et(t.schema);const h=p?await jt(e,{...o,schema:d},n,r):await agent(e,{...u,schema:d});a.turnLog.push({turn:t.label,
role:n,vendor:p?i.vendor:"claude",ok:!!h});Dt(t.label,n,r||(p?i.name:t.model),h);return h}async function jt(e,t,n,r,i={}){
const s=K(a,n,t);try{return await p.agent({...t,prompt:e,vendor:s.vendor,model:s.model,effort:s.effort,role:n,who:r||s.name,
run:a.run,fresh:true,onResult:o=>{Ft(t.label,o);if(o.status!=="done")a.notes.push(`${n} turn ${t.label} failed: ${g(o.error||
o.status,300)}`)},timeoutMin:Nt(n),...n==="setup"?{preflightVendors:ee(a),setupRunId:Pe(a)}:{},...i})}catch(o){if(Tt(o))
throw o;a.notes.push(`${n} turn ${t.label} failed: ${g(o&&o.message||o,300)}`);return null}}function Nt(e){const t=a.raw.
timeoutMin;const n=t&&typeof t==="object"?t[e]:t;const r=Math.round(Number(n));return r>0?r:null}const l={type:"string"};
const Ct=["testing","implementation","internal design"];const _={type:"object",properties:{outcome:l,purpose:l,scope:l,nonGoals:l,
acceptanceExamples:{type:"array",items:l},verification:l,delegated:{type:"array",items:l}}};const fe={brief:_,planMissing:l};
const Mt={type:"object",properties:{id:l,question:l,answer:l}};const qt={type:"object",properties:{version:{type:"intege\
r"},state:l,brief:_,decisions:{type:"array",items:Mt}}};const pe={type:"object",properties:{question:l,wording:l,outcomeA:l,
outcomeB:l,evidence:l,recommendation:l,changes:l}};const Lt=x({type:"object",properties:{strategy:{type:"string",enum:["\
independent","pair"],description:"Pair for scoped implementation with one clear approach and iterative review; independe\
nt for competing hypotheses or plans. Architecture and investigations require independent."},status:{type:"string",enum:[
"ok","needs-plan","needs-split"]},tier:{type:"string",enum:v},mode:{type:"string",enum:G},reasons:{type:"string",description:"\
Up to three sentences: what in the task or the code decided the tier."},planMissing:{type:"string",description:'With sta\
tus "needs-plan": the document the task depends on that you could not find. Otherwise "".'},signals:{type:"object",properties:{
kind:{type:"string",enum:["bug","feature","change","question","design"]},files:{type:"integer",description:"Your estimat\
e of the files the change touches; 0 for an investigation or a design."},publicApi:{type:"boolean",description:"Does it \
change a public API or schema?"},crossModule:{type:"boolean"},testsCover:{type:"string",enum:["yes","no","unknown"]},ambiguous:{
type:"boolean"},planGiven:{type:"boolean"}}},split:{type:"array",description:'With status "needs-split": the separate pi\
eces of work, in the order to do them. Otherwise [].',items:{type:"object",properties:{title:{type:"string",description:"\
A few words naming the piece."},task:{type:"string",description:"The piece as a task of its own, complete for someone wh\
o has not seen this request."},tier:{type:"string",enum:v,description:"Your estimate for this piece alone."},after:{type:"\
array",items:{type:"integer"},description:"The numbers (from 1) of earlier pieces this one builds on; [] if none."}}}}}});
function P(e,t,n){return le(t+"\n\n"+rt(a),{label:e,phase:"Brief",model:"opus",effort:"medium",schema:x({type:"object",properties:n})},
"intake")}function me(e,t=false){if(p)return"Return briefFile as an empty string. The runner saves the file.";const n=t?
"STATE":"settled";return`Write the object you return in brief as UTF-8 JSON to a temporary file with the file tool. Save\
 it by running this helper, substituting the quoted temporary file path for FILE${t?" and provisional for STATE if quest\
ions survive, otherwise settled":""}:
${a.cli} brief --repo ${a.raw.repo?w(a.raw.repo):'"$PWD"'} --content FILE --state ${n} --decisions ${w(JSON.stringify(e))}\

Copy the printed briefFile and document.brief exactly. On helper failure leave briefFile empty.`}async function he(e,t,n,r){
const i={version:1,state:t,brief:e,decisions:n};const s=p?await p.brief({document:i}):{document:i,briefFile:r};return B(
s,t)}function B(e,t){const n=e?.document;const r=t==="settled"?"/BRIEF.json":"/BRIEF.provisional.json";if(typeof e?.briefFile!==
"string"||!e.briefFile.startsWith("/")||!e.briefFile.endsWith(r)||!it(n,t))return k(a,"failed",e?.error||"Factory could \
not read or save a valid goal brief.");a.factory.brief={...n,brief:{...n.brief,delegated:_t(n.brief.delegated)}};a.factory.
briefFile=e.briefFile;return null}function _t(e){const t=Ct.filter(n=>!e.some(r=>r.trim().toLowerCase().startsWith(n)));
return[...e,...t]}async function Pt(){phase("Brief");const e=await P("brief shape","Shape the requested goal into a shor\
t brief. State the user-visible outcome and its purpose, scope and non-goals, concrete acceptance examples and the obser\
vable evidence that would verify delivery. Delegate testing, implementation and internal design explicitly. Do not ask t\
he user questions or decide a tier.",fe);if(e?.planMissing)return N(a,e.planMissing,null);if(!I(e?.brief))return k(a,"fa\
iled","The shaper returned no usable goal brief.");const t=await P("brief challenge",`Independently challenge the draft \
against the original wording. Try to show two plausible outcomes the wording permits that the user would judge different\
ly. Quote the wording, spell out both outcomes and what changes for delivery or acceptance. First try to settle each dif\
ference from repository evidence: read the relevant code, docs, git log, retros and available issues. Correct the draft \
where evidence settles it. An unavailable source is not itself a reason to ask.
Return all and only unresolved what/why differences in questions. For each, give the competing outcomes, evidence consid\
ered, a recommended answer and what the answer changes. Write the question, both outcomes, the recommendation and what c\
hanges for the user who asked, in their terms: what they would see, receive or be able to do. Name internal components, \
roles or mechanisms only where the user's own wording does. Do not ask about testing, implementation, internal design, p\
references or speculative cases. There is no completeness checklist. Return [] on a clear goal, including a clear one-li\
ne goal. No criteria or harness review.
Draft: ${JSON.stringify(e.brief)}
${me([],true)}`,{...fe,questions:{type:"array",items:pe},briefFile:l});if(t?.planMissing)return N(a,t.planMissing,null);
if(!I(t?.brief)||!Array.isArray(t.questions)||!t.questions.every(u=>u&&Object.keys(pe.properties).every(d=>E(u[d]))&&u.outcomeA.
trim()!==u.outcomeB.trim())){return k(a,"failed","The brief challenger returned no usable verdict.")}const n=t.questions.
map((u,d)=>({...u,id:`B${d+1}`,kind:"brief"}));const r=await he(t.brief,n.length?"provisional":"settled",[],t.briefFile);
if(r||!n.length)return r;const i=[],s=[];for(const u of n){const d=a.clarifications.filter(h=>h.id===u.id);if(d.length!==
1||!d[0].answer.trim())s.push(u);else i.push({id:u.id,question:u.question,answer:d[0].answer})}if(s.length){const u=p?"R\
esume the saved hostRunDir with --resume and an args file":"Resume this dark-factory:factory workflow in the same sessio\
n using resumeFromRunId and the original arguments";const d=`${u}, appending {id, answer} entries to clarifications. Kee\
p earlier answers unchanged.`;return{status:"needs-user",task:a.task,questions:s,decisions:i,resumable:true,resumeSteps:d,
forTheOrchestrator:"Ask all questions together. Show both outcomes, the recommendation and what the answer changes. "+d}}
const o=await P("brief answered",`Revise the brief so its outcome, scope and acceptance examples follow the user's answe\
rs. The answers settle the challenge.
Brief: ${JSON.stringify(t.brief)}
Questions: ${JSON.stringify(n)}
User decisions: ${JSON.stringify(i)}
${me(i)}`,{brief:_,briefFile:l});if(!I(o?.brief))return k(a,"failed","The shaper returned no usable answered brief.");const c=await he(
o.brief,"settled",i,o.briefFile);if(!c){const u=new Set(i.map(d=>d.id));a.raw={...a.raw,clarifications:a.raw.clarifications.
filter(d=>!u.has(d?.id))};a.clarifications=a.clarifications.filter(d=>!u.has(d.id))}return c}async function Bt(){let e=Ve(
a),t=Lt;const n=typeof a.raw.brief==="string"&&!p;if(n){e=`Before choosing a tier, load the supplied settled brief. Run \
this exact command:
${a.cli} brief --repo ${a.raw.repo?w(a.raw.repo):'"$PWD"'} --reuse ${w(a.raw.brief)}
Use its document with the original task. Copy its document and briefFile into your result. On failure leave briefFile em\
pty.

${e}`;t=x({type:"object",properties:{...t.properties,document:qt,briefFile:l}})}const r=await le(e,{label:"intake",phase:"\
Intake",schema:t,model:"opus",effort:"medium"},"intake");if(n){const i=B(r,"settled");if(i)return{error:i};const{document:s,
briefFile:o,...c}=r;return{intake:c}}return{intake:r}}async function Wt(){const e=a.raw;const t=te(e);a.factory={};if(e.
brief===void 0){const c=await Pt();if(c)return c}else if(e.brief!==false){if(typeof e.brief!=="string"||!e.brief.startsWith(
"/"))return k(a,"failed","brief must be false or an absolute path to a settled brief.");if(p){const c=B(await p.brief({source:e.
brief}),"settled");if(c)return c}}phase("Intake");const{intake:n,error:r}=await Bt();if(r)return r;if(!n)return k(a,"fai\
led","the intake agent returned nothing");if(n.status==="needs-plan")return N(a,n.planMissing,null);const i=Se(n);a.factory=
{...a.factory,tier:null,asked:t.tier,tierConfirmed:t.tierConfirmed,chosenBy:"intake",recommended:A(n),intake:n,escalation:null,
args:a.raw,split:i.length?{pieces:i.length,declined:true}:null};if(i.length&&!t.noSplit)return nt(a,i,n);const s=et(a,n);
if(s)return tt(a,s,n);const o=t.tier||A(n);a.factory.tier=o;a.factory.chosenBy=!t.tier?"intake":o===a.factory.recommended?
"pinned":"overruled";a.factory.strategy=ct(a,n);log(`factory: tier ${o} (${a.factory.chosenBy}${a.factory.chosenBy==="in\
take"?"":`; intake recommends ${a.factory.recommended}`}): ${g(n.reasons,200)}`);return await Ut(o,n)}const W=await At(Wt);
if(!W?.handoff)return st(a,It(W));return await Ht(W.handoff);async function Ut(){return{handoff:ht(a,gt(m,p?null:ce))}}async function Ht(e){
const t=n=>{const r=re({cli:vt(e),run:n.runDir?{runDir:n.runDir}:void 0},de());return r?{...n,report:{...n.report,markdown:`${n.
report.markdown}${r}`}}:n};for(;;){const n=bt(e,await workflow(ie(e),{factoryHandoff:q(e)}));if(n.final)return n.usage?t(
n.final):n.final;const r=n.handUp;log(`factory: escalating from ${r.escalation.from} to ${r.to} (${r.trigger}): ${r.why}`);
e=kt(e,r)}}
