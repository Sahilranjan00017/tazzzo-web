import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatDays, formatWindow, type SlotWindow } from '@/lib/delivery'
import { ToggleButton } from './ToggleButton'
import { WindowEditor } from './WindowEditor'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

/** Recurring weekly windows for one service area. No per-date capacity, used or remaining counts exist in the admin API. */
export function SlotsView({
  area,
  result,
  editId,
  canWrite,
  invalidInput,
}: {
  area?: string
  result?: Ok<{ items: SlotWindow[] }>
  editId?: string
  canWrite: boolean
  invalidInput?: boolean
}) {
  const header = (
    <PageHeader
      title="Delivery slots"
      description="Recurring weekly windows per service area, in the delivery zone's clock (Asia/Kolkata by default). The backend decides availability and holds capacity atomically."
    />
  )
  const lookup = (
    <form method="get" className="filters" aria-label="Choose service area">
      <label>
        Service area id
        <input name="area" defaultValue={area ?? ''} maxLength={128} />
      </label>
      <button type="submit" className="btn">
        Show windows
      </button>
      <Link href="/delivery/service-areas" className="btn">
        Browse service areas
      </Link>
    </form>
  )
  if (!area || !result) {
    return (
      <>
        {header}
        {lookup}
        {invalidInput ? (
          <p className="notice" role="alert">
            That is not a valid service area id.
          </p>
        ) : (
          <p className="muted">
            Open a service area to see its windows (the id is on each service area page).
          </p>
        )}
      </>
    )
  }
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        {lookup}
        <BackendFailure
          result={result}
          title="Delivery slots"
          subject="Delivery slots"
          forbiddenMessage="Your roles cannot read delivery slots."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const items = result.data.items
  const editing = editId ? items.find((w) => w.windowId === editId) : undefined
  return (
    <>
      {header}
      {lookup}
      {items.length === 0 ? (
        <EmptyState
          title="No windows"
          message="This area has no delivery windows (an unknown area id also shows none, so check the id)."
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Delivery windows table">
          <table className="data-table">
            <caption className="sr-only">{items.length} windows</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Time</th>
                <th scope="col">Days</th>
                <th scope="col" className="num">
                  Capacity
                </th>
                <th scope="col" className="num">
                  Cut-off (min)
                </th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.windowId}>
                  <th scope="row">
                    {w.label} <span className="muted">{w.windowId}</span>
                  </th>
                  <td>{formatWindow(w)}</td>
                  <td>{formatDays(w.days)}</td>
                  <td className="num">{w.capacity}</td>
                  <td className="num">{w.cutoffMinutes}</td>
                  <td>
                    <StatusBadge tone={w.active ? 'success' : 'neutral'}>
                      {w.active ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  </td>
                  <td>
                    {canWrite ? (
                      <div className="row">
                        <Link
                          href={`/delivery/slots?area=${encodeURIComponent(area)}&edit=${encodeURIComponent(w.windowId)}`}
                          className="btn"
                        >
                          Edit
                        </Link>
                        <ToggleButton
                          path={`/api/bff/delivery/slots/${encodeURIComponent(area)}/${encodeURIComponent(w.windowId)}`}
                          active={w.active}
                          version={w.version}
                          noun="delivery window"
                          consequence={
                            w.active
                              ? 'Customers can no longer choose this window. Existing orders are not changed.'
                              : 'Customers can choose this window again.'
                          }
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite ? (
        <section className="panel" aria-labelledby="we-h">
          <h2 id="we-h">{editing ? `Edit “${editing.label}”` : 'New delivery window'}</h2>
          {editId && !editing ? (
            <p className="notice" role="alert">
              That window was not found in this area.
            </p>
          ) : null}
          <WindowEditor
            key={editing ? `${editing.windowId}:${editing.version}` : 'new'}
            serviceAreaId={area}
            window={editing}
          />
          {editing ? (
            <p>
              <Link href={`/delivery/slots?area=${encodeURIComponent(area)}`}>
                Create a new window instead
              </Link>
            </p>
          ) : null}
        </section>
      ) : (
        <p className="notice" role="note">
          Read-only: changing delivery windows needs the cms-writer role.
        </p>
      )}
    </>
  )
}
