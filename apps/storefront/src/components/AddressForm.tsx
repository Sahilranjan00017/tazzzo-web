'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, type FormEvent } from 'react'
import { ADDRESS_LABELS, LABEL_TEXT, type Address, type AddressFields } from '@/lib/address/model'
import { addressErrorMessage } from '@/lib/address/messages'
import {
  FIELD_NAMES,
  FIELD_TITLE,
  LIMITS,
  validateAddress,
  type FieldErrors,
  type FieldName,
} from '@/lib/address/validation'
import { postJson } from '@/lib/post-json'
import { signInUrl } from '@/lib/cart/messages'

type Values = Record<FieldName, string>

const EMPTY: Values = {
  label: 'HOME',
  recipientName: '',
  recipientPhone: '',
  addressLine1: '',
  addressLine2: '',
  landmark: '',
  city: '',
  state: '',
  postalCode: '',
}

const AUTOCOMPLETE: Record<FieldName, string> = {
  label: 'off',
  recipientName: 'name',
  recipientPhone: 'tel-national',
  addressLine1: 'address-line1',
  addressLine2: 'address-line2',
  landmark: 'off',
  city: 'address-level2',
  state: 'address-level1',
  postalCode: 'postal-code',
}

const OPTIONAL: readonly FieldName[] = ['addressLine2', 'landmark']

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

function valuesOf(address: Address | null): Values {
  if (address === null) return EMPTY
  return {
    label: address.label,
    recipientName: address.recipientName,
    recipientPhone: address.recipientPhone.replace(/^\+91/, ''),
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? '',
    landmark: address.landmark ?? '',
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
  }
}

/**
 * Create or edit a saved address. Every field has a visible label and its own error, announced (`role="alert"`),
 * with focus moved to the first invalid field. The same grammar the server enforces is checked first for quick
 * feedback; the server and the backend check again. A create carries an idempotency key that is reused only while
 * the form is unchanged, so retrying a save after a lost reply never creates a second address.
 */
export function AddressForm({
  address,
  csrfToken,
}: {
  /** The address being edited, or null to create one. */
  address: Address | null
  csrfToken: string
}) {
  const router = useRouter()
  const [values, setValues] = useState<Values>(() => valuesOf(address))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)
  const refs = useRef<Partial<Record<FieldName, HTMLInputElement | HTMLSelectElement | null>>>({})

  const set = (name: FieldName) => (value: string) => setValues((v) => ({ ...v, [name]: value }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    setFormError(null)
    const checked = validateAddress(values)
    if (!checked.ok) {
      setErrors(checked.errors)
      refs.current[FIELD_NAMES.find((n) => checked.errors[n]) ?? 'label']?.focus()
      return
    }
    setErrors({})
    const fields: AddressFields = checked.value
    inFlight.current = true
    setBusy(true)
    let reply
    if (address === null) {
      const fingerprint = JSON.stringify(fields)
      if (attempt.current?.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: newKey() }
      }
      reply = await postJson('/api/addresses', csrfToken, {
        ...fields,
        idempotencyKey: attempt.current.key,
      })
    } else {
      reply = await postJson('/api/addresses/update', csrfToken, {
        ...fields,
        addressId: address.addressId,
        version: address.version,
      })
    }
    inFlight.current = false
    setBusy(false)
    if (reply.ok) {
      attempt.current = null
      router.push('/account/addresses')
      router.refresh()
      return
    }
    if (reply.error === 'unauthenticated') {
      window.location.assign(signInUrl('/account/addresses'))
      return
    }
    setFormError(addressErrorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    // A stale edit or a vanished address: show the fresh data.
    if (reply.error === 'conflict' || reply.error === 'not_found') router.refresh()
  }

  const field = (name: FieldName) => {
    const id = `address-${name}`
    const error = errors[name]
    const common = {
      id,
      name,
      value: values[name],
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? `${id}-error` : undefined,
      'aria-required': OPTIONAL.includes(name) ? undefined : true,
    }
    return (
      <div key={name}>
        <label htmlFor={id}>
          {FIELD_TITLE[name]}
          {OPTIONAL.includes(name) ? ' (optional)' : ''}
        </label>
        {name === 'label' ? (
          <select
            {...common}
            ref={(el) => {
              refs.current[name] = el
            }}
            onChange={(e) => set(name)(e.target.value)}
          >
            {ADDRESS_LABELS.map((l) => (
              <option key={l} value={l}>
                {LABEL_TEXT[l]}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...common}
            ref={(el) => {
              refs.current[name] = el
            }}
            type={name === 'recipientPhone' ? 'tel' : 'text'}
            inputMode={name === 'postalCode' || name === 'recipientPhone' ? 'numeric' : undefined}
            autoComplete={AUTOCOMPLETE[name]}
            maxLength={name in LIMITS ? LIMITS[name as keyof typeof LIMITS] * 2 : 20}
            onChange={(e) => set(name)(e.target.value)}
          />
        )}
        {error && (
          <p id={`${id}-error`} className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <section className="panel" aria-labelledby="address-form-title">
      <h1 id="address-form-title">{address === null ? 'Add an address' : 'Edit address'}</h1>
      <form onSubmit={(e) => void submit(e)} noValidate aria-busy={busy}>
        {FIELD_NAMES.map(field)}
        <p className="field-error" role="alert" data-testid="address-form-error">
          {formError}
        </p>
        <div className="actions">
          <button type="submit" className="button-primary" aria-disabled={busy}>
            {busy ? 'Saving…' : 'Save address'}
          </button>
          <button type="button" onClick={() => router.push('/account/addresses')}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
