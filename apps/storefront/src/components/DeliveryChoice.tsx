'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { LABEL_TEXT, type Address } from '@/lib/address/model'
import { signInUrl } from '@/lib/cart/messages'
import { deliveryErrorMessage } from '@/lib/delivery/messages'
import type { SlotsView } from '@/lib/delivery/slots'
import { postJson } from '@/lib/post-json'
import { SlotPicker } from '@/components/SlotPicker'

/**
 * The delivery step: pick a saved address (changing it reloads the slots for its PIN), pick a slot, and keep the
 * choice for the order step. Nothing is ordered or reserved here.
 */
export function DeliveryChoice({
  addresses,
  addressId,
  slots,
  slotsError,
  savedSlotId,
  csrfToken,
}: {
  addresses: Address[]
  /** The address whose slots are shown. */
  addressId: string | null
  slots: SlotsView | null
  /** The slots could not be loaded (shown as an alert). */
  slotsError: boolean
  /** The slot kept earlier for this address, if still offered. */
  savedSlotId: string | null
  csrfToken: string
}) {
  const router = useRouter()
  const [slot, setSlot] = useState<string | null>(savedSlotId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const inFlight = useRef(false)

  async function save() {
    if (inFlight.current || addressId === null) return
    if (slot === null) {
      setError('Choose a delivery slot.')
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    setSaved(false)
    const reply = await postJson('/api/checkout/delivery', csrfToken, { addressId, slotId: slot })
    inFlight.current = false
    setBusy(false)
    if (reply.ok) {
      setSaved(true)
      return
    }
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl('/checkout/delivery'))
      return
    }
    setError(deliveryErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    if (reply.error === 'slot_unavailable' || reply.error === 'not_found') {
      setSlot(null)
      router.refresh()
    }
  }

  if (addresses.length === 0) {
    return (
      <section className="panel">
        <h1>Delivery</h1>
        <p data-testid="delivery-no-address">
          Add a delivery address to see the available delivery slots.
        </p>
        <Link href="/account/addresses/new" className="button-link">
          Add an address
        </Link>
      </section>
    )
  }
  return (
    <section className="panel" aria-labelledby="delivery-title">
      <h1 id="delivery-title">Delivery</h1>
      <fieldset>
        <legend>Deliver to</legend>
        {addresses.map((a) => (
          <label key={a.addressId} className="slot-option" data-testid="delivery-address">
            <input
              type="radio"
              name="delivery-address"
              value={a.addressId}
              checked={a.addressId === addressId}
              onChange={() =>
                router.push(`/checkout/delivery?address=${encodeURIComponent(a.addressId)}`)
              }
            />
            <span className="slot-option__label">
              {LABEL_TEXT[a.label]}
              {a.isDefault ? ' (default)' : ''}
            </span>
            <span className="slot-option__note">
              {a.addressLine1}, {a.city} {a.postalCode}
            </span>
          </label>
        ))}
      </fieldset>
      {slotsError && (
        <p role="alert" data-testid="slots-error">
          We could not load delivery slots right now. Please try again in a moment.
        </p>
      )}
      {slots && <SlotPicker view={slots} value={slot} onChange={setSlot} />}
      <p className="field-error" role="alert" data-testid="delivery-error">
        {error}
      </p>
      <p role="status" aria-live="polite" data-testid="delivery-saved">
        {saved ? 'Your delivery address and slot are saved for the next step.' : ''}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button-primary"
          aria-disabled={busy || !slots?.serviceable}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save delivery choice'}
        </button>
        <Link href="/cart">Back to cart</Link>
      </div>
    </section>
  )
}
