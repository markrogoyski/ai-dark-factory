// Fault injection is confined to disposable export subjects, never shipped switches.
import fs from 'node:fs'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const mode=process.env.PUBLICATION_FAULT, destination=process.env.PUBLICATION_DESTINATION
const originalWrite=fs.writeFileSync, originalSpawn=cp.spawnSync
fs.writeFileSync=function(path,...args) {
  const name=String(path)
  if(name.includes('/.engine-stage-')&&((mode==='write'&&!name.endsWith('/manifest.json'))||(mode==='manifest'&&name.endsWith('/manifest.json')))) throw new Error('injected staging write failure')
  if(mode==='validation'&&name.endsWith('/manifest.json')) return originalWrite.call(this,path,'{}\n',...args.slice(1))
  const result = originalWrite.call(this,path,...args)
  if(mode==='stage-link'&&name.endsWith('/manifest.json')) fs.linkSync(path,process.env.PUBLICATION_SENTINEL+'/manifest-link')
  return result
}
cp.spawnSync=function(command,args,...rest) {
  if(args?.some(x=>String(x).endsWith('/engine-publish.py'))) {
    if(mode==='before-kill') process.kill(process.pid,'SIGKILL')
    if(mode==='unsupported') return {status:1,stderr:'exclusive publication unavailable',stdout:''}
    if(mode==='directory-race') { fs.mkdirSync(destination); fs.writeFileSync(destination+'/sentinel','keep') }
    if(mode==='symlink-race') fs.symlinkSync(process.env.PUBLICATION_SENTINEL,destination)
    const result=originalSpawn.call(this,command,args,...rest)
    if(mode==='after-kill') process.kill(process.pid,'SIGKILL')
    return result
  }
  return originalSpawn.call(this,command,args,...rest)
}
syncBuiltinESMExports()
