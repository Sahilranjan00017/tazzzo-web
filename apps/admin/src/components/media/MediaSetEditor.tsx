'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ImageUploadField, type UploadedImage } from '@/components/upload/ImageUploadField'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { callBff } from '@/lib/bff-client'
import {
  altText,
  mediaErrorMessage,
  setInput,
  type MediaAsset,
  type MediaSet,
  type OwnerType,
} from '@/lib/media'

type Row = {
  /** Stable React key for the row (survives a key replacement). */
  rowId: string
  assetId: string
  assetKey: string
  role: 'PRIMARY' | 'GALLERY'
  sort: string
  alt: string
  width?: number
  height?: number
  contentType?: string
  /** Thumbnail: the backend's resolved public URL, or a local preview of a just-uploaded file. */
  url?: string
  origin: 'stored' | 'new' | 'replaced'
  remove: boolean
}

const fromAsset = (a: MediaAsset): Row => ({
  rowId: a.assetId,
  assetId: a.assetId,
  assetKey: a.assetKey,
  role: a.role === 'PRIMARY' ? 'PRIMARY' : 'GALLERY',
  sort: String(a.sortOrder),
  alt: a.altText ?? '',
  width: a.width ?? undefined,
  height: a.height ?? undefined,
  contentType: a.contentType ?? undefined,
  url: a.url ?? undefined,
  origin: 'stored',
  remove: false,
})

const newId = () =>
  `img-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Date.now().toString(36)}`

/**
 * Edit one product/SKU media set: upload new images (direct to storage), replace an image (new upload, key swapped in the
 * same slot), set role / order / alt text, and remove images from the set. Everything is saved together as ONE whole-set
 * replace with the loaded version; the backend verifies every newly referenced key. A version conflict keeps the
 * person's unsaved edits on screen and offers an explicit reload. Remounted with `key={owner:version}` after a save.
 */
export function MediaSetEditor({
  ownerType,
  ownerId,
  set,
  createXhr,
}: {
  ownerType: OwnerType
  ownerId: string
  /** Undefined = the owner has no media set yet; the first save creates it. */
  set?: MediaSet
  /** Test seam for the storage PUT. */
  createXhr?: () => XMLHttpRequest
}) {
  const router = useRouter()
  const { run, busy } = useBffAction(mediaErrorMessage, { refreshOnConflict: false })
  const [rows, setRows] = useState<Row[]>((set?.assets ?? []).map(fromAsset))
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof setInput.parse>>()
  const [saveError, setSaveError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [replacing, setReplacing] = useState<string>()
  const previews = useRef<string[]>([])
  const patch = (rowId: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.rowId === rowId ? { ...r, ...p } : r)))
  const dirty = rows.some((r) => r.origin !== 'stored' || r.remove) || rowsChanged(rows, set)

  useEffect(() => {
    const urls = previews.current
    return () => {
      if (typeof URL.revokeObjectURL === 'function') urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const requestTarget = (contentType: string, sizeBytes: number) =>
    callBff('/api/bff/media/uploads', 'POST', { ownerType, ownerId, contentType, sizeBytes })
  const keep = (img: UploadedImage) => {
    if (img.previewUrl) previews.current.push(img.previewUrl)
  }

  function addUploaded(img: UploadedImage) {
    keep(img)
    setRows((rs) => {
      const live = rs.filter((r) => !r.remove)
      const orders = live.map((r) => Number(r.sort)).filter((n) => Number.isInteger(n))
      const first = live.length === 0
      return [
        ...rs,
        {
          rowId: newId(),
          assetId: newId(),
          assetKey: img.assetKey,
          role: first ? 'PRIMARY' : 'GALLERY',
          sort: String(first ? 0 : Math.max(0, ...orders) + 1),
          alt: '',
          width: img.width,
          height: img.height,
          contentType: img.contentType,
          url: img.previewUrl,
          origin: 'new',
          remove: false,
        },
      ]
    })
  }

  function replaceWith(rowId: string, img: UploadedImage) {
    keep(img)
    setRows((rs) =>
      rs.map((r) =>
        r.rowId === rowId
          ? {
              ...r,
              assetKey: img.assetKey,
              contentType: img.contentType,
              width: img.width,
              height: img.height,
              url: img.previewUrl,
              origin: r.origin === 'new' ? 'new' : 'replaced',
            }
          : r,
      ),
    )
    setReplacing(undefined)
  }

  function review(e: FormEvent) {
    e.preventDefault()
    const kept = rows.filter((r) => !r.remove)
    const msgs: string[] = []
    for (const r of kept) {
      const a = altText.safeParse(r.alt)
      if (!a.success)
        msgs.push(
          `${r.assetKey}: alt text must be 300 characters or fewer, with no < or > and no control characters.`,
        )
    }
    const candidate = {
      ownerType,
      ownerId,
      assets: kept.map((r) => ({
        assetId: r.assetId,
        assetKey: r.assetKey,
        role: r.role,
        sortOrder: /^\d{1,7}$/.test(r.sort.trim()) ? Number(r.sort.trim()) : Number.NaN,
        ...(r.alt.trim() ? { altText: r.alt } : {}),
        ...(r.width && r.height ? { width: r.width, height: r.height } : {}),
        ...(r.contentType ? { contentType: r.contentType } : {}),
      })),
      ...(set ? { expectedVersion: set.version } : {}),
    }
    const parsed = setInput.safeParse(candidate)
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const last = String(i.path.at(-1))
        msgs.push(
          last === 'sortOrder'
            ? i.message.includes('primary')
              ? 'The primary image must have order 0.'
              : i.message.includes('duplicate')
                ? 'Each image needs its own order number.'
                : 'Order must be a whole number.'
            : last === 'assets'
              ? i.message.includes('primary')
                ? 'Only one image can be primary.'
                : 'A media set holds at most 50 images.'
              : last === 'contentType'
                ? 'An image has an unsupported content type.'
                : last === 'altText'
                  ? 'Alt text must be 300 characters or fewer, with no < or > and no control characters.'
                  : i.message,
        )
      }
    }
    setErrors([...new Set(msgs)])
    if (msgs.length === 0 && parsed.success) {
      setSaveError(undefined)
      setConfirm(parsed.data)
    }
  }

  const removed = rows.filter((r) => r.remove && r.origin !== 'new').length
  const added = rows.filter((r) => !r.remove && r.origin === 'new').length
  const replaced = rows.filter((r) => !r.remove && r.origin === 'replaced').length
  return (
    <>
      {conflict ? (
        <div className="notice" role="alert">
          <p>
            Someone else changed this media set since you loaded it, so your changes were not saved.
            Your edits are still shown below. Reloading shows the latest version and discards them
            (uploaded files that were not saved stay unused in storage).
          </p>
          <button type="button" className="btn" onClick={() => router.refresh()}>
            Reload latest version
          </button>
        </div>
      ) : null}
      <form className="stack" onSubmit={review} noValidate aria-label="Edit media set">
        {rows.length === 0 ? (
          <p className="muted">No images yet. Upload one below.</p>
        ) : (
          <ul className="media-grid" aria-label="Media assets">
            {rows.map((r) => (
              <li
                key={r.rowId}
                className={`media-card${r.remove ? ' row-removed' : ''}`}
                aria-label={r.assetKey}
              >
                {r.url ? (
                  // Plain <img>: next/image adds an inline style (blocked by the CSP) and needs remote-host config.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="thumb" src={r.url} alt="" width={96} height={96} />
                ) : (
                  <span className="thumb thumb-empty" aria-hidden="true">
                    No preview
                  </span>
                )}
                <div className="media-fields">
                  <p className="wrap">
                    <code>{r.assetKey}</code>{' '}
                    {r.origin === 'new' ? <span className="badge badge-info">new</span> : null}
                    {r.origin === 'replaced' ? (
                      <span className="badge badge-info">replaced</span>
                    ) : null}
                    <span className="muted">
                      {' '}
                      {r.width && r.height ? `${r.width}×${r.height}` : 'size unknown'} ·{' '}
                      {r.contentType ?? 'type unknown'}
                    </span>
                  </p>
                  <div className="row">
                    <label>
                      Role
                      <select
                        aria-label={`Role for ${r.assetKey}`}
                        value={r.role}
                        disabled={r.remove}
                        onChange={(e) => patch(r.rowId, { role: e.target.value as Row['role'] })}
                      >
                        <option value="PRIMARY">Primary</option>
                        <option value="GALLERY">Gallery</option>
                      </select>
                    </label>
                    <label>
                      Order
                      <input
                        aria-label={`Order for ${r.assetKey}`}
                        value={r.sort}
                        inputMode="numeric"
                        size={5}
                        disabled={r.remove}
                        onChange={(e) => patch(r.rowId, { sort: e.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Alt text
                    <input
                      aria-label={`Alt text for ${r.assetKey}`}
                      value={r.alt}
                      maxLength={300}
                      disabled={r.remove}
                      onChange={(e) => patch(r.rowId, { alt: e.target.value })}
                    />
                  </label>
                  <div className="row">
                    <label className="inline">
                      <input
                        type="checkbox"
                        aria-label={`Remove ${r.assetKey}`}
                        checked={r.remove}
                        onChange={(e) => patch(r.rowId, { remove: e.target.checked })}
                      />
                      Remove from set
                    </label>
                    {!r.remove ? (
                      <button
                        type="button"
                        className="btn"
                        aria-expanded={replacing === r.rowId}
                        onClick={() => setReplacing(replacing === r.rowId ? undefined : r.rowId)}
                      >
                        {replacing === r.rowId ? 'Cancel replace' : `Replace ${r.assetKey}`}
                      </button>
                    ) : null}
                  </div>
                  {replacing === r.rowId ? (
                    <ImageUploadField
                      label={`Replacement image for ${r.assetKey}`}
                      hint="Uploads a new file; it takes this image's place (role, order and alt text stay) when you save."
                      requestTarget={requestTarget}
                      describe={mediaErrorMessage}
                      onUploaded={(img) => replaceWith(r.rowId, img)}
                      createXhr={createXhr}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || conflict || !dirty}>
            Review changes
          </button>
          {dirty ? <span className="muted">Unsaved changes</span> : null}
        </div>
      </form>
      <section className="panel" aria-labelledby="add-h">
        <h2 id="add-h">Add an image</h2>
        <ImageUploadField
          label="Image file"
          hint="JPEG, PNG or WebP, up to 5 MiB (the backend default). Choose a file or drop it here. SVG is never accepted."
          requestTarget={requestTarget}
          describe={mediaErrorMessage}
          onUploaded={addUploaded}
          disabled={conflict}
          createXhr={createXhr}
        />
      </section>
      <ConfirmDialog
        open={confirm !== undefined}
        title={`Save media for ${ownerId}?`}
        description={
          confirm
            ? `This replaces the whole set: ${confirm.assets.length} image${confirm.assets.length === 1 ? '' : 's'} will remain${added ? `, ${added} added` : ''}${replaced ? `, ${replaced} replaced` : ''}${removed ? `, ${removed} removed from the set (the files themselves are not deleted)` : ''}. Recorded against your account.`
            : ''
        }
        confirmLabel="Save media"
        destructive={removed > 0}
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const { ownerType: t, ownerId: id, ...body } = confirm
          void run(
            `/api/bff/media/${t}/${encodeURIComponent(id)}`,
            'PUT',
            body,
            'Media saved.',
          ).then((r) => {
            if (r.ok || r.status === 401) return setConfirm(undefined)
            if (r.status === 409) {
              setConfirm(undefined)
              setConflict(true)
              return
            }
            // Any other failure keeps the dialog open with the reason, so nothing closes silently.
            setSaveError(mediaErrorMessage(r))
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

function rowsChanged(rows: Row[], set: MediaSet | undefined): boolean {
  const byId = new Map((set?.assets ?? []).map((a) => [a.assetId, a]))
  return rows.some((r) => {
    const a = byId.get(r.assetId)
    return (
      !a ||
      a.assetKey !== r.assetKey ||
      a.role !== r.role ||
      String(a.sortOrder) !== r.sort ||
      (a.altText ?? '') !== r.alt
    )
  })
}
