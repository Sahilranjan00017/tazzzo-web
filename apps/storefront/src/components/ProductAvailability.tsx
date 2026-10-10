import Link from 'next/link'
import type { DeliveryLocation } from '@/lib/location/model'
import type { StockSignal } from '@/lib/products'

/**
 * What the delivery location means for this product, in the backend's own words: stock only with a serviceable PIN
 * (the backend cannot say without one), and an invitation to choose a location otherwise. An out-of-stock product is
 * announced by `AddToCart` next to its disabled button, so it is not repeated here.
 */
export function ProductAvailability({
  location,
  pinUsed,
  stockState,
  lowStockRemaining,
}: {
  location: DeliveryLocation | null
  /** The PIN the product was read with (null when none was sent). */
  pinUsed: string | null
  stockState: StockSignal
  lowStockRemaining: number | null
}) {
  if (location === null) {
    return (
      <p className="availability" data-testid="availability">
        <Link href="/location">Choose your delivery location</Link> to see availability.
      </p>
    )
  }
  if (location.serviceable === false) {
    return (
      <p className="availability availability--no" data-testid="availability">
        We do not deliver to {location.pin} yet. <Link href="/location">Change location</Link>
      </p>
    )
  }
  if (pinUsed === null) {
    return (
      <p className="availability" data-testid="availability">
        We could not confirm delivery to {location.pin} just now.{' '}
        <Link href="/location">Check location</Link>
      </p>
    )
  }
  if (stockState === 'IN_STOCK') {
    return (
      <p className="availability availability--yes" data-testid="availability">
        In stock for delivery to {pinUsed}.
      </p>
    )
  }
  if (stockState === 'LOW_STOCK') {
    return (
      <p className="availability availability--yes" data-testid="availability">
        {lowStockRemaining ? `Only ${lowStockRemaining} left` : 'Low stock'} for delivery to{' '}
        {pinUsed}.
      </p>
    )
  }
  return null
}
