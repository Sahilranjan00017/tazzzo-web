'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { LABEL_TEXT, type Address } from '@/lib/address/model'
import { addressErrorMessage } from '@/lib/address/messages'
import { signInUrl } from '@/lib/cart/messages'
import { postJson } from '@/lib/post-json'

/** The saved addresses with Edit, Set as default and a confirmed Delete. Results go to a live region, failures to an alert. */
export function AddressList({ addresses, csrfToken }: { addresses: Address[]; csrfToken: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)

  async function run(path: string, body: unknown, done: string) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setStatus('')
    const reply = await postJson(path, csrfToken, body)
    inFlight.current = false
    setBusy(false)
    setConfirming(null)
    if (reply.ok) {
      setStatus(done)
      router.refresh()
      heading.current?.focus()
      return
    }
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl('/account/addresses'))
      return
    }
    setError(addressErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    if (reply.error === 'conflict' || reply.error === 'not_found') router.refresh()
  }

  return (
    <section className="panel" aria-labelledby="addresses-title">
      <h1 id="addresses-title" ref={heading} tabIndex={-1}>
        Your addresses
      </h1>
      <p role="status" aria-live="polite" data-testid="address-status">
        {status}
      </p>
      <p className="field-error" role="alert" data-testid="address-error">
        {error}
      </p>
      {addresses.length === 0 ? (
        <p data-testid="address-empty">You have no saved addresses yet.</p>
      ) : (
        <ul className="address-list">
          {addresses.map((a) => {
            const name = `${LABEL_TEXT[a.label]} address, ${a.addressLine1}`
            return (
              <li key={a.addressId} className="address-card" data-testid="address-card">
                <p>
                  <strong>{LABEL_TEXT[a.label]}</strong>{' '}
                  {a.isDefault && <span className="badge">Default</span>}
                </p>
                <p>{a.recipientName}</p>
                <p>
                  {a.addressLine1}
                  {a.addressLine2 ? `, ${a.addressLine2}` : ''}
                  {a.landmark ? `, near ${a.landmark}` : ''}
                </p>
                <p>
                  {a.city}, {a.state} {a.postalCode}
                </p>
                <p>{a.recipientPhone}</p>
                {a.serviceable === false && (
                  <p className="field-error">We do not deliver to this PIN code yet.</p>
                )}
                <div className="address-card__actions">
                  <Link
                    href={`/account/addresses/${encodeURIComponent(a.addressId)}`}
                    aria-label={`Edit ${name}`}
                  >
                    Edit
                  </Link>
                  {!a.isDefault && (
                    <button
                      type="button"
                      aria-disabled={busy}
                      aria-label={`Make ${name} the default`}
                      onClick={() =>
                        !busy &&
                        void run(
                          '/api/addresses/default',
                          { addressId: a.addressId },
                          'Default address changed.',
                        )
                      }
                    >
                      Make default
                    </button>
                  )}
                  {confirming === a.addressId ? (
                    <>
                      <button
                        type="button"
                        aria-disabled={busy}
                        onClick={() =>
                          !busy &&
                          void run(
                            '/api/addresses/delete',
                            { addressId: a.addressId, version: a.version },
                            'Address deleted.',
                          )
                        }
                      >
                        Yes, delete {LABEL_TEXT[a.label]}
                      </button>
                      <button type="button" onClick={() => setConfirming(null)}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${name}`}
                      onClick={() => setConfirming(a.addressId)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p>
        <Link href="/account/addresses/new" className="button-link">
          Add an address
        </Link>
      </p>
    </section>
  )
}
