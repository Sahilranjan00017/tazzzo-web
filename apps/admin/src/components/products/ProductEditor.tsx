'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { bffErrorMessage, callBff } from '@/lib/bff-client'
import { ACTIONS_BY_STATE, ACTION_COPY, type LifecycleAction } from '@/lib/products'

/**
 * Title edit and lifecycle actions for one product. Mounted with `key={id:version}` by the page, so a refresh after a
 * save or a stale-version conflict re-initializes it from the authoritative backend copy. The backend authorizes
 * every call; `canWrite` only decides whether controls are offered. Nothing is retried automatically.
 */
export function ProductEditor({
  product,
  canWrite,
}: {
  product: { id: string; title: string; lifecycle: string; version: number }
  canWrite: boolean
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [title, setTitle] = useState(product.title)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<LifecycleAction>()
  const dirty = title.trim() !== product.title

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const base = `/api/bff/catalog/products/${encodeURIComponent(product.id)}`

  async function run(path: string, method: 'PATCH' | 'POST', body: unknown, success: string) {
    setBusy(true)
    const result = await callBff(path, method, body)
    setBusy(false)
    if (result.ok) {
      toast('success', success)
    } else {
      if (result.status === 401) {
        router.replace('/login?error=expired')
        router.refresh()
        return
      }
      toast('error', bffErrorMessage(result, 'product change'))
    }
    // Success or conflict: re-read the authoritative product. Other failures keep the form as typed.
    if (result.ok || result.status === 409 || result.status === 404) router.refresh()
  }

  function saveTitle(event: FormEvent) {
    event.preventDefault()
    if (busy || !dirty || !title.trim()) return
    void run(
      `${base}/title`,
      'PATCH',
      { title: title.trim(), expectedVersion: product.version },
      'Title saved.',
    )
  }

  const actions = ACTIONS_BY_STATE[product.lifecycle] ?? []

  if (!canWrite) {
    return (
      <p className="notice" role="note">
        Read-only: editing needs the cms-writer role. The backend enforces this independently.
      </p>
    )
  }
  return (
    <>
      <form className="stack" onSubmit={saveTitle} aria-label="Edit product title">
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            aria-describedby="title-help"
          />
        </label>
        <p id="title-help" className="muted">
          Title is the only field the backend lets you edit (version {product.version}).
        </p>
        <div className="row">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !dirty || !title.trim()}
          >
            {busy ? 'Saving…' : 'Save title'}
          </button>
          {dirty ? <span className="muted">Unsaved changes</span> : null}
        </div>
      </form>

      <section aria-labelledby="lifecycle-h" className="stack">
        <h3 id="lifecycle-h">Lifecycle</h3>
        {actions.length === 0 ? (
          <p className="muted">
            No lifecycle action is available from “{product.lifecycle}”. Merge is not offered here.
          </p>
        ) : (
          <div className="row">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                className={ACTION_COPY[a].destructive ? 'btn btn-danger' : 'btn'}
                disabled={busy || dirty}
                onClick={() => setPending(a)}
              >
                {ACTION_COPY[a].label}
              </button>
            ))}
          </div>
        )}
        {dirty && actions.length > 0 ? (
          <p className="muted">Save or discard the title change before changing lifecycle.</p>
        ) : null}
      </section>

      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? `${ACTION_COPY[pending].label} ${product.id}?` : ''}
        description={pending ? ACTION_COPY[pending].confirm : ''}
        confirmLabel={pending ? ACTION_COPY[pending].label : 'Confirm'}
        destructive={pending ? ACTION_COPY[pending].destructive : false}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          const action = pending
          if (!action) return
          void run(
            `${base}/lifecycle/${action}`,
            'POST',
            { expectedVersion: product.version },
            `Product is now ${ACTION_COPY[action].result}.`,
          ).then(() => setPending(undefined))
        }}
      />
    </>
  )
}
