#!/usr/bin/env node
// Version wrappers forward all real commands. No account CLI is invoked.
const {spawnSync}=require('node:child_process')
const args=process.argv.slice(2),tool=process.env.RUNTIME_TOOL,real=process.env.RUNTIME_REAL
if(args.length===1&&args[0]==='--version') console.log(`${tool} offline-version-${process.env.RUNTIME_LABEL}`)
else {const r=spawnSync(real,args,{stdio:'inherit',env:process.env});process.exit(r.status??1)}
