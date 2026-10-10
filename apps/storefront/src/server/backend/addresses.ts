import 'server-only'
import { z } from 'zod'
import { ADDRESS_LABELS, type Address } from '@/lib/address/model'
import { addressIfMatch } from '@/lib/address/validation'
import type { AddressError } from '@/lib/address/messages'
import type { AddressFields } from '@/lib/address/model'
import { isAddressId, isPin } from '@/lib/location/validation'
import { sendJson, type SendResult } from '@/server/backend/client'

/**
 * Typed calls over the saved-address contract (tazzzo-backend `AddressController`, all bearer-authenticated, the
 * customer id is ALWAYS the verified principal: it is never sent and the backend scopes every id to the caller, so a
 * foreign, unknown or malformed address id is the same 404). `POST` creates (201; `Idempotency-Key`, 8-64 of
 * `[A-Za-z0-9_-]`, makes a retry safe; the FIRST address becomes the default; at most 10 active, else 409
 * ADDRESS_LIMIT_REACHED), `PATCH` and `DELETE` REQUIRE `If-Match: "address-<version>"` (428 without, 412 when stale),
 * `PUT .../default` needs none, `GET` lists (default first). Success bodies are parsed with a strict schema; a body
 * that does not match is `unavailable`, never passed on. Backend text is never read: the public error `code` and the
 * status select a closed `AddressError`.
 */
export type AddressCallResult<T> =
  { ok: true; data: T } | { ok: false; reason: AddressError; retryAfterSeconds: number | null }

const text = z.string().min(1).max(400)
const addressBody = z.object({
  addressId: z.string().refine(isAddressId),
  label: z.enum(ADDRESS_LABELS),
  recipientName: text,
  recipientPhone: z.string().min(1).max(32),
  addressLine1: text,
  addressLine2: z.string().max(400).nullish(),
  landmark: z.string().max(400).nullish(),
  city: text,
  state: text,
  postalCode: z.string().refine(isPin),
  isDefault: z.boolean(),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  serviceability: z.object({ serviceable: z.boolean().nullish() }).nullish(),
})
const listBody = z.object({ items: z.array(addressBody).max(100) })

function toAddress(a: z.infer<typeof addressBody>): Address {
  return {
    addressId: a.addressId,
    label: a.label,
    recipientName: a.recipientName,
    recipientPhone: a.recipientPhone,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2 ?? null,
    landmark: a.landmark ?? null,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    isDefault: a.isDefault,
    version: a.version,
    serviceable: a.serviceability?.serviceable ?? null,
  }
}

/** The backend's public error code (and HTTP class) as one closed `AddressError`. */
export function addressFailure(result: Extract<SendResult, { ok: false }>): AddressCallResult<never> {
  const base = { ok: false, retryAfterSeconds: result.retryAfterSeconds } as const
  switch (result.kind) {
    case 'unauthenticated':
      return { ...base, reason: 'unauthenticated' }
    case 'rate_limited':
      return { ...base, reason: 'rate_limited' }
    case 'rejected':
      return { ...base, reason: 'bad_request' }
    default:
      switch (result.code) {
        case 'NOT_FOUND':
          return { ...base, reason: 'not_found' }
        case 'PRECONDITION_FAILED':
          return { ...base, reason: 'conflict' }
        case 'ADDRESS_LIMIT_REACHED':
          return { ...base, reason: 'limit_reached' }
        case 'IDEMPOTENCY_CONFLICT':
          return { ...base, reason: 'idempotency_conflict' }
        default:
          return { ...base, reason: 'unavailable' }
      }
  }
}

async function call<T>(
  schema: z.ZodType<T>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  accessToken: string,
  options: { body?: unknown; version?: number; idempotencyKey?: string } = {},
): Promise<AddressCallResult<T>> {
  const result = await sendJson(method, path, {
    bearer: accessToken,
    body: options.body,
    ifMatch: options.version === undefined ? undefined : addressIfMatch(options.version),
    idempotencyKey: options.idempotencyKey,
  })
  if (!result.ok) return addressFailure(result)
  const parsed = schema.safeParse(result.data)
  if (!parsed.success) {
    console.warn('storefront_backend_malformed path=/v1/customer/addresses')
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  return { ok: true, data: parsed.data }
}

const idPath = (addressId: string) => {
  if (!isAddressId(addressId)) throw new Error('canonical address ids only')
  return `/v1/customer/addresses/${encodeURIComponent(addressId)}`
}

const one = addressBody.transform(toAddress)
const many = listBody.transform((b) => b.items.map(toAddress))

/** `GET /v1/customer/addresses` (default first). */
export const listAddresses = (accessToken: string) =>
  call(many, 'GET', '/v1/customer/addresses', accessToken)

/** `GET /v1/customer/addresses/{id}`: 404 for an id that is not the caller's. */
export const getAddress = (accessToken: string, addressId: string) =>
  call(one, 'GET', idPath(addressId), accessToken)

/**
 * `POST /v1/customer/addresses`. Optional fields that are empty are left out. Only the nine address fields and the
 * idempotency header are sent: no customer id, no coordinates.
 */
export const createAddress = (accessToken: string, fields: AddressFields, idempotencyKey: string) =>
  call(one, 'POST', '/v1/customer/addresses', accessToken, {
    body: {
      ...fields,
      addressLine2: fields.addressLine2 ?? undefined,
      landmark: fields.landmark ?? undefined,
    },
    idempotencyKey,
  })

/** `PATCH`: every editable field is sent (an emptied optional field as `null`, which clears it). */
export const updateAddress = (
  accessToken: string,
  addressId: string,
  version: number,
  fields: AddressFields,
) => call(one, 'PATCH', idPath(addressId), accessToken, { body: fields, version })

export const deleteAddress = (accessToken: string, addressId: string, version: number) =>
  call(z.undefined(), 'DELETE', idPath(addressId), accessToken, { version })

export const setDefaultAddress = (accessToken: string, addressId: string) =>
  call(one, 'PUT', `${idPath(addressId)}/default`, accessToken)
