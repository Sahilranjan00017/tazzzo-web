import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import { formatPaise } from '@/lib/money'
import { REASON_LABEL, STATUS_LABEL, STATUS_TONE, type StaffOrder } from '@/lib/orders'
import { OrderActions } from './OrderActions'

export type OrderDetailResult = Exclude<BackendReadResult<StaffOrder>, { kind: 'unauthenticated' }>

/**
 * Staff order detail. Shows only what the backend returns: per-status timestamps (the backend has no event timeline,
 * no per-transition actor and no benefit snapshot) and the delivery contact needed to fulfil the order. Customer
 * coordinates are deliberately not displayed.
 */
export function OrderDetailView({
  result,
  canOperate,
}: {
  result: OrderDetailResult
  canOperate: boolean
}) {
  if (result.kind !== 'ok') {
    return (
      <BackendFailure
        result={result}
        title="Order"
        subject="Order"
        forbiddenMessage="Your roles cannot read orders."
        refresh={<RefreshButton />}
      />
    )
  }
  const o = result.data
  const a = o.deliveryAddress
  const stamps: [string, string | null | undefined][] = [
    ['Placed', o.createdAt],
    ['Confirmed', o.confirmedAt],
    ['Out for delivery', o.outForDeliveryAt],
    ['Delivered', o.deliveredAt],
    ['Cancelled', o.cancelledAt],
  ]
  return (
    <>
      <PageHeader
        title={`Order ${o.orderId}`}
        description="Personal data below is shown only to fulfil and support this order."
        actions={
          <Link href="/orders" className="btn">
            All orders
          </Link>
        }
      />
      <div className="detail-grid">
        <section className="panel" aria-labelledby="os-h">
          <h2 id="os-h">Status</h2>
          <p>
            <StatusBadge tone={STATUS_TONE[o.status] ?? 'neutral'}>
              {STATUS_LABEL[o.status] ?? o.status}
            </StatusBadge>{' '}
            <span className="muted">version {o.version}</span>
          </p>
          {o.status === 'CANCELLED' ? (
            <p>
              Cancelled by <strong>{(o.cancelledBy ?? 'unknown').toLowerCase()}</strong>
              {o.cancelReason ? <> — {REASON_LABEL[o.cancelReason] ?? o.cancelReason}</> : null}
            </p>
          ) : null}
          <dl className="kv">
            {stamps
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <div key={label} className="kv-row">
                  <dt>{label}</dt>
                  <dd>{formatShortIst(v)} IST</dd>
                </div>
              ))}
          </dl>
          <p className="muted">
            The backend records these timestamps only; it has no event history or per-step actor.
          </p>
          {canOperate ? (
            <OrderActions
              key={`${o.orderId}:${o.version}`}
              orderId={o.orderId}
              status={o.status}
              version={o.version}
            />
          ) : (
            <p className="notice" role="note">
              Read-only: changing an order needs the order-ops role.
            </p>
          )}
        </section>
        <section className="panel" aria-labelledby="od-h">
          <h2 id="od-h">Delivery</h2>
          <dl className="kv">
            <dt>Slot</dt>
            <dd>
              {o.deliverySlot?.label ?? '—'}
              {o.deliverySlot?.startsAt ? (
                <span className="muted">
                  {' '}
                  ({formatShortIst(o.deliverySlot.startsAt)} –{' '}
                  {formatShortIst(o.deliverySlot.endsAt)})
                </span>
              ) : null}
            </dd>
            <dt>Recipient</dt>
            <dd>{a?.recipientName ?? '—'}</dd>
            <dt>Phone</dt>
            <dd>{a?.recipientPhone ?? '—'}</dd>
            <dt>Address</dt>
            <dd className="pre">
              {[
                a?.addressLine1,
                a?.addressLine2,
                a?.landmark,
                [a?.city, a?.state].filter(Boolean).join(', '),
                a?.postalCode,
              ]
                .filter(Boolean)
                .join('\n') || '—'}
            </dd>
            <dt>Customer id</dt>
            <dd>
              <code>{o.customerId ?? '—'}</code>
            </dd>
          </dl>
        </section>
      </div>
      <section className="panel" aria-labelledby="ol-h">
        <h2 id="ol-h">Items</h2>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Order items">
          <table className="data-table">
            <caption className="sr-only">{o.lines.length} line items</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col" className="num">
                  Unit price
                </th>
                <th scope="col" className="num">
                  Line total
                </th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.skuId}>
                  <th scope="row">
                    <Link href={`/catalogue/products/${encodeURIComponent(l.skuId)}`}>
                      {l.title}
                    </Link>
                    <span className="muted"> {l.skuId}</span>
                  </th>
                  <td className="num">{l.quantity}</td>
                  <td className="num">{formatPaise(l.unitPricePaise)}</td>
                  <td className="num">{formatPaise(l.lineTotalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="kv">
          <dt>Subtotal</dt>
          <dd>{o.subtotalPaise != null ? formatPaise(o.subtotalPaise) : '—'}</dd>
          <dt>Payable</dt>
          <dd>{o.payablePaise != null ? formatPaise(o.payablePaise) : '—'}</dd>
          <dt>Payment</dt>
          <dd>
            {o.paymentMethod ?? '—'}
            {o.paymentCondition ? ` (${o.paymentCondition})` : ''}
          </dd>
        </dl>
      </section>
    </>
  )
}
