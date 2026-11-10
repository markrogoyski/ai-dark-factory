import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
let descriptor, replacement
export function initialize(data) { descriptor = data.descriptor; replacement = data.replacement }
export async function load(url, context, next) {
  if (url.endsWith('/lib/engine-observations.mjs')) {
    const d = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (!fileURLToPath(url).startsWith(d.dir + '/')) throw new Error('Observation mock outside owned fixture')
    return { format: 'module', shortCircuit: true, source: readFileSync(replacement, 'utf8').replace('/*DESCRIPTOR*/ null', JSON.stringify(descriptor)) }
  }
  return next(url, context)
}
