import fs from 'node:fs'
import crypto from 'node:crypto'
import child from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const output = process.env.VALIDATION_TRACE
if (!output) throw new Error('Missing validation trace')
const counts = { operation: process.env.VALIDATION_OPERATION || 'guard', pid: process.pid, reads: 0, readBytes: 0, hashes: 0, hashBytes: 0, subprocesses: 0, versionProbes: 0 }
const append = fs.appendFileSync
const read = fs.readFileSync
fs.readFileSync = function(...args) {
  const value = read.apply(this, args)
  counts.reads++; counts.readBytes += Buffer.byteLength(value)
  return value
}
const hash = crypto.createHash
crypto.createHash = function(...args) {
  counts.hashes++
  const value = hash.apply(this, args), update = value.update
  value.update = function(bytes, ...rest) { counts.hashBytes += Buffer.byteLength(bytes); return update.call(this, bytes, ...rest) }
  return value
}
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = child[key]
  child[key] = function(program, args, ...rest) {
    counts.subprocesses++
    if (args?.includes('--version')) counts.versionProbes++
    return original.call(this, program, args, ...rest)
  }
}
syncBuiltinESMExports()
process.on('exit', () => append(output, JSON.stringify(counts) + '\n'))
