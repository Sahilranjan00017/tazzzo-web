'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent } from 'react'
import { LABEL_TEXT, type Address } from '@/lib/address/model'
import { locationErrorMessage } from '@/lib/location/messages'
import type { DeliveryLocation } from '@/lib/location/model'
import { PIN_HINT, normalisePin } from '@/lib/location/validation'
import { postJson } from '@/lib/post-json'
import { signInUrl } from '@/lib/cart/messages'

interface Props {
  /** The location stored in this browser, or null. */
  initial: DeliveryLocation | null
  /** The session's CSRF token; null when signed out (the literal `1` is then sent). */
  csrfToken: string | null
  /** The signed-in customer's saved addresses (null: signed out, or they could not be loaded). */
  addresses: Address[] | null
  /** The saved address that is the delivery location now, if any. */
  selectedAddressId: string | null
  /** Already reduced to a same-origin path by the page. */
  next: string
}

function resultText(location: DeliveryLocation): string {
  if (location.serviceable === true) return `Good news: we deliver to ${location.pin}.`
  if (location.serviceable === false) {
    return `Sorry, we do not deliver to ${location.pin} yet. You can still browse, but items cannot be delivered there.`
  }
  return `We could not tell whether we deliver to ${location.pin}. Try again in a moment.`
}

/** PIN code check (any visitor) and, signed in, a choice among saved addresses. Errors are announced; all of it works by keyboard. */
export function LocationForm({ initial, csrfToken, addresses, selectedAddressId, next }: Props) {
  const router = useRouter()
  const [pin, setPin] = useState(initial?.viaAddress ? '' : (initial?.pin ?? ''))
  const [current, setCurrent] = useState<DeliveryLocation | null>(initial)
  const [selected, setSelected] = useState<string | null>(selectedAddressId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const inFlight = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const token = csrfToken ?? '1'

  async function submitPin(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    setStatus(null)
    const canonical = normalisePin(pin)
    if (canonical === null) {
      setError(PIN_HINT)
      input.current?.focus()
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    setStatus('Checking…')
    const reply = await postJson<DeliveryLocation>('/api/location', token, { pin: canonical })
    inFlight.current = false
    setBusy(false)
    if (reply.ok && reply.data) {
      setCurrent(reply.data)
      setSelected(null)
      setStatus(resultText(reply.data))
      router.refresh() // the header chip and every price and stock that depends on it
      return
    }
    setStatus(null)
    setError(locationErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    if (reply.error === 'invalid_pin') input.current?.focus()
  }

  async function chooseAddress(address: Address) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setStatus('Saving…')
    const reply = await postJson<DeliveryLocation>('/api/location', token, {
      addressId: address.addressId,
    })
    inFlight.current = false
    setBusy(false)
    if (reply.ok && reply.data) {
      setCurrent(reply.data)
      setSelected(address.addressId)
      setStatus(
        `Delivering to your ${LABEL_TEXT[address.label]} address. ${resultText(reply.data)}`,
      )
      router.refresh()
      return
    }
    setStatus(null)
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl('/location'))
      return
    }
    setError(locationErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
  }

  return (
    <section className="panel" aria-labelledby="location-title">
      <h1 id="location-title">Delivery location</h1>
      <p data-testid="location-current">
        {current === null
          ? 'No delivery location chosen yet.'
          : current.serviceable === false
            ? `Not delivering to ${current.pin} yet.`
            : `Delivering to ${current.pin}${current.viaAddress ? ' (a saved address)' : ''}.`}
      </p>
      <form onSubmit={(e) => void submitPin(e)} noValidate aria-busy={busy}>
        <label htmlFor="location-pin">PIN code</label>
        <input
          id="location-pin"
          ref={input}
          name="pin"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={12}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          aria-invalid={error !== null && status === null}
          aria-describedby="location-hint location-error"
        />
        <p id="location-hint" className="auth-hint">
          We check whether we deliver there and show what is in stock for it.
        </p>
        <div className="actions">
          <button type="submit" className="button-primary" aria-disabled={busy}>
            {busy ? 'Checking…' : 'Check PIN code'}
          </button>
          {current?.serviceable === true && (
            <Link href={next} className="button-link" data-testid="location-continue">
              Continue shopping
            </Link>
          )}
        </div>
      </form>
      <div aria-live="polite" aria-atomic="true">
        {status && (
          <p
            id="location-status"
            data-testid="location-status"
            className={current?.serviceable === false ? 'field-error' : 'auth-status'}
          >
            {status}
          </p>
        )}
      </div>
      <p id="location-error" className="field-error" role="alert" data-testid="location-error">
        {error}
      </p>

      {addresses !== null && (
        <section aria-labelledby="location-addresses">
          <h2 id="location-addresses">Or deliver to a saved address</h2>
          {addresses.length === 0 ? (
            <p>
              You have no saved addresses. <Link href="/account/addresses/new">Add an address</Link>
            </p>
          ) : (
            <ul className="address-list">
              {addresses.map((a) => (
                <li key={a.addressId} className="address-card" data-testid="location-address">
                  <p>
                    <strong>{LABEL_TEXT[a.label]}</strong>{' '}
                    {a.isDefault && <span className="badge">Default</span>}
                  </p>
                  <p>
                    {a.addressLine1}, {a.city} {a.postalCode}
                  </p>
                  {a.serviceable === false && (
                    <p className="field-error">We do not deliver to this PIN code yet.</p>
                  )}
                  <button
                    type="button"
                    aria-disabled={busy || selected === a.addressId}
                    aria-pressed={selected === a.addressId}
                    onClick={() => selected !== a.addressId && void chooseAddress(a)}
                  >
                    {selected === a.addressId ? 'Delivering here' : 'Deliver here'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {addresses === null && csrfToken === null && (
        <p>
          <Link href={signInUrl('/location')}>Sign in</Link> to deliver to a saved address.
        </p>
      )}
    </section>
  )
}
