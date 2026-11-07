let S = newState(parseEnsembleConfig(args))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
const requestControl = { started: hostRuntime?.now ? hostRuntime.now() - (hostRuntime.elapsedBefore || 0) : S.controls.maxRunMin ? Date.now() : 0, turns: 0, ...S.controls }
