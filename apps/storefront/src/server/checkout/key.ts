import 'server-only'
import { createHmac } from 'node:crypto'

/**
 * The `Idempotency-Key` of a checkout quote, derived (never stored) from the attempt's secret seed (`quoteKey`, kept in
 * the sealed checkout cookie), the cart version and the address:
 *
 *   key = base64url(HMAC-SHA256(quoteKey, "checkout-quote|v1|<cartVersion>|<addressId>"))   (43 characters)
 *
 * Why this shape. The backend keys a quote by `(customer, key)` and fingerprints it with the cart version and the
 * address: the same key with the same pair returns the ORIGINAL quote (same `quoteId`, so every refresh, double-click
 * and retry of one checkout attempt sees one quote and can only ever place one order), while the same key with another
 * pair is a 409 conflict. Deriving the key from the pair therefore makes it stable exactly while the attempt is
 * unchanged, moves to a fresh quote on its own when the cart or address changes, and needs no cookie write during a
 * page render (a page cannot set cookies). The seed is replaced (`rotateCheckoutQuoteKey`) only when the current quote
 * ended definitively (expired, or the price or stock moved) and when a new delivery choice is saved, never on an
 * unknown outcome, so a retry after "status unknown" reuses the same quote and can only return the same order.
 */
export function deriveQuoteKey(quoteKey: string, cartVersion: number, addressId: string): string {
  return createHmac('sha256', quoteKey)
    .update(`checkout-quote|v1|${cartVersion}|${addressId}`)
    .digest('base64url')
}
