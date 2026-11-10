import { register, syncBuiltinESMExports } from 'node:module'
import { readFileSync, appendFileSync } from 'node:fs'
import child from 'node:child_process'
const descriptor = process.env.PINNED_OBSERVATIONS_DESCRIPTOR
if (!descriptor) throw new Error('Missing observation harness descriptor')
const d = JSON.parse(readFileSync(descriptor, 'utf8'))
appendFileSync(d.trace, JSON.stringify({ pid: process.pid, ppid: process.ppid, module: import.meta.url, argv: process.argv, operation: 'preload' }) + '\n')
register(new URL('./pinned-loader.mjs', import.meta.url), { parentURL: import.meta.url, data: {
  descriptor, replacement: new URL('./pinned-observations.mjs', import.meta.url).pathname
} })
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = child[method]
  child[method] = function(command, args, options, ...rest) {
    const env = options?.env || process.env
    if (/node(?:$|\s)|dark-factory|python/.test(String(command)) && (!env.NODE_OPTIONS?.includes(d.preload) || !env.PYTHONPATH?.includes(d.pythonStartup))) throw new Error('Subject subprocess lost observation preload before spawn')
    return original.call(this, command, args, options, ...rest)
  }
}
syncBuiltinESMExports()
