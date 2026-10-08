import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { EmptyState, PageHeader, StatusBadge, type Tone } from '@/components/ui/primitives'
import { describeCount, formatCount, formatDateTimeIst, type BoundedCount } from '@/lib/format'
import { moduleHref } from '@/lib/nav'
import type { DashboardSummary } from '@/lib/dashboard'
import type { BackendReadResult } from '@/lib/backend-result'

export type DashboardResult = Exclude<
  BackendReadResult<DashboardSummary>,
  { kind: 'unauthenticated' }
>

function Metric({
  label,
  count,
  moduleId,
  tone,
  hint,
}: {
  label: string
  count: BoundedCount
  moduleId?: string
  tone?: Tone
  hint?: string
}) {
  const href = moduleId ? moduleHref(moduleId) : undefined
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">
        <span aria-hidden="true">{formatCount(count)}</span>
        <span className="sr-only">{describeCount(count)}</span>
        {tone && count.value > 0 ? <StatusBadge tone={tone}>Needs attention</StatusBadge> : null}
      </p>
      {count.capped ? (
        <p className="kpi-note">Lower bound: the backend stops counting here.</p>
      ) : null}
      {hint ? <p className="kpi-note">{hint}</p> : null}
      {href ? (
        <Link href={href} className="kpi-link">
          View {label.toLowerCase()}
        </Link>
      ) : null}
    </div>
  )
}

function Distribution({
  title,
  total,
  parts,
}: {
  title: string
  total: BoundedCount
  parts: { label: string; count: BoundedCount }[]
}) {
  return (
    <section className="panel" aria-label={title}>
      <h3>{title}</h3>
      <ul className="dist">
        {parts.map((part) => (
          <li key={part.label}>
            <label>
              <span>
                {part.label}: <strong>{formatCount(part.count)}</strong>
              </span>
              <progress
                max={Math.max(total.value, part.count.value, 1)}
                value={part.count.value}
                aria-label={`${part.label}: ${describeCount(part.count)} of ${describeCount(total)}`}
              />
            </label>
          </li>
        ))}
      </ul>
      <p className="kpi-note">
        Out of {formatCount(total)}
        {total.capped ? ' (lower bound)' : ''}. Parts need not add up to the total.
      </p>
    </section>
  )
}

/** Presentational dashboard: every backend outcome has its own state; nothing is estimated or invented. */
export function DashboardView({ result }: { result: DashboardResult }) {
  const refresh = <RefreshButton />
  if (result.kind !== 'ok') return <Failure result={result} refresh={refresh} />
  const d = result.data
  const hours = d.bounds.recentWindowHours
  const nothingYet =
    d.catalog.products_total.value === 0 && d.serviceability.service_areas_total.value === 0
  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Live summary from the backend, generated ${formatDateTimeIst(d.generatedAt)}. Counts stop at ${formatCount({ value: d.bounds.cap, capped: false })}; a “+” means at least that many.`}
        actions={refresh}
      />
      {nothingYet ? (
        <EmptyState
          title="No catalogue or service areas yet"
          message="The backend reports an empty dataset. Figures below are real zeros, not placeholders."
        />
      ) : null}

      <h2 className="section-title">Orders</h2>
      <div className="kpi-grid">
        <Metric label="Open: confirmed" count={d.orders.open_confirmed} moduleId="orders" />
        <Metric
          label="Open: out for delivery"
          count={d.orders.open_out_for_delivery}
          moduleId="orders"
        />
        <Metric label={`Confirmed, last ${hours}h`} count={d.orders.last24h_confirmed} />
        <Metric
          label={`Out for delivery, last ${hours}h`}
          count={d.orders.last24h_out_for_delivery}
        />
        <Metric label={`Delivered, last ${hours}h`} count={d.orders.last24h_delivered} />
        <Metric label={`Cancelled, last ${hours}h`} count={d.orders.last24h_cancelled} />
      </div>

      <h2 className="section-title">Catalogue and stock</h2>
      <div className="kpi-grid">
        <Metric label="Products" count={d.catalog.products_total} moduleId="products" />
        <Metric
          label="Low-stock"
          count={d.inventory.low_stock}
          moduleId="inventory"
          tone="warning"
          hint="Counts on-hand only; reserved stock is not subtracted."
        />
        <Metric
          label="Out-of-stock"
          count={d.inventory.out_of_stock}
          moduleId="inventory"
          tone="danger"
          hint="Counts on-hand only; reserved stock is not subtracted."
        />
        <Metric
          label="Service areas"
          count={d.serviceability.service_areas_total}
          moduleId="service-areas"
        />
      </div>
      <div className="dist-grid">
        <Distribution
          title="Catalogue lifecycle"
          total={d.catalog.products_total}
          parts={[
            { label: 'Active', count: d.catalog.active },
            { label: 'Draft', count: d.catalog.draft },
          ]}
        />
        <Distribution
          title="Service areas"
          total={d.serviceability.service_areas_total}
          parts={[{ label: 'Active', count: d.serviceability.active }]}
        />
      </div>

      <h2 className="section-title">Support and notifications</h2>
      <div className="kpi-grid">
        <Metric label="Open cases" count={d.support.open} moduleId="support" />
        <Metric label="In-progress cases" count={d.support.in_progress} moduleId="support" />
        <Metric
          label="Pending notifications"
          count={d.notifications.pending}
          hint="No notification provider ships yet, so rows can stay pending."
        />
        <Metric label="Failed notifications" count={d.notifications.failed} tone="danger" />
      </div>
    </>
  )
}

function Failure({
  result,
  refresh,
}: {
  result: Exclude<DashboardResult, { kind: 'ok' }>
  refresh: React.ReactNode
}) {
  const ref =
    'backendRequestId' in result && result.backendRequestId ? result.backendRequestId : undefined
  let title = 'Dashboard unavailable'
  let message =
    'The backend could not produce the summary. Nothing is shown rather than partial numbers.'
  if (result.kind === 'forbidden') {
    title = 'Not permitted'
    message =
      'Your roles cannot read the dashboard summary. The backend allows it for reader and cms-writer only.'
  } else if (result.kind === 'not_found') {
    title = 'Dashboard endpoint not found'
    message = 'The backend does not serve the dashboard summary in this environment.'
  } else if (result.kind === 'rate_limited') {
    title = 'Too many requests'
    message = result.retryAfterSeconds
      ? `Try again in ${result.retryAfterSeconds} seconds.`
      : 'Try again shortly.'
  } else if (result.kind === 'unavailable' && result.reason === 'shape') {
    message = 'The backend answered in an unexpected format, so it was not displayed.'
  } else if (result.kind === 'unavailable' && result.reason === 'timeout') {
    message = 'The backend took too long to answer (the summary has a 2 second server budget).'
  }
  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="panel panel-error" role="alert">
        <h2>{title}</h2>
        <p>{message}</p>
        {ref ? <p className="muted">Reference: {ref}</p> : null}
        {result.kind === 'forbidden' ? null : refresh}
      </div>
    </>
  )
}
