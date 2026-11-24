import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'

const write = fs.writeFileSync
const rename = fs.renameSync
fs.writeFileSync = function (file, ...args) {
  if (!process.env.DF_CANDIDATE_TEST_SWAP && /^candidate-[a-f0-9]{12}\.js$/.test(basename(String(file)))) {
    const workflows = dirname(file)
    const manifest = join(dirname(workflows), '.claude-plugin', 'plugin.json')
    if (fs.existsSync(manifest) && fs.existsSync(join(workflows, 'factory.js'))) {
      throw new Error('injected marker write failure after copying workflows')
    }
  }
  return write.call(this, file, ...args)
}
fs.renameSync = function (source, destination) {
  if (basename(String(source)) === 'candidate.json' && basename(dirname(source)).startsWith('.workflows-')) {
    throw new Error('injected record publication failure after swapping workflows')
  }
  return rename.call(this, source, destination)
}
syncBuiltinESMExports()
