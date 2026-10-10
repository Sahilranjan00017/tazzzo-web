/**
 * What a customer reads for each address outcome. The server only sends one of these codes (never backend text), so
 * nothing internal can reach the page. Pure; client-safe.
 */
export type AddressError =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'limit_reached'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'unavailable'

export function addressErrorMessage(
  error: string,
  retryAfterSeconds: number | null = null,
): string {
  switch (error) {
    case 'unauthenticated':
      return 'Please sign in to manage your addresses.'
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    case 'bad_request':
      return 'Some details are not valid. Check the fields marked below and try again.'
    case 'not_found':
      return 'This address no longer exists. We refreshed your list.'
    case 'conflict':
      return 'This address changed in another tab or window, so we refreshed it. Please check it and try again.'
    case 'limit_reached':
      return 'You have reached the limit of saved addresses. Delete one to add another.'
    case 'idempotency_conflict':
      return 'That save could not be repeated safely. Check your list, then try again.'
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
      return 'We could not update your addresses right now. Please try again in a moment.'
  }
}
