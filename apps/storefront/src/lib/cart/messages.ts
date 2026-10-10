import { MAX_DISTINCT_ITEMS, MAX_QUANTITY_PER_ITEM } from '@/lib/cart/model'

/**
 * What a customer reads for each cart outcome. The server only ever sends one of these codes (never backend text), so
 * nothing internal can reach the page. Pure; client-safe.
 */
export type CartError =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'conflict'
  | 'not_found'
  | 'item_limit'
  | 'quantity_limit'
  | 'rate_limited'
  | 'unavailable'

export function cartErrorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'unauthenticated':
      return 'Please sign in to use your cart.'
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    case 'bad_request':
      return `Choose a quantity between 1 and ${MAX_QUANTITY_PER_ITEM}.`
    case 'conflict':
      return 'Your cart changed in another tab or window, so we refreshed it. Please check it and try again.'
    case 'not_found':
      return 'This product is not available right now.'
    case 'item_limit':
      return `Your cart can hold up to ${MAX_DISTINCT_ITEMS} different items. Remove one to add another.`
    case 'quantity_limit':
      return `You can buy up to ${MAX_QUANTITY_PER_ITEM} of one item.`
    case 'rate_limited': {
      const wait =
        retryAfterSeconds === null || retryAfterSeconds <= 1
          ? 'a moment'
          : retryAfterSeconds < 90
            ? `${Math.ceil(retryAfterSeconds)} seconds`
            : `${Math.ceil(retryAfterSeconds / 60)} minutes`
      return `Too many requests. Please wait ${wait} and try again.`
    }
    default:
      return 'We could not update your cart right now. Please try again in a moment.'
  }
}

/** Where a signed-out visitor goes to sign in and come back to `next` (a same-origin path of ours; `/login` re-checks it). */
export const signInUrl = (next: string): string => `/login?next=${encodeURIComponent(next)}`
