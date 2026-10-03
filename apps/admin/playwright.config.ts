import { defineConfig, devices } from '@playwright/test'

export const E2E_PORT = 3988

/**
 * Browser E2E against the real Next.js runtime with a local mock OIDC provider, a token-verifying fake backend and a
 * Valkey container (see tests/e2e/global-setup.ts). Chromium only. Traces, screenshots and video are off so that no
 * test artifact can capture a token.
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
