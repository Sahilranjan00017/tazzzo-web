import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import { formatPaise } from '@/lib/money'
import {
  ORDER_STATUSES,
  STATUS_LABEL,
  STATUS_TONE,
  type OrderListQuery,
  type StaffOrder,
} from '@/lib/orders'

export type OrderListResult = Exclude<
  BackendReadResult<{ items: StaffOrder[]; nextCursor?: string | null }>,
  { kind: 'unauthenticated' }
>

const href = (status?: string, cursor?: string) => {
  const p = new URLSearchParams()
  if (status) p.set('status', status)
  if (cursor) p.set('cursor', cursor)
  const q = p.toString()
  return `/orders${q ? `?${q}` : ''}`
}

/** Newest-first order list. Only `status` is a server filter; there is no search, date or area filter on the backend. */
export function OrderListView({
  result,
  query,
}: {
  result: OrderListResult
  query: OrderListQuery
}) {
  const header = (
    <PageHeader
      title="Orders"
      description="Newest first. The backend filters by status only; it has no search, date or area filter."
    />
  )
  const filter = (
    <form method="get" className="filters" aria-label="Order filters">
      <label>
        Status
        <select name="status" defaultValue={query.status ?? ''}>
          <option value="">All</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn">
        Apply
      </button>
    </form>
  )
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Orders"
          subject="Orders"
          forbiddenMessage="Your roles cannot read orders. The backend allows it for order-ops and support-agent."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const { items, nextCursor } = result.data
  return (
    <>
      {header}
      {filter}
      {items.length === 0 ? (
        <EmptyState
          title="No orders"
          message={
            query.status ? 'No orders have this status.' : 'The backend reports no orders yet.'
          }
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Orders table">
          <table className="data-table">
            <caption className="sr-only">{items.length} orders</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col">Placed (IST)</th>
                <th scope="col" className="num">
                  Items
                </th>
                <th scope="col" className="num">
                  Payable
                </th>
                <th scope="col">Delivery slot</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.orderId}>
                  <th scope="row">
                    <Link href={`/orders/${encodeURIComponent(o.orderId)}`}>{o.orderId}</Link>
                  </th>
                  <td>
                    <StatusBadge tone={STATUS_TONE[o.status] ?? 'neutral'}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </StatusBadge>
                  </td>
                  <td>{formatShortIst(o.createdAt)}</td>
                  <td className="num">{o.itemCount ?? o.lines.length}</td>
                  <td className="num">{formatPaise(o.payablePaise ?? o.subtotalPaise ?? 0)}</td>
                  <td>{o.deliverySlot?.label ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.cursor ? (
          <Link href={href(query.status)} className="btn">
            Newest
          </Link>
        ) : null}
        {nextCursor ? (
          <Link href={href(query.status, nextCursor)} className="btn" rel="next">
            Older
          </Link>
        ) : null}
      </nav>
    </>
  )
}
