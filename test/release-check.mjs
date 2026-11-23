import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseVerdict } from '../tools/release-check.mjs'

const verdict = over => releaseVerdict({ version: '0.2.0', tags: [], changedSince: () => false, marketplaceVersion: undefined, dirty: false, ...over })

test('a first release with no tags is ready', () => {
  assert.equal(verdict().ok, true)
})

test('shipped changes since the current version\'s tag need a bump', () => {
  const v = verdict({ tags: ['v0.1.0', 'v0.2.0'], changedSince: tag => tag === 'v0.2.0' })
  assert.equal(v.ok, false)
  assert.match(v.message, /Bump the version/)
})

test('a released version with nothing shipped changed since is fine', () => {
  assert.equal(verdict({ tags: ['v0.2.0'] }).ok, true)
})

test('a new version must be above the latest release, compared numerically', () => {
  assert.equal(verdict({ version: '0.10.0', tags: ['v0.9.0'] }).ok, true)
  assert.equal(verdict({ version: '0.9.0', tags: ['v0.10.0'] }).ok, false)
})

test('a version in the marketplace entry, a malformed version or uncommitted shipped files fail', () => {
  assert.equal(verdict({ marketplaceVersion: '0.2.0' }).ok, false)
  assert.equal(verdict({ version: '0.2' }).ok, false)
  assert.equal(verdict({ dirty: true }).ok, false)
})
