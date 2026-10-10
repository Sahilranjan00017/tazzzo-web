import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resetRunFiles } from './support'

// Runs once per `journeys.sh` invocation (before any spec): fresh transcript, results and cross-journey state.
export default async function globalSetup() {
  const evidence = process.env.E2E_EVIDENCE_DIR!
  mkdirSync(join(evidence, 'screens'), { recursive: true })
  resetRunFiles(
    `Tazzzo local cross-stack E2E transcript — started ${new Date().toISOString()}\n` +
      `backend=${process.env.E2E_BACKEND} storefront=${process.env.E2E_STORE} cdn=${process.env.E2E_CDN} cms-origin=${process.env.E2E_CMS_ORIGIN}\n` +
      `Credentials are local random values and are printed as [role]; tokens, OTP codes, session tokens and presigned query strings are redacted.`,
  )
}
