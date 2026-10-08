'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { commerceErrorMessage } from '@/components/commerce-copy'
import { useBffAction } from '@/components/useBffAction'
import type { AdminPrice } from '@/lib/commerce'
import { formatPaise, paiseToInput, parseRupees } from '@/lib/money'

/**
 * Set the selling price and MRP for one SKU. Amounts are typed in rupees and converted to integer paise without
 * floating point. A first price is a create (no version); later changes carry the loaded version and the backend
 * rejects a stale one. The binding checkout price is always computed by the backend; this only sets its inputs.
 * Mounted with `key={sku:version}` so a reload re-initializes it from the authoritative copy.
 */
export function PriceEditor({ skuId, current }: { skuId: string; current?: AdminPrice }) {
  const { run, busy } = useBffAction(commerceErrorMessage)
  const [selling, setSelling] = useState(current ? paiseToInput(current.sellingPricePaise) : '')
  const [mrp, setMrp] = useState(current ? paiseToInput(current.mrpPaise) : '')
  const [errors, setErrors] = useState<{ selling?: string; mrp?: string }>({})
  const [pending, setPending] = useState<{ selling: number; mrp: number }>()

  function review(e: FormEvent) {
    e.preventDefault()
    const s = parseRupees(selling)
    const m = parseRupees(mrp)
    const next: typeof errors = {}
    if (!s.ok) next.selling = s.reason
    if (!m.ok) next.mrp = m.reason
    if (s.ok && m.ok && m.paise < s.paise) next.mrp = 'MRP cannot be below the selling price.'
    setErrors(next)
    if (s.ok && m.ok && Object.keys(next).length === 0) {
      if (current && s.paise === current.sellingPricePaise && m.paise === current.mrpPaise) {
        setErrors({ selling: 'Nothing changed.' })
        return
      }
      setPending({ selling: s.paise, mrp: m.paise })
    }
  }

  const description = pending
    ? `${current ? `Selling ${formatPaise(current.sellingPricePaise)} → ${formatPaise(pending.selling)}; MRP ${formatPaise(current.mrpPaise)} → ${formatPaise(pending.mrp)}.` : `Set the first price: selling ${formatPaise(pending.selling)}, MRP ${formatPaise(pending.mrp)}.`} The change is recorded against your account.`
    : ''

  return (
    <>
      <form className="stack form-narrow" onSubmit={review} noValidate aria-label="Set price">
        <label>
          Selling price (₹)
          <input
            inputMode="decimal"
            value={selling}
            onChange={(e) => setSelling(e.target.value)}
            aria-invalid={errors.selling ? true : undefined}
            aria-describedby={errors.selling ? 'sell-err' : undefined}
          />
          {errors.selling ? (
            <span id="sell-err" className="field-error" role="alert">
              {errors.selling}
            </span>
          ) : null}
        </label>
        <label>
          MRP (₹)
          <input
            inputMode="decimal"
            value={mrp}
            onChange={(e) => setMrp(e.target.value)}
            aria-invalid={errors.mrp ? true : undefined}
            aria-describedby={errors.mrp ? 'mrp-err' : undefined}
          />
          {errors.mrp ? (
            <span id="mrp-err" className="field-error" role="alert">
              {errors.mrp}
            </span>
          ) : null}
        </label>
        <p className="muted">Currency is INR. Amounts are stored in paise; up to ₹10,000,000.</p>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {current ? 'Review change' : 'Review first price'}
        </button>
      </form>
      <ConfirmDialog
        open={pending !== undefined}
        title={`${current ? 'Update' : 'Set'} price for ${skuId}?`}
        description={description}
        confirmLabel={current ? 'Update price' : 'Set price'}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending) return
          void run(
            `/api/bff/pricing/${encodeURIComponent(skuId)}`,
            'PUT',
            {
              sellingPricePaise: pending.selling,
              mrpPaise: pending.mrp,
              ...(current ? { expectedVersion: current.version } : {}),
            },
            'Price saved.',
          ).then(() => setPending(undefined))
        }}
      />
    </>
  )
}
