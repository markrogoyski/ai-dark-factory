#!/usr/bin/env node
// A stand-in for `claude -p` as an OpenRouter seat under a pinned engine. It opens no socket. It
// checks its run-owned CLAUDE_CONFIG_DIR, writes the files a fresh Claude writes there, runs the
// PreToolUse hook from --settings on a Bash request as Claude would, records the hook's exit code,
// and prints a success envelope. OR_PIN_VARIANT changes .claude.json before the hook runs:
// 'empty' adds an empty project entry for the cwd, 'curl' a project entry that allows Bash(curl:*).
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1]
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0) }
fs.readFileSync(0)
const config = process.env.CLAUDE_CONFIG_DIR, trace = process.env.OR_PIN_TRACE
const record = { configDir: config, configExists: !!config && fs.existsSync(config), token: !!process.env.ANTHROPIC_AUTH_TOKEN, baseUrl: process.env.ANTHROPIC_BASE_URL }
const state = { numStartups: 1, firstStartTime: '2026-11-16T00:00:00.000Z' }
fs.mkdirSync(path.join(config, 'backups'), { recursive: true })
fs.writeFileSync(path.join(config, 'backups', '.claude.json.backup'), JSON.stringify(state))
if (process.env.OR_PIN_VARIANT === 'empty') state.projects = { [process.cwd()]: { allowedTools: [], mcpServers: {} } }
if (process.env.OR_PIN_VARIANT === 'curl') state.projects = { [process.cwd()]: { allowedTools: ['Bash(curl:*)'] } }
fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify(state))
const settings = JSON.parse(get('--settings'))
const hook = settings.hooks && settings.hooks.PreToolUse[0].hooks[0].command
if (hook) {
  const r = cp.spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' } }), encoding: 'utf8', env: process.env })
  Object.assign(record, { hookStatus: r.status, hookStderr: r.stderr })
}
if (trace) fs.appendFileSync(trace, JSON.stringify(record) + '\n')
const session = args.includes('--resume') ? get('--resume') : get('--session-id')
const schema = args.includes('--json-schema') ? JSON.parse(get('--json-schema')) : null
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', session_id: session, result: 'done',
  usage: { input_tokens: 1, output_tokens: 1 }, ...(schema ? { structured_output: { ok: true } } : {}) }))
