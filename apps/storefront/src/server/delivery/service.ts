import 'server-only'
import type { DeliveryError } from '@/lib/delivery/messages'
import type { SlotsView } from '@/lib/delivery/slots'
import { isAddressId, isSlotId } from '@/lib/location/validation'
import { getAddress } from '@/server/backend/addresses'
import { listSlots } from '@/server/backend/slots'
import { withAccessToken } from '@/server/session/access'
import { writeCheckoutChoice, type CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

/**
 * Delivery slots and the order-step choice. The backend ties a slot to the ORDER only (`deliverySlotId` on placement,
 * reserved in the order's transaction); no earlier call stores it. So the choice is checked here against the backend's
 * own answers (the address is the caller's and serviceable, the slot is offered for that address's PIN and is
 * AVAILABLE right now) and kept in a sealed, short-lived cookie for the order step, which re-checks it. Nothing in
 * this file logs.
 */
export type DeliveryOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: DeliveryError; retryAfterSeconds: number | null }

const fail = (error: DeliveryError, retryAfterSeconds: number | null = null) =>
  ({ ok: false, error, retryAfterSeconds }) as const

/** Page read of the slots for a PIN (a page cannot refresh tokens: an unusable token is `unauthenticated`). */
export async function pageSlots(
  session: CustomerSession,
  pin: string,
): Promise<DeliveryOutcome<SlotsView>> {
  if (!accessTokenUsable(session)) return fail('unauthenticated')
  const result = await listSlots(session.accessToken, pin)
  return result.ok ? result : fail(result.reason, result.retryAfterSeconds)
}

export async function chooseDelivery(
  session: CustomerSession,
  addressId: unknown,
  slotId: unknown,
): Promise<DeliveryOutcome<{ addressId: string; slotId: string }>> {
  if (!isAddressId(addressId) || !isSlotId(slotId)) return fail('bad_request')
  const checked = await withAccessToken<DeliveryOutcome<null>>(
    session,
    async (token) => {
      const address = await getAddress(token, addressId)
      if (!address.ok) return fail(address.reason, address.retryAfterSeconds)
      if (address.data.serviceable !== true) return fail('unserviceable')
      const slots = await listSlots(token, address.data.postalCode)
      if (!slots.ok) return fail(slots.reason, slots.retryAfterSeconds)
      const slot = slots.data.slots.find((s) => s.slotId === slotId)
      if (!slots.data.serviceable || slot === undefined || slot.status !== 'AVAILABLE') {
        return fail('slot_unavailable')
      }
      return { ok: true, data: null }
    },
    {
      unauthenticated: () => fail('unauthenticated'),
      unavailable: () => fail('unavailable'),
      isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
    },
  )
  if (!checked.ok) return checked
  await writeCheckoutChoice({ customerId: session.customerId, addressId, slotId })
  return { ok: true, data: { addressId, slotId } }
}
