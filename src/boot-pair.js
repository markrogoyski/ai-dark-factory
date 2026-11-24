// runtime: "cli" (Claude Code only) hands the whole run to the standalone runner. It is a
// transport choice, not a Pair option, so it is taken off before the engine parses the args.
function pairTransport(input, hosted) {
  const raw = parsePairArgs(input)
  const { runtime, resume, ...rest } = raw
  if (runtime === undefined && resume === undefined) return { args: input, cli: null }
  if (runtime !== 'cli') throw new Error(runtime === undefined ? 'pair: resume takes the hostRunDir of an earlier runtime: "cli" run, with runtime: "cli".' : 'pair: runtime must be "cli" (the standalone runtime) or omitted.')
  if (hosted || raw.host === 'codex') throw new Error('pair: runtime applies only in Claude Code; the Codex host already runs the standalone runtime.')
  if (resume !== undefined && (typeof resume !== 'string' || !resume.trim())) throw new Error('pair: resume takes the hostRunDir of an earlier runtime: "cli" run.')
  return { args: rest, cli: { resume: resume || '' } }
}
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
const delegated = readHandoff(args, 'pair', !!hostRuntime?.now)
const transport = delegated ? { args: null, cli: null } : pairTransport(args, typeof factoryRuntime !== 'undefined')
let S = delegated ? handoffPairState(delegated) : newState(parsePairConfig(transport.args))
if (!delegated) S.pair = newPairState()
const requestControl = delegated ? handoffControl(delegated) : { started: requestClock(), turns: 0, ...S.controls }
