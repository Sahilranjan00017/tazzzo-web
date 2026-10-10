import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { startHarness, type Harness } from '../support/integration-env'
import { E2E_PORT } from '../../playwright.config'

/** Starts Valkey + mock OIDC + verifying fake backend, then `next dev` configured against them. */
export default async function globalSetup(): Promise<void> {
  const harness: Harness = await startHarness({ verifyTokens: true })
  const base = `http://localhost:${E2E_PORT}`
  const dev = spawn('node_modules/.bin/next', ['dev', '-p', String(E2E_PORT)], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CMS_BASE_URL: base,
      // The fake backend also plays object storage (presigned PUT target) and the public media base.
      CMS_MEDIA_UPLOAD_ORIGIN: harness.backend.url,
      CMS_MEDIA_PUBLIC_ORIGIN: harness.backend.url,
      NEXT_TELEMETRY_DISABLED: '1',
      // Production waits 90 s (and gives up after 16 min) to learn the outcome of a lost upload answer; tests use short windows.
      NEXT_PUBLIC_IMPORT_UPLOAD_POLL_MS: '1000',
      NEXT_PUBLIC_IMPORT_UPLOAD_SETTLE_MS: '6000',
      NEXT_PUBLIC_IMPORT_UPLOAD_MAXWAIT_MS: '25000',
    },
    detached: true,
    stdio: 'ignore',
  })
  ;(globalThis as Record<string, unknown>).__tazzzoE2e = { harness, devPid: dev.pid }
  process.env.E2E_OIDC_URL = harness.provider.issuer
  process.env.E2E_BACKEND_URL = harness.backend.url
  writeFileSync('.e2e-pids.json', JSON.stringify({ devPid: dev.pid }))
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${base}/login`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('next dev did not start')
}
