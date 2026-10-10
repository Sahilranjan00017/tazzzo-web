/**
 * A saved delivery address as the storefront models it (tazzzo-backend `AddressResponseDto`). `serviceable` is the
 * backend's three-state answer for the address's PIN: true, false, or null when it could not tell (never collapsed).
 * Pure; client-safe.
 */
export const ADDRESS_LABELS = ['HOME', 'WORK', 'OTHER'] as const
export type AddressLabel = (typeof ADDRESS_LABELS)[number]

export const LABEL_TEXT: Record<AddressLabel, string> = {
  HOME: 'Home',
  WORK: 'Work',
  OTHER: 'Other',
}

export interface AddressFields {
  label: AddressLabel
  recipientName: string
  /** Canonical `+91XXXXXXXXXX`. */
  recipientPhone: string
  addressLine1: string
  addressLine2: string | null
  landmark: string | null
  city: string
  state: string
  postalCode: string
}

export interface Address extends AddressFields {
  addressId: string
  isDefault: boolean
  /** The optimistic-concurrency version: edit and delete must present the one they last saw. */
  version: number
  serviceable: boolean | null
}
