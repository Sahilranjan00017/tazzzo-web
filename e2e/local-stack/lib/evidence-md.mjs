#!/usr/bin/env node
// Builds the per-journey tables for EVIDENCE_<date>.md from evidence/<date>/<run>/{results.json,versions.txt,cycle.txt}.
//   node lib/evidence-md.mjs evidence/2026-10-10 run1 run2
import { readFileSync, existsSync } from 'node:fs'
const [dir, ...runs] = process.argv.slice(2)
const out = []
for (const run of runs) {
  const rs = JSON.parse(readFileSync(`${dir}/${run}/results.json`, 'utf8'))
  const pass = rs.filter((r) => r.verdict === 'PASS').length
  const checks = rs.reduce((a, r) => a + r.checks, 0)
  const failed = rs.reduce((a, r) => a + r.failed, 0)
  out.push(`### ${run}: ${pass}/${rs.length} journeys PASS (${checks - failed}/${checks} checks)\n`)
  if (existsSync(`${dir}/${run}/cycle.txt`))
    out.push('```\n' + readFileSync(`${dir}/${run}/cycle.txt`, 'utf8').trim() + '\n```\n')
  out.push(
    '| journey | verdict | checks | time | transcript lines | title |\n| --- | --- | --- | --- | --- | --- |',
  )
  for (const r of rs)
    out.push(
      `| ${r.id} | ${r.verdict} | ${r.checks - r.failed}/${r.checks} | ${Math.round(r.ms / 1000)} s | \`${run}/transcript.txt\` L${r.startLine}-${r.endLine} | ${r.title}${r.failures.length ? ' <br>**FAILED:** ' + r.failures.join('; ').replace(/\|/g, '/') : ''}${r.blocked ? ' <br>**BLOCKED:** ' + r.blocked : ''} |`,
    )
  out.push('')
}
console.log(out.join('\n'))
