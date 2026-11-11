import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { api, root, jsonResult, git } from './fixtures/engine-package.mjs'
import { harness } from './fixtures/pinned-harness.mjs'

test('actual subprocess boundaries close extra descriptors and retain stdio and linked Git work', async t => {
  const E = await api(), f = harness(t), pin = E.exportEngine(f.source, f.output, f.target)
  const sentinel = join(f.dir, 'descriptor-sentinel'), report = join(f.dir, 'descriptor-report')
  const preload = join(root, 'test/fixtures/descriptor-child.cjs')
  const launch = (program, args, extra = {}) => {
    writeFileSync(sentinel, ''); writeFileSync(report, '')
    const r = spawnSync('python3', [join(root, 'test/fixtures/descriptor-launch.py'), sentinel, report, program, ...args], {
      cwd: f.target, env: { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS} --require=${preload}`, ...extra }, encoding: 'utf8', timeout: 120000,
    })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const records = readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(records[0].parentWritable, true); assert.equal(records[0].inheritable, true)
    const children = records.filter(row => !row.parentWritable && !row.rootOpen)
    assert.ok(children.length, JSON.stringify(records))
    for (const child of children) { assert.equal(child.wrote, undefined); assert.equal(child.error, 'EBADF') }
    assert.equal(readFileSync(sentinel, 'utf8'), 'parent')
    return r
  }
  // The initial Node parent receives the FD; the installed-relative launcher child must not.
  launch(process.execPath, [join(f.plugin, 'skills/dark-factory/scripts/run.mjs'), '--cwd', f.target, '--workflow', 'pair', '--explain', 'Inspect'])
  // A pinned bootstrap re-exec, including its version/publication helpers, retains stdio.
  launch(process.execPath, [join(f.plugin, 'bin/dark-factory-codex'), '--cwd', f.target, '--pin-engine', f.output, '--workflow', 'pair', '--explain', 'Inspect'])
  const helper = join(pin.root, 'bin/dark-factory'), env = { DARK_FACTORY_PIN: JSON.stringify(pin), DESCRIPTOR_ROOT_PID: 'python-parent' }
  const run = jsonResult(launch(helper, ['init', '--repo', f.target, '--seats', 'A', '--run-id', 'descriptors', '--factory'], env))
  const prompt = join(f.dir, 'prompt.md'); writeFileSync(prompt, 'Check fixture\n<<<OUTPUT_SCHEMA\n{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}\nOUTPUT_SCHEMA>>>\n')
  launch(helper, ['seat-run', '--run-dir', run.runDir, '--vendor', 'codex', '--seat', 'A', '--job', 'probe', '--model', 'fixture', '--effort', 'high', '--sandbox', 'workspace-write', '--cwd', run.worktrees.A, '--prompt-file', prompt, '--fresh', '--max-wait', '5'], { ...env, PINNED_TINY: '1' })
  const linked = join(f.dir, 'linked'); git(f.target, 'worktree', 'add', '-qb', 'descriptor-control', linked)
  const program = `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('allowed','workspace');cp.execFileSync('git',['add','allowed']);cp.execFileSync('git',['commit','-qm','Record allowed probe']);cp.execFileSync('git',['hash-object','allowed']);process.stderr.write('stderr-ok');process.stdout.write('stdout-ok')`
  const command = `cd ${JSON.stringify(linked)} && ${JSON.stringify(process.execPath)} -e ${"'" + program.replaceAll("'", "'\\''") + "'"}`
  const commandFile = join(f.dir, 'command'); writeFileSync(commandFile, command)
  const gate = launch(helper, ['verify', '--run-dir', run.runDir, '--path', run.worktrees.A, '--command-file', commandFile, '--label', 'fd-control', '--max-wait', '5'], env)
  const result = jsonResult(gate)
  assert.ok(['done', 'running'].includes(result.status), gate.stdout)
  if (result.status === 'running') {
    const done = f.run(helper, ['wait', '--run-dir', run.runDir, '--job', result.job, '--max-wait', '5'], env)
    assert.equal(jsonResult(done).suite?.exitCode, 0, done.stdout)
  } else assert.equal(result.suite?.exitCode, 0, gate.stdout)
  assert.equal(readFileSync(join(linked, 'allowed'), 'utf8'), 'workspace')
  assert.match(git(linked, 'log', '-1', '--format=%s'), /allowed probe/)
})
