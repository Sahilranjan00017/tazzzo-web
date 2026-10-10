/**
 * The delivery location the site works with. Only what the backend contract needs travels in the (sealed) cookie: the
 * PIN (the one location form `/v1/serviceability`, product, search and list reads resolve), whether the backend said
 * it is serviceable, and, for a signed-in customer who picked a saved address, that address's id (the ONE location the
 * cart accepts: `?addressId=`) together with the customer id it belongs to. Pure; client-safe.
 */
export interface DeliveryLocation {
  pin: string
  /** The backend's answer when it was last asked: true, false, or null when it could not tell. */
  serviceable: boolean | null
  /** Whether a saved address (not just a PIN) is the delivery location. */
  viaAddress: boolean
}

export function locationChipText(location: DeliveryLocation | null): string {
  if (location === null) return 'Set delivery location'
  if (location.serviceable === false) return `Not delivering to ${location.pin}`
  return `Deliver to ${location.pin}`
}
