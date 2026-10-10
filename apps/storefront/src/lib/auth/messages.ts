/**
 * What a customer reads for each sign-in outcome. The server only ever sends one of these codes (never backend
 * text), so nothing internal can reach the page. Pure; client-safe.
 */
export type ApiError =
  | 'invalid_phone'
  | 'invalid_code'
  | 'expired'
  | 'rate_limited'
  | 'unavailable'
  | 'forbidden'
  | 'bad_request'

export function waitText(seconds: number | null): string {
  if (seconds === null || seconds <= 1) return 'a moment'
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`
  return `${Math.ceil(seconds / 60)} minutes`
}

export function errorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'invalid_phone':
      return 'Enter a valid 10-digit Indian mobile number.'
    case 'invalid_code':
      return 'That code is not right. Check it and try again, or ask for a new code.'
    case 'expired':
      return 'That code has expired. Ask for a new one.'
    case 'rate_limited':
      return `Too many attempts. Please wait ${waitText(retryAfterSeconds)} and try again.`
    case 'forbidden':
      return 'We could not verify this request. Reload the page and try again.'
    default:
      return 'We could not sign you in right now. Please try again in a moment.'
  }
}

export const REASON_NOTICE: Record<string, string> = {
  expired: 'Your session has ended. Please sign in again.',
  unavailable: 'Your account is temporarily unavailable. Please try again in a moment.',
}
