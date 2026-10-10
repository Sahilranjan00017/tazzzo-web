import { PIN_HINT } from '@/lib/location/validation'

/** What a customer reads for each location outcome. The server only sends these codes, never backend text. */
export type LocationError =
  | 'invalid_pin'
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'

export function locationErrorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'invalid_pin':
      return PIN_HINT
    case 'unauthenticated':
      return 'Please sign in to use a saved address.'
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    case 'bad_request':
      return 'That request was not valid. Reload the page and try again.'
    case 'not_found':
      return 'That address is no longer available. Reload the page to see your saved addresses.'
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
      return 'We could not check that right now. Please try again in a moment.'
  }
}
