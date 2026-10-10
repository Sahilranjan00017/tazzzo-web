/**
 * Input grammar for the delivery location, shared by the browser (early feedback) and the server (the check that
 * counts). Mirrors the backend contract (tazzzo-backend `Pincode`: `^[1-9][0-9]{5}$`, the same rule address
 * `PostalCode` and `/v1/serviceability?pin=` enforce, applied after trimming). Pure; no secrets.
 */
import { safeNext } from '@/lib/auth/validation'

const PIN = /^[1-9][0-9]{5}$/
const ADDRESS_ID = /^ADDR_[A-Za-z0-9_-]{6,64}$/
const SLOT_ID = /^[a-z0-9][a-z0-9-]{0,31}~[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/

/** The six-digit Indian PIN for what a customer typed (surrounding blanks ignored, nothing else), or null. */
export function normalisePin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  const pin = raw.trim()
  return PIN.test(pin) ? pin : null
}

export const isPin = (value: unknown): value is string =>
  typeof value === 'string' && PIN.test(value)

/** The opaque saved-address id (`AddressId`): never case-changed, never trusted beyond this shape. */
export const isAddressId = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS_ID.test(value)

/** A delivery slot id `<window>~<yyyy-MM-dd>` (the backend order contract's `deliverySlotId`). */
export const isSlotId = (value: unknown): value is string =>
  typeof value === 'string' && SLOT_ID.test(value)

/** The backend's accepted `Idempotency-Key` grammar for an address create. */
export const isIdempotencyKey = (value: unknown): value is string =>
  typeof value === 'string' && IDEMPOTENCY_KEY.test(value)

export const PIN_HINT = 'Enter a 6-digit PIN code (it does not start with 0).'

/** Where to go back to after choosing a location: a same-origin path (see `safeNext`), `/` when none was given. */
export function returnPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  const safe = safeNext(raw)
  return safe === '/account' && !raw.startsWith('/account') ? '/' : safe
}
