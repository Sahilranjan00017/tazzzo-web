'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  altText,
  mediaErrorMessage,
  setInput,
  type MediaAsset,
  type MediaSet,
  type OwnerType,
} from '@/lib/media'

type Row = {
  assetId: string
  assetKey: string
  role: 'PRIMARY' | 'GALLERY'
  sort: string
  alt: string
  width?: number
  height?: number
  contentType?: string
  remove: boolean
}

const fromAsset = (a: MediaAsset): Row => ({
  assetId: a.assetId,
  assetKey: a.assetKey,
  role: a.role === 'PRIMARY' ? 'PRIMARY' : 'GALLERY',
  sort: String(a.sortOrder),
  alt: a.altText ?? '',
  width: a.width ?? undefined,
  height: a.height ?? undefined,
  contentType: a.contentType ?? undefined,
  remove: false,
})

/**
 * Edit metadata of the assets the backend already holds: role, order, alt text and removal. It never adds a key: while no
 * storage provider exists the backend would accept an unverified key, which could publish a broken image. The save is a
 * whole-set replace with the loaded version; remounted with `key={owner:version}` after every save or conflict.
 */
export function MediaSetEditor({
  ownerType,
  ownerId,
  set,
}: {
  ownerType: OwnerType
  ownerId: string
  set: MediaSet
}) {
  const { run, busy } = useBffAction(mediaErrorMessage)
  const [rows, setRows] = useState<Row[]>(set.assets.map(fromAsset))
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof setInput.parse>>()
  const patch = (i: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)))

  function review(e: FormEvent) {
    e.preventDefault()
    const kept = rows.filter((r) => !r.remove)
    const msgs: string[] = []
    for (const r of kept) {
      const a = altText.safeParse(r.alt)
      if (!a.success)
        msgs.push(`${r.assetId}: alt text must be 300 characters or fewer with no < or >.`)
    }
    const candidate = {
      ownerType,
      ownerId,
      assets: kept.map((r) => ({
        assetId: r.assetId,
        assetKey: r.assetKey,
        role: r.role,
        sortOrder: /^\d{1,7}$/.test(r.sort.trim()) ? Number(r.sort.trim()) : Number.NaN,
        ...(r.alt.trim() ? { altText: r.alt.trim() } : {}),
        ...(r.width && r.height ? { width: r.width, height: r.height } : {}),
        ...(r.contentType ? { contentType: r.contentType } : {}),
      })),
      expectedVersion: set.version,
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
              ? 'Only one image can be primary.'
              : last === 'contentType'
                ? 'An image has an unsupported content type.'
                : i.message,
        )
      }
    }
    setErrors([...new Set(msgs)])
    if (msgs.length === 0 && parsed.success) setConfirm(parsed.data)
  }

  const removed = rows.filter((r) => r.remove).length
  return (
    <>
      <form className="stack" onSubmit={review} noValidate aria-label="Edit media set">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Media assets">
          <table className="data-table">
            <caption className="sr-only">{rows.length} assets</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Role</th>
                <th scope="col">Order</th>
                <th scope="col">Alt text</th>
                <th scope="col">Remove</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.assetId} className={r.remove ? 'row-removed' : undefined}>
                  <th scope="row" className="wrap">
                    <code>{r.assetKey}</code>
                    <span className="muted">
                      {' '}
                      {r.width && r.height ? `${r.width}×${r.height}` : 'size unknown'} ·{' '}
                      {r.contentType ?? 'type unknown'}
                    </span>
                  </th>
                  <td>
                    <select
                      aria-label={`Role for ${r.assetId}`}
                      value={r.role}
                      onChange={(e) => patch(i, { role: e.target.value as Row['role'] })}
                    >
                      <option value="PRIMARY">Primary</option>
                      <option value="GALLERY">Gallery</option>
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Order for ${r.assetId}`}
                      value={r.sort}
                      inputMode="numeric"
                      size={5}
                      onChange={(e) => patch(i, { sort: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Alt text for ${r.assetId}`}
                      value={r.alt}
                      maxLength={300}
                      onChange={(e) => patch(i, { alt: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Remove ${r.assetId}`}
                      checked={r.remove}
                      onChange={(e) => patch(i, { remove: e.target.checked })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy || rows.length === 0}>
          Review changes
        </button>
      </form>
      <ConfirmDialog
        open={confirm !== undefined}
        title={`Save media for ${ownerId}?`}
        description={
          confirm
            ? `This replaces the whole set: ${confirm.assets.length} image${confirm.assets.length === 1 ? '' : 's'} will remain${removed ? `, ${removed} removed from the set (the files themselves are not deleted)` : ''}. Recorded against your account.`
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
          ).then(() => setConfirm(undefined))
        }}
      />
    </>
  )
}
