#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2), config = process.env.CLAUDE_CONFIG_DIR
const scenario = process.env.DF_PROBE_SCENARIO || ''
const record = row => appendFileSync(process.env.DF_PROBE_TRACE, JSON.stringify(row) + '\n')
const inventory = config && join(config, 'inventory.json'), market = config && join(config, 'market-path')
record({ argv, config, cwd: process.cwd(), secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR })
if (argv[0] === '--version') {
  console.log('2.1.330 (Claude fixture)')
} else if (argv.join(' ') === 'plugin list') {
  console.log('Read from: ' + join(process.cwd(), 'plugins/dark-factory'))
} else if (argv[0] === '-p' && !argv.includes('--plugin-dir')) {
  console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true,
    content: 'Workflow not found. Available: dark-factory:council, dark-factory:ensemble, dark-factory:factory, dark-factory:pair, dark-factory:run-plan' }] } }))
} else if (argv.slice(0, 3).join(' ') === 'plugin list --json') {
  console.log(scenario === 'foreign' ? JSON.stringify([{ id: 'foreign@market', enabled: true }])
    : existsSync(inventory) ? readFileSync(inventory, 'utf8') : '[]')
} else if (argv.slice(0, 3).join(' ') === 'plugin marketplace add') {
  writeFileSync(market, argv[3])
} else if (argv.slice(0, 2).join(' ') === 'plugin install') {
  const installPath = join(readFileSync(market, 'utf8'), 'df-probe')
  writeFileSync(inventory, JSON.stringify([{ id: argv[2], enabled: true, installPath }]))
} else {
  const plugin = argv[argv.indexOf('--plugin-dir') + 1]
  assert.deepEqual(argv, ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--allowedTools', 'Workflow', '--tools', 'Workflow', '--plugin-dir', plugin])
  assert.equal(JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8')).name, 'df-probe')
  const session = randomUUID(), sessionDir = join(config, 'projects', 'scratch', session)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const cache = []
  let turn = 0, initialRun, loadedV2 = false, running
  const emit = row => console.log(JSON.stringify({ ...row, session_id: session }))
  emit({ type: 'system', subtype: 'init' })
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') {
      const { request, request_id } = frame
      record({ request, session })
      assert.equal(request.subtype, 'stop_task')
      assert.equal(request.task_id, running?.taskId)
      if (scenario === 'unsupported') {
        emit({ type: 'control_response', response: { request_id, subtype: 'error',
          error: 'stop_task is not supported in this context (callback not registered)' } })
      } else if (scenario === 'early-refusal') {
        const active = running
        writeFileSync(active.stateFile, JSON.stringify({ taskId: active.taskId, status: 'killed' }))
        emit({ type: 'control_response', response: { request_id, subtype: 'success', response: {} } })
        emit({ type: 'system', subtype: 'task_notification', task_id: active.taskId, status: 'stopped' })
        setTimeout(active.stop, 650)
      } else {
        running.stop()
        emit({ type: 'control_response', response: { request_id, subtype: 'success', response: {} } })
      }
      continue
    }
    if (frame.message.content === '/reload-plugins') {
      record({ command: frame.message.content, session })
      loadedV2 = scenario !== 'reload-missing' && existsSync(join(plugin, 'workflows', 'upgrade-v2.js'))
      emit({ type: 'result', subtype: 'success', result: 'Plugins reloaded' })
      continue
    }
    const [, encoded] = /^Call Workflow exactly once with this input: (.+)\. Use no other tools\./.exec(frame.message.content)
    const input = JSON.parse(encoded)
    const toolId = 'toolu-' + ++turn, taskId = 'task-' + turn
    record({ input, session })
    if (scenario === 'auth') {
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })
      continue
    }
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'Workflow', input }] } })
    const reply = (body, data, is_error = false) => emit({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: body, is_error }] }, tool_use_result: data,
    })
    if (input.name.startsWith('df-probe:missing-')) {
      let name = scenario === 'coexist' ? 'df-probe:installed-marker, df-probe:sideload-marker' : 'df-probe:sideload-marker'
      if (loadedV2) name = 'df-probe:upgrade-v2'
      reply('Workflow not found. Available: ' + name, undefined, true)
      continue
    }

    if (input.resumeFromRunId && running) {
      record({ resumeRefused: true, input, session })
      reply('Workflow ' + input.resumeFromRunId + ' is paused but its run has not exited yet (task ' + running.taskId + ').',
        undefined, true)
      continue
    }
    const runId = input.resumeFromRunId || 'wf_' + randomUUID()
    if (!initialRun) initialRun = runId
    else assert.equal(input.resumeFromRunId, initialRun)
    reply('', { status: 'async_launched', taskId, runId })
    emit({ type: 'result', subtype: 'success', result: 'done' })

    const journalDir = join(sessionDir, 'subagents', 'workflows', runId), states = join(sessionDir, 'workflows')
    mkdirSync(journalDir, { recursive: true })
    mkdirSync(states, { recursive: true })
    // In the bare scenario every child agent is journaled under a run directory of its own.
    const childDir = scenario === 'bare' ? join(sessionDir, 'subagents', 'workflows', 'wf_child') : journalDir
    mkdirSync(childDir, { recursive: true })
    let spent = 0, cursor = 0, agentCount = 0
    const logs = []
    const agent = async (prompt, options) => {
      const index = cursor++, request = JSON.stringify([prompt, options])
      record({ agent: { index, request, probe: input.args.probe }, session })
      const old = cache[index]
      if (old?.request === request && scenario !== 'same-token-rerun') return old.result
      const key = 'key-' + index, agentId = 'agent-' + randomUUID()
      const equal = input.args.probe === 'L1-g' || scenario === 'same-token-rerun'
      const result = { token: equal ? 'identical-token' : 'token-' + randomUUID() }
      const dir = /:(C1|C2|S)$/.test(options.label) ? childDir : journalDir
      const write = row => appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify(row) + '\n')
      write({ type: 'started', key, agentId, label: options.label })
      if (!(scenario === 'both-names-no-child-transcript' && options.label.endsWith(':C1'))) {
        writeFileSync(join(dir, 'agent-' + agentId + '.jsonl'), '{}\n')
      }
      if (input.args.probe === 'L1-j' && options.label.endsWith(':C1') && !input.resumeFromRunId &&
          scenario !== 'always-miss' && !(scenario === 'retry' && input.args.words < 500)) {
        await new Promise((_, reject) => {
          running = { taskId, stateFile: join(states, runId + '.json'), stop: () => reject(new Error('fixture stop')) }
        })
      }
      write({ type: 'result', key, agentId, result })
      cache[index] = { request, result }
      spent += 10
      agentCount++
      return result
    }
    const workflow = async (name, args) => {
      const names = scenario === 'bare' ? ['child'] : ['df-probe:child']
      if (scenario === 'both-names-no-child-transcript') names.push('child')
      if (scenario === 'unresolved' || !names.includes(name)) throw new Error('unknown child')
      return execute('child', structuredClone(args))
    }
    function execute(name, args) {
      const source = readFileSync(join(plugin, 'workflows', name + '.js'), 'utf8')
      const body = source.slice(source.indexOf('\n') + 1)
      return new AsyncFunction('args', 'agent', 'budget', 'workflow', 'log', body)(args, agent, { spent: () => spent }, workflow,
        message => logs.push({ message }))
    }
    const finish = (status, result) => {
      running = undefined
      writeFileSync(join(states, runId + '.json'), JSON.stringify({ taskId, runId, status, result, logs, agentCount }))
      emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolId,
        status: status === 'killed' ? 'stopped' : status })
    }
    const job = execute(input.name.split(':').at(-1), input.args)
      .then(result => finish('completed', result), error => {
        if (error.message === 'fixture stop') finish('killed')
        else throw error
      })
    // The input loop must remain available for the stop control while C1 is active.
    if (input.args.probe !== 'L1-j' || input.resumeFromRunId ||
        scenario === 'always-miss' || (scenario === 'retry' && input.args.words < 500)) await job
  }
}
