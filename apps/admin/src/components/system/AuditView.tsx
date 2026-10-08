import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { actorTypes, auditFilterSearch, type AuditEvent, type AuditQuery } from '@/lib/audit'
import { formatDateTimeIst } from '@/lib/format'

export type AuditResult = Exclude<
  BackendReadResult<{ items: AuditEvent[]; nextCursor?: string | null }>,
  { kind: 'unauthenticated' }
>

const STAFF = ['order-ops', 'support-agent']

/**
 * Admin audit trail (read-only). Only safe attributed fields exist: no request payloads, before/after values, emails or
 * IPs. Newest first; the cursor is replayed with identical filters because the backend requires it.
 */
export function AuditView({
  result,
  query,
  problems,
  roles,
}: {
  result: AuditResult
  query: AuditQuery
  problems: string[]
  roles: readonly string[]
}) {
  const header = (
    <PageHeader
      title="Audit log"
      description="Who changed what, newest first. Times are shown in IST; filters take IST."
    />
  )
  if (result.kind !== 'ok') {
    const mixed = roles.some((r) => STAFF.includes(r))
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Audit log"
          subject="Audit events"
          forbiddenMessage={
            'The backend allows audit reads only for a signed-in human with the audit-reader role.' +
            (mixed
              ? ' Known backend limitation: audit-reader combined with order-ops or support-agent (without reader or cms-writer) is refused.'
              : '')
          }
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const { items, nextCursor } = result.data
  const field = (name: keyof AuditQuery, label: string, extra: Record<string, unknown> = {}) => (
    <label>
      {label}
      <input name={name} defaultValue={query[name] ?? ''} {...extra} />
    </label>
  )
  return (
    <>
      {header}
      <form method="get" className="filters" aria-label="Audit filters">
        <label>
          Actor type
          <select name="actorType" defaultValue={query.actorType ?? ''}>
            <option value="">Any</option>
            {actorTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {field('actorId', 'Actor id', { placeholder: 'google:…' })}
        {field('action', 'Action', { placeholder: 'e.g. CONTENT_BLOCK_CREATED' })}
        {field('targetType', 'Target type', { placeholder: 'e.g. product' })}
        {field('targetId', 'Target id')}
        {field('requestId', 'Request id', { placeholder: 'req_…' })}
        {field('fromLocal', 'From (IST)', { type: 'datetime-local' })}
        {field('toLocal', 'To (IST)', { type: 'datetime-local' })}
        <button type="submit" className="btn">
          Apply
        </button>
        <Link href="/system/audit" className="btn">
          Clear
        </Link>
      </form>
      {problems.map((p) => (
        <p key={p} className="notice" role="status">
          {p}
        </p>
      ))}
      {items.length === 0 ? (
        <EmptyState title="No events" message="No audit events match these filters." />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Audit events table">
          <table className="data-table">
            <caption className="sr-only">{items.length} audit events</caption>
            <thead>
              <tr>
                <th scope="col">When (IST)</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Actor</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <th scope="row">{formatDateTimeIst(e.occurredAt).replace(' IST', '')}</th>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td>
                    {e.targetType ? `${e.targetType}` : '—'}
                    {e.targetId ? <span className="muted"> {e.targetId}</span> : null}
                  </td>
                  <td>
                    {e.actorType}
                    {e.actorId ? <span className="muted"> {e.actorId}</span> : null}
                  </td>
                  <td>
                    <details>
                      <summary>Open</summary>
                      <dl className="kv">
                        <dt>Event id</dt>
                        <dd>
                          <code>{e.id}</code>
                        </dd>
                        <dt>UTC time</dt>
                        <dd>{e.occurredAt}</dd>
                        <dt>Request id</dt>
                        <dd>
                          {e.requestId ? (
                            <Link
                              href={`/system/audit${auditFilterSearch({ requestId: e.requestId })}`}
                            >
                              <code>{e.requestId}</code>
                            </Link>
                          ) : (
                            '—'
                          )}
                        </dd>
                        <dt>Credential</dt>
                        <dd>{e.credentialId ?? '—'}</dd>
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.cursor ? (
          <Link href={`/system/audit${auditFilterSearch(query)}`} className="btn">
            Newest
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            href={`/system/audit${auditFilterSearch(query, nextCursor)}`}
            className="btn"
            rel="next"
          >
            Older
          </Link>
        ) : null}
      </nav>
    </>
  )
}
