#!/usr/bin/env node
// Transport fixture only: all repository/helper operations remain real subprocesses.
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1]
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0) }
const originalWrite = fs.writeFileSync, originalLog = console.log
function mutate(result) {
  if (process.env.PINNED_INTAKE_FEATURE && result && Object.hasOwn(result, 'signals')) result.tier = 'feature'
  return result
}
fs.writeFileSync = function(file, data, ...rest) {
  if (String(file) === get('-o') && typeof data === 'string') data = JSON.stringify(mutate(JSON.parse(data)))
  return originalWrite.call(this, file, data, ...rest)
}
console.log = function(line) {
  try { const r = JSON.parse(line); if (r.structured_output) { mutate(r.structured_output); line = JSON.stringify(r) } } catch {}
  originalLog(line)
}
const originalExec = cp.execFileSync
if (process.env.PINNED_TINY) {
  for (const key of ['DARK_FACTORY_PIN', 'DARK_FACTORY_INVOCATION', 'DARK_FACTORY_SEAT_SPEC']) {
    if (Object.hasOwn(process.env, key)) throw new Error(`Executor context leaked to seat: ${key}`)
  }
  const resolved = originalExec('/bin/sh', ['-c', 'command -v dark-factory'], { encoding: 'utf8' }).trim()
  if (process.env.PINNED_EXPECTED_HELPER && fs.realpathSync(resolved) !== fs.realpathSync(process.env.PINNED_EXPECTED_HELPER)) throw new Error(`Wrong helper resolved: ${resolved}`)
  if (process.env.PINNED_HELPER_TRACE) fs.appendFileSync(process.env.PINNED_HELPER_TRACE, JSON.stringify({ provider: path.basename(process.argv[1]), resolved: fs.realpathSync(resolved) }) + '\n')
  if (process.env.PINNED_CANDIDATE_PROBE) {
    const plugin = process.env.PINNED_CANDIDATE_PROBE
    const result = JSON.parse(originalExec(process.execPath, [path.join(plugin, 'bin/dark-factory-codex'), '--cwd', process.env.FACTORY_TEST_REPO, '--workflow', 'pair', '--explain', 'Inspect candidate'], { encoding: 'utf8' }))
    if (result.provenance.executor.mode !== 'live' || result.provenance.executor.root !== plugin) throw new Error('Candidate was replaced by executor')
    originalExec(path.join(plugin, 'bin/dark-factory'), ['hash', '--file', process.env.PINNED_OBSERVATIONS_DESCRIPTOR])
  }
  if (process.env.PINNED_WAIT_FILE) {
    fs.writeFileSync(process.env.PINNED_WAIT_FILE + '.started', String(process.pid))
    const deadline = Date.now() + 30000
    while (!fs.existsSync(process.env.PINNED_WAIT_FILE)) {
      if (Date.now() > deadline) throw new Error('Fixture release timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  originalExec('dark-factory', ['hash', '--file', process.env.PINNED_OBSERVATIONS_DESCRIPTOR], { encoding: 'utf8' })
  if (path.basename(process.argv[1]) === 'agy') console.log(JSON.stringify({ status: 'SUCCESS', conversation_id: `fixture-${process.pid}`, structured_output: { ok: true } }))
  else {
    fs.writeFileSync(get('-o'), JSON.stringify({ ok: true }))
    console.log(JSON.stringify({ type: 'thread.started', thread_id: `fixture-${process.pid}` }))
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
  }
  process.exit(0)
}
if (args.includes('--settings') && process.env.PINNED_COMPETING_BIN) {
  process.env.PATH = process.env.PINNED_COMPETING_BIN + ':' + process.env.PATH
  cp.execFileSync = function(command, argv, options) {
    if (command !== 'dark-factory') return originalExec.call(this, command, argv, options)
    const q = x => "'" + String(x).replaceAll("'", "'\\''") + "'"
    const settings = JSON.parse(get('--settings')), hook = settings.hooks.PreToolUse[0].hooks[0].command
    const request = { tool_name: 'Bash', tool_input: { command: ['dark-factory', ...argv].map(q).join(' ') } }
    if (process.env.PINNED_HOOK_DRIFT) {
      const descriptor = process.env.PINNED_OBSERVATIONS_DESCRIPTOR, data = JSON.parse(fs.readFileSync(descriptor))
      data.sources[path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')] = { status: 'file', text: '{"disableAllHooks":true}' }
      fs.writeFileSync(descriptor, JSON.stringify(data))
      request.tool_input.command = `printf ran > ${q(process.env.PINNED_HOOK_DRIFT)}`
    }
    if (process.env.PINNED_HOOK_CORRUPT) fs.writeFileSync(process.env.PINNED_HOOK_CORRUPT, 'invalid syntax @')
    const r = cp.spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify(request), encoding: 'utf8', env: process.env })
    if (process.env.PINNED_HOOK_TRACE) fs.appendFileSync(process.env.PINNED_HOOK_TRACE, JSON.stringify({ status: r.status, stderr: r.stderr }) + '\n')
    // Claude blocks exit 2; other nonzero exits continue with the original input.
    if (r.status === 2) throw new Error(r.stderr)
    let input = request.tool_input
    if (r.status === 0) {
      const output = JSON.parse(r.stdout).hookSpecificOutput || {}
      if (output.permissionDecision === 'deny') throw new Error(output.permissionDecisionReason || 'Hook denied')
      input = output.updatedInput || input
    }
    return originalExec('/bin/sh', ['-c', input.command], options)
  }
  cp.execFileSync('dark-factory', ['hash', '--file', process.env.PINNED_OBSERVATIONS_DESCRIPTOR], { encoding: 'utf8' })
}
require(process.env.PINNED_TRANSPORT_FIXTURE)
