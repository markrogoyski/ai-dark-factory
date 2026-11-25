// ---------------------------------------------------------------- the groomed ticket

// A groomed ticket is the goal brief in a layout a person reads, edits and pastes into Jira. The
// writer's brief file stays on the writer's machine, so the text itself carries every brief field
// and the decisions. The footer only marks the text as groomed: a run always re-checks it.
const GROOM_FOOTER = 'Groomed by dark-factory'
const GROOM_SECTIONS = [
  { field: 'outcome', heading: 'Outcome' },
  { field: 'purpose', heading: 'Why' },
  { field: 'scope', heading: 'Scope' },
  { field: 'nonGoals', heading: 'Out of scope' },
  { field: 'acceptanceExamples', heading: 'Acceptance examples', list: true },
  { field: 'verification', heading: 'How we\'ll know it\'s done' },
  { field: 'delegated', heading: 'Left to the implementers', list: true },
  { field: 'decisions', heading: 'Decisions', list: true, optional: true },
]

// Headings survive Markdown (## Scope), Jira wiki markup (h2. Scope), bold (**Scope**) and a
// trailing colon. Only a line that is exactly a known heading counts.
function groomHeading(line) {
  const name = line.trim().replace(/^#{1,6}\s+/, '').replace(/^h[1-6]\.\s+/i, '')
    .replace(/^[*_]+|[*_]+$/g, '').replace(/:$/, '').trim().replace(/[‘’]/g, '\'').toLowerCase()
  return GROOM_SECTIONS.find(s => s.heading.toLowerCase() === name) || null
}

function groomFooterLine(line) {
  return line.trim().replace(/^[*_]+|[*_]+$/g, '').toLowerCase().startsWith(GROOM_FOOTER.toLowerCase())
}

const GROOM_BULLET = /^\s*(?:[-*•]|#|\d+[.)])\s+/

function groomList(lines) {
  const items = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (GROOM_BULLET.test(line)) items.push(line.replace(GROOM_BULLET, '').trim())
    else if (items.length) items[items.length - 1] += ' ' + line.trim()
    else items.push(line.trim())
  }
  return items
}

// "G3: question → answer"; the first arrow splits question from answer.
function groomDecision(item) {
  const m = /^([A-Z][1-9][0-9]*)\s*[:.]\s*(.+?)\s+(?:→|->)\s+(.+)$/.exec(item)
  return m ? { id: m[1], question: m[2].trim(), answer: m[3].trim() } : null
}

// The ticket's title, brief and decisions, or null when the text is not a complete groomed
// ticket: no footer, a missing or empty section, or a decision line that does not parse.
function parseGroomedTicket(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const end = lines.findIndex(groomFooterLine)
  if (end < 0) return null
  const body = {}, title = []
  let current = null
  for (const line of lines.slice(0, end)) {
    if (/^\s*-{3,}\s*$/.test(line)) continue
    const section = groomHeading(line)
    if (section) {
      if (body[section.field]) return null
      current = section
      body[section.field] = []
      continue
    }
    if (current) body[current.field].push(line)
    else if (line.trim()) title.push(line.trim().replace(/^#{1,6}\s+/, '').replace(/^h[1-6]\.\s+/i, ''))
  }
  const brief = {}
  let decisions = []
  for (const s of GROOM_SECTIONS) {
    const got = body[s.field]
    if (!got) {
      if (s.optional) continue
      return null
    }
    if (s.field === 'decisions') {
      const items = groomList(got).filter(item => !/^none\.?$/i.test(item))
      decisions = items.map(groomDecision)
      if (decisions.some(d => !d)) return null
    } else brief[s.field] = s.list ? groomList(got) : got.map(l => l.trim()).filter(Boolean).join('\n')
  }
  if (!validBriefContent(brief) || !brief.delegated.length) return null
  if (new Set(decisions.map(d => d.id)).size !== decisions.length) return null
  return { title: title.join(' '), brief, decisions }
}

function renderTicket(title, doc) {
  const b = doc.brief
  const list = xs => xs.map(x => `- ${x}`).join('\n')
  const decisions = doc.decisions.length ? doc.decisions.map(d => `- ${d.id}: ${d.question} → ${d.answer}`).join('\n') : 'None.'
  const value = { ...b, acceptanceExamples: list(b.acceptanceExamples), delegated: list(b.delegated), decisions }
  return `# ${title}\n\n` + GROOM_SECTIONS.map(s => `## ${s.heading}\n\n${value[s.field]}`).join('\n\n') + `\n\n---\n\n${GROOM_FOOTER}\n`
}

// A ticket title for a run whose task is not a groomed ticket: its first line, shortened.
function ticketTitleOf(task) {
  return oneLine(String(task || '').split('\n').find(l => l.trim()) || 'Untitled', 100)
}

// The next n decision IDs with this prefix, numbered after every ID already in use, so an answer
// can never bind to a different question on a later pass.
function nextDecisionIds(decisions, prefix, n) {
  const top = Math.max(0, ...decisions.map(d => String(d.id)).filter(id => id.startsWith(prefix))
    .map(id => Number(id.slice(prefix.length)) || 0))
  return Array.from({ length: n }, (_, i) => `${prefix}${top + i + 1}`)
}

const DECISION_STATUSES = ['holds', 'superseded', 'obsolete']

// A re-check's verdict on every carried decision: exactly one entry each, a known status and a
// reason. Returns the decisions that still hold, or null when the verdict is incomplete.
function heldDecisions(carried, review) {
  if (!Array.isArray(review) || review.length !== carried.length) return null
  const byId = new Map()
  for (const r of review) {
    if (!r || typeof r.id !== 'string' || byId.has(r.id) || !DECISION_STATUSES.includes(r.status) || !nonemptyBriefText(r.reason)) return null
    byId.set(r.id, r)
  }
  if (!carried.every(d => byId.has(d.id))) return null
  return carried.filter(d => byId.get(d.id).status === 'holds')
}

// The goal brief a run carries: Factory's (also inside a child it routed to) or, in a standalone
// Pair or council run, the run's own. Factory's record is the handoff envelope's, so a standalone
// run keeps its brief apart from it rather than creating S.factory.
function goalHolder(S) {
  return S.factory || S.goal || null
}

function goalDoc(S) {
  return goalHolder(S)?.brief || null
}

function goalFile(S) {
  return goalHolder(S)?.briefFile || ''
}
