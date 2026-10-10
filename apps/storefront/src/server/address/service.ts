import 'server-only'
import type { Address, AddressFields } from '@/lib/address/model'
import type { AddressError } from '@/lib/address/messages'
import {
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
  type AddressCallResult,
} from '@/server/backend/addresses'
import { forgetAddress, rememberUpdatedAddress } from '@/server/location/service'
import { withAccessToken } from '@/server/session/access'
import type { CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

/**
 * Saved-address flows for the pages and the `/api/addresses/*` routes. What a caller learns is a closed outcome: the
 * address(es) or an `AddressError`; backend text, ids and tokens stay in `server/backend/addresses.ts` and the
 * session. The customer id is never an input anywhere: the backend takes it from the bearer token and scopes every
 * address id to it. Nothing in this file logs.
 */
export type AddressOutcome<T> =
  { ok: true; data: T } | { ok: false; error: AddressError; retryAfterSeconds: number | null }

const toOutcome = <T>(result: AddressCallResult<T>): AddressOutcome<T> =>
  result.ok
    ? result
    : { ok: false, error: result.reason, retryAfterSeconds: result.retryAfterSeconds }

const unauthenticated = <T>(): AddressOutcome<T> => ({
  ok: false,
  error: 'unauthenticated',
  retryAfterSeconds: null,
})

/** Route handlers only: runs `flow` with a usable access token (rotated or refreshed once, see `withAccessToken`). */
export function withAddressAccess<T>(
  session: CustomerSession,
  flow: (accessToken: string) => Promise<AddressOutcome<T>>,
): Promise<AddressOutcome<T>> {
  return withAccessToken(session, flow, {
    unauthenticated: () => unauthenticated<T>(),
    unavailable: () => ({ ok: false, error: 'unavailable', retryAfterSeconds: null }),
    isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
  })
}

/**
 * Page reads: no cookie can be written there, so an access token that is (nearly) expired is `unauthenticated` and
 * the PAGE sends the browser through `/api/auth/refresh`.
 */
export async function pageAddresses(session: CustomerSession): Promise<AddressOutcome<Address[]>> {
  if (!accessTokenUsable(session)) return unauthenticated()
  return toOutcome(await listAddresses(session.accessToken))
}

export async function pageAddress(
  session: CustomerSession,
  addressId: string,
): Promise<AddressOutcome<Address>> {
  if (!accessTokenUsable(session)) return unauthenticated()
  return toOutcome(await getAddress(session.accessToken, addressId))
}

export function addAddress(
  session: CustomerSession,
  fields: AddressFields,
  idempotencyKey: string,
): Promise<AddressOutcome<Address>> {
  return withAddressAccess(session, async (token) =>
    toOutcome(await createAddress(token, fields, idempotencyKey)),
  )
}

export function editAddress(
  session: CustomerSession,
  addressId: string,
  version: number,
  fields: AddressFields,
): Promise<AddressOutcome<Address>> {
  return withAddressAccess(session, async (token) => {
    const result = toOutcome(await updateAddress(token, addressId, version, fields))
    if (result.ok) await rememberUpdatedAddress(session, result.data)
    return result
  })
}

export function removeAddress(
  session: CustomerSession,
  addressId: string,
  version: number,
): Promise<AddressOutcome<null>> {
  return withAddressAccess(session, async (token) => {
    const result = toOutcome(await deleteAddress(token, addressId, version))
    if (!result.ok) return result
    await forgetAddress(addressId)
    return { ok: true, data: null }
  })
}

export function makeDefault(
  session: CustomerSession,
  addressId: string,
): Promise<AddressOutcome<Address>> {
  return withAddressAccess(session, async (token) =>
    toOutcome(await setDefaultAddress(token, addressId)),
  )
}
