'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  REASON_LABEL,
  STAFF_CANCEL_REASONS,
  TRANSITIONS,
  orderErrorMessage,
  type OrderTarget,
} from '@/lib/orders'

const COPY: Record<
  OrderTarget,
  { label: string; confirm: string; destructive: boolean; done: string }
> = {
  OUT_FOR_DELIVERY: {
    label: 'Mark out for delivery',
    confirm: 'The customer is notified that the order is on its way.',
    destructive: false,
    done: 'Order is out for delivery.',
  },
  DELIVERED: {
    label: 'Mark delivered',
    confirm: 'This is final: a delivered order cannot be changed.',
    destructive: false,
    done: 'Order marked delivered.',
  },
  CANCELLED: {
    label: 'Cancel order',
    confirm:
      'This is final. Stock is restocked, the delivery-slot hold is released and the customer is notified, each exactly once. It cannot be undone.',
    destructive: true,
    done: 'Order cancelled.',
  },
}

/**
 * Order status actions. Only the backend's legal edges are offered for the current status; the backend enforces
 * them (and order-ops only). Cancel needs a reason. Remounted by the page with `key={orderId:version}`.
 */
export function OrderActions({
  orderId,
  status,
  version,
}: {
  orderId: string
  status: string
  version: number
}) {
  const { run, busy } = useBffAction(orderErrorMessage)
  const [pending, setPending] = useState<OrderTarget>()
  const [reason, setReason] = useState('')
  const targets = TRANSITIONS[status] ?? []

  if (targets.length === 0) {
    return (
      <p className="muted">
        This order is {status.toLowerCase().replace('_', ' ')}; it is final and has no further
        actions.
      </p>
    )
  }
  const cancelling = pending === 'CANCELLED'
  return (
    <>
      <div className="row">
        {targets.map((t) => (
          <button
            key={t}
            type="button"
            className={COPY[t].destructive ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={busy}
            onClick={() => {
              setReason('')
              setPending(t)
            }}
          >
            {COPY[t].label}
          </button>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? `${COPY[pending].label} ${orderId}?` : ''}
        description={
          pending
            ? COPY[pending].confirm + (cancelling && !reason ? ' Choose a reason first.' : '')
            : ''
        }
        confirmLabel={pending ? COPY[pending].label : 'Confirm'}
        destructive={pending ? COPY[pending].destructive : false}
        busy={busy}
        confirmDisabled={cancelling && !reason}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending || (cancelling && !reason)) return
          void run(
            `/api/bff/orders/${encodeURIComponent(orderId)}/transition`,
            'POST',
            { to: pending, expectedVersion: version, ...(cancelling ? { reason } : {}) },
            COPY[pending].done,
          ).then(() => setPending(undefined))
        }}
      >
        {cancelling ? (
          <div className="reason-pick" role="group" aria-label="Cancellation reason">
            <label>
              Cancellation reason (required)
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Choose…</option>
                {STAFF_CANCEL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
