// Stage the workflow bytes for native testing without writing into the source plugin.
//   node tools/candidate.mjs [--inline]
//   node tools/candidate.mjs --verify-verdict [--verdict FILE]
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from './build.mjs'
import { L2_REQUIRED } from './workflow-evidence.mjs'

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const PLUGIN = join(ROOT, 'plugins', 'dark-factory')
const VERDICT = join(ROOT, 'tools', 'native-verdict.json')
const RECORD = 'candidate.json'
const WORKFLOWS = { 'factory.js': 'factory-split', 'council.js': 'council', 'pair.js': 'pair' }
const ownedCopies = new WeakSet()

export function workflowBytes(mode = 'candidate') {
  if (mode !== 'candidate' && mode !== 'inline') throw new Error(`Unknown plugin copy mode: ${mode}`)
  return Object.freeze(Object.fromEntries(Object.entries(WORKFLOWS).map(([name, target]) => [
    name, mode === 'inline'
      ? readFileSync(join(PLUGIN, 'workflows', name))
      : Buffer.from(build(target)),
  ])))
}

export function workflowHashes(bytes) {
  return Object.fromEntries(Object.keys(WORKFLOWS).map(name => [
    name, createHash('sha256').update(bytes[name]).digest('hex'),
  ]))
}

function recordFor(mode, bytes) {
  const sha256 = Object.freeze(workflowHashes(bytes))
  return { mode, marker: `candidate-${sha256['factory.js'].slice(0, 12)}`, sha256 }
}

function writeWorkflows(path, bytes, marker) {
  for (const name of Object.keys(WORKFLOWS)) writeFileSync(join(path, name), bytes[name], { flag: 'wx' })
  const meta = {
    name: marker,
    description: 'Identifies the Factory build in this scratch plugin.',
    whenToUse: 'Only during the native Factory workflow check.',
    phases: [{ title: 'Identify', detail: 'Return the loaded build marker', model: 'haiku' }],
  }
  writeFileSync(join(path, `${marker}.js`),
    `export const meta = ${JSON.stringify(meta)}\n\nreturn ${JSON.stringify(marker)}\n`, { flag: 'wx' })
}

function writeRecord(path, record) {
  writeFileSync(join(path, RECORD), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
}

function isReplaced(name) {
  return Object.hasOwn(WORKFLOWS, name) || /^candidate-[a-f0-9]{12}\.js$/.test(name)
}

export function scratchBase() {
  const base = realpathSync(tmpdir())
  // The linked worktrees may themselves live under the main checkout.
  for (let path = ROOT; ; path = dirname(path)) {
    const rel = relative(path, base)
    if ((path === ROOT || existsSync(join(path, '.git')))
        && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) {
      throw new Error('Choose a TMPDIR outside the source checkout')
    }
    if (path === dirname(path)) return base
  }
}

export function createPluginCopy(mode = 'candidate', bytes = workflowBytes(mode)) {
  if (mode !== 'candidate' && mode !== 'inline') throw new Error(`Unknown plugin copy mode: ${mode}`)
  const record = recordFor(mode, bytes)
  const path = mkdtempSync(join(scratchBase(), 'df-candidate-'))
  try {
    const sourceWorkflows = join(PLUGIN, 'workflows')
    if (!lstatSync(sourceWorkflows).isDirectory()) throw new Error('Expected a plugin workflows directory')
    cpSync(PLUGIN, path, {
      recursive: true,
      filter: source => !source.endsWith(sep + '__pycache__')
        && !(dirname(source) === sourceWorkflows && isReplaced(relative(sourceWorkflows, source))),
    })
    writeWorkflows(join(path, 'workflows'), bytes, record.marker)
    writeRecord(path, record)
    const copy = Object.freeze({ path, ...record })
    ownedCopies.add(copy)
    return copy
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
}

// The session keeps its plugin path. Prepare the new files beside its workflows and
// keep the old directory available until the new workflows and record are published.
export function replacePluginWorkflows(copy, bytes) {
  if (!ownedCopies.has(copy) || realpathSync(copy.path) !== copy.path) {
    throw new Error('Workflow replacement requires an owned scratch plugin copy')
  }
  const path = copy.path
  const workflows = join(path, 'workflows')
  if (!lstatSync(workflows).isDirectory()) throw new Error('Expected a scratch workflows directory')
  const record = recordFor('candidate', bytes)
  const stage = mkdtempSync(join(path, '.workflows-'))
  const next = join(stage, 'next')
  const previous = join(stage, 'previous')
  let published = false
  let keepBackup = false
  try {
    cpSync(workflows, next, {
      recursive: true,
      filter: source => dirname(source) !== workflows || !isReplaced(relative(workflows, source)),
    })
    writeWorkflows(next, bytes, record.marker)
    writeRecord(stage, record)
    renameSync(workflows, previous)
    try {
      renameSync(next, workflows)
      published = true
      renameSync(join(stage, RECORD), join(path, RECORD))
    } catch (error) {
      try {
        if (published) renameSync(workflows, next)
        renameSync(previous, workflows)
      } catch (rollback) {
        keepBackup = true
        throw new AggregateError([error, rollback], `Workflow swap failed and could not be restored. Backup: ${previous}`)
      }
      throw error
    }
  } finally {
    if (!keepBackup) rmSync(stage, { recursive: true, force: true })
  }
  const replacement = Object.freeze({ path, ...record })
  ownedCopies.delete(copy)
  ownedCopies.add(replacement)
  return replacement
}

export function verifyVerdict(file = VERDICT) {
  const expected = JSON.parse(readFileSync(file, 'utf8'))?.l2?.sha256
  const mismatches = []
  for (const [name, actual] of Object.entries(workflowHashes(workflowBytes('inline')))) {
    const recorded = expected?.[name]
    if (actual !== recorded) {
      mismatches.push(`${name} sha256 mismatch: built ${actual}, verdict ${recorded ?? '(missing)'}`)
    }
  }
  return mismatches
}

// The L2 checks that have not passed, as "L2-ii fail" or "L3 pending".
export function incompleteChecks(file = VERDICT) {
  const checks = JSON.parse(readFileSync(file, 'utf8'))?.l2?.checks
  return L2_REQUIRED.filter(id => checks?.[id]?.status !== 'pass').map(id => `${id} ${checks?.[id]?.status ?? 'missing'}`)
}

function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--inline')) {
    console.log(createPluginCopy(args.length ? 'inline' : 'candidate').path)
    return 0
  }
  const [mode, flag, file] = args
  if (mode === '--verify-verdict'
      && (args.length === 1 || (args.length === 3 && flag === '--verdict' && file && !file.startsWith('--')))) {
    const mismatches = verifyVerdict(file)
    if (mismatches.length) {
      for (const mismatch of mismatches) console.error(mismatch)
      return 1
    }
    const incomplete = incompleteChecks(file)
    if (incomplete.length) {
      console.error(`Built Factory, council and Pair hashes match the verdict; l2 is not complete: ${incomplete.join(', ')}`)
      return 1
    }
    console.log('Built Factory, council and Pair hashes match the verdict, and every l2 check passes.')
    return 0
  }
  throw new Error('Usage: node tools/candidate.mjs [--inline | --verify-verdict [--verdict FILE]]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
