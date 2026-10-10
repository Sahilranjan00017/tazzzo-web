import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import {
  ROWS_PAGE_SIZE,
  STATUS_LABEL,
  STATUS_TONE,
  jobActions,
  negativeRowCount,
  pageOf,
  type ImportJob,
  type JobRow,
} from '@/lib/import-jobs'
import { ErrorsDownload } from './ErrorsDownload'
import { JobActions } from './JobActions'
import { JobPoller } from './JobPoller'
import { JobRowsTable } from './JobRowsTable'
import { JobUpload } from './JobUpload'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

const actorText = (a: { type?: string | null; id?: string | null } | null | undefined) =>
  a?.id ? `${a.id}${a.type ? ` (${a.type})` : ''}` : '—'

function Failure({
  result,
  subject,
}: {
  result: Exclude<Ok<unknown>, { kind: 'ok' }>
  subject: string
}) {
  const heading =
    result.kind === 'forbidden'
      ? 'Not permitted'
      : result.kind === 'not_found'
        ? `${subject} not found`
        : `${subject} unavailable`
  const message =
    result.kind === 'forbidden'
      ? 'Your roles cannot read import jobs. The backend allows it for reader and cms-writer.'
      : result.kind === 'not_found'
        ? 'The backend has no such import job.'
        : result.kind === 'rate_limited'
          ? 'Too many requests. Try again shortly.'
          : `The backend could not return ${subject.toLowerCase()}. Nothing is shown rather than partial data.`
  const trace = 'backendRequestId' in result ? result.backendRequestId : undefined
  return (
    <div className="panel panel-error" role="alert">
      <h2>{heading}</h2>
      <p>{message}</p>
      {trace ? <p className="muted">Reference: {trace}</p> : null}
      {result.kind === 'forbidden' || result.kind === 'not_found' ? null : (
        <RefreshButton label="Try again" />
      )}
    </div>
  )
}

const rowsHref = (id: string, from: number) =>
  `/catalogue/imports/jobs/${encodeURIComponent(id)}${from > 0 ? `?from=${from}` : ''}`

export function JobDetailView({
  jobId,
  job,
  rows,
  from,
  canWrite,
  approver,
}: {
  jobId: string
  job: Ok<ImportJob>
  rows?: Ok<{ rows: JobRow[]; next?: number | null }>
  from: number
  canWrite: boolean
  approver: string
}) {
  const back = (
    <p className="trail">
      <Link href="/catalogue/imports/jobs">All import jobs</Link>
    </p>
  )
  if (job.kind !== 'ok') {
    return (
      <>
        <PageHeader title={jobId} />
        {back}
        <Failure result={job} subject="Import job" />
      </>
    )
  }
  const j = job.data
  const can = jobActions(j.status, j.rowsTotal)
  const c = j.counts
  const page = rows?.kind === 'ok' ? pageOf(rows.data.rows, ROWS_PAGE_SIZE) : undefined
  const last = page?.items[page.items.length - 1]
  return (
    <>
      <PageHeader
        title={j.id}
        description={j.note ?? 'Product import job'}
        actions={<RefreshButton />}
      />
      {back}
      <section className="panel" aria-labelledby="job-summary-h">
        <h2 id="job-summary-h">Status</h2>
        <p>
          <StatusBadge tone={STATUS_TONE[j.status] ?? 'neutral'}>
            {STATUS_LABEL[j.status] ?? j.status}
          </StatusBadge>
        </p>
        <dl className="kv">
          <dt>Kind</dt>
          <dd>{j.kind}</dd>
          <dt>Rows stored</dt>
          <dd>{j.rowsTotal}</dd>
          <dt>Progress cursor</dt>
          <dd>
            row {j.nextRow} of {j.rowsTotal}
          </dd>
          <dt>Created by</dt>
          <dd>{actorText(j.createdBy)}</dd>
          <dt>Approved by</dt>
          <dd>{j.approvedBy ? actorText(j.approvedBy) : 'Not approved yet'}</dd>
          <dt>Created</dt>
          <dd>{formatShortIst(j.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatShortIst(j.updatedAt)}</dd>
          <dt>Finished</dt>
          <dd>{formatShortIst(j.finishedAt)}</dd>
          <dt>Version</dt>
          <dd>{j.version}</dd>
        </dl>
        {j.lastError ? (
          <p className="notice" role="note">
            Worker note: {j.lastError.slice(0, 200)}
          </p>
        ) : null}
      </section>
      <JobPoller key={j.status} job={j} />
      <section className="panel" aria-labelledby="job-counts-h">
        <h2 id="job-counts-h">Row counts</h2>
        <p className="muted">
          Validation: valid, unchanged (already identical in the catalogue), invalid, duplicate.
          Apply: applied, failed, not attempted. Counts are those of the latest pass.
        </p>
        <dl className="kv">
          <dt>Valid</dt>
          <dd>{c.valid}</dd>
          <dt>Unchanged</dt>
          <dd>{c.unchanged}</dd>
          <dt>Invalid</dt>
          <dd>{c.invalid}</dd>
          <dt>Duplicate</dt>
          <dd>{c.duplicate}</dd>
          <dt>Applied</dt>
          <dd>{c.applied}</dd>
          <dt>Failed</dt>
          <dd>{c.failed}</dd>
          <dt>Not attempted</dt>
          <dd>{c.not_attempted}</dd>
        </dl>
        {j.rowsTotal > 0 ? (
          <>
            <ErrorsDownload job={j} />
            <p className="muted">
              {negativeRowCount(j)} row{negativeRowCount(j) === 1 ? '' : 's'} currently have an
              invalid, duplicate or failed verdict.
            </p>
          </>
        ) : null}
      </section>
      {canWrite ? (
        <>
          <JobActions job={j} approver={approver} />
          {can.append ? <JobUpload job={j} /> : null}
        </>
      ) : (
        <p className="notice" role="note">
          Read-only: running an import job needs the cms-writer role.
        </p>
      )}
      <section className="stack" aria-labelledby="job-rows-h">
        <h2 id="job-rows-h">Rows</h2>
        {j.rowsTotal === 0 ? (
          <p className="muted">This job has no rows yet.</p>
        ) : !rows || rows.kind !== 'ok' ? (
          rows ? (
            <Failure result={rows} subject="Rows" />
          ) : null
        ) : page && page.items.length === 0 ? (
          <p className="muted">
            No rows from row {from}. The job has {j.rowsTotal} rows (numbered from 0).
          </p>
        ) : page ? (
          <>
            <JobRowsTable
              key={`${j.version}:${from}`}
              job={j}
              rows={page.items}
              canCorrect={canWrite && can.correct}
            />
            <nav className="pager" aria-label="Row pagination">
              {from > 0 ? (
                <Link href={rowsHref(j.id, 0)} className="btn">
                  First rows
                </Link>
              ) : null}
              {from > 0 ? (
                <Link
                  href={rowsHref(j.id, Math.max(0, from - ROWS_PAGE_SIZE))}
                  className="btn"
                  rel="prev"
                >
                  Previous
                </Link>
              ) : null}
              {page.more && last ? (
                <Link href={rowsHref(j.id, last.row + 1)} className="btn" rel="next">
                  Next
                </Link>
              ) : null}
            </nav>
            <form method="get" className="filters" aria-label="Go to row">
              <label>
                Start at row
                <input name="from" inputMode="numeric" defaultValue={from} pattern="[0-9]{1,12}" />
              </label>
              <button type="submit" className="btn">
                Go
              </button>
            </form>
          </>
        ) : null}
      </section>
    </>
  )
}
