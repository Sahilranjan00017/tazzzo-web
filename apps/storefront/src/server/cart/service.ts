import 'server-only'
import { cache } from 'react'
import { MAX_DISTINCT_ITEMS, MAX_QUANTITY_PER_ITEM, type Cart } from '@/lib/cart/model'
import type { CartError } from '@/lib/cart/messages'
import {
  clearCart,
  getCart,
  removeCartItem,
  setCartItem,
  type CartCallResult,
} from '@/server/backend/cart'
import { withAccessToken } from '@/server/session/access'
import { cartAddressId } from '@/server/location/service'
import { type CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

/**
 * Cart flows for the pages and the `/api/cart/*` routes. What a caller learns is a closed outcome: the cart (already
 * reduced to what the page shows) or a `CartError`; backend text, ids and tokens stay in `server/backend/cart.ts`
 * and the session. Nothing in this file logs.
 *
 * Concurrency: the backend's cart is a compare-and-swap on a version (`If-Match`). `setQuantity`/`removeLine`/
 * `emptyCart` present the version the customer's screen showed; if it is stale the backend refuses (409 here) and the
 * answer carries the fresh cart so the screen can catch up. Nothing is applied on top of a cart the customer has not
 * seen. `addToCart` is the exception: adding is commutative, so it reads the current cart, adds, and on a lost race
 * reads again and retries once.
 */
export type CartOutcome =
  | { ok: true; cart: Cart }
  | { ok: false; error: CartError; retryAfterSeconds: number | null; cart?: Cart }

const fail = (error: CartError, retryAfterSeconds: number | null = null, cart?: Cart) =>
  ({ ok: false, error, retryAfterSeconds, cart }) as const

/**
 * Runs a cart call with the customer's chosen saved address; if the backend no longer knows that address (deleted on
 * another device: a foreign or unknown id is the same 404) the call is repeated without it, so the cart still works
 * (and says `LOCATION_REQUIRED`) instead of failing.
 */
async function located(
  addressId: string | null,
  run: (addressId: string | null) => Promise<CartCallResult<Cart>>,
): Promise<CartCallResult<Cart>> {
  const first = await run(addressId)
  if (addressId !== null && !first.ok && first.reason === 'not_found') return run(null)
  return first
}

const toOutcome = (result: CartCallResult<Cart>): CartOutcome =>
  result.ok ? { ok: true, cart: result.data } : fail(result.reason, result.retryAfterSeconds)

/**
 * Page/layout read: no cookie can be written there, so an access token that is (nearly) expired or refused is
 * `unauthenticated` and the PAGE sends the browser through `/api/auth/refresh`. One call per token per render, shared
 * by the layout (header count) and the page.
 */
export const loadCart = cache(
  async (accessToken: string, addressId: string | null): Promise<CartOutcome> => {
    return toOutcome(await located(addressId, (a) => getCart(accessToken, a)))
  },
)

export async function loadCartForPage(session: CustomerSession): Promise<CartOutcome> {
  return accessTokenUsable(session)
    ? loadCart(session.accessToken, await cartAddressId(session))
    : fail('unauthenticated')
}

const HEADER_BUDGET_MS = 1_500

/** The header's item count: best effort and time-boxed, so a slow cart never slows every page. Null when unknown. */
export async function headerCartCount(session: CustomerSession | null): Promise<number | null> {
  if (session === null || !accessTokenUsable(session)) return null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), HEADER_BUDGET_MS))
  const outcome = await Promise.race([
    cartAddressId(session).then((a) => loadCart(session.accessToken, a)),
    timeout,
  ])
  return outcome !== null && outcome.ok ? outcome.cart.itemCount : null
}

/** Route handlers only (they can set cookies); the shared implementation is `withAccessToken`. */
export function withAccess(
  session: CustomerSession,
  flow: (accessToken: string) => Promise<CartOutcome>,
): Promise<CartOutcome> {
  return withAccessToken(session, flow, {
    unauthenticated: () => fail('unauthenticated'),
    unavailable: () => fail('unavailable'),
    isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
  })
}

/** After a refused mutation, the fresh cart for the screen (best effort). */
async function withFresh(
  error: CartError,
  accessToken: string,
  addressId: string | null,
): Promise<CartOutcome> {
  const fresh = await located(addressId, (a) => getCart(accessToken, a))
  return fail(error, null, fresh.ok ? fresh.data : undefined)
}

export async function viewCart(session: CustomerSession): Promise<CartOutcome> {
  const addressId = await cartAddressId(session)
  return withAccess(session, async (token) =>
    toOutcome(await located(addressId, (a) => getCart(token, a))),
  )
}

/** Adds `quantity` to the line (creating it). Never silently clamps: over the per-item bound is refused. */
export async function addToCart(
  session: CustomerSession,
  productId: string,
  quantity: number,
): Promise<CartOutcome> {
  const addressId = await cartAddressId(session)
  return withAccess(session, async (token) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await located(addressId, (a) => getCart(token, a))
      if (!current.ok) return toOutcome(current)
      const cart = current.data
      const existing = cart.lines.find((l) => l.productId === productId)?.quantity ?? 0
      if (existing + quantity > MAX_QUANTITY_PER_ITEM) return fail('quantity_limit', null, cart)
      if (existing === 0 && cart.lines.length >= MAX_DISTINCT_ITEMS) {
        return fail('item_limit', null, cart)
      }
      const set = await located(addressId, (a) =>
        setCartItem(token, productId, existing + quantity, cart.version, a),
      )
      if (set.ok || set.reason !== 'conflict' || attempt === 1) return toOutcome(set)
    }
    return fail('unavailable')
  })
}

/** Sets the line to exactly `quantity`, given the cart version the customer saw. */
export async function setQuantity(
  session: CustomerSession,
  productId: string,
  quantity: number,
  version: number,
): Promise<CartOutcome> {
  const addressId = await cartAddressId(session)
  return withAccess(session, async (token) => {
    const set = await located(addressId, (a) => setCartItem(token, productId, quantity, version, a))
    if (set.ok) return toOutcome(set)
    return set.reason === 'conflict' || set.reason === 'not_found'
      ? withFresh(set.reason, token, addressId)
      : toOutcome(set)
  })
}

/** Removes the line. A line that is already gone is a success: the customer's goal holds. */
export async function removeLine(
  session: CustomerSession,
  productId: string,
  version: number,
): Promise<CartOutcome> {
  const addressId = await cartAddressId(session)
  return withAccess(session, async (token) => {
    const removed = await located(addressId, (a) => removeCartItem(token, productId, version, a))
    if (removed.ok) return toOutcome(removed)
    if (removed.reason === 'conflict') return withFresh('conflict', token, addressId)
    if (removed.reason === 'not_found') {
      const fresh = await located(addressId, (a) => getCart(token, a))
      if (fresh.ok && !fresh.data.lines.some((l) => l.productId === productId)) {
        return { ok: true, cart: fresh.data }
      }
    }
    return toOutcome(removed)
  })
}

export async function emptyCart(session: CustomerSession, version: number): Promise<CartOutcome> {
  const addressId = await cartAddressId(session)
  return withAccess(session, async (token) => {
    const cleared = await located(addressId, (a) => clearCart(token, version, a))
    if (cleared.ok) return toOutcome(cleared)
    return cleared.reason === 'conflict'
      ? withFresh('conflict', token, addressId)
      : toOutcome(cleared)
  })
}
