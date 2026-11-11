const fs = require('node:fs')
if (process.env.DESCRIPTOR_REPORT) {
  const report = { argv: process.argv.slice(1), pid: process.pid }
  if (!process.env.DESCRIPTOR_ROOT_PID || process.env.DESCRIPTOR_ROOT_PID === String(process.pid)) {
    process.env.DESCRIPTOR_ROOT_PID = String(process.pid)
    report.rootOpen = fs.fstatSync(Number(process.env.DESCRIPTOR_FD)).isFile()
  } else {
    try { fs.writeSync(Number(process.env.DESCRIPTOR_FD), 'child-leak'); report.wrote = true }
    catch (error) { report.error = error.code }
  }
  fs.appendFileSync(process.env.DESCRIPTOR_REPORT, JSON.stringify(report) + '\n')
}
