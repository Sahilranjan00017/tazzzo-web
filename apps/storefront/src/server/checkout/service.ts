import 'server-only'
import type { Address } from '@/lib/address/model'
import type { PlaceError } from '@/lib/checkout/messages'
import type { BlockedLine, Quote, ReviewView } from '@/lib/checkout/model'
import type { Cart, CartLine } from '@/lib/cart/model'
import { formatWindow, type Slot } from '@/lib/delivery/slots'
import { isAddressId, isSlotId } from '@/lib/location/validation'
import { getAddress } from '@/server/backend/addresses'
import { getCart } from '@/server/backend/cart'
import { createQuote } from '@/server/backend/checkout'
import { placeCodOrder } from '@/server/backend/orders'
import { listSlots } from '@/server/backend/slots'
import { loadCartForPage } from '@/server/cart/service'
import { deriveQuoteKey } from '@/server/checkout/key'
import { withAccessToken } from '@/server/session/access'
import {
  clearCheckoutChoice,
  readCheckoutChoice,
  rotateCheckoutQuoteKey,
  setCheckoutPlacing,
  type CheckoutChoice,
  type CustomerSession,
} from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

/**
 * The order step: the review page's data and the order placement. What a caller learns is a closed outcome; backend
 * text, ids and tokens stay in `server/backend/*` and the session. Nothing in this file logs.
 *
 * The customer never supplies a price, a total or a quantity: the review shows the backend's QUOTE for the cart as it is
 * right now (re-requested on every render; an unchanged attempt gets the same quote back, see `deriveQuoteKey`), and
 * placement names only that quote.
 */
export type ReviewRedirect =
  | '/cart'
  | '/checkout/delivery'
  | '/checkout/delivery?reason=slot'
  | '/checkout/delivery?reason=address'
  | '/checkout/delivery?reason=unserviceable'

export type ReviewOutcome =
  | { kind: 'redirect'; to: ReviewRedirect }
  /** The access token is unusable (`rejected`: the backend refused a fresh one): the page sends it through refresh. */
  | { kind: 'unauthenticated'; rejected: boolean }
  | { kind: 'unavailable'; rateLimited: boolean; retryAfterSeconds: number | null }
  /** The quote this attempt had ended (expired): the customer asks for a fresh review. */
  | { kind: 'expired' }
  | { kind: 'blocked'; lines: BlockedLine[] }
  | { kind: 'ready'; view: ReviewView }

const redirect = (to: ReviewRedirect): ReviewOutcome => ({ kind: 'redirect', to })
const unavailable = (
  rateLimited = false,
  retryAfterSeconds: number | null = null,
): ReviewOutcome => ({
  kind: 'unavailable',
  rateLimited,
  retryAfterSeconds,
})

/** The order-step choice kept for THIS customer, or null (none, expired, tampered, another customer's). */
export async function keptChoice(session: CustomerSession): Promise<CheckoutChoice | null> {
  const choice = await readCheckoutChoice()
  return choice !== null && choice.customerId === session.customerId ? choice : null
}

const lineOf = (cart: Cart, productId: string): CartLine | undefined =>
  cart.lines.find((l) => l.productId === productId)

const MAX_QUOTE_ATTEMPTS = 2

/**
 * The review page's data (page reads only: no cookie can be written here, so an unusable access token is handed back
 * as `unauthenticated` and the PAGE sends the browser through `/api/auth/refresh`).
 */
export async function reviewCheckout(session: CustomerSession): Promise<ReviewOutcome> {
  if (!accessTokenUsable(session)) return { kind: 'unauthenticated', rejected: false }
  const token = session.accessToken
  const choice = await keptChoice(session)
  if (choice === null) {
    // Nothing chosen yet: an empty cart goes back to the cart, otherwise on to the delivery step.
    const cart = await loadCartForPage(session)
    if (!cart.ok) return cartFailure(cart.error, cart.retryAfterSeconds)
    return redirect(cart.cart.lines.length === 0 ? '/cart' : '/checkout/delivery')
  }
  if (!isAddressId(choice.addressId) || !isSlotId(choice.slotId))
    return redirect('/checkout/delivery')

  const [cartResult, addressResult] = await Promise.all([
    getCart(token, choice.addressId),
    getAddress(token, choice.addressId),
  ])
  if (!addressResult.ok) {
    if (addressResult.reason === 'not_found') return redirect('/checkout/delivery?reason=address')
    return failure(addressResult.reason, addressResult.retryAfterSeconds)
  }
  if (!cartResult.ok) {
    // The cart is located by the saved address: it no longer existing is the address being gone.
    if (cartResult.reason === 'not_found') return redirect('/checkout/delivery?reason=address')
    return failure(cartResult.reason, cartResult.retryAfterSeconds)
  }
  const address = addressResult.data
  if (cartResult.data.lines.length === 0) return redirect('/cart')
  if (address.serviceable !== true) return redirect('/checkout/delivery?reason=unserviceable')

  const slots = await listSlots(token, address.postalCode)
  if (!slots.ok) return failure(slots.reason, slots.retryAfterSeconds)
  const slot: Slot | undefined = slots.data.slots.find((s) => s.slotId === choice.slotId)
  if (!slots.data.serviceable || slot === undefined || slot.status !== 'AVAILABLE') {
    return redirect('/checkout/delivery?reason=slot')
  }

  let cart = cartResult.data
  for (let attempt = 0; attempt < MAX_QUOTE_ATTEMPTS; attempt++) {
    const quote = await createQuote(token, {
      addressId: choice.addressId,
      cartVersion: cart.version,
      idempotencyKey: deriveQuoteKey(choice.quoteKey, cart.version, choice.addressId),
    })
    if (quote.ok) {
      return {
        kind: 'ready',
        view: toView(quote.data, cart, address, choice.slotId, slot),
      }
    }
    switch (quote.reason) {
      case 'cart_changed': {
        // The cart moved between reading it and quoting it: read it once more and quote that.
        if (attempt === MAX_QUOTE_ATTEMPTS - 1) return unavailable()
        const fresh = await getCart(token, choice.addressId)
        if (!fresh.ok) return failure(fresh.reason, fresh.retryAfterSeconds)
        if (fresh.data.lines.length === 0) return redirect('/cart')
        cart = fresh.data
        continue
      }
      case 'cart_empty':
        return redirect('/cart')
      case 'unserviceable':
        return redirect('/checkout/delivery?reason=unserviceable')
      case 'address_gone':
        return redirect('/checkout/delivery?reason=address')
      case 'unauthenticated':
        return { kind: 'unauthenticated', rejected: true }
      case 'expired':
        return { kind: 'expired' }
      case 'items_unavailable':
        return {
          kind: 'blocked',
          lines: (quote.rejected ?? []).map((r) => {
            const line = lineOf(cart, r.productId)
            return {
              productId: r.productId,
              title: line?.title ?? null,
              imageUrl: line?.imageUrl ?? null,
              quantity: line?.quantity ?? 0,
              reason: r.reason,
            }
          }),
        }
      case 'rate_limited':
        return unavailable(true, quote.retryAfterSeconds)
      default:
        return unavailable()
    }
  }
  return unavailable()
}

function failure(reason: string, retryAfterSeconds: number | null): ReviewOutcome {
  if (reason === 'unauthenticated') return { kind: 'unauthenticated', rejected: true }
  return unavailable(reason === 'rate_limited', retryAfterSeconds)
}

function cartFailure(error: string, retryAfterSeconds: number | null): ReviewOutcome {
  return error === 'unauthenticated'
    ? { kind: 'unauthenticated', rejected: false }
    : unavailable(error === 'rate_limited', retryAfterSeconds)
}

function toView(
  quote: Quote,
  cart: Cart,
  address: Address,
  slotId: string,
  slot: Slot,
): ReviewView {
  const discount = quote.money?.benefitDiscountPaise ?? 0
  return {
    quoteId: quote.quoteId,
    cartVersion: quote.cartVersion,
    addressId: quote.addressId,
    slotId,
    lines: quote.lines.map((l) => {
      const line = lineOf(cart, l.productId)
      return {
        productId: l.productId,
        title: line?.title ?? null,
        imageUrl: line?.imageUrl ?? null,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        mrpPaise: line?.mrpPaise ?? null,
        lineTotalPaise: l.lineTotalPaise,
      }
    }),
    itemCount: quote.itemCount,
    subtotalPaise: quote.subtotalPaise,
    discountPaise: discount,
    payablePaise: quote.money?.payablePaise ?? null,
    expiresAt: quote.expiresAt,
    address,
    slot: { slotId, label: slot.label, date: slot.date, window: formatWindow(slot) },
  }
}

export type PlaceOutcome =
  | { ok: true; orderId: string; payablePaise: number | null }
  | { ok: false; error: PlaceError; retryAfterSeconds: number | null }

const failPlace = (error: PlaceError, retryAfterSeconds: number | null = null): PlaceOutcome => ({
  ok: false,
  error,
  retryAfterSeconds,
})

/** Failures after which the quote can never be placed as it is: the next review must get a NEW one. */
const ENDS_THE_QUOTE: ReadonlySet<PlaceError> = new Set([
  'quote_expired',
  'price_changed',
  'items_unavailable',
])

export interface PlaceInput {
  quoteId: string
  cartVersion: number
  addressId: string
  slotId: string
}

/**
 * Places the Cash on Delivery order for the quote the customer reviewed. Route handlers only (they can set cookies).
 * - The order is placed with the quote id and the slot the SERVER holds in the sealed choice; the reviewed address and
 *   slot the page sent must match it, else the choice changed under the screen (another tab) and nothing is sent.
 * - The cart must still be the version that was reviewed (changed in another tab: nothing is sent).
 * - The backend's `(customer, quoteId)` uniqueness is the idempotency: repeating this call with the same quote returns
 *   the same order, whether the first call's answer was lost, timed out or the button was pressed twice.
 * - On success the checkout choice is cleared (the backend has emptied the cart). On a failure that ends the quote the
 *   seed is replaced so the next review gets a new quote; on an unknown outcome the seed is kept and the quote is
 *   remembered as pending (`placing`), so the retry asks for the same quote and skips the cart check.
 */
export async function placeOrder(
  session: CustomerSession,
  input: PlaceInput,
): Promise<PlaceOutcome> {
  const choice = await keptChoice(session)
  if (choice === null || choice.addressId !== input.addressId || choice.slotId !== input.slotId) {
    return failPlace('choice_changed')
  }
  const retrying = choice.placing === input.quoteId
  // Mark the attempt BEFORE anything is sent: whatever happens to the answer, the server's own cookie already says this
  // quote may be on its way. (If the response is lost the browser never sees this cookie; the screen has its own marker
  // for that, see `PendingOrderNotice`.)
  let current: CheckoutChoice = choice
  if (!retrying) {
    await setCheckoutPlacing(choice, input.quoteId)
    current = { ...choice, placing: input.quoteId }
  }
  const outcome = await withAccessToken<PlaceOutcome>(
    session,
    async (token) => {
      // A retry of an attempt whose outcome is unknown is not a new decision: the cart may well have been emptied by the
      // order that went through, and the backend answers a repeat of the same quote with that one order.
      if (!retrying) {
        const cart = await getCart(token, choice.addressId)
        if (!cart.ok) {
          if (cart.reason === 'unauthenticated') return failPlace('unauthenticated')
          if (cart.reason === 'not_found') return failPlace('address_changed')
          return failPlace(
            cart.reason === 'rate_limited' ? 'rate_limited' : 'unavailable',
            cart.retryAfterSeconds,
          )
        }
        if (cart.data.version !== input.cartVersion) return failPlace('cart_changed')
      }
      const placed = await placeCodOrder(token, {
        quoteId: input.quoteId,
        deliverySlotId: choice.slotId,
      })
      return placed.ok
        ? { ok: true, orderId: placed.data.orderId, payablePaise: placed.data.payablePaise }
        : failPlace(placed.reason, placed.retryAfterSeconds)
    },
    {
      unauthenticated: () => failPlace('unauthenticated'),
      unavailable: () => failPlace('unavailable'),
      isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
    },
  )
  if (outcome.ok || outcome.error === 'already_ordered') {
    await clearCheckoutChoice()
  } else if (ENDS_THE_QUOTE.has(outcome.error)) {
    await rotateCheckoutQuoteKey(current)
  } else {
    // Unknown: keep it, so the retry is recognised. Anything else is a definite "not placed": forget it.
    await setCheckoutPlacing(current, outcome.error === 'unknown' ? input.quoteId : undefined)
  }
  return outcome
}

/** "Refresh the review": the customer's explicit request for a new quote after the last one ended. Route handlers only. */
export async function renewReview(session: CustomerSession): Promise<boolean> {
  const choice = await keptChoice(session)
  if (choice === null) return false
  await rotateCheckoutQuoteKey(choice)
  return true
}
