#!/usr/bin/env node
// Post-hoc redaction of committed evidence text files, in place (same rules as the live redactor in tests/support.ts).
//   node lib/redact-evidence.mjs evidence/2026-10-10        (idempotent)
// With --check it only reports leftovers and exits 1 if any (journeys.sh runs this as a regression check).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RULES, redactPii } from './redact-patterns.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const root = args.find((a) => !a.startsWith('--'))
const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(txt|json|md)$/.test(f)) files.push(p)
  }
}
walk(root)
let bad = 0
for (const f of files) {
  const s = readFileSync(f, 'utf8')
  const r = redactPii(s)
  if (r === s) continue
  if (check) {
    bad++
    console.error(`unredacted PII/one-time id in ${f}`)
  } else writeFileSync(f, r)
}
if (check && bad) process.exit(1)
console.log(`${check ? 'checked' : 'redacted'} ${files.length} files${check ? ': clean' : ''}`)
void RULES
