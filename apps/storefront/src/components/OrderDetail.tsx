import Link from 'next/link'
import { CancelOrder } from '@/components/CancelOrder'
import { FocusOnMount } from '@/components/FocusOnMount'
import { formatSlotDate, formatWindow } from '@/lib/delivery/slots'
import { formatPaise } from '@/lib/format'
import { STATUS_TEXT, formatInstant, slotDate, type Order } from '@/lib/orders/model'

/**
 * One order, entirely from the order's own stored snapshot (what the backend returns; nothing is recomputed or looked
 * up again): status, items, the money it settled on, the address and delivery slot as they were when it was placed.
 * `placed`: the page the customer lands on right after placing it, which says so and takes focus.
 */
export function OrderDetail({
  order,
  placed,
  cancelOffered,
  csrfToken,
}: {
  order: Order
  placed: boolean
  cancelOffered: boolean
  csrfToken: string
}) {
  const a = order.address
  const cancelled = order.status === 'CANCELLED'
  const slotDay = order.slot ? slotDate(order.slot.slotId) : null
  const payable = order.money?.payablePaise ?? null
  return (
    <section className="order" aria-labelledby="order-title" data-order-id={order.orderId}>
      {placed && !cancelled ? (
        <>
          <FocusOnMount id="order-title">Thank you, your order is placed</FocusOnMount>
          <p role="status" data-testid="order-placed">
            Your order is confirmed.{' '}
            {payable !== null
              ? `Please keep ${formatPaise(payable) ?? ''} ready to pay in cash when it arrives.`
              : 'You pay in cash when it arrives.'}
          </p>
        </>
      ) : (
        <h1 id="order-title">Your order</h1>
      )}
      <p className="order__meta">
        <span className="badge" data-testid="order-status" data-status={order.status}>
          {STATUS_TEXT[order.status]}
        </span>{' '}
        <span data-testid="order-id">Order {order.orderId}</span>
      </p>
      <ul className="order__times">
        <li>Placed {formatInstant(order.createdAt)}</li>
        {order.outForDeliveryAt && (
          <li>Out for delivery {formatInstant(order.outForDeliveryAt)}</li>
        )}
        {order.deliveredAt && <li>Delivered {formatInstant(order.deliveredAt)}</li>}
        {order.cancelledAt && <li>Cancelled {formatInstant(order.cancelledAt)}</li>}
      </ul>

      <h2>Items</h2>
      <ul className="checkout-lines" aria-label="Items in this order">
        {order.lines.map((line) => (
          <li key={line.productId} className="order-line" data-product-id={line.productId}>
            <div className="checkout-line__body">
              <p className="checkout-line__title">
                <Link href={`/p/${encodeURIComponent(line.productId)}`}>
                  {line.title ?? line.productId}
                </Link>
              </p>
              {line.brandCode && <p className="cart-line__meta">{line.brandCode}</p>}
              <p className="cart-line__meta">
                {line.quantity} × {formatPaise(line.unitPricePaise) ?? '—'}
              </p>
            </div>
            <p className="checkout-line__total">
              <span className="visually-hidden">Line total </span>
              {formatPaise(line.lineTotalPaise) ?? '—'}
            </p>
          </li>
        ))}
      </ul>

      <div className="cart-summary" data-testid="order-totals">
        <p className="cart-summary__row">
          <span>
            Subtotal ({order.itemCount} {order.itemCount === 1 ? 'item' : 'items'})
          </span>
          <span data-testid="order-subtotal">{formatPaise(order.subtotalPaise) ?? '—'}</span>
        </p>
        {order.money && order.money.benefitDiscountPaise > 0 && (
          <p className="cart-summary__row">
            <span>Discount</span>
            <span data-testid="order-discount">
              −{formatPaise(order.money.benefitDiscountPaise) ?? ''}
            </span>
          </p>
        )}
        {payable !== null ? (
          <p className="cart-summary__row">
            <span>{cancelled ? 'Total' : 'To pay on delivery'}</span>
            <strong data-testid="order-total">{formatPaise(payable) ?? '—'}</strong>
          </p>
        ) : (
          <p className="cart-summary__hint">The amount payable is not available for this order.</p>
        )}
        <p className="cart-summary__hint" data-testid="order-payment">
          Payment: {order.paymentMethod === 'COD' ? 'Cash on delivery' : 'Pay on delivery'}
          {cancelled ? '. Nothing is due.' : ''}
        </p>
      </div>

      <div className="checkout-grid">
        <div className="panel" data-testid="order-address">
          <h2>Delivering to</h2>
          <p>
            <strong>{a.recipientName}</strong>
            {a.label ? ` (${a.label})` : ''}
          </p>
          <p>
            {a.addressLine1}
            {a.addressLine2 ? `, ${a.addressLine2}` : ''}
            {a.landmark ? `, near ${a.landmark}` : ''}
          </p>
          <p>
            {a.city}, {a.state} {a.postalCode}
          </p>
          <p>{a.recipientPhone}</p>
        </div>
        <div className="panel" data-testid="order-slot">
          <h2>Delivery slot</h2>
          {order.slot ? (
            <>
              {slotDay && (
                <p>
                  <strong>{formatSlotDate(slotDay)}</strong>
                </p>
              )}
              <p>
                {order.slot.label}
                {formatWindow(order.slot) ? `, ${formatWindow(order.slot)}` : ''}
              </p>
            </>
          ) : (
            <p>No delivery slot was chosen for this order.</p>
          )}
        </div>
      </div>

      {cancelOffered && <CancelOrder orderId={order.orderId} csrfToken={csrfToken} />}
      <p>
        <Link href="/orders">All your orders</Link>
      </p>
    </section>
  )
}
