import { defineConfig, devices } from '@playwright/test'

export const E2E_PORT = 3989

/**
 * Browser E2E against the real Next.js runtime (`next dev`) pointed at a local fake public API and a fake media host
 * (tests/support/fake-backend.ts, started in tests/e2e/global-setup.ts). Chromium only; no production services.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
