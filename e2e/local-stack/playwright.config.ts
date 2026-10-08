import { defineConfig, devices } from '@playwright/test'

// Run through scripts/journeys.sh (it loads run/stack.env and links node_modules to the storefront's installed
// @playwright/test, so this harness adds no dependency). The CDN stand-in's self-signed certificate is accepted by this
// browser only (ignoreHTTPSErrors); nothing is added to any system trust store.
export default defineConfig({
  testDir: 'tests',
  outputDir: 'run/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_STORE,
    ignoreHTTPSErrors: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
