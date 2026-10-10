'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { Price } from '@/components/Price'
import { SafeImage } from '@/components/SafeImage'
import { LABEL_TEXT } from '@/lib/address/model'
import { signInUrl } from '@/lib/cart/messages'
import {
  PLACE_ACTION,
  isPlaceError,
  placeErrorMessage,
  type PlaceAction,
  type PlaceError,
} from '@/lib/checkout/messages'
import type { ReviewView } from '@/lib/checkout/model'
import { formatSlotDate } from '@/lib/delivery/slots'
import { formatPaise } from '@/lib/format'
import { hardNavigate } from '@/lib/navigate'
import { postJson } from '@/lib/post-json'

/**
 * The order review: the backend's quote for the cart as it is now, the address and slot chosen, Cash on Delivery,
 * and one "Place order" button. The screen shows only what the server rendered and sends only the quote it showed
 * (with the cart version, address and slot of that review, which the server checks against its own); it never sends or
 * computes a price. Pressing is ignored while a placement is in flight, and after a success the button stays disabled
 * until the confirmation page replaces this one, so a double click or a repeat can only ever ask for the same quote.
 * What happens next on a failure is the closed error's action: re-render the review (`refresh`), go back to the
 * delivery step (`delivery`), see Orders (`orders`) or press again (`retry`, same quote). Results are announced in a
 * polite live region, failures in an alert that takes focus.
 */
export function CheckoutReview({ view, csrfToken }: { view: ReviewView; csrfToken: string }) {
  const router = useRouter()
  const [placing, setPlacing] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [done, setDone] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<{ code: PlaceError; text: string } | null>(null)
  /** The total the customer last saw when a price change was reported, to say what it was and what it is now. */
  const [changedFrom, setChangedFrom] = useState<number | null>(null)
  const inFlight = useRef(false)
  const errorRef = useRef<HTMLDivElement>(null)
  const action: PlaceAction | null = error ? PLACE_ACTION[error.code] : null

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  async function place() {
    if (inFlight.current || done) return
    inFlight.current = true
    setPlacing(true)
    setError(null)
    setStatus('Placing your order…')
    const reply = await postJson<{ orderId?: unknown }>('/api/orders', csrfToken, {
      quoteId: view.quoteId,
      cartVersion: view.cartVersion,
      addressId: view.addressId,
      slotId: view.slotId,
    })
    const orderId = reply.data?.orderId
    if (reply.ok && typeof orderId === 'string' && /^ORD_[A-Za-z0-9_-]{6,64}$/.test(orderId)) {
      setDone(true)
      setStatus('Your order is placed. Opening the confirmation…')
      hardNavigate(`/orders/${encodeURIComponent(orderId)}?placed=1`)
      return
    }
    const code: PlaceError = isPlaceError(reply.error) ? reply.error : 'unavailable'
    setStatus('')
    if (code === 'unauthenticated') {
      hardNavigate(signInUrl('/checkout'))
      return
    }
    const next = PLACE_ACTION[code]
    setError({ code, text: placeErrorMessage(code, reply.retryAfterSeconds ?? null) })
    if (code === 'price_changed') setChangedFrom(view.payablePaise ?? view.subtotalPaise)
    inFlight.current = false
    setPlacing(false)
    // The page renders again with the backend's current quote; the button stays off until it has arrived.
    if (next === 'refresh') startRefresh(() => router.refresh())
  }

  const total = view.payablePaise ?? view.subtotalPaise
  const totalText = formatPaise(total) ?? ''
  const changed = changedFrom !== null && changedFrom !== total
  const stopped = action === 'delivery' || action === 'orders'
  const busy = placing || refreshing
  const disabled = busy || done || stopped
  const a = view.address
  return (
    <section
      className="checkout"
      aria-labelledby="checkout-title"
      aria-busy={busy}
      data-quote-id={view.quoteId}
    >
      <h1 id="checkout-title">Review your order</h1>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="checkout-status">
        {status}
      </p>
      <div
        className="checkout__error"
        role="alert"
        tabIndex={-1}
        ref={errorRef}
        data-testid="checkout-error"
      >
        {error?.text}
      </div>
      {error && action === 'delivery' && (
        <p>
          <Link
            href="/checkout/delivery"
            className="button-link"
            data-testid="checkout-to-delivery"
          >
            Choose delivery address and slot
          </Link>
        </p>
      )}
      {error && (action === 'orders' || error.code === 'unknown') && (
        <p>
          <Link href="/orders" data-testid="checkout-to-orders">
            Check your orders
          </Link>
        </p>
      )}
      {changed && (
        <p className="notice" role="note" data-testid="checkout-changed">
          The total changed from {formatPaise(changedFrom) ?? ''} to {totalText}. Your order is not
          placed until you confirm the new total.
        </p>
      )}

      <h2>Items</h2>
      <ul className="checkout-lines" aria-label="Items in your order">
        {view.lines.map((line) => (
          <li key={line.productId} className="checkout-line" data-product-id={line.productId}>
            <div className="checkout-line__media">
              {line.imageUrl ? (
                <SafeImage
                  src={line.imageUrl}
                  alt=""
                  width={64}
                  height={64}
                  className="cart-line__image"
                />
              ) : (
                <ImagePlaceholder label="" className="cart-line__image" />
              )}
            </div>
            <div className="checkout-line__body">
              <p className="checkout-line__title">{line.title ?? 'This item'}</p>
              <Price sellingPaise={line.unitPricePaise} mrpPaise={line.mrpPaise} />
              <p className="cart-line__meta">Quantity {line.quantity}</p>
            </div>
            <p className="checkout-line__total">
              <span className="visually-hidden">Line total </span>
              {formatPaise(line.lineTotalPaise) ?? '—'}
            </p>
          </li>
        ))}
      </ul>

      <div className="checkout-grid">
        <div className="panel" data-testid="checkout-address">
          <h2>Deliver to</h2>
          <p>
            <strong>{a.recipientName}</strong> ({LABEL_TEXT[a.label]})
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
        <div className="panel" data-testid="checkout-slot">
          <h2>Delivery slot</h2>
          <p>
            <strong>{formatSlotDate(view.slot.date)}</strong>
          </p>
          <p>
            {view.slot.label}
            {view.slot.window ? `, ${view.slot.window}` : ''}
          </p>
          <p>
            <Link href="/checkout/delivery">Change address or slot</Link>
          </p>
        </div>
      </div>

      <div className="panel" data-testid="checkout-payment">
        <h2>Payment</h2>
        <p>
          <strong>Cash on delivery.</strong> Pay when your order arrives.
        </p>
      </div>

      <div className="cart-summary" data-testid="checkout-totals">
        <p className="cart-summary__row">
          <span>
            Subtotal ({view.itemCount} {view.itemCount === 1 ? 'item' : 'items'})
          </span>
          <span data-testid="checkout-subtotal">{formatPaise(view.subtotalPaise) ?? '—'}</span>
        </p>
        {view.discountPaise > 0 && (
          <p className="cart-summary__row">
            <span>Discount</span>
            <span data-testid="checkout-discount">−{formatPaise(view.discountPaise) ?? ''}</span>
          </p>
        )}
        <p className="cart-summary__row">
          <span>{view.payablePaise === null ? 'Total' : 'To pay on delivery'}</span>
          <strong data-testid="checkout-total">{totalText || '—'}</strong>
        </p>
        <p className="cart-summary__hint">
          This is your total for these items. It can change if a price changes before you place the
          order; you will see the new total and be asked to confirm it.
        </p>
        <button
          type="button"
          className="button-primary checkout__place"
          aria-disabled={disabled}
          data-testid="checkout-place"
          onClick={() => {
            if (!disabled) void place()
          }}
        >
          {placing
            ? 'Placing order…'
            : changed
              ? `Confirm ${totalText} and place order`
              : `Place order · ${totalText}`}
        </button>
        <p className="cart-summary__hint">
          <Link href="/cart">Back to cart</Link>
        </p>
      </div>
    </section>
  )
}
