import 'server-only'
import type { NextResponse } from 'next/server'
import type { PlaceError } from '@/lib/checkout/messages'
import { isQuoteId } from '@/lib/checkout/model'
import { isCartVersion } from '@/lib/cart/validation'
import { isAddressId, isSlotId } from '@/lib/location/validation'
import type { PlaceInput } from '@/server/checkout/service'
import { readSession, type CustomerSession } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import { forbidden, json, readJsonObject, rejectBody } from '@/server/session/route'

/** Shared plumbing of the `/api/orders*` and `/api/checkout/refresh` route handlers, on top of the session routes'. */
const STATUS: Record<PlaceError, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  choice_changed: 409,
  cart_changed: 409,
  quote_expired: 409,
  price_changed: 409,
  items_unavailable: 409,
  slot_unavailable: 409,
  address_changed: 409,
  unserviceable: 409,
  already_ordered: 409,
  hold_expired: 409,
  rate_limited: 429,
  unavailable: 503,
  // The order MAY exist: not a client error and not a plain "unavailable".
  unknown: 502,
}

/** The normalised answer to a failed placement: a closed code (never backend text) and a retry hint. */
export function respondPlaceError(
  error: PlaceError,
  retryAfterSeconds: number | null,
): NextResponse {
  const retry: Record<string, string> =
    retryAfterSeconds !== null ? { 'Retry-After': String(retryAfterSeconds) } : {}
  return json(STATUS[error], { ok: false, error, retryAfterSeconds }, retry)
}

/**
 * Exactly `{quoteId, cartVersion, addressId, slotId}`: the quote the customer reviewed, the cart version, address and
 * slot that review showed. No price, total, quantity, payment method or customer id of any kind is accepted.
 */
export function parsePlaceBody(body: Record<string, unknown>): PlaceInput | null {
  const keys = Object.keys(body)
  if (keys.length !== 4) return null
  if (!['quoteId', 'cartVersion', 'addressId', 'slotId'].every((k) => keys.includes(k))) return null
  const { quoteId, cartVersion, addressId, slotId } = body
  if (!isQuoteId(quoteId) || !isCartVersion(cartVersion)) return null
  if (!isAddressId(addressId) || !isSlotId(slotId)) return null
  return { quoteId, cartVersion, addressId, slotId }
}

/**
 * A checkout/orders mutation (`POST`, JSON, cookie-authenticated). Order matters: the CSRF rule first (with the
 * session's token when there is one, so a forged request is a 403 whether or not a session exists), then the session,
 * then the body (bounded, exactly the expected fields), and only then the backend.
 */
export async function orderMutation<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T | null,
  run: (session: CustomerSession, input: T) => Promise<NextResponse>,
): Promise<NextResponse> {
  const session = await readSession()
  if (!isSameOriginMutation(request.headers, session?.csrf ?? '1')) return forbidden()
  if (session === null) return respondPlaceError('unauthenticated', null)
  const body = await readJsonObject(request)
  if (!body.ok) return rejectBody(body.status)
  const input = parse(body.value)
  if (input === null) return rejectBody(400)
  return run(session, input)
}
