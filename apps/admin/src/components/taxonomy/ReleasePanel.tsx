'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { StatusBadge } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { RELEASE_ID, STATUS_TONE, taxonomyErrorMessage } from '@/lib/taxonomy'

/**
 * Releases. The backend can open a release, publish one and read one by id, but it cannot LIST releases or say which
 * is open, so this panel works from an id the operator supplies (`?release=<id>`); nothing is guessed or remembered.
 */
export function ReleasePanel({
  canWrite,
  looked,
}: {
  canWrite: boolean
  looked?: { id: string; status: string; basedOn?: string | null } | { id: string; missing: true }
}) {
  const { run, busy } = useBffAction(taxonomyErrorMessage)
  const [openId, setOpenId] = useState('')
  const [error, setError] = useState<string>()
  const [confirmPublish, setConfirmPublish] = useState(false)

  async function open(e: FormEvent) {
    e.preventDefault()
    if (!RELEASE_ID.test(openId.trim()))
      return setError('Use letters, digits and . _ : - only (1-64 characters).')
    setError(undefined)
    await run(
      '/api/bff/catalog/taxonomy/releases',
      'POST',
      { releaseId: openId.trim() },
      'Release opened.',
    )
  }

  return (
    <>
      <section className="panel" aria-labelledby="lookup-h">
        <h2 id="lookup-h">Look up a release</h2>
        <form method="get" className="filters" aria-label="Look up release">
          <label>
            Release id
            <input name="release" defaultValue={looked?.id ?? ''} maxLength={64} />
          </label>
          <button type="submit" className="btn">
            Look up
          </button>
        </form>
        {looked && 'missing' in looked ? (
          <p className="notice" role="status">
            No release “{looked.id}” was found.
          </p>
        ) : looked ? (
          <>
            <dl className="kv">
              <dt>Release</dt>
              <dd>{looked.id}</dd>
              <dt>Status</dt>
              <dd>
                <StatusBadge tone={STATUS_TONE[looked.status] ?? 'neutral'}>
                  {looked.status}
                </StatusBadge>
              </dd>
              <dt>Based on</dt>
              <dd>{looked.basedOn ?? '—'}</dd>
            </dl>
            {canWrite && looked.status !== 'active' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => setConfirmPublish(true)}
              >
                Publish release
              </button>
            ) : null}
          </>
        ) : (
          <p className="muted">
            The backend has no list of releases, so enter a release id to see its status.
          </p>
        )}
      </section>

      {canWrite ? (
        <section className="panel" aria-labelledby="open-h">
          <h2 id="open-h">Open a release</h2>
          <p className="muted">
            Only one release can be open at a time. If another is open the backend refuses and does
            not say which; look it up by id above.
          </p>
          <form className="filters" onSubmit={open} aria-label="Open release">
            <label>
              New release id
              <input value={openId} maxLength={64} onChange={(e) => setOpenId(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || !openId.trim()}>
              Open release
            </button>
          </form>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <p>
            <Link href="/catalogue/taxonomy">Back to taxonomy</Link>
          </p>
        </section>
      ) : (
        <p className="notice" role="note">
          Opening and publishing releases needs the cms-writer role.
        </p>
      )}

      <ConfirmDialog
        open={confirmPublish}
        title={`Publish release ${looked?.id ?? ''}?`}
        description="This makes every change in the release visible to customers. It runs synchronously and can take a while."
        confirmLabel="Publish"
        busy={busy}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={() => {
          if (!looked) return
          void run(
            `/api/bff/catalog/taxonomy/releases/${encodeURIComponent(looked.id)}/publish`,
            'POST',
            {},
            'Release published.',
          ).then(() => setConfirmPublish(false))
        }}
      />
    </>
  )
}
