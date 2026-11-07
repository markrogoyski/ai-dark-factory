// Installation and launch checks in temporary repositories. No models or account writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'factory install '))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const checkout = join(dir, 'checkout with spaces')
  const plugin = join(checkout, 'plugins/dark-factory')
  const skill = join(plugin, 'skills/dark-factory')
  mkdirSync(join(plugin, 'bin'), { recursive: true })
  mkdirSync(join(plugin, 'workflows'), { recursive: true })
  cpSync(join(root, 'plugins/dark-factory/skills/dark-factory'), skill, { recursive: true })
  cpSync(join(root, 'install-codex.sh'), join(checkout, 'install-codex.sh'))
  for (const file of ['bin/dark-factory', 'bin/dark-factory-codex', 'workflows/factory.js', 'workflows/council.js', 'workflows/pair.js']) {
    writeFileSync(join(plugin, file), '')
  }
  const repo = join(dir, 'target repository')
  mkdirSync(repo)
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo])
  const destination = join(repo, '.agents/skills/dark-factory')
  const install = (args = [], cwd = repo) => spawnSync('bash', [join(checkout, 'install-codex.sh'), ...args], { cwd, encoding: 'utf8' })
  return { dir, checkout, plugin, skill, repo, destination, install }
}

test('default installation resolves the repository root and is idempotent', t => {
  const f = fixture(t)
  const nested = join(f.repo, 'nested')
  mkdirSync(nested)
  const first = f.install([], nested)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(lstatSync(f.destination).isSymbolicLink(), true)
  assert.equal(realpathSync(f.destination), realpathSync(f.skill))
  const link = readlinkSync(f.destination)
  const second = f.install(['--repo', f.repo])
  assert.equal(second.status, 0, second.stderr)
  assert.equal(readlinkSync(f.destination), link)
})

test('installation does not replace an existing skill directory', t => {
  const f = fixture(t)
  mkdirSync(f.destination, { recursive: true })
  writeFileSync(join(f.destination, 'SKILL.md'), 'the existing skill')
  const result = f.install(['--repo', f.repo])
  assert.equal(result.status, 1)
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), 'the existing skill')
})

test('installation preserves broken links owned by another checkout', t => {
  const f = fixture(t)
  mkdirSync(dirname(f.destination), { recursive: true })
  const original = join(f.dir, 'old-checkout')
  symlinkSync(original, f.destination)
  const result = f.install(['--repo', f.repo])
  assert.equal(result.status, 1)
  assert.equal(readlinkSync(f.destination), original)
})

test('argument validation and help do not create an installation', t => {
  const f = fixture(t)
  for (const args of [['--repo'], ['--repo', f.repo, '--user'], ['--user', '--user'], ['--unknown']]) {
    assert.equal(f.install(args).status, 1, args.join(' '))
  }
  assert.equal(f.install(['--help']).status, 0)
  assert.equal(existsSync(f.destination), false)
})

test('installation rejects non-repositories and incomplete packages', t => {
  const f = fixture(t)
  assert.equal(f.install(['--repo', f.dir]).status, 1)
  rmSync(join(f.plugin, 'workflows/factory.js'))
  assert.equal(f.install(['--repo', f.repo]).status, 1)
  assert.equal(existsSync(f.destination), false)
})

test('a linked launcher forwards arguments, input, cwd, output, and result status', t => {
  const f = fixture(t)
  writeFileSync(join(f.plugin, 'bin/dark-factory-codex'), `
    const fs = require('node:fs')
    console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), input: fs.readFileSync(0, 'utf8')}))
    console.error('progress from runner')
    process.exitCode = 2
  `)
  assert.equal(f.install(['--repo', f.repo]).status, 0)
  const args = ['--workflow', 'pair', '--args-file', 'path with spaces/task.json', '--', 'Task with `literal` and $(literal) and "quotes"']
  const result = spawnSync(process.execPath, [join(f.destination, 'scripts/run.mjs'), ...args], {
    cwd: f.repo, input: 'context on stdin\n', encoding: 'utf8',
  })
  assert.equal(result.status, 2, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: realpathSync(f.repo), input: 'context on stdin\n' })
  assert.equal(result.stderr.trim(), 'progress from runner')
})

test('the launcher forwards termination to its child', async t => {
  const f = fixture(t)
  writeFileSync(join(f.plugin, 'bin/dark-factory-codex'), `
    process.on('SIGTERM', () => { console.log('terminated'); process.exit(0) })
    console.log('ready')
    setInterval(() => {}, 1000)
  `)
  const child = spawn(process.execPath, [join(f.skill, 'scripts/run.mjs')], { cwd: f.repo, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const closed = once(child, 'close')
  let output = ''
  child.stdout.on('data', data => { output += data })
  await once(child.stdout, 'data')
  child.kill('SIGTERM')
  const [code, signal] = await closed
  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.match(output, /terminated/)
})
