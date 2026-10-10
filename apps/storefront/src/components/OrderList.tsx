import Link from 'next/link'
import { formatSlotDate } from '@/lib/delivery/slots'
import { formatPaise } from '@/lib/format'
import { STATUS_TEXT, formatInstant, slotDate, type OrderPage } from '@/lib/orders/model'

/**
 * The order history, newest first, one link per order. Paging is the backend's cursor: "Older orders" follows
 * `nextCursor`; the cursor only moves forward, so a page after the first offers a way back to the newest.
 */
export function OrderList({ page, first }: { page: OrderPage; first: boolean }) {
  return (
    <section className="orders" aria-labelledby="orders-title">
      <h1 id="orders-title">Your orders</h1>
      {page.orders.length === 0 ? (
        <div className="cart-empty" data-testid="orders-empty">
          <p>{first ? 'You have not placed any orders yet.' : 'There are no more orders.'}</p>
          <Link href={first ? '/' : '/orders'} className="button-link">
            {first ? 'Start shopping' : 'Back to your newest orders'}
          </Link>
        </div>
      ) : (
        <ol className="order-list" aria-label="Orders, newest first">
          {page.orders.map((o) => {
            const day = o.slot ? slotDate(o.slot.slotId) : null
            const amount = o.payablePaise ?? o.subtotalPaise
            return (
              <li key={o.orderId} className="order-card" data-order-id={o.orderId}>
                <p className="order-card__top">
                  <Link href={`/orders/${encodeURIComponent(o.orderId)}`} data-testid="order-link">
                    Order placed {formatInstant(o.createdAt)}
                  </Link>
                  <span className="badge" data-status={o.status}>
                    {STATUS_TEXT[o.status]}
                  </span>
                </p>
                <p className="cart-line__meta">
                  {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} ·{' '}
                  {formatPaise(amount) ?? '—'}
                </p>
                {o.slot && (
                  <p className="cart-line__meta">
                    Delivery {day ? `${formatSlotDate(day)}, ` : ''}
                    {o.slot.label}
                  </p>
                )}
                <p className="cart-line__meta">{o.orderId}</p>
              </li>
            )
          })}
        </ol>
      )}
      <nav className="pager" aria-label="Order pages">
        {!first && page.orders.length > 0 && <Link href="/orders">Newest orders</Link>}
        {page.nextCursor && (
          <Link
            href={`/orders?cursor=${encodeURIComponent(page.nextCursor)}`}
            data-testid="orders-older"
            rel="next"
          >
            Older orders
          </Link>
        )}
      </nav>
    </section>
  )
}
