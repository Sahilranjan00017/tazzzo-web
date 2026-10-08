import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { describeCount, formatCount } from '@/lib/format'
import type { DashboardSummary } from '@/lib/dashboard'

type R = Exclude<BackendReadResult<DashboardSummary>, { kind: 'unauthenticated' }>

const TYPES = [
  'ORDER_CONFIRMED',
  'ORDER_OUT_FOR_DELIVERY',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'SUPPORT_REPLY',
  'SUPPORT_CASE_RESOLVED',
]

/**
 * Notification health: only the two aggregate counters the backend exposes (via the dashboard summary). Per-message
 * detail, retry and provider activation do not exist as admin APIs: BLOCKED_BY_BACKEND, shown as such.
 */
export function NotificationsView({ result }: { result: R }) {
  const header = (
    <PageHeader
      title="Notifications"
      description="Aggregate health only. The backend has no per-message admin API."
      actions={<RefreshButton />}
    />
  )
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Notifications"
          subject="Notification summary"
          forbiddenMessage="The notification counters come from the dashboard summary, which the backend allows for reader and cms-writer only."
        />
      </>
    )
  }
  const { pending, failed } = result.data.notifications
  return (
    <>
      {header}
      <div className="kpi-grid">
        <div className="kpi">
          <p className="kpi-label">Pending</p>
          <p className="kpi-value">
            <span aria-hidden="true">{formatCount(pending)}</span>
            <span className="sr-only">{describeCount(pending)}</span>
          </p>
          {pending.capped ? (
            <p className="kpi-note">Lower bound: the backend stops counting here.</p>
          ) : null}
          <p className="kpi-note">
            No notification provider ships yet, so messages can stay pending.
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Failed</p>
          <p className="kpi-value">
            <span aria-hidden="true">{formatCount(failed)}</span>
            <span className="sr-only">{describeCount(failed)}</span>
            {failed.value > 0 ? <StatusBadge tone="danger">Needs attention</StatusBadge> : null}
          </p>
          {failed.capped ? (
            <p className="kpi-note">Lower bound: the backend stops counting here.</p>
          ) : null}
        </div>
      </div>
      <section className="panel" aria-labelledby="nb-h">
        <h2 id="nb-h">Not available from the backend</h2>
        <ul>
          <li>Per-message list, status, recipient or body (no admin read API exists).</li>
          <li>Retry or resend of a failed message.</li>
          <li>Delivery receipts and provider activation or status.</li>
        </ul>
        <p className="muted">
          These are blocked by the backend, not hidden. Event types the backend can send:
        </p>
        <p>
          {TYPES.map((t) => (
            <code key={t} className="chip">
              {t}
            </code>
          ))}
        </p>
      </section>
    </>
  )
}
