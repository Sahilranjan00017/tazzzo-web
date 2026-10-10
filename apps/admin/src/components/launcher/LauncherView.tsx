import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { DashboardSummary } from '@/lib/dashboard'
import { formatCount } from '@/lib/format'
import { attentionItems, launcherFor } from '@/lib/launcher'
import { moduleHref } from '@/lib/nav'

export type LauncherDashboard =
  | Exclude<BackendReadResult<DashboardSummary>, { kind: 'unauthenticated' }>
  /** The viewer's roles are not served the dashboard summary, so no call was made. */
  | { kind: 'not_requested' }

/**
 * Home: a role-aware launcher. Cards lead only to modules these roles can use. The "Needs attention" strip reuses the
 * existing dashboard summary (reader and cms-writer only); when it is unavailable the launcher still works and says so.
 */
export function LauncherView({
  roles,
  writer,
  dashboard,
}: {
  roles: readonly string[]
  writer: boolean
  dashboard: LauncherDashboard
}) {
  const sections = launcherFor(roles)
  return (
    <>
      <PageHeader
        title="Tazzzo Admin"
        description={
          writer
            ? 'You can view and edit catalogue content.'
            : 'Editing controls are hidden for your roles.'
        }
      />
      <Attention dashboard={dashboard} roles={roles} />
      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`launch-${s.id}`}>
          <h2 id={`launch-${s.id}`} className="section-title">
            {s.label}
          </h2>
          <div className="kpi-grid">
            {s.cards.map((c) => (
              <div key={c.id} className="kpi" data-testid={`launch-${c.id}`}>
                <p className="kpi-label">
                  <Link href={c.href}>{c.label}</Link>
                </p>
                {c.blurb ? <p className="kpi-note">{c.blurb}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function Attention({
  dashboard,
  roles,
}: {
  dashboard: LauncherDashboard
  roles: readonly string[]
}) {
  if (dashboard.kind === 'not_requested') return null
  if (dashboard.kind !== 'ok') {
    return (
      <section className="panel" aria-labelledby="attention-h">
        <h2 id="attention-h">Needs attention</h2>
        <p className="muted">
          The live summary is unavailable right now, so nothing is shown rather than partial
          numbers. The modules below still work.
        </p>
        <RefreshButton />
      </section>
    )
  }
  const items = attentionItems(dashboard.data, (id) => moduleHref(id, roles))
  return (
    <section className="panel" aria-labelledby="attention-h">
      <h2 id="attention-h">Needs attention</h2>
      {items.length === 0 ? (
        <p className="muted" data-testid="attention-none">
          Nothing needs attention right now: no out-of-stock or low-stock products, failed
          notifications or open support cases.
        </p>
      ) : (
        <ul>
          {items.map((i) => (
            <li key={i.id} data-testid={`attention-${i.id}`}>
              <StatusBadge tone={i.tone}>{i.label}</StatusBadge> <strong>{formatCount(i)}</strong>
              {i.capped ? <span className="muted"> (at least)</span> : null}
              {i.href ? (
                <>
                  {' · '}
                  <Link href={i.href}>Open</Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        From the live dashboard summary. See the <Link href="/dashboard">Dashboard</Link> for
        everything.
      </p>
    </section>
  )
}
