// Every new native leg starts at the same commit, in its own repository.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GIT_REPO_ENV } from '../plugins/dark-factory/lib/engine.mjs'

export { GIT_REPO_ENV }
export const fixtureVerify = 'node --test'

export function fixtureEnvironment(env) {
  const clean = { ...env }
  for (const name of GIT_REPO_ENV) delete clean[name]
  return clean
}

function git(cwd, env, ...args) {
  const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, env, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`Could not prepare Factory Git fixture: ${run.stderr.trim()}`)
  return run.stdout.trim()
}

export function fixtureSeed(root, env) {
  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(seed, env, 'init', '--quiet', '--template=', '-b', 'main')
  const files = {
    'math.cjs': 'exports.count = (n) => n + 1\nexports.increment = (n) => n + 1\n',
    'caller.cjs': "const { increment } = require('./math.cjs')\nexports.next = (n) => increment(n)\n",
    'retry.cjs': "exports.retryable = (error) => error.code === 'ETIMEDOUT'\n",
    'fixture.test.cjs': "const assert = require('node:assert/strict')\nconst { test } = require('node:test')\nconst { next } = require('./caller.cjs')\ntest('caller advances by one', () => assert.equal(next(1), 2))\n",
  }
  for (const [file, source] of Object.entries(files)) writeFileSync(join(seed, file), source)
  git(seed, env, 'add', '--', ...Object.keys(files))
  git(seed, {
    ...env, GIT_AUTHOR_NAME: 'Factory Check', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Factory Check', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  }, 'commit', '--quiet', '-m', 'Create Factory fixture')
  const head = git(seed, env, 'rev-parse', 'HEAD')
  return {
    head,
    clone(dir) {
      git(root, env, 'clone', '--quiet', '--no-local', '--', seed, dir)
      if (git(dir, env, 'rev-parse', 'HEAD') !== head) throw new Error('Factory fixture HEAD differs from the seed')
      return dir
    },
  }
}
