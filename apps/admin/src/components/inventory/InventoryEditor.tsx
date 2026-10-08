'use client'

import { useState, type FormEvent } from 'react'
import { commerceErrorMessage } from '@/components/commerce-copy'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { COUNT_MAX, ON_HAND_MAX, type AdminInventory } from '@/lib/commerce'

const whole = (text: string, max: number): number | undefined =>
  /^\d{1,10}$/.test(text.trim()) && Number(text) <= max ? Number(text) : undefined

/**
 * Stock for one SKU at one location. The save is an ABSOLUTE set of on-hand (not a delta) and never changes reserved
 * stock; the confirmation shows before and after. Activate/deactivate are separate versioned actions. A first row
 * (no `current`) is a create. Remounted with `key={sku:location:version}` after every save or conflict.
 */
export function InventoryEditor({
  skuId,
  locationId,
  current,
}: {
  skuId: string
  locationId: string
  current?: AdminInventory
}) {
  const { run, busy } = useBffAction(commerceErrorMessage)
  const [onHand, setOnHand] = useState(current ? String(current.onHand) : '')
  const [low, setLow] = useState(current ? String(current.lowStockThreshold) : '0')
  const [max, setMax] = useState(current ? String(current.maxPurchasable) : '0')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<{ onHand: number; low: number; max: number }>()
  const [toggle, setToggle] = useState<'activate' | 'deactivate'>()
  const base = `/api/bff/inventory/${encodeURIComponent(skuId)}/${encodeURIComponent(locationId)}`

  function review(e: FormEvent) {
    e.preventDefault()
    const o = whole(onHand, ON_HAND_MAX)
    const l = whole(low, COUNT_MAX)
    const m = whole(max, COUNT_MAX)
    if (o === undefined)
      return setError(
        `On-hand must be a whole number from 0 to ${ON_HAND_MAX.toLocaleString('en-IN')}.`,
      )
    if (l === undefined || m === undefined)
      return setError('Thresholds must be whole numbers, 0 or more.')
    if (current && o < current.reserved)
      return setError(`On-hand cannot be below the ${current.reserved} units already reserved.`)
    if (
      current &&
      o === current.onHand &&
      l === current.lowStockThreshold &&
      m === current.maxPurchasable
    )
      return setError('Nothing changed.')
    setError(undefined)
    setPending({ onHand: o, low: l, max: m })
  }

  return (
    <>
      <form className="stack form-narrow" onSubmit={review} noValidate aria-label="Set stock">
        <label>
          On-hand quantity
          <input inputMode="numeric" value={onHand} onChange={(e) => setOnHand(e.target.value)} />
        </label>
        <label>
          Low-stock threshold
          <input inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value)} />
        </label>
        <label>
          Max purchasable per order
          <input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted">
          This sets the absolute on-hand count; it does not add or subtract. Reserved units are not
          changed.
        </p>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {current ? 'Review change' : 'Review first stock record'}
          </button>
          {current ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setToggle(current.active ? 'deactivate' : 'activate')}
            >
              {current.active ? 'Deactivate' : 'Activate'}
            </button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={pending !== undefined}
        title={`Set stock for ${skuId} at ${locationId}?`}
        description={
          pending
            ? `${current ? `On-hand ${current.onHand} → ${pending.onHand}.` : `Create with on-hand ${pending.onHand}.`} Low-stock threshold ${pending.low}, max per order ${pending.max}. Recorded against your account.`
            : ''
        }
        confirmLabel="Save stock"
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending) return
          void run(
            base,
            'PUT',
            {
              onHand: pending.onHand,
              lowStockThreshold: pending.low,
              maxPurchasable: pending.max,
              ...(current ? { expectedVersion: current.version } : {}),
            },
            'Stock saved.',
          ).then(() => setPending(undefined))
        }}
      />
      <ConfirmDialog
        open={toggle !== undefined}
        title={
          toggle === 'deactivate' ? 'Deactivate this stock record?' : 'Activate this stock record?'
        }
        description={
          toggle === 'deactivate'
            ? 'An inactive record is not sellable from this location until reactivated.'
            : 'The record becomes sellable from this location again.'
        }
        confirmLabel={toggle === 'deactivate' ? 'Deactivate' : 'Activate'}
        destructive={toggle === 'deactivate'}
        busy={busy}
        onCancel={() => setToggle(undefined)}
        onConfirm={() => {
          if (!toggle || !current) return
          void run(`${base}/${toggle}`, 'POST', { expectedVersion: current.version }, 'Done.').then(
            () => setToggle(undefined),
          )
        }}
      />
    </>
  )
}
