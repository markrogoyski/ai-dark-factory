let S = newState(parsePairConfig(args))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
S.pair = newPairState()
const requestControl = { started: requestClock(), turns: 0, ...S.controls }
