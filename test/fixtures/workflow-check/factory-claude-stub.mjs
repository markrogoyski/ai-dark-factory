#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const config = process.env.CLAUDE_CONFIG_DIR
const cwd = process.cwd()
const scenario = process.env.DF_PROBE_SCENARIO
const trace = row => appendFileSync(process.env.DF_PROBE_TRACE, JSON.stringify(row) + '\n')
const setting = flag => argv[argv.indexOf(flag) + 1]
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
trace({ argv, config, cwd })
assert.equal(process.env.GIT_DIR, undefined)

if (argv[0] === '--version') {
  console.log('2.1.330 (Claude Factory fixture)')
} else if (argv.join(' ') === 'plugin list --json') {
  console.log(JSON.stringify(scenario === 'installed' ? [{ id: 'dark-factory@local', enabled: false }] : []))
} else {
  const plugin = setting('--plugin-dir')
  const permission = readJson(join(config, 'settings.json')).permissions
  const settings = JSON.parse(setting('--settings'))
  const command = settings.hooks.PreToolUse[0].hooks[0].command
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Workflow')
  assert.equal(setting('--permission-mode'), 'acceptEdits')
  if (argv.includes('--session-id')) assert.ok(!argv.includes('--permission-prompts'))
  else assert.equal(setting('--permission-prompts'), 'none')
  assert.equal(setting('--setting-sources'), 'user')
  assert.ok(!argv.includes('--tools') && !argv.includes('--allowedTools'))
  assert.ok(permission.allow.includes('Bash(dark-factory:*)'))
  assert.ok(settings.permissions.allow.includes('Bash(date -u +%Y-%m-%dT%H:%M:%SZ)'))
  assert.equal(process.env.PATH.split(':')[0], join(plugin, 'bin'))
  assert.equal(readJson(join(plugin, '.claude-plugin', 'plugin.json')).name, 'dark-factory')
  const session = argv.includes('--session-id') ? setting('--session-id') : randomUUID()
  const sessionDir = join(config, 'projects', 'scratch', session)
  const runId = 'wf_' + randomUUID()
  let turn = 0, original, setup, names, record, running, exitingTask, previous = []
  function load() {
    names = readdirSync(join(plugin, 'workflows')).map(file => 'dark-factory:' + file.slice(0, -3))
    record = readJson(join(plugin, 'candidate.json'))
  }
  load()
  const emit = row => {
    const data = JSON.stringify({ ...row, session_id: session })
    if (argv.includes('--session-id')) {
      mkdirSync(join(config, 'projects', 'scratch'), { recursive: true })
      appendFileSync(sessionDir + '.jsonl', data + '\n')
    }
    console.log(data)
  }
  function hook(input, toolUseId) {
    const request = { tool_name: 'Workflow', tool_input: input, session_id: session, tool_use_id: toolUseId }
    const invoking = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(request), encoding: 'utf8' })
    trace({ guard: invoking.status, toolUseId, input, session })
    if (invoking.status === 0) {
      assert.equal(JSON.parse(invoking.stdout).hookSpecificOutput.permissionDecision, 'allow')
    }
    return invoking.status
  }
  emit({ type: 'system', subtype: 'init' })
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') {
      const { request, request_id } = frame
      trace({ request, session })
      assert.equal(request.subtype, 'stop_task')
      assert.equal(request.task_id, running.taskId)
      const unsupported = !argv.includes('--session-id') && scenario === 'unsupported-factory'
      emit({ type: 'control_response', response: unsupported
        ? { request_id, subtype: 'error', error: 'stop_task is not supported in this context' }
        : { request_id, subtype: 'success' } })
      if (!unsupported) {
        running.finish('killed')
        if (scenario === 'guard') exitingTask = request.task_id
        running = null
      }
      continue
    }
    const user = frame.message.content
    if (user === '/reload-plugins') {
      const previous = record.marker
      if (scenario !== 'stale-reload') load()
      trace({ command: user, session, previous, marker: record.marker })
      emit({ type: 'result', subtype: 'success', result: 'Plugins reloaded' })
      continue
    }
    const [, encoded] = /^Call Workflow exactly once with this input: (.+)\. Use no other tools\./.exec(user)
    const input = JSON.parse(encoded)
    const toolUseId = 'tool-' + ++turn
    const taskId = 'task-' + turn
    const listing = input.name.startsWith('dark-factory:missing-')
    if (listing && scenario === 'guard') {
      assert.equal(hook({ name: 'dark-factory:factory', args: { task: 'Unexpected' } }, 'unsolicited'), 2)
    }
    // As natively, an unknown workflow name is rejected before PreToolUse hooks run.
    if (!listing && scenario !== 'no-receipt') assert.equal(hook(input, toolUseId), 0)
    if (!listing && scenario === 'guard') assert.equal(hook(input, 'duplicate'), 2)
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Workflow', input }] } })
    const reply = (body, data, isError = false) => emit({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body, is_error: isError }] },
      tool_use_result: data,
    })
    // no-receipt: no hook ran, so the unlisted Workflow call is refused without a permission prompt.
    if (!listing && scenario === 'no-receipt') {
      trace({ unguarded: input, session })
      reply('Fixture: Workflow requires permission.', undefined, true)
      continue
    }
    if (listing) {
      // The scratch copy changes after the checker created it.
      if (scenario === 'altered-copy') appendFileSync(join(plugin, 'workflows', 'factory.js'), '\n// altered\n')
      let available = names
      if (scenario === 'duplicate') available = [...names, 'dark-factory:factory']
      // late-precondition: a later leg's listing lacks its marker.
      if (scenario === 'missing-marker' || (scenario === 'late-precondition' && cwd.split(sep).includes('L2-ii-inline'))) available = names.filter(name => !name.includes(':candidate-'))
      if (scenario === 'wrong-marker') available = names.map(name => name.includes(':candidate-') ? 'dark-factory:candidate-ffffffffffff' : name)
      trace({ listing: available, session, marker: record.marker })
      reply('Workflow not found. Available: ' + available.join(', '), undefined, true)
      continue
    }

    assert.equal(input.name, 'dark-factory:factory')
    if (scenario === 'launch-refusal' && input.args.maxTurns === 2 && record.mode === 'candidate') {
      trace({ refused: input, session })
      reply('Fixture: native Workflow refused to launch.', undefined, true)
      continue
    }
    const { args, resumeFromRunId } = input
    if (resumeFromRunId && exitingTask) {
      trace({ resumeRefused: input, session })
      reply(`Workflow ${runId} is paused but its run has not exited yet (task ${exitingTask}).`, undefined, true)
      exitingTask = null
      continue
    }
    const cancellation = args.tier === 'simple' && args.strategy === 'independent' && args.maxTurns === undefined
    trace({ launch: input, session, cwd, runId, marker: record.marker, mode: record.mode, sha256: record.sha256 })
    reply('', { status: 'async_launched', taskId, runId })
    emit({ type: 'result', subtype: 'success', result: 'done' })
    const journalDir = join(sessionDir, 'subagents', 'workflows', runId)
    const stateDir = join(sessionDir, 'workflows')
    mkdirSync(journalDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    // As native workflowProgress does, a resume reports the earlier completed agents as cached.
    const progress = resumeFromRunId
      ? previous.filter(entry => entry.state === 'done').map((entry, index) => ({ ...entry, index: index + 1, cached: true }))
      : []
    function agent(label, result) {
      const key = label + '-key', agentId = randomUUID()
      progress.push({ type: 'workflow_agent', index: progress.length + 1, label, agentId, state: result === undefined ? 'running' : 'done' })
      const rows = [{ type: 'started', key, agentId, label }]
      if (result !== undefined) rows.push({ type: 'result', key, agentId, result })
      for (const row of rows) {
        appendFileSync(join(journalDir, 'journal.jsonl'), JSON.stringify(row) + '\n')
      }
      return agentId
    }
    const metrics = { workflow: 'factory', strategy: args.strategy, tier: args.tier,
      limits: { maxTurns: args.maxTurns ?? null, maxRunMin: null } }
    // The execution plan follows the args the run received. dropped-arg: the candidate's resumed
    // run lost pair.maxReviews (Pair) or audit: false (Fix), as a handoff that drops an arg would.
    const dropped = scenario === 'dropped-arg' && record.mode === 'candidate' && resumeFromRunId
    const plan = { workflow: 'factory', tier: args.tier, strategy: args.strategy,
      participants: [{ model: 'opus', vendor: 'claude', effort: 'high' }],
      reviewers: args.audit === false && !dropped ? [] : [{ model: 'astra', vendor: 'codex', effort: 'high' }],
      limits: { maxTurns: args.maxTurns ?? null, maxReviews: dropped ? null : args.pair?.maxReviews ?? null },
      intake: { reasons: 'Model-written intake ' + randomUUID() } }
    const question = { question: 'Which fixture behavior?', id: args.tier === 'fix' ? 'S1' : 'Q1' }
    if (args.strategy === 'pair') question.kind = 'design'
    const instructions = 'Resume with Workflow({name: "dark-factory:factory", resumeFromRunId: <id>}).'
    let result
    if (!resumeFromRunId) {
      assert.equal(original, undefined)
      original = args
      setup = JSON.parse(execFileSync('dark-factory', ['init', '--repo', cwd, '--factory', '--seats', 'A'], { encoding: 'utf8' }))
      agent('intake', { status: 'ok' })
      agent('setup', setup)
    } else {
      assert.equal(resumeFromRunId, runId)
      assert.deepEqual(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'clarifications')), original)
    }
    const { runDir, room } = setup
    const finish = (status, result) => {
      if (result) result = { ...result, plan }
      previous = progress
      writeFileSync(join(stateDir, runId + '.json'), JSON.stringify({ runId, taskId, status, result, workflowProgress: progress }))
      emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId,
        status: status === 'killed' ? 'stopped' : status })
    }
    if (cancellation) {
      if (!resumeFromRunId && scenario !== 'early-cancel') {
        const active = agent('r0:A sonnet')
        writeFileSync(join(journalDir, `agent-${active}.jsonl`), '{"type":"assistant"}\n')
        trace({ active, session })
        running = { taskId, finish }
        continue
      }
      if (resumeFromRunId) {
        agent(scenario === 'failed-restart' ? 'r1:A sonnet' : 'r0:A sonnet', { status: 'ok' })
        trace({ restarted: true, session })
      }
      result = { status: 'done', runDir, metrics: { ...metrics, turns: 6 } }
    } else if (args.maxTurns === 2) {
      result = { status: 'blocked', stopReason: 'Run turn budget exhausted (2).', metrics: { ...metrics, turns: 2 }, runDir }
    } else if (!resumeFromRunId) {
      if (args.strategy === 'pair') {
        agent('draft design', {})
        agent('stop Q1', { status: 'ok' })
        // Independent runs can stop on different design findings; only L3's inline run differs here.
        const open = scenario === 'model-variance' && cwd.split(sep).includes('L3-inline') ? 2 : 1
        result = { workflow: 'factory', tier: args.tier, strategy: 'pair', stage: scenario === 'wrong-boundary' ? 'implement' : 'design',
          stopReason: `The design used its review allowance without approval, with ${open} design findings open.`, resumable: true,
          resumeSteps: instructions, questions: [question], status: 'needs-user', metrics: { ...metrics, turns: 4 }, runDir, room }
      } else {
        agent('spec coverage: astra (relay)', {})
        result = { round: 'spec', forTheOrchestrator: instructions, questions: [question], status: 'needs-user',
          metrics: { ...metrics, turns: 4 }, runDir, room }
      }
    } else {
      const worktree = join(runDir, 'wt', 'A')
      assert.ok(worktree.startsWith(cwd + sep))
      writeFileSync(join(worktree, 'edit.txt'), 'fixture agent edit\n')
      trace({ edit: worktree, session })
      // model-variance: the candidate's model takes more rounds, with other later agents, turns,
      // worktree files and evidence hashes. That is not a protocol difference.
      const varies = scenario === 'model-variance' && record.mode === 'candidate'
      if (varies) writeFileSync(join(worktree, 'more.txt'), 'another model edit\n')
      // Evidence is named by a hash of the measured bytes, which differ between runs.
      mkdirSync(join(runDir, 'evidence', 'A-' + randomUUID().replaceAll('-', '').repeat(2)), { recursive: true })
      if (args.strategy === 'pair') {
        agent('resume-check Q1', { status: 'ok' })
        agent(varies ? 'pair-code-2' : 'author implementation', {})
      } else {
        agent('spec amend', { criteria: [{ id: 'C1' }] })
        if (varies) agent('r2:A sonnet', {})
      }
      // parity: the candidate stops where the control finishes, a protocol difference.
      const status = scenario === 'parity' && record.mode === 'candidate' ? 'blocked' : 'done'
      result = { status, decisions: args.clarifications, spec: { answered: [question.id] },
        metrics: { ...metrics, turns: varies ? 11 : 6 }, runDir, room }
    }
    finish('completed', result)
  }
}
