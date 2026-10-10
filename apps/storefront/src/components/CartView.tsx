'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { Price } from '@/components/Price'
import { QuantityStepper } from '@/components/QuantityStepper'
import { SafeImage } from '@/components/SafeImage'
import { cartErrorMessage, signInUrl } from '@/lib/cart/messages'
import {
  lineBlocked,
  lineMaxQuantity,
  lineNotes,
  unpricedCount,
  type Cart,
  type CartLine,
} from '@/lib/cart/model'
import { formatPaise } from '@/lib/format'

type Reply = { ok: boolean; error?: string; retryAfterSeconds?: number | null; cart?: Cart }

/** One cart mutation through the BFF with the session's CSRF token. Never throws. */
export async function postCart(path: string, csrfToken: string, body: unknown): Promise<Reply> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': csrfToken },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    return (await response.json()) as Reply
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

export function CartLineItem({
  line,
  busy,
  onQuantity,
  onRemove,
}: {
  line: CartLine
  busy: boolean
  onQuantity: (line: CartLine, quantity: number) => void
  onRemove: (line: CartLine) => void
}) {
  const name = line.title ?? 'This item'
  const notes = lineNotes(line)
  const blocked = lineBlocked(line)
  const href = `/p/${encodeURIComponent(line.productId)}`
  return (
    <li
      className={`cart-line${blocked ? ' cart-line--blocked' : ''}`}
      data-product-id={line.productId}
      data-blocked={blocked}
    >
      <div className="cart-line__media">
        {line.imageUrl ? (
          <SafeImage
            src={line.imageUrl}
            alt=""
            width={96}
            height={96}
            className="cart-line__image"
          />
        ) : (
          <ImagePlaceholder label="" className="cart-line__image" />
        )}
      </div>
      <div className="cart-line__body">
        <h2 className="cart-line__title">
          {line.title ? <Link href={href}>{line.title}</Link> : <span>{name}</span>}
        </h2>
        {line.brandCode && <p className="cart-line__meta">{line.brandCode}</p>}
        {line.unitPricePaise !== null ? (
          <Price sellingPaise={line.unitPricePaise} mrpPaise={line.mrpPaise} />
        ) : (
          <p className="cart-line__meta">Price unavailable</p>
        )}
        {notes.length > 0 && (
          <ul className="cart-line__notes">
            {notes.map((n) => (
              <li key={n.text} className={`cart-note cart-note--${n.tone}`}>
                <span className="visually-hidden">
                  {n.tone === 'blocking' ? 'Problem: ' : 'Note: '}
                </span>
                {n.text}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cart-line__controls">
        <QuantityStepper
          value={line.quantity}
          max={lineMaxQuantity(line)}
          label={name}
          busy={busy}
          onChange={(next) => onQuantity(line, next)}
        />
        <p className="cart-line__total">
          <span className="visually-hidden">Line total </span>
          {formatPaise(line.lineTotalPaise) ?? '—'}
        </p>
        <button
          type="button"
          className="link-button"
          aria-disabled={busy}
          aria-label={`Remove ${name} from cart`}
          onClick={() => {
            if (!busy) onRemove(line)
          }}
        >
          Remove
        </button>
      </div>
    </li>
  )
}

/**
 * The cart screen, from the cart the server rendered. Every change goes through `/api/cart/*` and the screen shows only
 * what the server answered (no optimistic state, so a failed change can never leave a wrong cart on screen); while a
 * change is in flight the controls ignore presses. A stale version (changed elsewhere) answers with the fresh cart,
 * which replaces the screen. Results are announced in a polite live region, failures in an alert.
 */
export function CartView({ initial, csrfToken }: { initial: Cart; csrfToken: string }) {
  const router = useRouter()
  const [cart, setCart] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [confirming, setConfirming] = useState(false)
  const inFlight = useRef(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)

  const restoreFocus = useRef(false)

  // Focus follows the swap between "Clear cart" and its confirmation, so a keyboard user never loses their place.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
    else if (restoreFocus.current) clearRef.current?.focus()
    restoreFocus.current = false
  }, [confirming])

  async function run(
    path: string,
    body: unknown,
    success: (next: Cart) => string,
    after?: () => void,
  ) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setStatus('Updating your cart…')
    const reply = await postCart(path, csrfToken, body)
    inFlight.current = false
    setBusy(false)
    if (reply.ok && reply.cart) {
      setCart(reply.cart)
      setStatus(success(reply.cart))
      after?.()
      router.refresh() // the header count
      return
    }
    setStatus('')
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl('/cart'))
      return
    }
    if (reply.cart) setCart(reply.cart)
    setError(cartErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    if (reply.cart) router.refresh()
  }

  const total = (next: Cart) => formatPaise(next.subtotalPaise) ?? ''

  function changeQuantity(line: CartLine, quantity: number) {
    void run(
      '/api/cart/update',
      { productId: line.productId, quantity, version: cart.version },
      (next) => `${line.title ?? 'Item'}: quantity ${quantity}. Subtotal ${total(next)}.`,
    )
  }
  function removeLine(line: CartLine) {
    void run(
      '/api/cart/remove',
      { productId: line.productId, version: cart.version },
      (next) =>
        `${line.title ?? 'Item'} removed. ${next.lines.length === 0 ? 'Your cart is empty.' : `Subtotal ${total(next)}.`}`,
      () => headingRef.current?.focus(),
    )
  }
  function clearAll() {
    setConfirming(false)
    void run(
      '/api/cart/clear',
      { version: cart.version },
      () => 'Your cart is empty.',
      () => headingRef.current?.focus(),
    )
  }

  const unpriced = unpricedCount(cart)
  const blocked = cart.lines.filter(lineBlocked).length
  return (
    <section className="cart" aria-labelledby="cart-title" data-cart-version={cart.version}>
      <h1 id="cart-title" tabIndex={-1} ref={headingRef}>
        Your cart
      </h1>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="cart-status">
        {status}
      </p>
      <p className="cart__error" role="alert" data-testid="cart-error">
        {error}
      </p>
      {cart.lines.length === 0 ? (
        <div className="cart-empty">
          <p>Your cart is empty.</p>
          <Link href="/" className="button-link">
            Continue shopping
          </Link>
        </div>
      ) : (
        <>
          {cart.freshness === 'REVALIDATE' && (
            <p className="notice" role="note">
              It has been a while since you changed your cart. Please check prices and availability.
            </p>
          )}
          {blocked > 0 && (
            <p className="notice" role="note" data-testid="cart-blocked">
              {blocked === 1 ? '1 item needs' : `${blocked} items need`} your attention before you
              can buy.
            </p>
          )}
          <ul className="cart-lines" aria-label="Items in your cart">
            {cart.lines.map((line) => (
              <CartLineItem
                key={line.productId}
                line={line}
                busy={busy}
                onQuantity={changeQuantity}
                onRemove={removeLine}
              />
            ))}
          </ul>
          <div className="cart-summary">
            <p className="cart-summary__row">
              <span>
                Subtotal ({cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'})
              </span>
              <strong data-testid="cart-subtotal">{formatPaise(cart.subtotalPaise) ?? '—'}</strong>
            </p>
            {unpriced > 0 && (
              <p className="cart-summary__hint">
                {unpriced === 1 ? '1 item has' : `${unpriced} items have`} no price right now and{' '}
                {unpriced === 1 ? 'is' : 'are'} not included.
              </p>
            )}
            <p className="cart-summary__hint">
              Delivery, fees and taxes are added at checkout. Prices can change until you pay.
            </p>
            {confirming ? (
              <div
                className="cart-summary__confirm"
                role="group"
                aria-label="Confirm clearing the cart"
              >
                <span>Remove all items?</span>
                <button
                  type="button"
                  className="link-button"
                  ref={confirmRef}
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) clearAll()
                  }}
                >
                  Yes, clear cart
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    restoreFocus.current = true
                    setConfirming(false)
                  }}
                >
                  Keep items
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="link-button"
                ref={clearRef}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) setConfirming(true)
                }}
              >
                Clear cart
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
