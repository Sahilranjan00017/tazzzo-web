import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { FakeBackend } from '../support/fake-backend'
import { E2E_PORT } from '../../playwright.config'

/** Starts the fake public API + media host, then `next dev` configured against them. */
export default async function globalSetup(): Promise<void> {
  const backend = new FakeBackend()
  await backend.start()
  const base = `http://localhost:${E2E_PORT}`
  const dev = spawn('node_modules/.bin/next', ['dev', '-p', String(E2E_PORT)], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      TAZZZO_API_BASE_URL: backend.url,
      TAZZZO_SITE_URL: base,
      TAZZZO_MEDIA_BASE_URL: `${backend.mediaUrl}/media`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    detached: true,
    stdio: 'ignore',
  })
  ;(globalThis as Record<string, unknown>).__tazzzoStoreE2e = { backend, devPid: dev.pid }
  process.env.E2E_BACKEND_URL = backend.url
  process.env.E2E_MEDIA_URL = backend.mediaUrl
  writeFileSync('.e2e-pids.json', JSON.stringify({ devPid: dev.pid }))
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${base}/robots.txt`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('next dev did not start')
}
