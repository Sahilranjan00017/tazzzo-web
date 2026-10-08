import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatShortIst } from '@/lib/format'
import { CATEGORY_LABEL, STATUS_LABEL, STATUS_TONE, type StaffCase } from '@/lib/support'
import { SupportActions } from './SupportActions'

export type CaseResult = Exclude<BackendReadResult<StaffCase>, { kind: 'unauthenticated' }>

/** Case thread. Message text is rendered as plain text only (never HTML). */
export function SupportCaseView({
  result,
  canWork,
  canSeeOrders,
  myActorId,
}: {
  result: CaseResult
  canWork: boolean
  canSeeOrders: boolean
  myActorId?: string
}) {
  if (result.kind !== 'ok') {
    return (
      <BackendFailure
        result={result}
        title="Support case"
        subject="Support case"
        forbiddenMessage="Your roles cannot read support cases."
        refresh={<RefreshButton />}
      />
    )
  }
  const c = result.data
  const mine = !!myActorId && c.assignedTo === myActorId
  return (
    <>
      <PageHeader
        title={c.subject}
        description={c.caseId}
        actions={
          <Link href="/support" className="btn">
            All cases
          </Link>
        }
      />
      <div className="detail-grid">
        <section className="panel" aria-labelledby="sc-h">
          <h2 id="sc-h">Case</h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <StatusBadge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                {STATUS_LABEL[c.status] ?? c.status}
              </StatusBadge>
            </dd>
            <dt>Category</dt>
            <dd>{CATEGORY_LABEL[c.category ?? ''] ?? c.category ?? '—'}</dd>
            <dt>Assigned</dt>
            <dd>{!c.assignedTo ? 'Unassigned' : mine ? 'You' : 'A teammate'}</dd>
            <dt>Customer id</dt>
            <dd>
              <code>{c.customerId ?? '—'}</code>
            </dd>
            <dt>Order</dt>
            <dd>
              {c.orderId ? (
                canSeeOrders ? (
                  <Link href={`/orders/${encodeURIComponent(c.orderId)}`}>{c.orderId}</Link>
                ) : (
                  <code>{c.orderId}</code>
                )
              ) : (
                '—'
              )}
            </dd>
            <dt>Opened</dt>
            <dd>{formatShortIst(c.createdAt)} IST</dd>
            <dt>Version</dt>
            <dd>{c.version}</dd>
          </dl>
          <p className="muted">
            The backend does not resolve staff ids to names, and it has no priority, SLA or category
            filter.
          </p>
        </section>
        <section className="panel" aria-labelledby="sa-h">
          <h2 id="sa-h">Actions</h2>
          {canWork ? (
            <SupportActions
              key={`${c.caseId}:${c.version}`}
              caseId={c.caseId}
              status={c.status}
              version={c.version}
              assignedToMe={mine}
            />
          ) : (
            <p className="notice" role="note">
              Read-only: replying and changing cases needs the support-agent role.
            </p>
          )}
        </section>
      </div>
      <section className="panel" aria-labelledby="sm-h">
        <h2 id="sm-h">Conversation ({c.messages.length})</h2>
        {c.messages.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <ol className="thread">
            {c.messages.map((m) => (
              <li key={m.id} className={m.author === 'STAFF' ? 'msg msg-staff' : 'msg'}>
                <p className="msg-meta">
                  <strong>{m.author === 'STAFF' ? 'Support' : 'Customer'}</strong> ·{' '}
                  {formatShortIst(m.at)} IST
                </p>
                <p className="msg-text">{m.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
