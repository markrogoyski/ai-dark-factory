#!/usr/bin/env node
// Resolve through a skill symlink so one installed skill can use the complete shipped plugin.
import { realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
const runner = resolve(here, '../../../bin/dark-factory-codex')
const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit'] })

const signals = ['SIGINT', 'SIGTERM']
const forward = new Map(signals.map(signal => [signal, () => child.kill(signal)]))
for (const [signal, handler] of forward) process.on(signal, handler)

child.on('error', error => {
  console.error(`dark-factory: could not start the runner: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  for (const [name, handler] of forward) process.removeListener(name, handler)
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
