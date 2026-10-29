// From here the script runs. `S` is the one state object: the lib/ functions take it as their first
// argument, and the code below it (schemas, turns, the flows) uses it directly. `let`, because the
// factory rebuilds it once it knows the tier.
let S = newState(parseConfig(args))
// Claude supplies agent()/parallel(); the standalone runner supplies this optional adapter.
// Keep the feature check here so the same generated workflow runs in both hosts.
const hostRuntime = typeof factoryRuntime === 'undefined' ? null : factoryRuntime
