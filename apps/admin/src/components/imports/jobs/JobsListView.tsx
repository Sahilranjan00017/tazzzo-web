import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { PageHeader, EmptyState, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import {
  JOBS_PAGE_SIZE,
  JOB_STATUSES,
  STATUS_LABEL,
  STATUS_TONE,
  pageOf,
  type ImportJob,
  type JobListQuery,
} from '@/lib/import-jobs'
import { CreateJobForm } from './CreateJobForm'

export type JobListResult = Exclude<
  BackendReadResult<{ jobs: ImportJob[]; next?: string | null }>,
  { kind: 'unauthenticated' }
>

const href = (status?: string, after?: string) => {
  const p = new URLSearchParams()
  if (status) p.set('status', status)
  if (after) p.set('after', after)
  const q = p.toString()
  return `/catalogue/imports/jobs${q ? `?${q}` : ''}`
}

/** Newest-first import jobs. Filter: status only (the backend's list has no other filter). Keyset paging by job id. */
export function JobsListView({
  result,
  query,
  canWrite,
}: {
  result: JobListResult
  query: JobListQuery
  canWrite: boolean
}) {
  const header = (
    <PageHeader
      title="Import jobs"
      description="Large product imports that are validated and applied in the background, with a verdict for every row and an explicit approval before anything is written."
      actions={
        <Link className="btn" href="/catalogue/imports">
          Quick import (up to 500 rows per request)
        </Link>
      }
    />
  )
  if (result.kind !== 'ok') {
    const forbidden = result.kind === 'forbidden'
    return (
      <>
        {header}
        <div className="panel panel-error" role="alert">
          <h2>{forbidden ? 'Not permitted' : 'Import jobs unavailable'}</h2>
          <p>
            {forbidden
              ? 'Your roles cannot read import jobs. The backend allows it for reader and cms-writer.'
              : result.kind === 'rate_limited'
                ? 'Too many requests. Try again shortly.'
                : 'The backend could not return the import jobs. Nothing is shown rather than partial data.'}
          </p>
          {'backendRequestId' in result && result.backendRequestId ? (
            <p className="muted">Reference: {result.backendRequestId}</p>
          ) : null}
          {forbidden ? null : <RefreshButton label="Try again" />}
        </div>
      </>
    )
  }
  const { items, more } = pageOf(result.data.jobs, JOBS_PAGE_SIZE)
  const last = items[items.length - 1]
  return (
    <>
      {header}
      {canWrite ? (
        <CreateJobForm />
      ) : (
        <p className="notice" role="note">
          Read-only: creating and running import jobs needs the cms-writer role.
        </p>
      )}
      <form method="get" className="filters" aria-label="Import job filters">
        <label>
          Status
          <select name="status" defaultValue={query.status ?? ''}>
            <option value="">All</option>
            {JOB_STATUSES.map((s) => (
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
      {items.length === 0 ? (
        <EmptyState
          title="No import jobs"
          message={
            query.after
              ? 'There are no older jobs.'
              : query.status
                ? 'No job has this status.'
                : 'No import job has been created yet.'
          }
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Import jobs table">
          <table className="data-table">
            <caption className="sr-only">{items.length} import jobs, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Rows
                </th>
                <th scope="col" className="num">
                  Applied
                </th>
                <th scope="col" className="num">
                  Failed
                </th>
                <th scope="col" className="num">
                  Invalid
                </th>
                <th scope="col">Created (IST)</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id}>
                  <th scope="row">
                    <Link href={`/catalogue/imports/jobs/${encodeURIComponent(j.id)}`}>{j.id}</Link>
                  </th>
                  <td>
                    <StatusBadge tone={STATUS_TONE[j.status] ?? 'neutral'}>
                      {STATUS_LABEL[j.status] ?? j.status}
                    </StatusBadge>
                  </td>
                  <td className="num">{j.rowsTotal}</td>
                  <td className="num">{j.counts.applied}</td>
                  <td className="num">{j.counts.failed}</td>
                  <td className="num">{j.counts.invalid + j.counts.duplicate}</td>
                  <td>{formatShortIst(j.createdAt)}</td>
                  <td className="wrap">{j.note ? j.note.slice(0, 80) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.after ? (
          <Link href={href(query.status)} className="btn">
            Newest
          </Link>
        ) : null}
        {more && last ? (
          <Link href={href(query.status, last.id)} className="btn" rel="next">
            Older
          </Link>
        ) : null}
      </nav>
    </>
  )
}
