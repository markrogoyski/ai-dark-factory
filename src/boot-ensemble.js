let S = newState(parseEnsembleConfig(args))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
const requestControl = { started: requestClock(), turns: 0, ...S.controls }
