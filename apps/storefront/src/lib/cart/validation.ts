import { isProductId } from '@/lib/ids'
import { MAX_QUANTITY_PER_ITEM } from '@/lib/cart/model'

/**
 * Input grammar for the cart routes, shared by the browser (early feedback) and the server (the check that counts).
 * Mirrors the backend contract (`CartController`: `ProductIds` grammar, `quantity` 1..max, `If-Match: "cart-<n>"`
 * with up to 15 digits); the backend validates again. Pure; no secrets.
 */
export function isQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_QUANTITY_PER_ITEM
  )
}

export function isCartVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10 ** 15
}

/** The `If-Match` value for a cart version (the backend's ETag form). */
export const ifMatch = (version: number): string => `"cart-${version}"`

type Body = Record<string, unknown>

/** Exactly these keys and no others: an unexpected field is a refused request, not an ignored one. */
function exactly(body: Body, keys: string[]): boolean {
  const present = Object.keys(body)
  return present.length === keys.length && keys.every((k) => present.includes(k))
}

export interface AddInput {
  productId: string
  quantity: number
}
export interface SetInput extends AddInput {
  version: number
}
export interface RemoveInput {
  productId: string
  version: number
}
export interface ClearInput {
  version: number
}

export function parseAdd(body: Body): AddInput | null {
  if (!exactly(body, ['productId', 'quantity'])) return null
  const { productId, quantity } = body
  return isProductId(productId) && isQuantity(quantity) ? { productId, quantity } : null
}

export function parseSet(body: Body): SetInput | null {
  if (!exactly(body, ['productId', 'quantity', 'version'])) return null
  const { productId, quantity, version } = body
  return isProductId(productId) && isQuantity(quantity) && isCartVersion(version)
    ? { productId, quantity, version }
    : null
}

export function parseRemove(body: Body): RemoveInput | null {
  if (!exactly(body, ['productId', 'version'])) return null
  const { productId, version } = body
  return isProductId(productId) && isCartVersion(version) ? { productId, version } : null
}

export function parseClear(body: Body): ClearInput | null {
  if (!exactly(body, ['version'])) return null
  return isCartVersion(body.version) ? { version: body.version } : null
}
