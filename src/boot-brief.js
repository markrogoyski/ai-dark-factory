// brief — one grooming pass over a ticket (src/goal.js), for the dark-factory:groom skill and for
// anyone checking a ticket before a factory run. It reads the repository and changes nothing.
let S = newState(parseConfig(parseArgs(args), { workflow: 'brief' }))
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
const requestControl = { started: requestClock(), turns: 0, ...S.controls }
