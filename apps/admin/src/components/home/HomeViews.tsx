import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { PUBLICATION_DELAY_NOTE } from '@/lib/content'
import { formatShortIst } from '@/lib/format'
import {
  AUDIENCES,
  AUDIENCE_LABEL,
  EFFECTIVE_LABEL,
  EFFECTIVE_TONE,
  HOME_TYPES,
  TYPE_LABEL,
  actorLabel,
  audienceOf,
  effectiveOf,
  scheduleText,
  type HomeBlock,
  type HomeType,
} from '@/lib/home-content'
import { BannerFrame, HomeBlockEditor } from './HomeBlockEditor'
import { HomeBlockTable } from './HomeBlockTable'
import { HomeStatusActions } from './HomeStatusActions'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

export function HomeListView({
  result,
  filter,
  canWrite,
  nowMs,
}: {
  result: Ok<{ items: HomeBlock[]; archivedCapped?: boolean }>
  filter: { status?: string; audience?: string }
  canWrite: boolean
  nowMs: number
}) {
  const header = (
    <PageHeader
      title="Home content"
      description="Banners, product rails and category grids on the customer Home, per channel. Up to 200 blocks."
      actions={
        <>
          <Link href="/content/home/preview" className="btn">
            Preview
          </Link>
          {canWrite
            ? HOME_TYPES.map((t) => (
                <Link key={t} href={`/content/home/new?type=${t}`} className="btn btn-primary">
                  New {TYPE_LABEL[t].toLowerCase()}
                </Link>
              ))
            : null}
        </>
      }
    />
  )
  if (result.kind !== 'ok')
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Home content"
          subject="Home content"
          forbiddenMessage="Your roles cannot read content. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  const items = result.data.items.filter((b) => b.placement === 'HOME' || !b.placement)
  const filtered = Boolean(filter.status || filter.audience)
  return (
    <>
      {header}
      <form method="get" className="filters" aria-label="Home content filters">
        <label>
          Stored status
          <select name="status" defaultValue={filter.status ?? ''}>
            <option value="">All</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </label>
        <label>
          Channel
          <select name="audience" defaultValue={filter.audience ?? ''}>
            <option value="">All</option>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Apply
        </button>
      </form>
      <p className="muted">
        Status is the backend&apos;s view as of this page load (Scheduled = published, before its
        start; Expired = published, after its end). Times are IST. {PUBLICATION_DELAY_NOTE}
      </p>
      {!canWrite ? (
        <p className="notice" role="note">
          Read-only: changing Home content needs the cms-writer role.
        </p>
      ) : null}
      {result.data.archivedCapped ? (
        <p className="muted">
          Showing the first 200 archived blocks (the backend lists at most 200 per request). Draft
          and published blocks are always complete.
        </p>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          title="No Home blocks"
          message={
            filtered ? 'No blocks match these filters.' : 'No Home content has been created yet.'
          }
        />
      ) : (
        <HomeBlockTable blocks={items} canWrite={canWrite} nowMs={nowMs} filtered={filtered} />
      )}
    </>
  )
}

export function HomeDetailView({
  result,
  canWrite,
  nowMs,
}: {
  result: Ok<HomeBlock>
  canWrite: boolean
  nowMs: number
}) {
  if (result.kind !== 'ok')
    return (
      <BackendFailure
        result={result}
        title="Home block"
        subject="Home block"
        forbiddenMessage="Your roles cannot read content."
        refresh={<RefreshButton />}
      />
    )
  const b = result.data
  if (b.placement !== 'HOME' || !(HOME_TYPES as readonly string[]).includes(b.type))
    return (
      <>
        <PageHeader title="Not Home content" />
        <p className="notice" role="alert">
          This content entry is a {b.type} on {b.placement}. FAQs are managed in{' '}
          <Link href={`/content/faqs/${encodeURIComponent(b.blockId)}`}>FAQs</Link>.
        </p>
      </>
    )
  const eff = effectiveOf(b, nowMs)
  const type = b.type as HomeType
  return (
    <>
      <PageHeader
        title={b.title}
        description={`${TYPE_LABEL[type]} · ${b.blockId}`}
        actions={
          <>
            <Link href="/content/home/preview" className="btn">
              Preview
            </Link>
            <Link href="/content/home" className="btn">
              All Home content
            </Link>
          </>
        }
      />
      <section className="panel" aria-labelledby="hs-h">
        <h2 id="hs-h">Status</h2>
        <p>
          <StatusBadge tone={EFFECTIVE_TONE[eff]}>{EFFECTIVE_LABEL[eff]}</StatusBadge>{' '}
          <span className="muted">
            stored {b.status.toLowerCase()} · {AUDIENCE_LABEL[audienceOf(b.audience)]} ·{' '}
            {scheduleText(b)} · order {b.sort} · version {b.version}
          </span>
        </p>
        <p className="muted">
          Created by {actorLabel(b.createdBy)}
          {b.createdAt ? ` on ${formatShortIst(b.createdAt)} IST` : ''}; last changed by{' '}
          {actorLabel(b.updatedBy)}
          {b.updatedAt ? ` on ${formatShortIst(b.updatedAt)} IST` : ''}.
        </p>
        {canWrite ? (
          <HomeStatusActions key={`${b.blockId}:${b.version}`} block={b} />
        ) : (
          <p className="notice" role="note">
            Read-only: changing Home content needs the cms-writer role.
          </p>
        )}
      </section>
      {canWrite ? (
        <section className="panel" aria-labelledby="he-h">
          <h2 id="he-h">Content</h2>
          <HomeBlockEditor key={`${b.blockId}:${b.version}`} type={type} block={b} />
        </section>
      ) : (
        <ReadOnlyBlock block={b} />
      )}
    </>
  )
}

function ReadOnlyBlock({ block: b }: { block: HomeBlock }) {
  const p = b.payload
  return (
    <section className="panel" aria-labelledby="hr-h">
      <h2 id="hr-h">Content</h2>
      {b.type === 'BANNER' ? (
        <div className="banner-images">
          <BannerFrame image={{ url: b.imageUrl ?? undefined }} crop="app" label="App banner" />
          <BannerFrame
            image={{ url: b.desktopImageUrl ?? b.imageUrl ?? undefined }}
            crop={b.desktopImageUrl ? 'web-3x1' : 'web-16x9'}
            label="Website desktop banner"
          />
        </div>
      ) : null}
      <dl className="kv">
        {b.type === 'BANNER' ? (
          <>
            <div className="kv-row">
              <dt>Link</dt>
              <dd>
                <code>{p.link ?? '—'}</code>
              </dd>
            </div>
            <div className="kv-row">
              <dt>Subtitle</dt>
              <dd>{p.subtitle ?? '—'}</dd>
            </div>
            <div className="kv-row">
              <dt>Alt text</dt>
              <dd>{p.altText ?? '(defaults to the title)'}</dd>
            </div>
          </>
        ) : (
          <div className="kv-row">
            <dt>{b.type === 'PRODUCT_RAIL' ? 'Products' : 'Categories'}</dt>
            <dd>{(p.ids ?? []).join(', ') || '—'}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}
