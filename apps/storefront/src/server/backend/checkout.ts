import 'server-only'
import { z } from 'zod'
import { ifMatch } from '@/lib/cart/validation'
import { QUOTE_ID, itemReasonOf, type ItemReason, type Quote } from '@/lib/checkout/model'
import { PRODUCT_ID } from '@/lib/ids'
import { isAddressId } from '@/lib/location/validation'
import { sendJson } from '@/server/backend/client'

/**
 * `POST /v1/customer/checkout/quote` (tazzzo-backend `CheckoutController`, bearer). The body carries ONLY `addressId`;
 * the cart version the customer reviewed is `If-Match: "cart-<n>"` (428 without, 412 when stale) and `Idempotency-Key`
 * (8-64 of `[A-Za-z0-9_-]`, required) makes a retry safe: the same key with the same cart version and address returns
 * the ORIGINAL quote (same `quoteId`, never re-priced, expiry never extended) until it expires (then 410
 * `QUOTE_EXPIRED`: a new quote needs a NEW key); the same key with another cart version or address is 409
 * `IDEMPOTENCY_CONFLICT`. The quote is a validated snapshot (default lifetime 5 minutes), not a reservation or a price
 * lock. It has NO fee, tax or tip; it carries lines (id, quantity, unit and line paise), the subtotal, an advisory
 * `benefitPreview` and `moneyPreview`. A cart that cannot be bought is refused up front: 409 `CHECKOUT_CART_EMPTY`,
 * `CHECKOUT_UNSERVICEABLE`, or `CHECKOUT_ITEM_UNAVAILABLE` with the bounded per-line reasons. Success bodies are parsed
 * with a strict schema and cross-checked (lines add up to the subtotal, payable = subtotal - discount); a body that
 * does not match is `unavailable`, never passed on. Backend text is never read.
 */
export type QuoteFailure =
  | 'unauthenticated'
  | 'rate_limited'
  | 'bad_request'
  | 'cart_changed'
  | 'cart_empty'
  | 'items_unavailable'
  | 'unserviceable'
  | 'address_gone'
  | 'expired'
  | 'unavailable'

export type QuoteCallResult =
  | { ok: true; data: Quote }
  | {
      ok: false
      reason: QuoteFailure
      retryAfterSeconds: number | null
      /** The lines the backend refused, for `items_unavailable`. */
      rejected?: Array<{ productId: string; reason: ItemReason }>
    }

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const quoteBody = z.object({
  quoteId: z.string().regex(QUOTE_ID),
  cartVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  addressId: z.string().refine(isAddressId),
  items: z
    .array(
      z.object({
        skuId: z.string().regex(PRODUCT_ID),
        quantity: z.number().int().min(1).max(10_000),
        unitPricePaise: paise,
        lineTotalPaise: paise,
      }),
    )
    .min(1)
    .max(50),
  itemCount: z.number().int().min(1),
  subtotalPaise: paise,
  currency: z.literal('INR'),
  expiresAt: z.string().max(40),
  benefitPreview: z
    .object({
      applied: z.boolean(),
      discountPaise: paise.nullish(),
      discountBps: z.number().int().min(0).max(10_000).nullish(),
    })
    .nullish(),
  moneyPreview: z
    .object({
      merchandiseSubtotalPaise: paise,
      benefitDiscountPaise: paise,
      payablePaise: paise,
    })
    .nullish(),
})

/** The quote, or null when the body contradicts itself (lines that do not add up, money that does not follow). */
export function toQuote(body: z.infer<typeof quoteBody>): Quote | null {
  const lineSum = body.items.reduce((sum, l) => sum + l.lineTotalPaise, 0)
  const quantitySum = body.items.reduce((sum, l) => sum + l.quantity, 0)
  if (
    lineSum !== body.subtotalPaise ||
    quantitySum !== body.itemCount ||
    body.items.some((l) => l.unitPricePaise * l.quantity !== l.lineTotalPaise)
  ) {
    return null
  }
  const money = body.moneyPreview ?? null
  if (
    money !== null &&
    (money.merchandiseSubtotalPaise !== body.subtotalPaise ||
      money.benefitDiscountPaise > money.merchandiseSubtotalPaise ||
      money.payablePaise !== money.merchandiseSubtotalPaise - money.benefitDiscountPaise)
  ) {
    return null
  }
  const preview = body.benefitPreview ?? null
  const benefit =
    preview === null
      ? null
      : preview.applied
        ? {
            applied: true,
            discountPaise: preview.discountPaise ?? 0,
            discountBps: preview.discountBps ?? 0,
          }
        : { applied: false, discountPaise: 0, discountBps: 0 }
  const expires = Date.parse(body.expiresAt)
  return {
    quoteId: body.quoteId,
    cartVersion: body.cartVersion,
    addressId: body.addressId,
    lines: body.items.map((l) => ({
      productId: l.skuId,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      lineTotalPaise: l.lineTotalPaise,
    })),
    itemCount: body.itemCount,
    subtotalPaise: body.subtotalPaise,
    expiresAt: Number.isFinite(expires) ? expires : null,
    benefit,
    money,
  }
}

export async function createQuote(
  accessToken: string,
  input: { addressId: string; cartVersion: number; idempotencyKey: string },
): Promise<QuoteCallResult> {
  if (!isAddressId(input.addressId)) throw new Error('canonical address ids only')
  const result = await sendJson('POST', '/v1/customer/checkout/quote', {
    bearer: accessToken,
    body: { addressId: input.addressId },
    ifMatch: ifMatch(input.cartVersion),
    idempotencyKey: input.idempotencyKey,
  })
  if (!result.ok) {
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
            return { ...base, reason: 'cart_changed' }
          case 'CHECKOUT_CART_EMPTY':
            return { ...base, reason: 'cart_empty' }
          case 'CHECKOUT_UNSERVICEABLE':
            return { ...base, reason: 'unserviceable' }
          case 'NOT_FOUND':
            return { ...base, reason: 'address_gone' }
          case 'QUOTE_EXPIRED':
          case 'IDEMPOTENCY_CONFLICT':
            return { ...base, reason: 'expired' }
          case 'CHECKOUT_ITEM_UNAVAILABLE':
            return {
              ...base,
              reason: 'items_unavailable',
              rejected: (result.items ?? []).map((i) => ({
                productId: i.skuId,
                reason: itemReasonOf(i.reason),
              })),
            }
          default:
            return { ...base, reason: 'unavailable' }
        }
    }
  }
  const parsed = quoteBody.safeParse(result.data)
  const quote = parsed.success ? toQuote(parsed.data) : null
  if (quote === null) {
    console.warn('storefront_backend_malformed path=/v1/customer/checkout/quote')
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  return { ok: true, data: quote }
}
