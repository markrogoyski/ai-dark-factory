let S = newState(parseConfig(parseArgs(args, { 'no-brief': ['brief', false] }), { workflow: 'factory' }))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
const requestControl = { started: requestClock(), turns: 0, ...S.controls }
