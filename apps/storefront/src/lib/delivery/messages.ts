import { addressErrorMessage, type AddressError } from '@/lib/address/messages'

/** The closed set of outcomes of saving the delivery choice (address + slot). Client-safe. */
export type DeliveryError = AddressError | 'slot_unavailable' | 'unserviceable'

export function deliveryErrorMessage(error: string, retryAfterSeconds: number | null = null): string {
  switch (error) {
    case 'slot_unavailable':
      return 'That delivery slot is no longer available. Please choose another.'
    case 'unserviceable':
      return 'We do not deliver to that address yet. Choose another address.'
    case 'not_found':
      return 'That address is no longer available. Reload the page to see your saved addresses.'
    default:
      return addressErrorMessage(error, retryAfterSeconds)
  }
}
