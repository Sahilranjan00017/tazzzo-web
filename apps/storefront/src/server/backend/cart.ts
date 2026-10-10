import 'server-only'
import { z } from 'zod'
import { isAllowedImageUrl } from '@/lib/images'
import { PRODUCT_ID } from '@/lib/ids'
import type { MediaBase } from '@/lib/media-base'
import { ifMatch } from '@/lib/cart/validation'
import { CART_ISSUES, type Cart, type CartIssue } from '@/lib/cart/model'
import type { CartError } from '@/lib/cart/messages'
import { sendJson, type SendResult } from '@/server/backend/client'
import { serverEnv } from '@/server/env'

/**
 * Typed calls over the customer cart contract (tazzzo-backend `CartController`, all bearer-authenticated):
 * `GET /v1/customer/cart`, `PUT /v1/customer/cart/items/{skuId}` (sets an exact quantity; `skuId` is the product id),
 * `DELETE /v1/customer/cart/items/{skuId}` and `DELETE /v1/customer/cart`. Every mutation REQUIRES `If-Match:
 * "cart-<version>"` (a stale version is 412, none is 428); every answer is the full, freshly enriched cart. There is
 * no merge call (no guest cart) and no `addressId` is sent (the site has no saved-address UI yet), so the backend
 * reports `LOCATION_REQUIRED` and stock `UNKNOWN`; that is shown as-is, never guessed. Success bodies are parsed with
 * a strict schema; a body that does not match is `unavailable`, never passed on. Backend text is never read: only the
 * public error `code` selects a closed `CartError`.
 */
export type CartCallResult<T> =
  { ok: true; data: T } | { ok: false; reason: CartError; retryAfterSeconds: number | null }

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const item = z.object({
  skuId: z.string().regex(PRODUCT_ID),
  quantity: z.number().int().min(1).max(10_000),
  product: z
    .object({
      title: z.string().max(500).nullish(),
      brandCode: z.string().max(100).nullish(),
      imageUrl: z.string().max(2048).nullish(),
    })
    .nullish(),
  price: z.object({ unitPricePaise: paise, mrpPaise: paise.nullish() }).nullish(),
  availability: z.object({
    stockState: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']),
    maxOrderQuantity: z.number().int().min(0).max(1_000_000),
    serviceable: z.boolean().nullish(),
  }),
  lineTotalPaise: paise.nullish(),
  buyable: z.boolean(),
  issues: z.array(z.string().max(64)).max(32),
})
const cartBody = z.object({
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  items: z.array(item).max(50),
  itemCount: z.number().int().min(0),
  subtotalPaise: paise,
  freshness: z.enum(['FRESH', 'REVALIDATE']),
})

const KNOWN = new Set<string>(CART_ISSUES)
const issueOf = (code: string): CartIssue =>
  KNOWN.has(code) ? (code as CartIssue) : 'UNRECOGNISED'

export function toCart(body: z.infer<typeof cartBody>, media: MediaBase | null): Cart {
  return {
    version: body.version,
    itemCount: body.itemCount,
    subtotalPaise: body.subtotalPaise,
    freshness: body.freshness,
    lines: body.items.map((i) => ({
      productId: i.skuId,
      quantity: i.quantity,
      title: i.product?.title?.trim() || null,
      brandCode: i.product?.brandCode ?? null,
      imageUrl: isAllowedImageUrl(i.product?.imageUrl, media) ? i.product.imageUrl : null,
      unitPricePaise: i.price?.unitPricePaise ?? null,
      mrpPaise: i.price?.mrpPaise ?? null,
      lineTotalPaise: i.lineTotalPaise ?? null,
      stockState: i.availability.stockState,
      maxOrderQuantity: i.availability.maxOrderQuantity,
      serviceable: i.availability.serviceable ?? null,
      buyable: i.buyable,
      issues: [...new Set(i.issues.map(issueOf))],
    })),
  }
}

/** The backend's public error code (and HTTP class) as one closed `CartError`. */
function failure(result: Extract<SendResult, { ok: false }>): CartCallResult<never> {
  const base = { ok: false, retryAfterSeconds: result.retryAfterSeconds } as const
  switch (result.kind) {
    case 'unauthenticated':
      return { ...base, reason: 'unauthenticated' }
    case 'rate_limited':
      return { ...base, reason: 'rate_limited' }
    case 'rejected':
      return { ...base, reason: 'bad_request' }
    default:
      switch (result.code) {
        case 'PRECONDITION_FAILED':
          return { ...base, reason: 'conflict' }
        case 'NOT_FOUND':
          return { ...base, reason: 'not_found' }
        case 'CART_ITEM_LIMIT_REACHED':
          return { ...base, reason: 'item_limit' }
        default:
          return { ...base, reason: 'unavailable' }
      }
  }
}

async function call(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  options: { body?: unknown; version?: number } = {},
): Promise<CartCallResult<Cart>> {
  const result = await sendJson(method, path, {
    bearer: accessToken,
    body: options.body,
    ifMatch: options.version === undefined ? undefined : ifMatch(options.version),
  })
  if (!result.ok) return failure(result)
  const parsed = cartBody.safeParse(result.data)
  if (!parsed.success) {
    console.warn(`storefront_backend_malformed path=${path.split('?')[0]}`)
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  return { ok: true, data: toCart(parsed.data, serverEnv().media) }
}

const itemPath = (productId: string) => {
  // Canonical grammar only, and never case-folded: the id reaches the backend path exactly as validated.
  if (!PRODUCT_ID.test(productId)) throw new Error('canonical product ids only')
  return `/v1/customer/cart/items/${encodeURIComponent(productId)}`
}

/** `GET /v1/customer/cart`. */
export const getCart = (accessToken: string) => call('GET', '/v1/customer/cart', accessToken)

/** `PUT /v1/customer/cart/items/{id}`: the line's quantity becomes exactly `quantity` (1..20), if `version` is current. */
export const setCartItem = async (
  accessToken: string,
  productId: string,
  quantity: number,
  version: number,
) => call('PUT', itemPath(productId), accessToken, { body: { quantity }, version })

/** `DELETE /v1/customer/cart/items/{id}`: 404 (`not_found`) when the line is not in the cart. */
export const removeCartItem = async (accessToken: string, productId: string, version: number) =>
  call('DELETE', itemPath(productId), accessToken, { version })

/** `DELETE /v1/customer/cart`: empties the cart (the version still advances). */
export const clearCart = (accessToken: string, version: number) =>
  call('DELETE', '/v1/customer/cart', accessToken, { version })
