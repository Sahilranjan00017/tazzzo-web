import { defineConfig, devices } from '@playwright/test'

export const PROD_E2E_PORT = 3990

/**
 * Browser E2E against the PRODUCTION build (`next build`, then `next start` with NODE_ENV=production): the real
 * production CSP (nonce scripts and styles, no 'unsafe-inline'/'unsafe-eval'), a fake public API and an https fake
 * media host with a throwaway self-signed certificate (production only accepts https media), which this browser
 * context is told to accept. Run `pnpm --filter storefront build` first.
 */
export default defineConfig({
  testDir: 'tests/e2e-prod',
  globalSetup: './tests/e2e-prod/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PROD_E2E_PORT}`,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium-production', use: { ...devices['Desktop Chrome'] } }],
})
