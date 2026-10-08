'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ImageUploadField, type UploadedImage } from '@/components/upload/ImageUploadField'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { callBff } from '@/lib/bff-client'
import { PUBLICATION_DELAY_NOTE, utcToIstLocal, windowToUtc } from '@/lib/content'
import {
  AUDIENCES,
  AUDIENCE_LABEL,
  LINK_KINDS,
  MAX_ALT,
  MAX_GRID,
  MAX_RAIL,
  MAX_SUBTITLE,
  MAX_TITLE,
  TYPE_LABEL,
  audienceOf,
  displayTextIssue,
  homeErrorMessage,
  homeUpdateInput,
  homeWriteInput,
  idsIssue,
  linkIssue,
  linkOf,
  parseLink,
  scheduleInstant,
  splitIds,
  titleIssue,
  type Audience,
  type BannerCrop,
  type HomeBlock,
  type HomeType,
  type LinkKind,
  type TextIssue,
} from '@/lib/home-content'

type Image = { key: string; url?: string }

const TEXT_COPY: Record<TextIssue, (what: string, max: number) => string> = {
  required: (w) => `${w} is required.`,
  too_long: (w, max) => `${w} must be ${max} characters or fewer.`,
  control: (w) => `${w} must not contain control characters (tabs, line breaks…).`,
  markup: (w) => `${w} must be plain text: no < or >.`,
  invisible: (w) =>
    `${w} must not contain invisible or direction-control characters (for example zero-width spaces or right-to-left overrides).`,
}

const LINK_LABEL: Record<LinkKind, string> = {
  product: 'Product',
  category: 'Category',
  search: 'Search',
}
const LINK_PLACEHOLDER: Record<LinkKind, string> = {
  product: 'TZP-1001',
  category: 'TZC-000123',
  search: 'mango',
}

/**
 * Create, edit or duplicate one HOME block (banner, product rail or category grid). A new block is always a DRAFT. Banner
 * images are uploaded straight to storage (content upload target, key under c/home/) and referenced on save, where the
 * backend verifies them. The schedule is entered and shown in IST (UTC+05:30); start is included, end excluded. A version
 * conflict keeps the person's edits on screen and offers an explicit reload.
 */
export function HomeBlockEditor({
  type,
  block,
  template,
  createXhr,
}: {
  type: HomeType
  /** The block being edited (absent = create). */
  block?: HomeBlock
  /** Prefill for a new draft (duplicate). */
  template?: HomeBlock
  createXhr?: () => XMLHttpRequest
}) {
  const router = useRouter()
  const { run, busy } = useBffAction(homeErrorMessage, { refreshOnConflict: false })
  const src = block ?? template
  const p = src?.payload
  const link = parseLink(p?.link)
  const initialTitle = block
    ? block.title
    : template
      ? `Copy of ${template.title}`.slice(0, MAX_TITLE)
      : ''
  const [title, setTitle] = useState(initialTitle)
  const [audience, setAudience] = useState<Audience>(audienceOf(src?.audience))
  const [sort, setSort] = useState(String(src?.sort ?? 0))
  const [starts, setStarts] = useState(utcToIstLocal(src?.startsAt))
  const [ends, setEnds] = useState(utcToIstLocal(src?.endsAt))
  const [linkKind, setLinkKind] = useState<LinkKind>(link.kind)
  const [linkValue, setLinkValue] = useState(link.value)
  const [subtitle, setSubtitle] = useState(p?.subtitle ?? '')
  const [alt, setAlt] = useState(p?.altText ?? '')
  const [image, setImage] = useState<Image | undefined>(
    p?.imageAssetKey ? { key: p.imageAssetKey, url: src?.imageUrl ?? undefined } : undefined,
  )
  const [desktop, setDesktop] = useState<Image | undefined>(
    p?.desktopImageAssetKey
      ? { key: p.desktopImageAssetKey, url: src?.desktopImageUrl ?? undefined }
      : undefined,
  )
  const [idsText, setIdsText] = useState((p?.ids ?? []).join('\n'))
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<Record<string, unknown>>()
  const [saveError, setSaveError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [dirty, setDirty] = useState(!block)
  const errorRef = useRef<HTMLUListElement>(null)
  const previews = useRef<string[]>([])
  const archived = block?.status === 'ARCHIVED'
  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setDirty(true)
      set(v)
    }

  useEffect(() => {
    const urls = previews.current
    return () => {
      if (typeof URL.revokeObjectURL === 'function') urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])
  useEffect(() => {
    if (!dirty || !block) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, block])

  const requestTarget = (contentType: string, sizeBytes: number) =>
    callBff('/api/bff/content/home/uploads', 'POST', { contentType, sizeBytes })
  /** A local preview that nothing shows any more is released at once (not only on unmount). */
  function release(url: string | undefined) {
    const at = url ? previews.current.indexOf(url) : -1
    if (!url || at < 0) return
    previews.current.splice(at, 1)
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
  }
  function onMobileUploaded(img: UploadedImage) {
    if (img.previewUrl) previews.current.push(img.previewUrl)
    release(image?.url)
    setDirty(true)
    setImage({ key: img.assetKey, url: img.previewUrl })
  }
  function onDesktopUploaded(img: UploadedImage) {
    if (img.previewUrl) previews.current.push(img.previewUrl)
    release(desktop?.url)
    setDirty(true)
    setDesktop({ key: img.assetKey, url: img.previewUrl })
  }
  function removeDesktop() {
    release(desktop?.url)
    setDirty(true)
    setDesktop(undefined)
  }

  function review(e: FormEvent) {
    e.preventDefault()
    const msgs: string[] = []
    const t = title.trim()
    const ti = titleIssue(t)
    if (ti) msgs.push(TEXT_COPY[ti]('Title', MAX_TITLE))
    const sortN = /^\d{1,5}$/.test(sort.trim()) ? Number(sort.trim()) : Number.NaN
    if (!(sortN >= 0 && sortN <= 10_000)) msgs.push('Order must be a whole number from 0 to 10000.')
    const from = scheduleInstant(starts, src?.startsAt, windowToUtc, utcToIstLocal)
    const to = scheduleInstant(ends, src?.endsAt, windowToUtc, utcToIstLocal)
    if (starts && !from) msgs.push('The start time is not valid.')
    if (ends && !to) msgs.push('The end time is not valid.')
    if (from && to && Date.parse(from) >= Date.parse(to))
      msgs.push('The end time must be after the start time.')
    let payload: Record<string, unknown> = {}
    if (type === 'BANNER') {
      if (!image) msgs.push('Upload the mobile (app) image.')
      const li = linkIssue(linkKind, linkValue)
      if (li) msgs.push(li)
      const s = subtitle.trim()
      const a = alt.trim()
      const si = s ? displayTextIssue(s, MAX_SUBTITLE) : undefined
      if (si) msgs.push(TEXT_COPY[si]('Subtitle', MAX_SUBTITLE))
      const ai = a ? displayTextIssue(a, MAX_ALT) : undefined
      if (ai) msgs.push(TEXT_COPY[ai]('Alt text', MAX_ALT))
      payload = {
        imageAssetKey: image?.key ?? '',
        ...(desktop ? { desktopImageAssetKey: desktop.key } : {}),
        link: linkOf(linkKind, linkValue),
        ...(s ? { subtitle: s } : {}),
        ...(a ? { altText: a } : {}),
      }
    } else {
      const ids = splitIds(idsText)
      const ii = idsIssue(type, ids)
      if (ii) msgs.push(ii)
      payload = { ids }
    }
    const candidate = {
      type,
      title: t,
      sort: sortN,
      audience,
      ...(from ? { startsAt: from } : {}),
      ...(to ? { endsAt: to } : {}),
      payload,
      ...(block ? { blockId: block.blockId, expectedVersion: block.version } : {}),
    }
    const parsed = (block ? homeUpdateInput : homeWriteInput).safeParse(candidate)
    if (!parsed.success && msgs.length === 0)
      msgs.push('Some values are not accepted. Review the fields and try again.')
    setErrors([...new Set(msgs)])
    if (msgs.length === 0 && parsed.success) {
      setSaveError(undefined)
      setConfirm(candidate)
    } else requestAnimationFrame(() => errorRef.current?.focus())
  }

  const live = block?.status === 'PUBLISHED'
  const disabled = archived || conflict
  return (
    <>
      {conflict ? (
        <div className="notice" role="alert">
          <p>
            This block changed since you loaded it, so your changes were not saved. Your edits are
            still shown below. Reloading shows the latest version and discards them.
          </p>
          <button type="button" className="btn" onClick={() => router.refresh()}>
            Reload latest version
          </button>
        </div>
      ) : null}
      <form
        className="stack"
        onSubmit={review}
        noValidate
        aria-label={block ? `Edit ${TYPE_LABEL[type]}` : `New ${TYPE_LABEL[type]}`}
      >
        <label>
          Title (shown to customers on banners and as the section heading)
          <input
            value={title}
            maxLength={MAX_TITLE}
            disabled={disabled}
            onChange={(e) => touch(setTitle)(e.target.value)}
          />
        </label>
        <fieldset disabled={disabled}>
          <legend>Channel</legend>
          {AUDIENCES.map((a) => (
            <label key={a} className="inline">
              <input
                type="radio"
                name="audience"
                value={a}
                checked={audience === a}
                onChange={() => touch(setAudience)(a)}
              />
              {AUDIENCE_LABEL[a]}
            </label>
          ))}
        </fieldset>

        {type === 'BANNER' ? (
          <>
            <section className="panel" aria-labelledby="img-h">
              <h2 id="img-h">Images</h2>
              <div className="banner-images">
                <div className="stack">
                  <h3>Mobile image (app and mobile website)</h3>
                  <p className="muted">App, 528:178 (about 3:1)</p>
                  <BannerFrame image={image} crop="app" label="Mobile image in the app" />
                  <p className="muted">Website below 768 px wide, 16:9</p>
                  <BannerFrame
                    image={image}
                    crop="web-16x9"
                    label="Mobile image on the mobile website"
                  />
                  {!disabled ? (
                    <ImageUploadField
                      label={image ? 'Replace mobile image' : 'Mobile image'}
                      hint="Required. JPEG, PNG or WebP. Cropped to 528:178 (about 3:1) in the app and to 16:9 on the mobile website; keep the subject centred."
                      requestTarget={requestTarget}
                      describe={homeErrorMessage}
                      onUploaded={onMobileUploaded}
                      createXhr={createXhr}
                    />
                  ) : null}
                </div>
                <div className="stack">
                  <h3>Desktop image (optional, website on desktop)</h3>
                  <p className="muted">Website from 768 px wide, 3:1</p>
                  <BannerFrame image={desktop ?? image} crop="web-3x1" label="Desktop image" />
                  <p className="muted">
                    {desktop
                      ? 'Shown at 3:1 only when every banner in the same carousel (consecutive banners) has a desktop image; otherwise the carousel stays 16:9. Check the preview.'
                      : 'Without one, the website shows the mobile image on desktop, and this banner’s carousel stays 16:9.'}
                  </p>
                  {!disabled ? (
                    <>
                      <ImageUploadField
                        label={desktop ? 'Replace desktop image' : 'Desktop image'}
                        hint="Optional. Website from 768 px wide: 3:1, but only when every banner in the same carousel has a desktop image (otherwise 16:9)."
                        requestTarget={requestTarget}
                        describe={homeErrorMessage}
                        onUploaded={onDesktopUploaded}
                        createXhr={createXhr}
                      />
                      {desktop ? (
                        <button type="button" className="btn" onClick={removeDesktop}>
                          Remove desktop image
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </section>
            <fieldset disabled={disabled}>
              <legend>Link (where the banner leads)</legend>
              <div className="row">
                <label>
                  Link type
                  <select
                    value={linkKind}
                    onChange={(e) => touch(setLinkKind)(e.target.value as LinkKind)}
                  >
                    {LINK_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {LINK_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {linkKind === 'search' ? 'Search text' : `${LINK_LABEL[linkKind]} id`}
                  <input
                    value={linkValue}
                    placeholder={LINK_PLACEHOLDER[linkKind]}
                    maxLength={linkKind === 'search' ? 64 : 44}
                    onChange={(e) => touch(setLinkValue)(e.target.value)}
                  />
                </label>
              </div>
              <p className="muted">
                Links can only open a product, a category or a search; never a web address.
                {linkValue.trim() ? (
                  <>
                    {' '}
                    Will open <code>{linkOf(linkKind, linkValue)}</code>.
                  </>
                ) : null}
              </p>
            </fieldset>
            <label>
              Subtitle (optional)
              <input
                value={subtitle}
                maxLength={MAX_SUBTITLE}
                disabled={disabled}
                onChange={(e) => touch(setSubtitle)(e.target.value)}
              />
            </label>
            <label>
              Alt text (optional; read by screen readers, defaults to the title)
              <input
                value={alt}
                maxLength={MAX_ALT}
                disabled={disabled}
                onChange={(e) => touch(setAlt)(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            {type === 'PRODUCT_RAIL'
              ? `Product ids (1 to ${MAX_RAIL}, one per line or comma-separated)`
              : `Category node ids (1 to ${MAX_GRID}, one per line or comma-separated)`}
            <textarea
              rows={6}
              value={idsText}
              disabled={disabled}
              placeholder={type === 'PRODUCT_RAIL' ? 'TZP-1001\nTZP-1002' : 'TZC-000123'}
              onChange={(e) => touch(setIdsText)(e.target.value)}
            />
            <span className="muted">
              {splitIds(idsText).length} of {type === 'PRODUCT_RAIL' ? MAX_RAIL : MAX_GRID}
            </span>
          </label>
        )}

        <label>
          Order (lower shows first; reordering on the list re-sequences all blocks)
          <input
            value={sort}
            inputMode="numeric"
            disabled={disabled}
            onChange={(e) => touch(setSort)(e.target.value)}
          />
        </label>
        <fieldset disabled={disabled}>
          <legend>Schedule (optional, IST, UTC+05:30)</legend>
          <div className="row">
            <label>
              Starts (IST)
              <input
                type="datetime-local"
                value={starts}
                onChange={(e) => touch(setStarts)(e.target.value)}
              />
            </label>
            <label>
              Ends (IST)
              <input
                type="datetime-local"
                value={ends}
                onChange={(e) => touch(setEnds)(e.target.value)}
              />
            </label>
          </div>
          <p className="muted">
            Start is included, end is excluded. A blank box means no bound (saving clears it).
            Publishing is separate: a block is shown only when it is published and inside its
            schedule.
          </p>
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert" tabIndex={-1} ref={errorRef}>
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        {archived ? (
          <p className="muted">Archived blocks are final and cannot be edited.</p>
        ) : (
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || conflict || !dirty}>
              {block ? 'Review changes' : 'Review new draft'}
            </button>
            {block && dirty ? <span className="muted">Unsaved changes</span> : null}
          </div>
        )}
      </form>
      <ConfirmDialog
        open={confirm !== undefined}
        title={block ? 'Save changes to this block?' : 'Create this block as a draft?'}
        description={
          block
            ? live
              ? `This block is PUBLISHED: your edit changes what customers see on ${AUDIENCE_LABEL[audience]}. ${PUBLICATION_DELAY_NOTE}`
              : 'It is not public until published.'
            : 'It is created as a draft and is not visible to customers until you publish it.'
        }
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const path = block
            ? `/api/bff/content/home/blocks/${encodeURIComponent(block.blockId)}`
            : '/api/bff/content/home/blocks'
          void run(
            path,
            block ? 'PUT' : 'POST',
            confirm,
            block ? 'Block saved.' : 'Draft created.',
          ).then((r) => {
            if (r.ok || r.status === 401) {
              setConfirm(undefined)
              if (r.ok && !block) {
                const id = (r.data as { blockId?: string } | undefined)?.blockId
                router.push(id ? `/content/home/${encodeURIComponent(id)}` : '/content/home')
              }
              return
            }
            if (r.status === 409 && r.code === 'STALE_VERSION') {
              setConfirm(undefined)
              setConflict(true)
              return
            }
            // Anything else keeps the dialog open with the reason.
            setSaveError(homeErrorMessage(r))
          })
        }}
      >
        {saveError ? (
          <p className="field-error" role="alert">
            {saveError}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  )
}

/** The banner image cropped to its channel's frame, or a neutral placeholder. */
export function BannerFrame({
  image,
  crop,
  label,
}: {
  image?: { url?: string }
  crop: BannerCrop
  label: string
}) {
  return (
    <div className={`banner-frame banner-${crop}`} data-crop={crop}>
      {image?.url ? (
        // Plain <img>: next/image adds an inline style (blocked by the CSP) and needs remote-host config.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.url} alt={`${label} preview`} />
      ) : (
        <span className="muted">{image ? 'Uploaded image (no preview address)' : 'No image'}</span>
      )}
    </div>
  )
}
