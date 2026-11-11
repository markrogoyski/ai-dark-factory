import { pathToFileURL } from 'node:url'
const [plugin,source,destination,candidate]=process.argv.slice(2)
try {const E=await import(pathToFileURL(plugin+'/lib/engine.mjs'));console.log(JSON.stringify(E.exportEngine(source,destination,candidate)))}
catch(error){console.error(error.message);process.exitCode=1}
