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
import { clearSession, writeSession, type CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable, refreshSession } from '@/server/session/service'

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

const toOutcome = (result: CartCallResult<Cart>): CartOutcome =>
  result.ok ? { ok: true, cart: result.data } : fail(result.reason, result.retryAfterSeconds)

/**
 * Page/layout read: no cookie can be written there, so an access token that is (nearly) expired or refused is
 * `unauthenticated` and the PAGE sends the browser through `/api/auth/refresh`. One call per token per render, shared
 * by the layout (header count) and the page.
 */
export const loadCart = cache(async (accessToken: string): Promise<CartOutcome> => {
  return toOutcome(await getCart(accessToken))
})

export async function loadCartForPage(session: CustomerSession): Promise<CartOutcome> {
  return accessTokenUsable(session) ? loadCart(session.accessToken) : fail('unauthenticated')
}

const HEADER_BUDGET_MS = 1_500

/** The header's item count: best effort and time-boxed, so a slow cart never slows every page. Null when unknown. */
export async function headerCartCount(session: CustomerSession | null): Promise<number | null> {
  if (session === null || !accessTokenUsable(session)) return null
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), HEADER_BUDGET_MS))
  const outcome = await Promise.race([loadCart(session.accessToken), timeout])
  return outcome !== null && outcome.ok ? outcome.cart.itemCount : null
}

/**
 * Route handlers only (they can set cookies): runs `flow` with a usable access token. An expired token is rotated
 * first; a token the backend refuses is rotated once and the flow re-run. A session the backend will not refresh is
 * ended. Returns `unauthenticated` when there is no way to continue as this customer.
 */
export async function withAccess(
  session: CustomerSession,
  flow: (accessToken: string) => Promise<CartOutcome>,
): Promise<CartOutcome> {
  let current = session
  let rotated = false
  const rotate = async (): Promise<CartOutcome | null> => {
    const result = await refreshSession(current)
    if (!result.ok) {
      if (result.reason === 'invalid') {
        await clearSession()
        return fail('unauthenticated')
      }
      return fail('unavailable')
    }
    current = result.session
    rotated = true
    await writeSession(current)
    return null
  }
  if (!accessTokenUsable(current)) {
    const stopped = await rotate()
    if (stopped) return stopped
  }
  let outcome = await flow(current.accessToken)
  if (!outcome.ok && outcome.error === 'unauthenticated' && !rotated) {
    const stopped = await rotate()
    if (stopped) return stopped
    outcome = await flow(current.accessToken)
  }
  if (!outcome.ok && outcome.error === 'unauthenticated') await clearSession()
  return outcome
}

/** After a refused mutation, the fresh cart for the screen (best effort). */
async function withFresh(error: CartError, accessToken: string): Promise<CartOutcome> {
  const fresh = await getCart(accessToken)
  return fail(error, null, fresh.ok ? fresh.data : undefined)
}

export function viewCart(session: CustomerSession): Promise<CartOutcome> {
  return withAccess(session, async (token) => toOutcome(await getCart(token)))
}

/** Adds `quantity` to the line (creating it). Never silently clamps: over the per-item bound is refused. */
export function addToCart(
  session: CustomerSession,
  productId: string,
  quantity: number,
): Promise<CartOutcome> {
  return withAccess(session, async (token) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await getCart(token)
      if (!current.ok) return toOutcome(current)
      const cart = current.data
      const existing = cart.lines.find((l) => l.productId === productId)?.quantity ?? 0
      if (existing + quantity > MAX_QUANTITY_PER_ITEM) return fail('quantity_limit', null, cart)
      if (existing === 0 && cart.lines.length >= MAX_DISTINCT_ITEMS) {
        return fail('item_limit', null, cart)
      }
      const set = await setCartItem(token, productId, existing + quantity, cart.version)
      if (set.ok || set.reason !== 'conflict' || attempt === 1) return toOutcome(set)
    }
    return fail('unavailable')
  })
}

/** Sets the line to exactly `quantity`, given the cart version the customer saw. */
export function setQuantity(
  session: CustomerSession,
  productId: string,
  quantity: number,
  version: number,
): Promise<CartOutcome> {
  return withAccess(session, async (token) => {
    const set = await setCartItem(token, productId, quantity, version)
    if (set.ok) return toOutcome(set)
    return set.reason === 'conflict' || set.reason === 'not_found'
      ? withFresh(set.reason, token)
      : toOutcome(set)
  })
}

/** Removes the line. A line that is already gone is a success: the customer's goal holds. */
export function removeLine(
  session: CustomerSession,
  productId: string,
  version: number,
): Promise<CartOutcome> {
  return withAccess(session, async (token) => {
    const removed = await removeCartItem(token, productId, version)
    if (removed.ok) return toOutcome(removed)
    if (removed.reason === 'conflict') return withFresh('conflict', token)
    if (removed.reason === 'not_found') {
      const fresh = await getCart(token)
      if (fresh.ok && !fresh.data.lines.some((l) => l.productId === productId)) {
        return { ok: true, cart: fresh.data }
      }
    }
    return toOutcome(removed)
  })
}

export function emptyCart(session: CustomerSession, version: number): Promise<CartOutcome> {
  return withAccess(session, async (token) => {
    const cleared = await clearCart(token, version)
    if (cleared.ok) return toOutcome(cleared)
    return cleared.reason === 'conflict' ? withFresh('conflict', token) : toOutcome(cleared)
  })
}
