import { mkdirSync, writeFileSync, readFileSync, cpSync, chmodSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fixture, root, commit, jsonResult, readJson, subjectEnv } from './engine-package.mjs'

export function harness(t) {
  const f = fixture(t), bin = join(f.dir, 'bin'), home = join(f.dir, 'home'), pythonStartup = join(f.dir, 'python-startup')
  for (const path of [bin, home, pythonStartup, join(home, 'codex'), join(home, 'claude'), join(f.target, 'tests'), join(f.dir, 'bounded-temp')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(f.target, 'sum.cjs'), 'module.exports = (a,b) => a - b\n')
  const gateSwitch = join(f.dir, 'gate-switch.json')
  writeFileSync(join(f.target, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)\n" +
    `const fs=require('node:fs');if(fs.existsSync(${JSON.stringify(gateSwitch)}))fs.writeFileSync(JSON.parse(fs.readFileSync(${JSON.stringify(gateSwitch)})).path,'gate dependency drift')\n`)
  writeFileSync(join(f.target, 'tests/preserved.cjs'), "require('node:assert/strict').equal(require('../sum.cjs')(2,0),2)\n")
  commit(f.target)
  cpSync(join(root, 'test/fixtures/pinned-sitecustomize.py'), join(pythonStartup, 'sitecustomize.py'))
  for (const name of ['codex', 'claude', 'agy']) { cpSync(join(root, 'test/fixtures/pinned-provider.cjs'), join(bin, name)); chmodSync(join(bin, name), 0o755) }
  const preload = join(root, 'test/fixtures/pinned-preload.mjs'), descriptor = join(f.dir, 'observations.json'), trace = join(f.dir, 'observations.jsonl')
  const absentPaths = []
  for (let p = dirname(f.dir); ; p = dirname(p)) {
    absentPaths.push(join(p, '.claude/settings.json'), join(p, '.claude/settings.local.json'), join(p, '.codex/config.toml'))
    if (dirname(p) === p) break
  }
  const settings = { dir: f.dir, trace, preload, pythonStartup, absentPaths, sources: {}, defaults: [join(f.dir, 'bounded-temp')] }
  writeFileSync(descriptor, JSON.stringify(settings)); writeFileSync(trace, '')
  const env = { ...subjectEnv(process.env), HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
    TMPDIR: join(f.dir, 'bounded-temp'), TMP: join(f.dir, 'bounded-temp'), TEMP: join(f.dir, 'bounded-temp'),
    PATH: bin + ':' + process.env.PATH, NODE_OPTIONS: `--import=${preload}`, PYTHONPATH: pythonStartup,
    PINNED_OBSERVATIONS_DESCRIPTOR: descriptor, PINNED_TRANSPORT_FIXTURE: join(root, 'test/fixtures/codex-cli.cjs'),
    FACTORY_TEST_REPO: f.target, FACTORY_TEST_LOG: join(f.dir, 'calls.jsonl'), FACTORY_TEST_RUN_PATH: join(f.dir, 'run-path'),
    COUNCIL_JOB_POLL: '0.01', COUNCIL_RETRY_WAIT: '0', COUNCIL_TRANSCRIPT_WAIT: '0' }
  const run = (program, args, extra = {}) => spawnSync(program, args, { cwd: f.target, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  const launch = (args, extra = {}) => run(process.execPath, [join(f.plugin, 'bin/dark-factory-codex'), '--cwd', f.target, ...args], extra)
  const update = change => { Object.assign(settings, change); writeFileSync(descriptor, JSON.stringify(settings)) }
  return { ...f, env, settings, descriptor, trace, run, launch, update,
    traces: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    result: args => jsonResult(launch(args)), readJson }
}
export function paused(f) {
  const first = jsonResult(f.launch(['--pin-engine', f.output, '--tier', 'simple', 'Fix sum'], { PINNED_INTAKE_FEATURE: '1' }))
  if (first.status !== 'needs-tier') throw new Error(JSON.stringify(first))
  const answers = join(f.dir, 'answers.json'); writeFileSync(answers, JSON.stringify({ tierConfirmed: true }))
  return { first, resume: (args = []) => jsonResult(f.launch(['--resume', first.hostRunDir, '--args-file', answers, ...args], { PINNED_INTAKE_FEATURE: '1' })) }
}
