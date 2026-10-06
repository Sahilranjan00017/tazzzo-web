import 'server-only'
import { z } from 'zod'
import { COUNT_MAX, LOCATION_ID, ON_HAND_MAX } from '@/lib/commerce'
import { MAX_PAISE } from '@/lib/money'
import { PRODUCT_ID } from '@/lib/products'
import type { BffMutationSpec } from './mutation'

const version = z.number().int().min(1).max(2_147_483_647)

const priceOut = z.object({
  skuId: z.string(),
  sellingPricePaise: z.number().int(),
  mrpPaise: z.number().int(),
  version: z.number().int(),
})
const priceInput = z
  .object({
    skuId: z.string().regex(PRODUCT_ID),
    sellingPricePaise: z.number().int().min(0).max(MAX_PAISE),
    mrpPaise: z.number().int().min(0).max(MAX_PAISE),
    /** Absent = create the first price (backend 201); present = compare-and-set update. */
    expectedVersion: version.optional(),
  })
  .strict()
  .refine((v) => v.mrpPaise >= v.sellingPricePaise, {
    path: ['mrpPaise'],
    message: 'MRP below selling price',
  })

/**
 * `PUT /api/v1/admin/prices/{skuId}`. INR only (always sent explicitly). Replacing a price is audit-attributed to the
 * human by the backend. A stale or already-existing row returns 409 STALE_VERSION; never retried automatically.
 */
export const setPriceMutation: BffMutationSpec<
  z.infer<typeof priceInput>,
  z.infer<typeof priceOut>,
  z.infer<typeof priceOut>
> = {
  routeId: 'pricing.set',
  method: 'PUT',
  input: priceInput,
  backend: ({ skuId, sellingPricePaise, mrpPaise, expectedVersion }) => ({
    path: `/api/v1/admin/prices/${encodeURIComponent(skuId)}`,
    body: {
      sellingPricePaise,
      mrpPaise,
      currency: 'INR',
      ...(expectedVersion ? { expectedVersion } : {}),
    },
  }),
  output: priceOut,
  toClient: (o) => o,
}

const invOut = z.object({
  skuId: z.string(),
  fulfillmentLocationId: z.string(),
  onHand: z.number().int(),
  version: z.number().int(),
})
const ids = {
  skuId: z.string().regex(PRODUCT_ID),
  locationId: z.string().regex(LOCATION_ID),
}
const invInput = z
  .object({
    ...ids,
    onHand: z.number().int().min(0).max(ON_HAND_MAX),
    lowStockThreshold: z.number().int().min(0).max(COUNT_MAX),
    maxPurchasable: z.number().int().min(0).max(COUNT_MAX),
    expectedVersion: version.optional(),
  })
  .strict()

/** `PUT .../inventory/{sku}/{location}`: an ABSOLUTE set of on-hand (never a delta); `reserved` is not touched. */
export const setInventoryMutation: BffMutationSpec<
  z.infer<typeof invInput>,
  z.infer<typeof invOut>,
  z.infer<typeof invOut>
> = {
  routeId: 'inventory.set',
  method: 'PUT',
  input: invInput,
  backend: ({ skuId, locationId, onHand, lowStockThreshold, maxPurchasable, expectedVersion }) => ({
    path: `/api/v1/admin/inventory/${encodeURIComponent(skuId)}/${encodeURIComponent(locationId)}`,
    body: {
      onHand,
      lowStockThreshold,
      maxPurchasable,
      ...(expectedVersion ? { expectedVersion } : {}),
    },
  }),
  output: invOut,
  toClient: (o) => o,
}

export const INVENTORY_ACTIONS = ['activate', 'deactivate'] as const
export type InventoryAction = (typeof INVENTORY_ACTIONS)[number]
const toggleInput = z.object({ ...ids, expectedVersion: version }).strict()

export function inventoryToggleMutation(
  action: InventoryAction,
): BffMutationSpec<z.infer<typeof toggleInput>, z.infer<typeof invOut>, z.infer<typeof invOut>> {
  return {
    routeId: `inventory.${action}`,
    method: 'POST',
    input: toggleInput,
    backend: ({ skuId, locationId, expectedVersion }) => ({
      path: `/api/v1/admin/inventory/${encodeURIComponent(skuId)}/${encodeURIComponent(locationId)}/${action}`,
      body: { expectedVersion },
    }),
    output: invOut,
    toClient: (o) => o,
  }
}
