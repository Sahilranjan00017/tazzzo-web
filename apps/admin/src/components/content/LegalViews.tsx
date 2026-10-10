import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import {
  BLOCK_STATUSES,
  EFFECTIVE_TONE,
  LEGAL_SLUGS,
  LEGAL_SLUG_LABEL,
  PUBLICATION_DELAY_NOTE,
  effectiveStatus,
  legalParagraphs,
  liveLegalFor,
  type ContentBlock,
} from '@/lib/content'
import { formatShortIst } from '@/lib/format'
import { LegalEditor, LegalStatusActions } from './LegalEditor'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

const FORBIDDEN = 'Your roles cannot read content. The backend allows it for reader and cms-writer.'

/** Which document each public page serves right now, so an editor never has to infer it from a table. */
function LiveNow({ items, nowMs }: { items: ContentBlock[]; nowMs: number }) {
  return (
    <section className="panel" aria-labelledby="legal-live-h">
      <h2 id="legal-live-h">Live now</h2>
      <p className="muted">
        The document each public page serves right now (published and inside its window, as of this
        page load).
      </p>
      <ul>
        {LEGAL_SLUGS.map((slug) => {
          const doc = liveLegalFor(items, slug, nowMs)
          const count = items.filter(
            (b) =>
              b.payload.legalSlug === slug &&
              b.type === 'LEGAL' &&
              effectiveStatus(b, nowMs) === 'live',
          ).length
          return (
            <li key={slug} data-testid={`live-${slug.toLowerCase()}`}>
              <strong>{LEGAL_SLUG_LABEL[slug]}</strong>
              {' · '}
              {doc ? (
                <>
                  <StatusBadge tone="success">live</StatusBadge>{' '}
                  <Link href={`/content/legal/${encodeURIComponent(doc.blockId)}`}>
                    {doc.title}
                  </Link>
                  {doc.payload.effectiveDate ? (
                    <span className="muted"> · effective {doc.payload.effectiveDate}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <StatusBadge tone="warning">none live</StatusBadge>{' '}
                  <span className="muted">
                    The public {LEGAL_SLUG_LABEL[slug]} page shows “not found” until a document is
                    published.
                  </span>
                </>
              )}
              {count > 1 ? (
                <span className="field-error" role="alert">
                  {' '}
                  {count} documents are live for this page; the most recently edited one is shown.
                  Unpublish the others.
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function LegalListView({
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
      title="Legal documents"
      description="Terms and Privacy as shown on the website and in the app. One document per page can be live at a time."
      actions={
        canWrite ? (
          <Link href="/content/legal/new" className="btn btn-primary">
            New document
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
          title="Legal documents"
          subject="legal documents"
          forbiddenMessage={FORBIDDEN}
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const all = result.data.items.filter((b) => b.type === 'LEGAL')
  return (
    <>
      {header}
      <LiveNow items={all} nowMs={nowMs} />
      <form method="get" className="filters" aria-label="Legal document filters">
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
        “Visibility” is derived from the publication window as of this page load.{' '}
        {PUBLICATION_DELAY_NOTE}
      </p>
      {all.length === 0 ? (
        <EmptyState
          title="No legal documents"
          message={
            status
              ? 'No legal documents have this status.'
              : 'No legal documents have been created yet.'
          }
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Legal documents table">
          <table className="data-table">
            <caption className="sr-only">{all.length} legal documents</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Document</th>
                <th scope="col">Visibility</th>
                <th scope="col">Effective</th>
                <th scope="col">Window (IST)</th>
                <th scope="col" className="num">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {all.map((b) => {
                const eff = effectiveStatus(b, nowMs)
                return (
                  <tr key={b.blockId}>
                    <th scope="row" className="wrap">
                      <Link href={`/content/legal/${encodeURIComponent(b.blockId)}`}>
                        {b.title}
                      </Link>
                    </th>
                    <td>
                      {LEGAL_SLUG_LABEL[b.payload.legalSlug ?? ''] ?? b.payload.legalSlug ?? '—'}
                    </td>
                    <td>
                      <StatusBadge tone={EFFECTIVE_TONE[eff]}>{eff}</StatusBadge>
                    </td>
                    <td>{b.payload.effectiveDate ?? '—'}</td>
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

export function LegalDetailView({
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
        title="Legal document"
        subject="legal document"
        forbiddenMessage="Your roles cannot read content."
        refresh={<RefreshButton />}
      />
    )
  }
  const b = result.data
  if (b.type !== 'LEGAL')
    return (
      <>
        <PageHeader title="Not a legal document" />
        <p className="notice" role="alert">
          This content entry is a {b.type} on {b.placement}.{' '}
          {b.type === 'FAQ' ? (
            <Link href={`/content/faqs/${encodeURIComponent(b.blockId)}`}>Open it in FAQs</Link>
          ) : (
            <Link href={`/content/home/${encodeURIComponent(b.blockId)}`}>
              Open it in Home content
            </Link>
          )}
          .
        </p>
      </>
    )
  const eff = effectiveStatus(b, nowMs)
  const label = LEGAL_SLUG_LABEL[b.payload.legalSlug ?? ''] ?? b.payload.legalSlug ?? 'Legal'
  return (
    <>
      <PageHeader
        title={b.title}
        description={`${label} · ${b.blockId}`}
        actions={
          <Link href="/content/legal" className="btn">
            All legal documents
          </Link>
        }
      />
      <section className="panel" aria-labelledby="ls-h">
        <h2 id="ls-h">Status</h2>
        <p>
          <StatusBadge tone={EFFECTIVE_TONE[eff]}>{eff}</StatusBadge>{' '}
          <span className="muted">
            stored {b.status.toLowerCase()} · version {b.version}
          </span>
        </p>
        {canWrite ? (
          <LegalStatusActions
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
        <LegalEditor key={`${b.blockId}:${b.version}`} block={b} />
      ) : (
        <section className="panel">
          <h2>Content</h2>
          <p className="muted">
            {label}
            {b.payload.effectiveDate ? ` · effective ${b.payload.effectiveDate}` : ''}
          </p>
          {legalParagraphs(b.payload.body ?? '').map((t, i) => (
            <p key={i} className="msg-text">
              {t}
            </p>
          ))}
        </section>
      )}
    </>
  )
}
