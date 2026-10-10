import 'server-only'
import type { Address } from '@/lib/address/model'
import type { DeliveryLocation } from '@/lib/location/model'
import type { LocationError } from '@/lib/location/messages'
import { isAddressId, normalisePin } from '@/lib/location/validation'
import { getAddress } from '@/server/backend/addresses'
import { checkServiceability } from '@/server/backend/serviceability'
import { withAccessToken } from '@/server/session/access'
import {
  clearCheckoutChoice,
  clearLocation,
  customerSessionsEnabled,
  readCheckoutChoice,
  readLocation,
  unbindLocationAddress,
  writeLocation,
  type CustomerSession,
} from '@/server/session/cookies'

/**
 * The delivery location, and how it reaches the backend (tazzzo-backend contract):
 * - public reads (`/v1/products/{id}`, `/v1/search`, `/v1/categories/{id}/products`) take `?pin=` (6-digit Indian
 *   PIN; `lat`/`lng` are refused). The PIN is passed only when the backend said it is serviceable, so the data cache
 *   is split only by real service areas' PINs, never by whatever a visitor typed;
 * - the signed-in cart takes `?addressId=` of a SAVED address, nothing else; the cookie remembers that id together
 *   with the customer it belongs to and it is honoured only for that customer's session.
 * The cookie is sealed and carries no name, phone or street. Nothing in this file logs.
 */
export type LocationOutcome<T> =
  { ok: true; data: T } | { ok: false; error: LocationError; retryAfterSeconds: number | null }

const fail = (error: LocationError, retryAfterSeconds: number | null = null) =>
  ({ ok: false, error, retryAfterSeconds }) as const

/** The location this browser works with (null when none was chosen), as the pages show it. */
export async function currentLocation(
  session: CustomerSession | null,
): Promise<DeliveryLocation | null> {
  const stored = await readLocation()
  if (stored === null) return null
  return {
    pin: stored.pin,
    serviceable: stored.serviceable,
    viaAddress: boundAddressId(stored, session) !== null,
  }
}

function boundAddressId(
  stored: { addressId?: string; customerId?: string },
  session: CustomerSession | null,
): string | null {
  return session !== null &&
    stored.addressId !== undefined &&
    stored.customerId === session.customerId
    ? stored.addressId
    : null
}

/** The saved address the cart should be located by, or null (none chosen, another customer's, signed out). */
export async function cartAddressId(session: CustomerSession | null): Promise<string | null> {
  const stored = await readLocation()
  return stored === null ? null : boundAddressId(stored, session)
}

/** The PIN for public product reads: only a PIN the backend said is serviceable. */
export async function catalogPin(): Promise<string | null> {
  const stored = await readLocation()
  return stored !== null && stored.serviceable === true ? stored.pin : null
}

/** Checks a typed PIN with `/v1/serviceability` and remembers it (serviceable or not). Visitors need no account. */
export async function setPinLocation(rawPin: unknown): Promise<LocationOutcome<DeliveryLocation>> {
  const pin = normalisePin(rawPin)
  if (pin === null) return fail('invalid_pin')
  if (!customerSessionsEnabled()) return fail('unavailable')
  const checked = await checkServiceability(pin)
  if (!checked.ok) return fail(checked.reason === 'rejected' ? 'invalid_pin' : 'unavailable')
  await writeLocation({ pin, serviceable: checked.serviceable })
  return { ok: true, data: { pin, serviceable: checked.serviceable, viaAddress: false } }
}

/** Makes one of the signed-in customer's SAVED addresses the delivery location (the backend proves ownership). */
export async function setAddressLocation(
  session: CustomerSession,
  addressId: unknown,
): Promise<LocationOutcome<DeliveryLocation>> {
  if (!isAddressId(addressId)) return fail('not_found')
  if (!customerSessionsEnabled()) return fail('unavailable')
  type R = LocationOutcome<Address>
  const found = await withAccessToken<R>(
    session,
    async (token) => {
      const result = await getAddress(token, addressId)
      return result.ok
        ? { ok: true, data: result.data }
        : fail(
            result.reason === 'not_found' ||
              result.reason === 'unauthenticated' ||
              result.reason === 'rate_limited'
              ? result.reason
              : 'unavailable',
            result.retryAfterSeconds,
          )
    },
    {
      unauthenticated: () => fail('unauthenticated'),
      unavailable: () => fail('unavailable'),
      isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
    },
  )
  if (!found.ok) return found
  const address = found.data
  await writeLocation({
    pin: address.postalCode,
    serviceable: address.serviceable,
    addressId: address.addressId,
    customerId: session.customerId,
  })
  return {
    ok: true,
    data: { pin: address.postalCode, serviceable: address.serviceable, viaAddress: true },
  }
}

export async function forgetLocation(): Promise<void> {
  await clearLocation()
}

/** An address that is the delivery location was edited: its PIN (and so its serviceability) may have changed. */
export async function rememberUpdatedAddress(
  session: CustomerSession,
  address: Address,
): Promise<void> {
  const stored = await readLocation()
  if (stored === null || boundAddressId(stored, session) !== address.addressId) return
  await writeLocation({
    pin: address.postalCode,
    serviceable: address.serviceable,
    addressId: address.addressId,
    customerId: session.customerId,
  })
}

/** An address was deleted: it stops being the delivery location (the PIN stays) and the order-step choice. */
export async function forgetAddress(addressId: string): Promise<void> {
  const stored = await readLocation()
  if (stored?.addressId === addressId) await unbindLocationAddress()
  const choice = await readCheckoutChoice()
  if (choice?.addressId === addressId) await clearCheckoutChoice()
}
