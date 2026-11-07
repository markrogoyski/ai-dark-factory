// Small pure helpers: text clipping, de-duplication, the prompt hash and the seeded shuffle.

function clip(s, n) {
  const str = String(s ?? '')
  return str.length <= n ? str : str.slice(0, n) + ' […]'
}

function oneLine(s, n) { return clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n) }

function sum(xs) { return xs.reduce((a, b) => a + b, 0) }

function uniqueBy(xs, f) { const seen = new Set(); return xs.filter(x => { const k = f(x); if (seen.has(k)) return false; seen.add(k); return true }) }

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }

// Models often return an ID with its text attached ("1B3: the suite passes", "[1B3] …").
// Accept the first ledger-shaped token instead of requiring an exact string.
const ID_RE = /\b((?:repair|review)\d+[A-F]\d+|T\d+[A-F]\d+|TX[CDRT]\d+|\d+[A-F]\d+|[FGI][A-F]\d+|K\d+[A-F]\d+|X[CDGKRST]\d+|Q\d+|S\d+)\b/

function idOf(s) {
  const str = String(s ?? '').trim()
  const m = str.match(ID_RE)
  return m ? m[1] : str
}

// Prompt integrity: must match prompt_hash() in bin/dark-factory exactly.
function fnv(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function normalize(text) { return String(text).replace(/\r\n/g, '\n').replace(/[ \t\n]+$/, '') }

function promptHash(text) { const t = normalize(text); return `${t.length}-${fnv(t).toString(16).padStart(8, '0')}` }

// Deterministic seat shuffle (Math.random is unavailable, and must be: it would break resume).
function permutation(n, seed) {
  const idx = Array.from({ length: n }, (_, i) => i)
  let s = (seed >>> 0) || 1
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t
  }
  return idx
}

// Codex structured output is strict: every property required, no extras. Optional fields are
// expressed as empty strings/arrays instead. Claude agents get the same schemas.
function strict(schema) {
  if (!schema || typeof schema !== 'object') return schema
  const out = { ...schema }
  if (out.type === 'object' && out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, strict(v)]))
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  }
  if (out.type === 'array' && out.items) out.items = strict(out.items)
  return out
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// The factory's Feature tier builds in increments, rounds K1, K2, …, whose snapshots are inc1, inc2, ….
const buildStep = r => { const m = typeof r === 'string' && r.match(/^K(\d+)$/); return m ? Number(m[1]) : null }
const atRound = r => r === 'F' ? 'in the final version' : r === 'G' ? 'in the fix pass' : r === 'I' ? 'in the audit fix pass' : buildStep(r) ? `in build increment ${buildStep(r)}` : `in round ${r}`
const sentence = t => { const x = oneLine(t, 100000); return !x || /[.!?…]$/.test(x) ? x : `${x}.` }
const capital = t => t.charAt(0).toUpperCase() + t.slice(1)
const listText = xs => xs.length > 2 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(' and ')

// "seat 4, checker 6": how many of xs fall under each f(x)
const countsOf = (xs, f) => Object.entries(xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m }, {}))
  .map(([k, n]) => `${k} ${n}`).join(', ')
