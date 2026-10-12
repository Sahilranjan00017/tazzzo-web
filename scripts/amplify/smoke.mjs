#!/usr/bin/env node
// Post-deploy smoke check for a UAT web app. Usage: node scripts/amplify/smoke.mjs <storefront|admin> <https://origin>
// Checks only what proves the SSR runtime is the real Next server with the app's own security layer:
//  - the page answers (storefront "/" 200; admin "/login" 200, a public page),
//  - the security headers from next.config are present and `x-powered-by` is absent,
//  - the nonce CSP from src/proxy.ts is present AND differs between two requests (so nothing caches the HTML).
// It sends no credentials and prints no response bodies.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const TARGETS = { storefront: '/', admin: '/login' }

export function nonceOf(csp) {
  const match = /'nonce-([A-Za-z0-9+/=]{16,})'/.exec(csp ?? '')
  return match ? match[1] : null
}

/** Pure verdict over two responses: returns a list of failure strings (empty = pass). */
export function judge(first, second) {
  const failures = []
  for (const [label, res] of [
    ['first', first],
    ['second', second],
  ]) {
    if (res.status !== 200) failures.push(`${label} request status ${res.status}, expected 200`)
    if (res.headers.get('x-content-type-options') !== 'nosniff')
      failures.push(`${label}: x-content-type-options missing`)
    if (res.headers.get('x-frame-options') !== 'DENY')
      failures.push(`${label}: x-frame-options missing`)
    if (res.headers.get('x-powered-by') !== null) failures.push(`${label}: x-powered-by present`)
    const csp = res.headers.get('content-security-policy')
    if (nonceOf(csp) === null) failures.push(`${label}: no nonce CSP`)
    else if (/unsafe-inline|unsafe-eval/.test(csp))
      failures.push(`${label}: CSP contains unsafe-inline/unsafe-eval`)
  }
  const a = nonceOf(first.headers.get('content-security-policy'))
  const b = nonceOf(second.headers.get('content-security-policy'))
  if (a !== null && a === b)
    failures.push('CSP nonce repeated across requests: the HTML is being cached')
  return failures
}

export async function smoke(
  app,
  origin,
  { fetchImpl = fetch, attempts = 6, delayMs = 15_000 } = {},
) {
  const path = TARGETS[app]
  if (!path) throw new Error(`unknown app: ${app}`)
  const url = new URL(path, origin)
  if (url.protocol !== 'https:') throw new Error('smoke check requires an https origin')
  let failures = ['not attempted']
  for (let attempt = 1; attempt <= attempts && failures.length > 0; attempt++) {
    try {
      const get = () =>
        fetchImpl(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
      const first = await get()
      const second = await get()
      failures = judge(first, second)
    } catch (error) {
      failures = [`request failed: ${error.cause?.code ?? error.message}`]
    }
    if (failures.length > 0 && attempt < attempts) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { url: url.toString(), failures }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [app, origin] = process.argv.slice(2)
  if (!app || !origin) {
    console.error('usage: smoke.mjs <storefront|admin> <https://origin>')
    process.exit(2)
  }
  const { url, failures } = await smoke(app, origin)
  if (failures.length > 0) {
    console.error(`SMOKE FAILED ${url}`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`smoke ok ${url}`)
}
