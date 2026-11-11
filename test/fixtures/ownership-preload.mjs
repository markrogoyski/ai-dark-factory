import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const lstat = fs.lstatSync, fstat = fs.fstatSync
const target = process.env.OWNERSHIP_TARGET
fs.lstatSync = function(path, ...args) {
  const stat = lstat.call(this, path, ...args)
  if (String(path) === target && process.env.OWNERSHIP_FAULT === 'uid') stat.uid += 1
  return stat
}
fs.fstatSync = function(fd, ...args) {
  const stat = fstat.call(this, fd, ...args)
  if (process.env.OWNERSHIP_FAULT === 'fstat-uid') stat.uid += 1
  return stat
}
syncBuiltinESMExports()
