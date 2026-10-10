import { normalisePhone } from '@/lib/auth/validation'
import { isAddressId, isIdempotencyKey, isPin } from '@/lib/location/validation'
import { ADDRESS_LABELS, type AddressFields, type AddressLabel } from '@/lib/address/model'

/**
 * Input grammar for a saved address, shared by the browser form (per-field feedback) and the BFF routes (the check
 * that counts). Mirrors the backend contract (tazzzo-backend `AddressService`, `AddressTexts`, `PostalCode`,
 * `RecipientPhone`, `AddressLabel`): label HOME/WORK/OTHER; name <= 80, line 1 <= 160, line 2 <= 160 (optional),
 * landmark <= 120 (optional), city <= 80, state <= 80 code points, trimmed, no control characters; a PIN
 * `^[1-9][0-9]{5}$`; an Indian mobile number (sent canonical). The backend validates again. Pure; no secrets.
 */
export const LIMITS = {
  recipientName: 80,
  addressLine1: 160,
  addressLine2: 160,
  landmark: 120,
  city: 80,
  state: 80,
} as const

export type FieldName = keyof AddressFields
export type FieldErrors = Partial<Record<FieldName, string>>

export const FIELD_NAMES: readonly FieldName[] = [
  'label',
  'recipientName',
  'recipientPhone',
  'addressLine1',
  'addressLine2',
  'landmark',
  'city',
  'state',
  'postalCode',
]

export const FIELD_TITLE: Record<FieldName, string> = {
  label: 'Address type',
  recipientName: 'Full name',
  recipientPhone: 'Mobile number',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  landmark: 'Landmark',
  city: 'City',
  state: 'State',
  postalCode: 'PIN code',
}

// Java `Character.isISOControl`: C0 and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

type Text = { ok: true; value: string | null } | { ok: false; message: string }

function text(raw: unknown, title: string, max: number, required: boolean): Text {
  if (raw === null || raw === undefined) {
    return required ? { ok: false, message: `${title} is required.` } : { ok: true, value: null }
  }
  if (typeof raw !== 'string') return { ok: false, message: `${title} is not valid.` }
  const value = raw.trim()
  if (value === '') {
    return required ? { ok: false, message: `${title} is required.` } : { ok: true, value: null }
  }
  if ([...value].length > max) {
    return { ok: false, message: `${title} can be at most ${max} characters.` }
  }
  if (CONTROL.test(value)) return { ok: false, message: `${title} has characters we cannot accept.` }
  return { ok: true, value }
}

export type AddressCheck =
  { ok: true; value: AddressFields } | { ok: false; errors: FieldErrors }

/** Checks one address as typed; the value is normalised (trimmed, empty optionals null, phone canonical). */
export function validateAddress(input: Record<string, unknown>): AddressCheck {
  const errors: FieldErrors = {}
  const out: Partial<AddressFields> = {}
  const label = input.label
  if (typeof label === 'string' && (ADDRESS_LABELS as readonly string[]).includes(label)) {
    out.label = label as AddressLabel
  } else errors.label = 'Choose Home, Work or Other.'
  const phone = normalisePhone(input.recipientPhone)
  if (phone === null) errors.recipientPhone = 'Enter a 10-digit Indian mobile number starting 6 to 9.'
  else out.recipientPhone = phone
  const postal = typeof input.postalCode === 'string' ? input.postalCode.trim() : null
  if (postal === null || !isPin(postal)) errors.postalCode = 'Enter a 6-digit PIN code (it does not start with 0).'
  else out.postalCode = postal
  const fields = [
    ['recipientName', true],
    ['addressLine1', true],
    ['addressLine2', false],
    ['landmark', false],
    ['city', true],
    ['state', true],
  ] as const
  for (const [name, required] of fields) {
    const result = text(input[name], FIELD_TITLE[name], LIMITS[name], required)
    if (!result.ok) errors[name] = result.message
    else if (name === 'addressLine2' || name === 'landmark') out[name] = result.value
    else out[name] = result.value as string
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: out as AddressFields }
}

type Body = Record<string, unknown>

/** Exactly these keys and no others: an unexpected field (a user id, coordinates, ...) is refused, not ignored. */
function exactly(body: Body, keys: readonly string[]): boolean {
  const present = Object.keys(body)
  return present.length === keys.length && keys.every((k) => present.includes(k))
}

export const isAddressVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10 ** 15

export interface CreateInput {
  idempotencyKey: string
  fields: AddressFields
}
export interface UpdateInput {
  addressId: string
  version: number
  fields: AddressFields
}

export function parseCreate(body: Body): CreateInput | null {
  if (!exactly(body, [...FIELD_NAMES, 'idempotencyKey'])) return null
  if (!isIdempotencyKey(body.idempotencyKey)) return null
  const checked = validateAddress(body)
  return checked.ok ? { idempotencyKey: body.idempotencyKey, fields: checked.value } : null
}

export function parseUpdate(body: Body): UpdateInput | null {
  if (!exactly(body, [...FIELD_NAMES, 'addressId', 'version'])) return null
  if (!isAddressId(body.addressId) || !isAddressVersion(body.version)) return null
  const checked = validateAddress(body)
  return checked.ok
    ? { addressId: body.addressId, version: body.version, fields: checked.value }
    : null
}

export function parseDelete(body: Body): { addressId: string; version: number } | null {
  if (!exactly(body, ['addressId', 'version'])) return null
  return isAddressId(body.addressId) && isAddressVersion(body.version)
    ? { addressId: body.addressId, version: body.version }
    : null
}

export function parseDefault(body: Body): { addressId: string } | null {
  if (!exactly(body, ['addressId'])) return null
  return isAddressId(body.addressId) ? { addressId: body.addressId } : null
}

/** The `If-Match` value for an address version (the backend's ETag form). */
export const addressIfMatch = (version: number): string => `"address-${version}"`
