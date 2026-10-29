// From here the script runs. `S` is the one state object: the lib/ functions take it as their first
// argument, and the code below it (schemas, turns, the flows) uses it directly. `let`, because the
// factory rebuilds it once it knows the tier.
let S = newState(parseConfig(args))
