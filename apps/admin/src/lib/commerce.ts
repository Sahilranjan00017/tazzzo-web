import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'

/** Price + inventory contracts (backend main c3306b6: PriceAdminController, InventoryAdminController). Client-safe. */
export const LOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export const priceSchema = z.object({
  skuId: z.string(),
  currency: z.string(),
  sellingPricePaise: z.number().int().nonnegative(),
  mrpPaise: z.number().int().nonnegative(),
  version: z.number().int(),
  active: z.boolean().nullish(),
  status: z.string().nullish(),
})
export type AdminPrice = z.infer<typeof priceSchema>

export const inventorySchema = z.object({
  skuId: z.string(),
  fulfillmentLocationId: z.string(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  lowStockThreshold: z.number().int(),
  maxPurchasable: z.number().int(),
  version: z.number().int(),
  active: z.boolean(),
})
export type AdminInventory = z.infer<typeof inventorySchema>

export const PRICE_STATUS_TONE: Record<string, Tone> = {
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  NOT_YET_EFFECTIVE: 'info',
  EXPIRED: 'warning',
}

export const ON_HAND_MAX = 1_000_000
export const COUNT_MAX = 2_147_483_647

/** Derived label for stock; the dashboard's own low-stock count ignores `reserved`, this one uses `available`. */
export function stockState(i: Pick<AdminInventory, 'available' | 'lowStockThreshold' | 'active'>): {
  label: string
  tone: Tone
} {
  if (!i.active) return { label: 'Inactive', tone: 'neutral' }
  if (i.available <= 0) return { label: 'Out of stock', tone: 'danger' }
  if (i.available <= i.lowStockThreshold) return { label: 'Low stock', tone: 'warning' }
  return { label: 'In stock', tone: 'success' }
}

/** Backend codes for price/inventory, in operator language. */
export const COMMERCE_CODE_COPY: Record<string, string> = {
  INVALID_PRICE:
    'The backend rejected the price (amounts must be within range and MRP must not be below the selling price).',
  INVALID_INVENTORY:
    'The backend rejected the stock values (for example, on-hand cannot be below the quantity already reserved).',
  STALE_VERSION:
    'This record changed since you loaded it (or it already exists / does not exist). It has been reloaded; review it and try again.',
}
