'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { signInUrl } from '@/lib/cart/messages'
import { orderErrorMessage } from '@/lib/orders/messages'
import { CANCEL_REASONS, CANCEL_REASON_TEXT, isCancelReason } from '@/lib/orders/model'
import { hardNavigate } from '@/lib/navigate'
import { postJson } from '@/lib/post-json'

/**
 * Cancel one confirmed order. Offered only where the deployment says the backend allows it (see `cancelOffered`); the
 * backend decides every request, and a refusal (the window closed, the order moved on) is shown, never hidden.
 * Two steps (a button, then a reason and an explicit confirmation) so a stray press cancels nothing; focus follows the
 * swap and the result is announced.
 */
export function CancelOrder({ orderId, csrfToken }: { orderId: string; csrfToken: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const inFlight = useRef(false)
  const openRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLSelectElement>(null)
  const restoreFocus = useRef(false)

  useEffect(() => {
    if (open) reasonRef.current?.focus()
    else if (restoreFocus.current) openRef.current?.focus()
    restoreFocus.current = false
  }, [open])

  async function cancel() {
    if (inFlight.current) return
    if (!isCancelReason(reason)) {
      setError('Choose a reason.')
      reasonRef.current?.focus()
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    setStatus('Cancelling your order…')
    const reply = await postJson('/api/orders/cancel', csrfToken, { orderId, reason })
    inFlight.current = false
    setBusy(false)
    if (reply.ok) {
      setStatus('Your order is cancelled.')
      setOpen(false)
      startRefresh(() => router.refresh())
      return
    }
    setStatus('')
    if (reply.error === 'unauthenticated') {
      hardNavigate(signInUrl(`/orders/${orderId}`))
      return
    }
    setError(orderErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    // The order moved on elsewhere: show it as it is now.
    if (reply.error === 'not_cancellable' || reply.error === 'window_closed') {
      startRefresh(() => router.refresh())
    }
  }

  return (
    <div className="cancel-order" aria-busy={busy || refreshing}>
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="cancel-status">
        {status}
      </p>
      <p className="field-error" role="alert" data-testid="cancel-error">
        {error}
      </p>
      {open ? (
        <div role="group" aria-label="Cancel this order" className="cancel-order__form">
          <label htmlFor="cancel-reason">Reason</label>
          <select
            id="cancel-reason"
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Choose a reason</option>
            {CANCEL_REASONS.map((r) => (
              <option key={r} value={r}>
                {CANCEL_REASON_TEXT[r]}
              </option>
            ))}
          </select>
          <div className="actions">
            <button
              type="button"
              className="button-primary"
              aria-disabled={busy}
              data-testid="cancel-confirm"
              onClick={() => {
                if (!busy) void cancel()
              }}
            >
              {busy ? 'Cancelling…' : 'Yes, cancel this order'}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                restoreFocus.current = true
                setError(null)
                setOpen(false)
              }}
            >
              Keep my order
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="link-button"
          ref={openRef}
          data-testid="cancel-open"
          onClick={() => setOpen(true)}
        >
          Cancel order
        </button>
      )}
    </div>
  )
}
