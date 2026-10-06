import 'server-only'
import type { BackendReadResult } from '@/lib/backend-result'
import { healthSchema, type Health } from '@/lib/health'
import { serverEnv } from '@/server/env'
import { backendRead } from './read'

/**
 * Unauthenticated health probes: no token is sent. Readiness answers 503 with a body when a dependency is down, which is
 * still a meaningful report. Whether the edge exposes these paths publicly is an infrastructure matter (unknown here).
 */
type Probe = Exclude<BackendReadResult<Health>, { kind: 'unauthenticated' }>
/** A health probe carries no credential, so a 401 here is just an unusable probe, never a session event. */
const asProbe = (r: BackendReadResult<Health>): Probe =>
  r.kind === 'unauthenticated' ? { kind: 'unavailable', reason: 'status' } : r

export async function readHealth(): Promise<{ live: Probe; ready: Probe }> {
  const backendUrl = serverEnv().TAZZZO_BACKEND_URL
  const [live, ready] = await Promise.all([
    backendRead({ backendUrl }, '/health/live', healthSchema),
    backendRead({ backendUrl, parseAlso: [503] }, '/health/ready', healthSchema),
  ])
  return { live: asProbe(live), ready: asProbe(ready) }
}
