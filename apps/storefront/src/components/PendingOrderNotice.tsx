'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useSyncExternalStore } from 'react'
import { clearPendingOrder, readPendingOrder, subscribePendingOrder } from '@/lib/pending-order'

/**
 * Shown on every page (for a signed-in customer) after an order attempt whose outcome the screen could not learn: the
 * order may exist, and the cart it emptied is no sign that it does not. It stays until the customer has looked at
 * Orders (visiting `/orders` clears it) or says they have checked. It lives in this tab's `sessionStorage`, so it
 * survives the lost response, a reload and navigation, and never reaches the server.
 */
export function PendingOrderNotice() {
  const pathname = usePathname()
  const pending = useSyncExternalStore(
    subscribePendingOrder,
    () => readPendingOrder() !== null,
    () => false,
  )
  useEffect(() => {
    if (pathname.startsWith('/orders')) clearPendingOrder()
  }, [pathname])
  if (!pending) return null
  return (
    <div className="notice pending-order" role="status" data-testid="pending-order">
      <p>
        An order you just tried to place may have gone through, but we could not confirm it.{' '}
        <Link href="/orders" data-testid="pending-order-link">
          Check your orders
        </Link>{' '}
        before ordering again.
      </p>
      <button type="button" className="link-button" onClick={clearPendingOrder}>
        I have checked
      </button>
    </div>
  )
}
