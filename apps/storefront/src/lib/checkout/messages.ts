/**
 * What a customer reads for each outcome of placing an order. The server only ever sends one of these codes (never
 * backend text), so nothing internal can reach the page. Pure; client-safe.
 *
 * `unknown` is the one outcome in which the order MAY have been placed (the backend call timed out or failed after the
 * request left); every other error is a definite "no order was created by this request".
 */
export type PlaceError =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'choice_changed'
  | 'cart_changed'
  | 'quote_expired'
  | 'price_changed'
  | 'items_unavailable'
  | 'slot_unavailable'
  | 'address_changed'
  | 'unserviceable'
  | 'already_ordered'
  | 'hold_expired'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown'

/** What the screen does next: sign in again, re-render the review, go back to the delivery step, see Orders, or retry. */
export type PlaceAction = 'signin' | 'refresh' | 'delivery' | 'orders' | 'retry'

export const PLACE_ACTION: Record<PlaceError, PlaceAction> = {
  unauthenticated: 'signin',
  forbidden: 'retry',
  bad_request: 'refresh',
  choice_changed: 'refresh',
  cart_changed: 'refresh',
  quote_expired: 'refresh',
  price_changed: 'refresh',
  items_unavailable: 'refresh',
  slot_unavailable: 'delivery',
  address_changed: 'delivery',
  unserviceable: 'delivery',
  already_ordered: 'orders',
  hold_expired: 'retry',
  rate_limited: 'retry',
  unavailable: 'retry',
  unknown: 'retry',
}

export function isPlaceError(value: unknown): value is PlaceError {
  return typeof value === 'string' && Object.hasOwn(PLACE_ACTION, value)
}

function wait(retryAfterSeconds: number | null): string {
  return retryAfterSeconds === null || retryAfterSeconds <= 1
    ? 'a moment'
    : retryAfterSeconds < 90
      ? `${Math.ceil(retryAfterSeconds)} seconds`
      : `${Math.ceil(retryAfterSeconds / 60)} minutes`
}

export function placeErrorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'unauthenticated':
      return 'Please sign in to place your order.'
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    case 'bad_request':
      return 'We could not place this order as shown, so we refreshed it. Please check it and try again.'
    case 'choice_changed':
      return 'Your delivery choice changed in another tab or window, so we refreshed this page. Please check it and place your order again.'
    case 'cart_changed':
      return 'Your cart changed in another tab or window, so we refreshed this page. Please check it and place your order again.'
    case 'quote_expired':
      return 'This order review expired, so we refreshed it. Please check it and place your order again.'
    case 'price_changed':
      return 'A price changed, so we refreshed your total. Please review it and confirm to place your order.'
    case 'items_unavailable':
      return 'Some items are no longer available in the quantity you chose, so no order was placed.'
    case 'slot_unavailable':
      return 'That delivery slot is no longer available. Please choose another.'
    case 'address_changed':
      return 'Your delivery address changed. Please choose your delivery address and slot again.'
    case 'unserviceable':
      return 'We do not deliver to that address any more. Choose another address.'
    case 'already_ordered':
      return 'An order for this cart was already placed. Check your orders.'
    case 'hold_expired':
      return 'We could not hold your items in time, so no order was placed. Please try again.'
    case 'rate_limited':
      return `Too many requests. Please wait ${wait(retryAfterSeconds)} and try again.`
    case 'unknown':
      return 'We could not confirm whether your order was placed. Check your orders first. If it is not there, you can safely try again.'
    default:
      return 'We could not place your order right now. No order was placed. Please try again in a moment.'
  }
}

/** The review screen's own failures (it renders from the server, so these are page states, not replies). */
export const REVIEW_UNAVAILABLE =
  'We could not prepare your order review right now. Nothing was ordered. Please try again in a moment.'
