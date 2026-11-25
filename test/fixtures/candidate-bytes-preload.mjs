// Gives the checker two different builds: the candidate build reads one source with the fixture
// statement added, src/main-factory.js unless DF_CANDIDATE_FIXTURE_SOURCE names another, so the
// candidate's bytes and marker differ from the shipped workflows'.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { FIXTURE_STATEMENT } from './candidate-fixture.mjs'

const source = '/' + (process.env.DF_CANDIDATE_FIXTURE_SOURCE || 'src/main-factory.js')
const read = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  const text = read.call(this, file, ...args)
  return String(file).endsWith(source) ? text + FIXTURE_STATEMENT : text
}
syncBuiltinESMExports()
