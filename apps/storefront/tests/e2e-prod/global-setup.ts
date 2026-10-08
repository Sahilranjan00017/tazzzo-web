import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBackend } from '../support/fake-backend'
import { PROD_E2E_PORT } from '../../playwright.prod.config'

export const E2E_CALLER_NAME = 'storefront_test'
export const E2E_CALLER_SECRET = 'e2e-throwaway-caller-secret-not-a-real-value-0001'

/** A throwaway self-signed certificate for 127.0.0.1 (test only; the key never leaves a temp dir). */
function throwawayCertificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'storefront-e2e-tls-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    const made = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    )
    if (made.status !== 0) throw new Error('openssl could not create the test certificate')
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Starts the fake public API + https media host, then the production server (`next start`). */
export default async function globalSetup(): Promise<void> {
  if (!existsSync('.next/BUILD_ID')) {
    throw new Error('no production build: run `pnpm --filter storefront build` first')
  }
  const backend = new FakeBackend()
  await backend.start({ mediaTls: throwawayCertificate() })
  const base = `http://localhost:${PROD_E2E_PORT}`
  const server = spawn('node_modules/.bin/next', ['start', '-p', String(PROD_E2E_PORT)], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TAZZZO_API_BASE_URL: backend.url, // plain http is accepted in production only for loopback
      TAZZZO_SITE_URL: 'https://www.tazzzo.test',
      TAZZZO_MEDIA_BASE_URL: `${backend.mediaUrl}/media`,
      // Throwaway test credential (the fake backend only records it). Never a real value.
      TAZZZO_CALLER_NAME: E2E_CALLER_NAME,
      TAZZZO_CALLER_SECRET: E2E_CALLER_SECRET,
      // As behind the ALB: X-Forwarded-For's rightmost entry is trusted. The rate limits are the DEFAULTS.
      STOREFRONT_TRUST_PROXY: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    detached: true,
    stdio: 'ignore',
  })
  ;(globalThis as Record<string, unknown>).__tazzzoStoreE2e = { backend, devPid: server.pid }
  process.env.E2E_BACKEND_URL = backend.url
  process.env.E2E_MEDIA_URL = backend.mediaUrl
  writeFileSync('.e2e-pids.json', JSON.stringify({ devPid: server.pid }))
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${base}/robots.txt`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('next start did not start')
}
