import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import {
  BLOCK_STATUSES,
  EFFECTIVE_TONE,
  FAQ_CATEGORY_LABEL,
  PUBLICATION_DELAY_NOTE,
  effectiveStatus,
  type ContentBlock,
} from '@/lib/content'
import { formatShortIst } from '@/lib/format'
import { FaqEditor, FaqStatusActions } from './FaqEditor'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

export function FaqListView({
  result,
  status,
  canWrite,
  nowMs,
}: {
  result: Ok<{ items: ContentBlock[] }>
  status?: string
  canWrite: boolean
  nowMs: number
}) {
  const header = (
    <PageHeader
      title="FAQs"
      description="Help-centre questions, shared by every customer platform. The backend returns up to 200 entries, with no paging."
      actions={
        canWrite ? (
          <Link href="/content/faqs/new" className="btn btn-primary">
            New FAQ
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
          title="FAQs"
          subject="FAQs"
          forbiddenMessage="Your roles cannot read content. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const items = result.data.items.filter((b) => b.type === 'FAQ')
  return (
    <>
      {header}
      <form method="get" className="filters" aria-label="FAQ filters">
        <label>
          Stored status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">All</option>
            {BLOCK_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Apply
        </button>
      </form>
      <p className="muted">
        “Live now” is derived from the publication window as of this page load.{' '}
        {PUBLICATION_DELAY_NOTE}
      </p>
      {items.length === 0 ? (
        <EmptyState
          title="No FAQs"
          message={status ? 'No FAQs have this status.' : 'No FAQs have been created yet.'}
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="FAQ table">
          <table className="data-table">
            <caption className="sr-only">{items.length} FAQs</caption>
            <thead>
              <tr>
                <th scope="col">Question</th>
                <th scope="col">Category</th>
                <th scope="col">Visibility</th>
                <th scope="col" className="num">
                  Order
                </th>
                <th scope="col">Window (IST)</th>
                <th scope="col" className="num">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const eff = effectiveStatus(b, nowMs)
                return (
                  <tr key={b.blockId}>
                    <th scope="row" className="wrap">
                      <Link href={`/content/faqs/${encodeURIComponent(b.blockId)}`}>
                        {b.payload.question ?? b.title}
                      </Link>
                    </th>
                    <td>
                      {FAQ_CATEGORY_LABEL[b.payload.faqCategory ?? ''] ??
                        b.payload.faqCategory ??
                        '—'}
                    </td>
                    <td>
                      <StatusBadge tone={EFFECTIVE_TONE[eff]}>{eff}</StatusBadge>
                    </td>
                    <td className="num">{b.sort}</td>
                    <td>
                      {b.startsAt || b.endsAt
                        ? `${formatShortIst(b.startsAt)} → ${b.endsAt ? formatShortIst(b.endsAt) : 'open'}`
                        : '—'}
                    </td>
                    <td className="num">{b.version}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

export function FaqDetailView({
  result,
  canWrite,
  nowMs,
}: {
  result: Ok<ContentBlock>
  canWrite: boolean
  nowMs: number
}) {
  if (result.kind !== 'ok') {
    return (
      <BackendFailure
        result={result}
        title="FAQ"
        subject="FAQ"
        forbiddenMessage="Your roles cannot read content."
        refresh={<RefreshButton />}
      />
    )
  }
  const b = result.data
  if (b.type !== 'FAQ')
    return (
      <>
        <PageHeader title="Not an FAQ" />
        <p className="notice" role="alert">
          This content entry is a {b.type}, not an FAQ. Home content is managed in{' '}
          <Link href={`/content/home/${encodeURIComponent(b.blockId)}`}>Home content</Link>.
        </p>
      </>
    )
  const eff = effectiveStatus(b, nowMs)
  return (
    <>
      <PageHeader
        title={b.payload.question ?? b.title}
        description={b.blockId}
        actions={
          <Link href="/content/faqs" className="btn">
            All FAQs
          </Link>
        }
      />
      <section className="panel" aria-labelledby="fs-h">
        <h2 id="fs-h">Status</h2>
        <p>
          <StatusBadge tone={EFFECTIVE_TONE[eff]}>{eff}</StatusBadge>{' '}
          <span className="muted">
            stored {b.status.toLowerCase()} · version {b.version}
          </span>
        </p>
        {canWrite ? (
          <FaqStatusActions
            key={`${b.blockId}:${b.version}`}
            blockId={b.blockId}
            status={b.status}
            version={b.version}
          />
        ) : (
          <p className="notice" role="note">
            Read-only: changing content needs the cms-writer role.
          </p>
        )}
      </section>
      {canWrite ? (
        <FaqEditor key={`${b.blockId}:${b.version}`} block={b} />
      ) : (
        <section className="panel">
          <h2>Content</h2>
          <p className="muted">{b.payload.faqCategory}</p>
          <p>
            <strong>{b.payload.question}</strong>
          </p>
          <p className="msg-text">{b.payload.answer}</p>
        </section>
      )}
    </>
  )
}
