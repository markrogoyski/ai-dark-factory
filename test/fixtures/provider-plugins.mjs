import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
export function providerPlugin(home, variant = 'bounded') {
  const root = join(home, 'plugins/cache/example/dark-factory/1.0.0')
  const files = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'dark-factory', version: '1.0.0', description: 'Offline inspection fixture' }),
    'bin/dark-factory': '#!/bin/sh\nexit 99\n',
    'lib/runner.mjs': 'throw new Error("must never execute during inspection")\n',
    'schemas/result.json': '{}\n',
    'workflows/pair.js': 'throw new Error("native tool unavailable")\n',
    'skills/review/SKILL.md': '---\nname: review\ndescription: Inspect code\n---\nRead the diff.\n',
    'commands/review.md': 'Read the diff.\n', 'agents/reviewer.md': 'Review the change.\n',
    'output-styles/concise.md': 'Use concise paragraphs.\n',
  }
  if (variant === 'hook') files['hooks/hooks.json'] = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch forbidden-startup' }] }] } })
  if (variant === 'mcp') files['.mcp.json'] = JSON.stringify({ server: { command: 'touch', args: ['forbidden-startup'] } })
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const registry = join(home, 'plugins/installed_plugins.json')
  writeFileSync(registry, JSON.stringify({ version: 2, plugins: { 'dark-factory@example': [{ scope: 'user', installPath: root }] } }))
  return { root, registry, files }
}
