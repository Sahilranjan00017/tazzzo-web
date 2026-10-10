import type { DeliveryError } from '@/lib/delivery/messages'
import { isAddressId, isSlotId } from '@/lib/location/validation'
import { chooseDelivery } from '@/server/delivery/service'
import { respondLocation, locationMutation } from '@/server/location/route'
import { json } from '@/server/session/route'

/**
 * `POST /api/checkout/delivery` `{addressId, slotId}`: checks the choice against the backend (the address is the
 * caller's and serviceable; the slot is offered for its PIN and AVAILABLE) and keeps it, sealed, for the order step.
 * It places no order and reserves nothing (the backend reserves a slot only when the order is placed).
 */
export const POST = (request: Request) =>
  locationMutation(
    request,
    (body) => {
      const keys = Object.keys(body)
      if (keys.length !== 2 || !keys.includes('addressId') || !keys.includes('slotId')) return null
      return isAddressId(body.addressId) && isSlotId(body.slotId)
        ? { addressId: body.addressId, slotId: body.slotId }
        : null
    },
    async (session, input) => {
      if (session === null) {
        return respondLocation({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
      }
      const outcome = await chooseDelivery(session, input.addressId, input.slotId)
      if (outcome.ok) return respondLocation(outcome)
      return respondDeliveryError(outcome.error, outcome.retryAfterSeconds)
    },
    true,
  )


function respondDeliveryError(error: DeliveryError, retryAfterSeconds: number | null) {
  const status: Record<DeliveryError, number> = {
    unauthenticated: 401,
    forbidden: 403,
    bad_request: 400,
    not_found: 404,
    conflict: 409,
    limit_reached: 409,
    idempotency_conflict: 409,
    rate_limited: 429,
    unavailable: 503,
    slot_unavailable: 409,
    unserviceable: 422,
  }
  const retry: Record<string, string> =
    retryAfterSeconds !== null ? { 'Retry-After': String(retryAfterSeconds) } : {}
  return json(status[error], { ok: false, error, retryAfterSeconds }, retry)
}
