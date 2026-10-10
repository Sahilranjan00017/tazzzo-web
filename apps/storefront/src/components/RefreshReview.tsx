'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { signInUrl } from '@/lib/cart/messages'
import { hardNavigate } from '@/lib/navigate'
import { postJson } from '@/lib/post-json'

/**
 * The review page when its quote ended (it expired): a fresh review is one press away. The press asks the server to
 * start a new quote (`/api/checkout/refresh`: no backend call, nothing placed) and re-renders the page.
 */
export function RefreshReview({ csrfToken }: { csrfToken: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  async function refresh() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    const reply = await postJson('/api/checkout/refresh', csrfToken, {})
    if (reply.ok) {
      router.refresh()
      return
    }
    inFlight.current = false
    setBusy(false)
    if (reply.error === 'unauthenticated') {
      hardNavigate(signInUrl('/checkout'))
      return
    }
    if (reply.error === 'choice_changed') {
      hardNavigate('/checkout/delivery')
      return
    }
    setError('We could not refresh your review. Please try again.')
  }

  return (
    <section className="panel" aria-labelledby="checkout-title" aria-busy={busy}>
      <h1 id="checkout-title">Review your order</h1>
      <p role="status" data-testid="checkout-expired">
        Your order review expired. Nothing was ordered. Refresh it to see your current total.
      </p>
      <p className="field-error" role="alert">
        {error}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button-primary"
          aria-disabled={busy}
          data-testid="checkout-refresh"
          onClick={() => {
            if (!busy) void refresh()
          }}
        >
          {busy ? 'Refreshing…' : 'Refresh my review'}
        </button>
        <Link href="/cart">Back to cart</Link>
      </div>
    </section>
  )
}
