import { rmSync } from 'node:fs'
import type { FakeBackend } from '../support/fake-backend'

export default async function globalTeardown(): Promise<void> {
  const state = (globalThis as Record<string, unknown>).__tazzzoStoreE2e as
    { backend: FakeBackend; devPid?: number } | undefined
  if (state?.devPid) {
    try {
      process.kill(-state.devPid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  await state?.backend.stop()
  rmSync('.e2e-pids.json', { force: true })
}
