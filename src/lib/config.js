// Run configuration: what the caller's args say, and the seat catalog. Pure: no runtime globals.

// A string task may start with `--seats a,b,c,d` (as /council passes its text through as a string),
// and for the factory with `--tier simple`, in either order.
function parseArgs(a) {
  if (typeof a !== 'string') return a || {}
  const out = {}
  let rest = a, m
  while ((m = rest.match(/^\s*--(seats|tier)[= ]\s*([\w:.,-]+)\s+([\s\S]*)$/))) { out[m[1]] = m[2]; rest = m[3] }
  return { task: Object.keys(out).length ? rest : a, ...out }
}

const IMPLEMENT_RE =
  /\b(implement|fix|add|writ(e|ing)|build|refactor|migrat\w*|port|rename|remove|delete|optimi[sz]\w*|patch|introduce|support)\b/i

const DESIGN_RE = /\b(design|architect\w*|propos(e|al)|approach(es)?|trade-?offs?|strategy|plan)\b/i
const MODES = ['implement', 'investigate', 'design']
const WORDS_BY_MODE = { implement: 800, investigate: 1500, design: 2000, plan: 1500 }   // soft limit, flagged when exceeded
// 'plan' is no mode a user picks: the factory's Feature tier debates plans in it before it builds.
const LARGE_DIFF = 400                                                          // changed lines; readers start from the per-file summary
const NOTES_CHARS = 4000                                                         // cap on private notes carried to the next turn

const CATALOG = {
  opus:   { vendor: 'claude', model: 'opus',        name: 'Claude Opus' },
  sonnet: { vendor: 'claude', model: 'sonnet',      name: 'Claude Sonnet' },
  fable:  { vendor: 'claude', model: 'fable',       name: 'Claude Fable' },
  haiku:  { vendor: 'claude', model: 'haiku',       name: 'Claude Haiku' },
  astra:  { vendor: 'codex',  model: 'gpt-6-astra', name: 'Codex Astra' },
  sol:    { vendor: 'codex',  model: 'gpt-6.1-sol', name: 'Codex Sol' },
  luna:   { vendor: 'codex',  model: 'gpt-6-luna',  name: 'Codex Luna' },
  gemini:       { vendor: 'gemini', model: 'gemini-3.8-flash', name: 'Gemini Flash', efforts: ['low', 'medium', 'high'] },
  'gemini-pro': { vendor: 'gemini', model: 'gemini-3.1-pro',   name: 'Gemini Pro',   efforts: ['low', 'high'] },
}

const DEFAULT_SEATS = ['opus', 'sonnet', 'astra', 'gemini']
const CODEX_SEATS = ['opus', 'astra', 'sol']
const VENDOR_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
const VENDOR_CLI = { claude: 'Claude CLI', codex: 'Codex CLI', gemini: 'Antigravity CLI (agy)' }

// Codex and Gemini seats run outside Claude Code, through a relay, and keep their own thread.
const external = s => s.external === true || s.vendor !== 'claude'

// In the Codex host every model runs through a CLI adapter, including Claude. The marker also
// selects the shorter continuation prompts for seats whose CLI session survives between turns.
const hostSeat = (host, s) => host === 'codex' ? { ...s, external: true } : s
const CODEX_ROLES = {
  intake: 'astra', setup: 'sol', checker: 'sol', questions: 'luna',
  spec: 'astra', retro: 'sol', record: 'luna',
}
const ROLE_EFFORT = { intake: 'medium', setup: 'medium', checker: 'medium', questions: 'low', spec: 'medium', retro: 'medium', record: 'low' }

function parseRoles(raw) {
  if (raw.host !== 'codex') return {}
  const overrides = raw.roles && typeof raw.roles === 'object' ? raw.roles : {}
  for (const role of Object.keys(overrides)) if (!(role in CODEX_ROLES)) throw new Error(`factory: unknown role '${role}'. Known: ${Object.keys(CODEX_ROLES).join(', ')}.`)
  return Object.fromEntries(Object.entries(CODEX_ROLES).map(([role, fallback]) => {
    const value = overrides[role]
    const option = value && typeof value === 'object' ? value : { model: value }
    const model = option.model || (role === 'checker' && raw.checkModel) || fallback
    return [role, parseSeat(model, option.effort || ROLE_EFFORT[role])]
  }))
}

function roleAgent(S, role, opts) {
  return S.roles && S.roles[role] ? S.roles[role] : { vendor: 'claude', model: opts.model, name: opts.model, effort: opts.effort }
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = [...CLAUDE_EFFORTS, 'ultra']

function parseSeat(spec, effortSpec) {
  const key = String(spec).trim().toLowerCase()
  let s
  if (CATALOG[key]) s = { key, ...CATALOG[key] }
  else if (key.startsWith('codex:') && key.length > 6) s = { key, vendor: 'codex', model: key.slice(6), name: `Codex ${key.slice(6)}` }
  else if (key.startsWith('gemini:') && key.length > 7) s = { key, vendor: 'gemini', model: key.slice(7), name: `Gemini ${key.slice(7)}`, slug: true }
  else throw new Error(`council: unknown seat '${spec}'. Known: ${Object.keys(CATALOG).join(', ')}, codex:<model-slug> or gemini:<model-slug>.`)
  const e = effortSpec && typeof effortSpec === 'object' ? effortSpec[key] : effortSpec
  s.effort = e ? String(e).toLowerCase() : 'high'
  const valid = s.vendor === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS
  if (!valid.includes(s.effort)) throw new Error(`council: effort '${s.effort}' is not valid for ${s.name}. Valid: ${valid.join(', ')}.`)
  // agy names the effort in the model slug (gemini-3.8-flash-high). A level the model lacks maps to
  // the nearest one it has, so one effort can be given for every seat.
  if (s.vendor === 'gemini' && !s.slug) {
    const rank = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    const want = rank.indexOf(s.effort)
    s.effort = s.efforts.reduce((best, x) => Math.abs(rank.indexOf(x) - want) <= Math.abs(rank.indexOf(best) - want) ? x : best)   // ties go up
    s.model = `${s.model}-${s.effort}`
  }
  delete s.efforts; delete s.slug
  return s
}

const seatList = v => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(Boolean)

// The independent audit of the final version (implement mode): one fresh model per lens, none of
// which saw the debate. `audit: false` turns it off; an object swaps a lens's model, e.g.
// {correctness: 'sol', design: 'sonnet'}. Each auditor files under an ID prefix of its own.
const AUDIT_LENSES = { correctness: { model: 'astra', id: 'XC' }, design: { model: 'opus', id: 'XD' } }
// The factory's Feature tier adds a third lens, on the tests; its Simple tier has one reviewer
// instead. Each under a prefix of its own.
const FEATURE_LENS = { tests: { model: 'sonnet', id: 'XT' } }
const FEATURE_INCREMENTS = 4      // the Feature tier's build turns at most; a plan that lists more hands the work to Architecture
const SIMPLE_LENS = { review: { model: 'astra', id: 'XR' } }
// The factory's Architecture tier reviews a milestone plan, not a change: whether it matches the
// code (grounding), whether its order works (sequencing), and what could sink it (risk, with the
// designs the council didn't choose). The risk lens is the run's only model that wrote no design.
const ARCH_LENSES = { grounding: { model: 'astra', id: 'XG' }, sequencing: { model: 'opus', id: 'XS' }, risk: { model: 'gemini', id: 'XK' } }
const CODEX_AUDIT_LENSES = { correctness: { model: 'astra', id: 'XC' }, design: { model: 'sol', id: 'XD' } }
const CODEX_FEATURE_LENS = { tests: { model: 'luna', id: 'XT' } }
const CODEX_ARCH_LENSES = { grounding: { model: 'astra', id: 'XG' }, sequencing: { model: 'sol', id: 'XS' }, risk: { model: 'luna', id: 'XK' } }
const MAX_MILESTONES = 8          // the Architecture tier's milestone plan lists at most this many

function parseAudit(v, lenses = AUDIT_LENSES) {
  if (v === false) return []
  const pick = v && typeof v === 'object' ? v : {}
  return Object.entries(lenses).map(([lens, d]) => ({ lens, id: d.id, ...parseSeat(pick[lens] || d.model, pick.effort || 'high') }))
}

// The review of the specification before any work begins (every mode): two models who see only the
// task, the code and the setup's criteria look for what the criteria miss or leave open. `spec: false`
// turns it off; 'ask' stops for the user on questions the code can't settle instead of assuming;
// an object swaps a lens's model, e.g. {coverage: 'sol', intent: 'sonnet', ask: true}.
const SPEC_LENSES = { coverage: 'astra', intent: 'opus' }

function parseSpec(v, lenses = SPEC_LENSES) {
  if (v === false) return { reviewers: [], ask: false }
  const pick = v && typeof v === 'object' ? v : {}
  return {
    reviewers: Object.entries(lenses).map(([lens, model]) => ({ lens, ...parseSeat(pick[lens] || model, pick.effort || 'high') })),
    ask: v === 'ask' || pick.ask === true,
  }
}

// Everything a run is told, read once from the workflow's args. Throws when there is no task or
// the lineup is unusable. The result is the config half of the state object (see newState).
// `opts` comes from the factory, never from the user: {workflow, tier, escalation}. With tier
// 'simple' the run has one seat, one reviewer and no spec review; with 'feature', a third auditor;
// with 'architecture', the plan's three reviewers instead of the auditors.
function parseConfig(args, opts = {}) {
  const raw = parseArgs(args)
  const host = raw.host === 'codex' ? 'codex' : 'claude'
  const roles = parseRoles(raw)
  const task = String(raw.task || raw.prompt || raw.question || '').trim()
  if (!task) {
    throw new Error('council: no task given. Pass args as a string, or {task, mode?, seats?, rounds?, ...}.')
  }
  const simple = opts.tier === 'simple' ? parseFactory(raw).simple : null
  const modeGiven = !!simple || MODES.includes(raw.mode)
  // A guess from the task's wording, until setup has read the task and its documents and picks the
  // mode itself ("Do the next item in BUG_CHECK_LIST.md" names no verb, but it's an implement task).
  const mode = simple ? 'implement' : modeGiven
    ? raw.mode
    : (IMPLEMENT_RE.test(task) ? 'implement' : DESIGN_RE.test(task) ? 'design' : 'investigate')
  const lineup = (simple ? [parseSeat(simple.implementer, raw.effort)]
    : (seatList(raw.seats).length ? seatList(raw.seats) : host === 'codex' ? CODEX_SEATS : DEFAULT_SEATS).map(s => parseSeat(s, raw.effort))).map(s => hostSeat(host, s))
  if (!simple && (lineup.length < 2 || lineup.length > 6)) throw new Error('council: use between 2 and 6 seats.')
  const auditLenses = host === 'codex' ? CODEX_AUDIT_LENSES : AUDIT_LENSES
  const featureLens = host === 'codex' ? CODEX_FEATURE_LENS : FEATURE_LENS
  const archLenses = host === 'codex' ? CODEX_ARCH_LENSES : ARCH_LENSES
  const spec = simple ? { reviewers: [], ask: false } : parseSpec(raw.spec, host === 'codex' ? { coverage: 'astra', intent: 'sol' } : SPEC_LENSES)
  return {
    raw, host, roles, task, modeGiven, mode,
    rounds: Math.max(1, Math.min(3, Number(raw.rounds) || 2)),
    context: String(raw.context || '').trim(),
    plan: (Array.isArray(raw.plan) ? raw.plan : raw.plan ? [raw.plan] : []).map(p => String(p).trim()).filter(Boolean),
    cli: String(raw.cli || 'dark-factory'),
    allowDirty: raw.allowDirty === true,
    // The factory's historical-evidence check (seats keep raw evidence, an auditor confirms it,
    // readiness requires it). Off unless asked for per run; see historyCheck().
    evidence: raw.evidence === true,
    narrow: raw.narrow !== false,
    retro: raw.retro !== false,
    // Vote-timing experiments, off unless asked for per run: they change when or how the council
    // counts agreement, which is the owner's call. See consensus() and runBallot().
    approval: raw.approval === true,
    ballot: raw.ballot === true,
    clarifications: (Array.isArray(raw.clarifications) ? raw.clarifications : [])
      .filter(c => c && c.id && c.answer)
      .map(c => ({ id: String(c.id), answer: String(c.answer), afterRound: Number.isInteger(c.afterRound) ? c.afterRound : -1 })),
    lineup,
    panel: (seatList(raw.panel).length ? seatList(raw.panel) : host === 'codex' ? ['astra', 'sol'] : ['opus', 'astra']).map(s => hostSeat(host, parseSeat(s, 'high'))),
    auditors: simple ? [{ lens: 'review', id: SIMPLE_LENS.review.id, ...parseSeat(simple.reviewer, 'high') }]
      .map(s => hostSeat(host, s)) : parseAudit(raw.audit, opts.tier === 'feature' ? { ...auditLenses, ...featureLens } : opts.tier === 'architecture' ? archLenses : auditLenses).map(s => hostSeat(host, s)),
    specReviewers: simple ? [] : spec.reviewers.map(s => hostSeat(host, s)),
    specAsk: simple ? false : spec.ask,
    workflowName: opts.workflow || 'council',
    tier: opts.tier || null,
    simple,
    escalation: opts.escalation || null,
    checkModel: host === 'codex' ? roles.checker.key : ['sonnet', 'opus', 'haiku', 'fable'].includes(raw.checkModel) ? raw.checkModel : 'sonnet',
    letters: 'ABCDEF'.slice(0, lineup.length).split(''),
  }
}
