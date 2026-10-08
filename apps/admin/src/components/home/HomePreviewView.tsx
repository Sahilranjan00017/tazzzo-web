import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { formatDateTimeIst } from '@/lib/format'
import {
  AUDIENCE_LABEL,
  EFFECTIVE_LABEL,
  EFFECTIVE_TONE,
  PREVIEW_VIEWS,
  PREVIEW_VIEW_LABEL,
  TYPE_LABEL,
  audienceOf,
  bannerLayouts,
  scheduleText,
  type BannerLayout,
  type Effective,
  type HomeBlock,
  type HomePreview,
  type HomeType,
  type PreviewBlock,
  type PreviewQuery,
  type PreviewView,
} from '@/lib/home-content'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

const query = (q: PreviewQuery, view: PreviewView) => {
  const p = new URLSearchParams({ view, drafts: String(q.drafts) })
  if (q.atLocal) p.set('at', q.atLocal)
  return `/content/home/preview?${p.toString()}`
}

/**
 * Read-only preview of what one channel's Home shows at an instant (backend `GET .../preview/home`; it never publishes).
 * App = phone frame; Website = desktop browser (wide image when present) or mobile browser (mobile image). Banner crops
 * follow the channel's frame; order, schedule, channel and state are shown for every block.
 */
export function HomePreviewView({
  q,
  result,
  blocks,
}: {
  q: PreviewQuery
  result: Ok<HomePreview>
  /** The admin list, for each block's schedule window (the preview omits it). */
  blocks?: HomeBlock[]
}) {
  const windows = new Map((blocks ?? []).map((b) => [b.blockId, b]))
  return (
    <>
      <PageHeader
        title="Home preview"
        description="What customers on one channel would see. Read-only: previewing never publishes anything."
        actions={
          <Link href="/content/home" className="btn">
            All Home content
          </Link>
        }
      />
      <nav aria-label="Preview channel" className="tabs">
        {PREVIEW_VIEWS.map((v) => (
          <Link
            key={v}
            href={query(q, v)}
            className={v === q.view ? 'tab tab-active' : 'tab'}
            aria-current={v === q.view ? 'page' : undefined}
          >
            {PREVIEW_VIEW_LABEL[v]}
          </Link>
        ))}
      </nav>
      <form method="get" className="filters" aria-label="Preview options">
        <input type="hidden" name="view" value={q.view} />
        <label>
          Preview at (IST, UTC+05:30)
          <input type="datetime-local" name="at" defaultValue={q.atLocal ?? ''} />
        </label>
        <label>
          Drafts
          <select name="drafts" defaultValue={String(q.drafts)}>
            <option value="true">Include drafts</option>
            <option value="false">Published only</option>
          </select>
        </label>
        <button type="submit" className="btn">
          Show preview
        </button>
        <Link href={query({ ...q, atLocal: undefined }, q.view)} className="btn">
          Now
        </Link>
      </form>
      {q.invalidAt ? (
        <p className="notice" role="alert">
          The preview time was not valid, so the current time is used.
        </p>
      ) : null}
      {result.kind !== 'ok' ? (
        <BackendFailure
          result={result}
          title="Preview"
          subject="Preview"
          forbiddenMessage="Your roles cannot preview content. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      ) : (
        <PreviewFrame view={q.view} preview={result.data} windows={windows} />
      )}
    </>
  )
}

export function PreviewFrame({
  view,
  preview,
  windows,
}: {
  view: PreviewView
  preview: HomePreview
  windows: Map<string, Pick<HomeBlock, 'startsAt' | 'endsAt'>>
}) {
  const frame =
    view === 'app'
      ? 'phone-frame'
      : view === 'web-mobile'
        ? 'browser-frame browser-mobile'
        : 'browser-frame'
  const layouts = bannerLayouts(view, preview.blocks)
  return (
    <section className="panel" aria-labelledby="pv-h">
      <h2 id="pv-h">
        {PREVIEW_VIEW_LABEL[view]} at {formatDateTimeIst(preview.at)}
      </h2>
      <p className="muted">
        Channel <code>{preview.channel}</code> ·{' '}
        {preview.includeDrafts ? 'drafts shown as if published' : 'published blocks only'} ·{' '}
        {preview.blocks.length} block{preview.blocks.length === 1 ? '' : 's'}. Banners appear only
        when the backend has a public image address configured (the public Home drops them
        otherwise).{' '}
        {view === 'app'
          ? 'App banners: mobile image, 528:178.'
          : view === 'web-mobile'
            ? 'Website below 768 px: mobile image, 16:9.'
            : 'Website from 768 px: 3:1 only when every banner of a carousel (consecutive banners) has a desktop image, otherwise 16:9.'}
      </p>
      <div className={frame} data-view={view}>
        {view !== 'app' ? (
          <div className="browser-bar" aria-hidden="true">
            tazzzo.com
          </div>
        ) : null}
        <ol className="preview-screen" aria-label={`${PREVIEW_VIEW_LABEL[view]} Home`}>
          {preview.blocks.length === 0 ? (
            <li>
              <EmptyState title="Nothing to show" message="No block is visible at this time." />
            </li>
          ) : (
            preview.blocks.map((b, i) => (
              <PreviewItem
                key={b.blockId}
                block={b}
                index={i}
                view={view}
                layout={layouts.get(b.blockId)}
                win={windows.get(b.blockId)}
              />
            ))
          )}
        </ol>
      </div>
    </section>
  )
}

function PreviewItem({
  block: b,
  index,
  view,
  layout,
  win,
}: {
  block: PreviewBlock
  index: number
  view: PreviewView
  layout?: BannerLayout
  win?: Pick<HomeBlock, 'startsAt' | 'endsAt'>
}) {
  const eff = (Object.keys(EFFECTIVE_LABEL) as Effective[]).includes(b.effectiveStatus as Effective)
    ? (b.effectiveStatus as Effective)
    : 'DRAFT'
  const draft = b.status === 'DRAFT'
  const src = layout?.src
  return (
    <li className={`preview-block${draft ? ' preview-draft' : ''}`} data-block-id={b.blockId}>
      <div className="preview-meta">
        <span>#{index + 1}</span>
        <StatusBadge tone={EFFECTIVE_TONE[eff]}>
          {draft ? 'Draft (preview only)' : EFFECTIVE_LABEL[eff]}
        </StatusBadge>
        <span>{TYPE_LABEL[b.type as HomeType] ?? b.type}</span>
        <span>{AUDIENCE_LABEL[audienceOf(b.audience)]}</span>
        <span>{win ? scheduleText(win) : 'schedule unknown'}</span>
      </div>
      {b.type === 'BANNER' ? (
        <div className={`banner-frame banner-${layout?.crop ?? 'app'}`} data-crop={layout?.crop}>
          {src ? (
            // Plain <img>: next/image adds an inline style (blocked by the CSP) and needs remote-host config.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={b.altText ?? b.title} />
          ) : (
            <span className="muted">No image</span>
          )}
          <span className="banner-title">{b.title}</span>
        </div>
      ) : (
        <div className="preview-section">
          <h3>{b.title}</h3>
          <ul className="chips" aria-label={`${b.title} items`}>
            {(b.ids ?? []).map((id) => (
              <li key={id} className="chip">
                {id}
              </li>
            ))}
          </ul>
        </div>
      )}
      {b.type === 'BANNER' && b.subtitle ? <p className="preview-subtitle">{b.subtitle}</p> : null}
      {b.type === 'BANNER' && b.link ? (
        <p className="muted">
          Opens <code>{b.link}</code>
          {view === 'web-desktop' && !b.desktopImageUrl
            ? ' · no desktop image: the mobile image is used'
            : ''}
          {view === 'web-desktop' && layout?.crop === 'web-16x9'
            ? ' · 16:9 because not every banner in this carousel has a desktop image'
            : ''}
        </p>
      ) : null}
    </li>
  )
}
