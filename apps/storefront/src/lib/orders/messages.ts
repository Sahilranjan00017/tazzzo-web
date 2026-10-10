/**
 * What a customer reads for each order read/cancel outcome. The server only ever sends one of these codes (never
 * backend text). Pure; client-safe.
 */
export type OrderError =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'not_cancellable'
  | 'window_closed'
  | 'rate_limited'
  | 'unavailable'

export function orderErrorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'unauthenticated':
      return 'Please sign in to see your orders.'
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    case 'bad_request':
      return 'We could not process that request. Reload the page and try again.'
    case 'not_found':
      return 'We could not find that order.'
    case 'not_cancellable':
      return 'This order can no longer be cancelled.'
    case 'window_closed':
      return 'Cancelling is not available for this order. If you need help, please contact Tazzzo support.'
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
      return 'We could not reach your orders right now. Please try again in a moment.'
  }
}
