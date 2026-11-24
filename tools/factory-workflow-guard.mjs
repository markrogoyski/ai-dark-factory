// Permit only the Workflow input the checker has just requested. Other native tools
// still use Claude's permission mode and the fixture's scratch settings. The mode is auto, as
// Factory runs in real sessions: under acceptEdits no allow rule matches the quoted "$PWD" in
// setup's `dark-factory init --repo "$PWD"`, so setup is refused unless its agent retries.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const script = fileURLToPath(import.meta.url)
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"

export function factoryWorkflowGuard(path, { existing = false } = {}) {
  if (!existing) mkdirSync(path, { mode: 0o700 })
  const pending = join(path, 'pending.json')
  const receipt = join(path, 'receipt.json')
  const command = [process.execPath, script, path].map(quote).join(' ') + ' || exit 2'
  return {
    args: [
      '--permission-mode', 'auto', '--permission-prompts', 'none', '--setting-sources', 'user',
      '--settings', JSON.stringify({
        permissions: { allow: [
          'Bash(date -u +%Y-%m-%dT%H:%M:%SZ)', 'Bash(node --test)',
          ...['status', 'diff', 'log', 'show', 'rev-parse', 'add', 'commit'].map(verb => `Bash(git ${verb}:*)`),
        ] },
        hooks: { PreToolUse: [{ matcher: 'Workflow', hooks: [{ type: 'command', command }] }] },
      }),
    ],
    permit(input) {
      if (existsSync(pending) || existsSync(receipt)) throw new Error('Another Workflow request is still outstanding')
      const staged = join(path, 'next.json')
      writeFileSync(staged, JSON.stringify(input), { flag: 'wx', mode: 0o600 })
      renameSync(staged, pending)
    },
    verify(call) {
      const approved = existsSync(receipt) && JSON.parse(readFileSync(receipt, 'utf8'))
      if (!approved || approved.session_id !== call.session || approved.tool_use_id !== call.toolUseId) {
        throw new Error('Missing correlated Factory Workflow guard receipt. Check that scratch hooks are enabled.')
      }
    },
    clear() {
      for (const file of [pending, receipt, join(path, 'claimed.json')]) rmSync(file, { force: true })
    },
  }
}

function authorize(path, request) {
  const pending = join(path, 'pending.json')
  const expected = JSON.parse(readFileSync(pending, 'utf8'))
  if (request.tool_name !== 'Workflow' || !request.session_id || !request.tool_use_id ||
      !isDeepStrictEqual(request.tool_input, expected)) throw new Error('Workflow input does not match the outstanding request')
  // Concurrent invocations can both read the permit, but only one can move it.
  renameSync(pending, join(path, 'claimed.json'))
  const { session_id, tool_use_id } = request
  writeFileSync(join(path, 'receipt.json'), JSON.stringify({ session_id, tool_use_id }), { flag: 'wx', mode: 0o600 })
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
}

if (process.argv[1] === script) {
  try {
    console.log(JSON.stringify(authorize(process.argv[2], JSON.parse(readFileSync(0, 'utf8')))))
  } catch (error) {
    console.error(`Factory Workflow guard: ${error.message}`)
    process.exitCode = 2
  }
}
