import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HANDOFF_SOURCE = 'src/lib/handoff.js'

// Evaluate the shared library in build order, including constants used by the handoff.
export async function handoffProtocol(root) {
  const { LIB, PAIR_LIB } = await import(pathToFileURL(join(root, 'tools/sources.mjs')).href)
  const files = [...new Set([...LIB, ...PAIR_LIB, HANDOFF_SOURCE])]
  const source = files.map(file => readFileSync(join(root, file), 'utf8')).join('\n')
  const { HANDOFF_VERSION: protocol, childWorkflow } =
    new Function(`'use strict';\n${source}\nreturn { HANDOFF_VERSION, childWorkflow }`)()
  const forms = ['pair', 'independent'].map(strategy => {
    const name = childWorkflow({ strategy })
    return typeof name === 'string' && name.trim() ? (name.includes(':') ? 'qualified' : 'bare') : null
  })
  return { protocol, nameForm: forms[0] === forms[1] ? forms[0] : null }
}
