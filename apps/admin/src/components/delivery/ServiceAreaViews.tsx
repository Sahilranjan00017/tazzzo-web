import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { ServiceArea } from '@/lib/delivery'
import { AreaEditor } from './AreaEditor'
import { ToggleButton } from './ToggleButton'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

export function ServiceAreaListView({
  result,
  after,
  canWrite,
}: {
  result: Ok<{ items: ServiceArea[]; nextCursor?: string | null }>
  after?: string
  canWrite: boolean
}) {
  const header = (
    <PageHeader
      title="Service areas"
      description="One record per pincode, in pincode order. There is no map or geocoding provider; a pincode is only a validated code."
      actions={
        canWrite ? (
          <Link href="/delivery/service-areas/new" className="btn btn-primary">
            New service area
          </Link>
        ) : undefined
      }
    />
  )
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Service areas"
          subject="Service areas"
          forbiddenMessage="Your roles cannot read service areas. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const { items, nextCursor } = result.data
  return (
    <>
      {header}
      <form method="get" className="filters" aria-label="Jump to pincode">
        <label>
          Start after pincode
          <input name="after" defaultValue={after ?? ''} inputMode="numeric" maxLength={6} />
        </label>
        <button type="submit" className="btn">
          Go
        </button>
      </form>
      {items.length === 0 ? (
        <EmptyState title="No service areas" message="The backend reports none yet." />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Service areas table">
          <table className="data-table">
            <caption className="sr-only">{items.length} service areas</caption>
            <thead>
              <tr>
                <th scope="col">Pincode</th>
                <th scope="col">Area id</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Routes
                </th>
                <th scope="col" className="num">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.pincode}>
                  <th scope="row">
                    <Link href={`/delivery/service-areas/${a.pincode}`}>{a.pincode}</Link>
                  </th>
                  <td>{a.serviceAreaId}</td>
                  <td>
                    <StatusBadge tone={a.active ? 'success' : 'neutral'}>
                      {a.active ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  </td>
                  <td className="num">{a.routes.length}</td>
                  <td className="num">{a.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {after ? (
          <Link href="/delivery/service-areas" className="btn">
            First page
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            href={`/delivery/service-areas?after=${encodeURIComponent(nextCursor)}`}
            className="btn"
            rel="next"
          >
            Next page
          </Link>
        ) : null}
      </nav>
    </>
  )
}

export function ServiceAreaDetailView({
  result,
  canWrite,
}: {
  result: Ok<ServiceArea>
  canWrite: boolean
}) {
  if (result.kind !== 'ok') {
    return (
      <BackendFailure
        result={result}
        title="Service area"
        subject="Service area"
        forbiddenMessage="Your roles cannot read service areas."
        refresh={<RefreshButton />}
      />
    )
  }
  const a = result.data
  const active = a.routes.filter((r) => r.active).sort((x, y) => x.priority - y.priority)
  return (
    <>
      <PageHeader
        title={`Pincode ${a.pincode}`}
        description={a.serviceAreaId}
        actions={
          <>
            <Link href="/delivery/service-areas" className="btn">
              All areas
            </Link>
            <Link
              href={`/delivery/slots?area=${encodeURIComponent(a.serviceAreaId)}`}
              className="btn"
            >
              Delivery slots
            </Link>
          </>
        }
      />
      <div className="detail-grid">
        <section className="panel" aria-labelledby="sa-h">
          <h2 id="sa-h">Status</h2>
          <p>
            <StatusBadge tone={a.active ? 'success' : 'neutral'}>
              {a.active ? 'Active' : 'Inactive'}
            </StatusBadge>{' '}
            <span className="muted">version {a.version}</span>
          </p>
          <p className="muted">
            Serving location:{' '}
            {active[0] ? <code>{active[0].fulfillmentLocationId}</code> : 'none (no active route)'}
          </p>
          {canWrite ? (
            <ToggleButton
              path={`/api/bff/delivery/service-areas/${a.pincode}`}
              active={a.active}
              version={a.version}
              noun="service area"
              consequence={
                a.active
                  ? 'Customers at this pincode can no longer order. Existing orders are not changed.'
                  : 'Customers at this pincode can order again if an active route exists.'
              }
            />
          ) : (
            <p className="notice" role="note">
              Read-only: changing service areas needs the cms-writer role.
            </p>
          )}
        </section>
        <section className="panel" aria-labelledby="sr-h">
          <h2 id="sr-h">Routes</h2>
          {canWrite ? (
            <AreaEditor key={`${a.pincode}:${a.version}`} area={a} />
          ) : a.routes.length === 0 ? (
            <p className="muted">No routes.</p>
          ) : (
            <ul>
              {a.routes
                .slice()
                .sort((x, y) => x.priority - y.priority)
                .map((r) => (
                  <li key={r.fulfillmentLocationId}>
                    <code>{r.fulfillmentLocationId}</code> · priority {r.priority} ·{' '}
                    {r.active ? 'active' : 'inactive'}
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
