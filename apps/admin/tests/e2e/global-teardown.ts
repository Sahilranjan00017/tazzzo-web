import { rmSync } from 'node:fs'
import { stopHarness, type Harness } from '../support/integration-env'

export default async function globalTeardown(): Promise<void> {
  const state = (globalThis as Record<string, unknown>).__tazzzoE2e as
    { harness: Harness; devPid?: number } | undefined
  if (state?.devPid) {
    try {
      process.kill(-state.devPid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  await stopHarness(state?.harness)
  rmSync('.e2e-pids.json', { force: true })
}
