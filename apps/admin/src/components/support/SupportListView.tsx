import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import {
  CASE_STATUSES,
  CATEGORY_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type CaseListQuery,
  type CaseSummary,
} from '@/lib/support'

export type CaseListResult = Exclude<
  BackendReadResult<{ items: CaseSummary[]; nextCursor?: string | null }>,
  { kind: 'unauthenticated' }
>

const href = (status?: string, cursor?: string) => {
  const p = new URLSearchParams()
  if (status) p.set('status', status)
  if (cursor) p.set('cursor', cursor)
  const q = p.toString()
  return `/support${q ? `?${q}` : ''}`
}

/**
 * Support queue, most recently updated first. The backend filters by status only (no category, assignee, customer or
 * text filter). Rows move as cases update, so a page boundary can repeat a case; ids are de-duplicated per page.
 */
export function SupportListView({
  result,
  query,
  myActorId,
}: {
  result: CaseListResult
  query: CaseListQuery
  myActorId?: string
}) {
  const header = (
    <PageHeader
      title="Support"
      description="Most recently updated first. The backend filters by status only."
    />
  )
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Support"
          subject="Support cases"
          forbiddenMessage="Your roles cannot read support cases. The backend allows it for support-agent and order-ops."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const seen = new Set<string>()
  const items = result.data.items.filter((c) => !seen.has(c.caseId) && seen.add(c.caseId))
  return (
    <>
      {header}
      <form method="get" className="filters" aria-label="Support filters">
        <label>
          Status
          <select name="status" defaultValue={query.status ?? ''}>
            <option value="">All</option>
            {CASE_STATUSES.map((s) => (
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
          title="No cases"
          message={query.status ? 'No cases have this status.' : 'There are no support cases.'}
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Support cases table">
          <table className="data-table">
            <caption className="sr-only">{items.length} cases</caption>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">Status</th>
                <th scope="col">Category</th>
                <th scope="col">Assigned</th>
                <th scope="col" className="num">
                  Messages
                </th>
                <th scope="col">Updated (IST)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.caseId}>
                  <th scope="row" className="wrap">
                    <Link href={`/support/${encodeURIComponent(c.caseId)}`}>{c.subject}</Link>
                  </th>
                  <td>
                    <StatusBadge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                      {STATUS_LABEL[c.status] ?? c.status}
                    </StatusBadge>
                  </td>
                  <td>{CATEGORY_LABEL[c.category ?? ''] ?? c.category ?? '—'}</td>
                  <td>
                    {!c.assignedTo
                      ? 'Unassigned'
                      : c.assignedTo === myActorId
                        ? 'You'
                        : 'A teammate'}
                  </td>
                  <td className="num">{c.messageCount ?? 0}</td>
                  <td>{formatShortIst(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.cursor ? (
          <Link href={href(query.status)} className="btn">
            Most recent
          </Link>
        ) : null}
        {result.data.nextCursor ? (
          <Link href={href(query.status, result.data.nextCursor)} className="btn" rel="next">
            Older
          </Link>
        ) : null}
      </nav>
    </>
  )
}
