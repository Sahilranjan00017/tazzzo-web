import 'server-only'
import { z } from 'zod'
import { AREA_ID, PINCODE, WINDOW_ID, areaWriteInput, windowWriteInput } from '@/lib/delivery'
import type { BffMutationSpec } from './mutation'

const areaOut = z.object({
  pincode: z.string(),
  serviceAreaId: z.string(),
  active: z.boolean(),
  version: z.number().int(),
})
const windowOut = z.object({
  serviceAreaId: z.string(),
  windowId: z.string(),
  active: z.boolean(),
  version: z.number().int(),
})
const version = z.number().int().min(1).max(2_147_483_647)

/**
 * `PUT /api/v1/admin/service-areas/{pincode}`: whole replace of serviceAreaId + routes (area `active` untouched).
 * No version = create (201, a duplicate gives 409 STALE_VERSION); with a version = compare-and-set.
 */
export const putAreaMutation: BffMutationSpec<
  z.infer<typeof areaWriteInput>,
  z.infer<typeof areaOut>,
  z.infer<typeof areaOut>
> = {
  routeId: 'delivery.area.put',
  method: 'PUT',
  input: areaWriteInput,
  backend: ({ pincode, serviceAreaId, routes, expectedVersion }) => ({
    path: `/api/v1/admin/service-areas/${encodeURIComponent(pincode)}`,
    body: { serviceAreaId, routes, ...(expectedVersion ? { expectedVersion } : {}) },
  }),
  output: areaOut,
  toClient: (o) => o,
}

export const TOGGLES = ['activate', 'deactivate'] as const
export type Toggle = (typeof TOGGLES)[number]

const areaToggleInput = z
  .object({ pincode: z.string().regex(PINCODE), expectedVersion: version })
  .strict()
export function areaToggleMutation(
  action: Toggle,
): BffMutationSpec<
  z.infer<typeof areaToggleInput>,
  z.infer<typeof areaOut>,
  z.infer<typeof areaOut>
> {
  return {
    routeId: `delivery.area.${action}`,
    method: 'POST',
    input: areaToggleInput,
    backend: ({ pincode, expectedVersion }) => ({
      path: `/api/v1/admin/service-areas/${encodeURIComponent(pincode)}/${action}`,
      body: { expectedVersion },
    }),
    output: areaOut,
    toClient: (o) => o,
  }
}

/** `PUT /api/v1/admin/delivery-slots/{areaId}/{windowId}`: create or compare-and-set a recurring weekly window. */
export const putWindowMutation: BffMutationSpec<
  z.infer<typeof windowWriteInput>,
  z.infer<typeof windowOut>,
  z.infer<typeof windowOut>
> = {
  routeId: 'delivery.window.put',
  method: 'PUT',
  input: windowWriteInput,
  backend: ({ serviceAreaId, windowId, expectedVersion, ...rest }) => ({
    path: `/api/v1/admin/delivery-slots/${encodeURIComponent(serviceAreaId)}/${encodeURIComponent(windowId)}`,
    body: { ...rest, ...(expectedVersion ? { expectedVersion } : {}) },
  }),
  output: windowOut,
  toClient: (o) => o,
}

const windowToggleInput = z
  .object({
    serviceAreaId: z.string().regex(AREA_ID),
    windowId: z.string().regex(WINDOW_ID),
    expectedVersion: version,
  })
  .strict()
export function windowToggleMutation(
  action: Toggle,
): BffMutationSpec<
  z.infer<typeof windowToggleInput>,
  z.infer<typeof windowOut>,
  z.infer<typeof windowOut>
> {
  return {
    routeId: `delivery.window.${action}`,
    method: 'POST',
    input: windowToggleInput,
    backend: ({ serviceAreaId, windowId, expectedVersion }) => ({
      path: `/api/v1/admin/delivery-slots/${encodeURIComponent(serviceAreaId)}/${encodeURIComponent(windowId)}/${action}`,
      body: { expectedVersion },
    }),
    output: windowOut,
    toClient: (o) => o,
  }
}
