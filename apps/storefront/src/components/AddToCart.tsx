'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { postCart } from '@/components/CartView'
import { QuantityStepper } from '@/components/QuantityStepper'
import { cartErrorMessage, signInUrl } from '@/lib/cart/messages'
import { MAX_QUANTITY_PER_ITEM, lineNotes, type Cart } from '@/lib/cart/model'

interface Props {
  productId: string
  productName: string
  /** The session's CSRF token, or null when signed out (the control then leads to sign-in). */
  csrfToken: string | null
  /** The public product read's stock signal. It carries no location, so it is normally `UNKNOWN`. */
  stockState: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN'
}

/**
 * "Add to cart" on the product page. Signed out, it is a link to `/login` that returns here. Signed in, it posts to
 * `/api/cart/add` and reports what the BACKEND said about the line afterwards (its issues: out of stock, not enough
 * stock, ...), because the public product read has no location and so no stock answer of its own. A known
 * `OUT_OF_STOCK` disables the control up front.
 */
export function AddToCart({ productId, productName, csrfToken, stockState }: Props) {
  const router = useRouter()
  const [quantity, setQuantity] = useState(1)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  const inFlight = useRef(false)

  if (stockState === 'OUT_OF_STOCK') {
    return (
      <div className="add-to-cart">
        <p className="stock stock--out" data-testid="stock-state">
          Out of stock
        </p>
        <button type="button" className="button-primary" disabled>
          Add to cart
        </button>
      </div>
    )
  }
  if (csrfToken === null) {
    return (
      <div className="add-to-cart">
        <Link
          href={signInUrl(`/p/${encodeURIComponent(productId)}`)}
          className="button-primary"
          data-testid="add-signin"
        >
          Sign in to add to cart
        </Link>
      </div>
    )
  }
  const token = csrfToken

  async function add() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setAdded(false)
    setStatus('Adding to your cart…')
    const reply = await postCart('/api/cart/add', token, { productId, quantity })
    inFlight.current = false
    setBusy(false)
    if (reply.ok && reply.cart) {
      const line = (reply.cart as Cart).lines.find((l) => l.productId === productId)
      const note = line ? lineNotes(line).find((n) => n.tone === 'blocking') : undefined
      setAdded(true)
      setStatus(
        `Added ${quantity} to your cart. You now have ${line?.quantity ?? quantity}.${note ? ` ${note.text}` : ''}`,
      )
      router.refresh() // the header count
      return
    }
    setStatus('')
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl(`/p/${encodeURIComponent(productId)}`))
      return
    }
    setError(cartErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
  }

  return (
    <div className="add-to-cart">
      <QuantityStepper
        value={quantity}
        max={MAX_QUANTITY_PER_ITEM}
        label={productName}
        busy={busy}
        onChange={setQuantity}
      />
      <button
        type="button"
        className="button-primary"
        aria-disabled={busy}
        onClick={() => void add()}
      >
        {busy ? 'Adding…' : 'Add to cart'}
      </button>
      <p className="add-to-cart__status" role="status" aria-live="polite" data-testid="add-status">
        {status}
      </p>
      {added && (
        <p>
          <Link href="/cart">View cart</Link>
        </p>
      )}
      <p className="auth-error" role="alert" data-testid="add-error">
        {error}
      </p>
    </div>
  )
}
