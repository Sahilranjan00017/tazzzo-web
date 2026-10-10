import 'server-only'
import { z } from 'zod'
import { getJson } from '@/server/backend/client'

/**
 * `GET /v1/serviceability?pin=` (tazzzo-backend `CommerceReadController`): public, `private, no-store`, a valid PIN
 * REQUIRED (a malformed one is 400; `lat`/`lng` are not used: they are refused unless an operator enabled a geo
 * provider). The answer is `{serviceable, serviceAreaId?, serviceAreaVersion?, etaMinutesMin/Max?}`; only `serviceable`
 * is used (the area id is internal routing, ETA is omitted by the backend). Never cached: it is one backend call per
 * check, so the route that calls it sits in the proxy's stricter per-visitor bucket.
 */
export type ServiceabilityResult =
  { ok: true; serviceable: boolean } | { ok: false; reason: 'rejected' | 'unavailable' }

const body = z.object({ serviceable: z.boolean() })

export async function checkServiceability(pin: string): Promise<ServiceabilityResult> {
  if (!/^[1-9][0-9]{5}$/.test(pin)) throw new Error('canonical PINs only')
  const result = await getJson(`/v1/serviceability?pin=${pin}`, { cache: false })
  if (!result.ok) {
    return { ok: false, reason: result.kind === 'bad_request' ? 'rejected' : 'unavailable' }
  }
  const parsed = body.safeParse(result.data)
  if (!parsed.success) {
    console.warn('storefront_backend_malformed path=/v1/serviceability')
    return { ok: false, reason: 'unavailable' }
  }
  return { ok: true, serviceable: parsed.data.serviceable }
}
