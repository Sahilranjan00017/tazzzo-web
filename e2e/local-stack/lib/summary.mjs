#!/usr/bin/env node
// Prints the per-journey table from results.json and exits non-zero unless every journey PASSED.
import { readFileSync } from 'node:fs'
const [file, secs] = process.argv.slice(2)
const rs = JSON.parse(readFileSync(file, 'utf8'))
const pad = (s, n) => String(s).padEnd(n)
console.log(
  `\n${pad('journey', 6)} ${pad('verdict', 8)} ${pad('checks', 9)} ${pad('time', 6)} ${pad('transcript', 12)} title`,
)
for (const r of rs)
  console.log(
    `${pad(r.id, 6)} ${pad(r.verdict, 8)} ${pad(`${r.checks - r.failed}/${r.checks}`, 9)} ${pad(Math.round(r.ms / 1000) + 's', 6)} ${pad(`L${r.startLine}-${r.endLine}`, 12)} ${r.title}${r.blocked ? `  [BLOCKED: ${r.blocked}]` : ''}${r.failures.length ? `  [FAILED: ${r.failures.join('; ')}]` : ''}`,
  )
const pass = rs.filter((r) => r.verdict === 'PASS').length
console.log(
  `\njourneys passed ${pass}/${rs.length}; failed ${rs.filter((r) => r.verdict === 'FAIL').length}; blocked ${rs.filter((r) => r.verdict === 'BLOCKED').length}; total run time ${secs}s`,
)
process.exit(pass === rs.length && rs.length > 0 ? 0 : 1)
