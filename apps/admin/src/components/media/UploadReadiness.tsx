'use client'

import { useEffect, useRef, useState } from 'react'
import { callBff } from '@/lib/bff-client'
import { checkFile, mediaErrorMessage, type OwnerType } from '@/lib/media'

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

/**
 * Upload is BLOCKED_BY_EXTERNAL_PROVIDER: the backend answers 503 MEDIA_STORAGE_NOT_CONFIGURED until a storage provider
 * exists. This control only asks the backend whether it could issue an upload target for the chosen file (it never
 * uploads, and the signed target is never sent to the browser). It cannot report a successful upload.
 */
export function UploadReadiness({ ownerType, ownerId }: { ownerType: OwnerType; ownerId: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [fileProblem, setFileProblem] = useState<string>()
  const [file, setFile] = useState<{ type: string; size: number }>()
  const input = useRef<HTMLInputElement>(null)

  // A file chosen before hydration finished is still on the input but unknown to React state: pick it up once.
  useEffect(() => {
    const f = input.current?.files?.[0]
    if (!f) return
    setFile({ type: f.type, size: f.size })
    setFileProblem(checkFile(f))
  }, [])

  async function check() {
    if (!file || fileProblem) return
    setState({ kind: 'busy' })
    const r = await callBff('/api/bff/media/uploads', 'POST', {
      ownerType,
      ownerId,
      contentType: file.type,
      sizeBytes: file.size,
    })
    if (r.ok) return setState({ kind: 'ready' })
    if (r.status === 401)
      return setState({ kind: 'error', message: 'Your session has ended. Please sign in again.' })
    const blocked = r.code === 'MEDIA_STORAGE_NOT_CONFIGURED'
    setState({ kind: blocked ? 'blocked' : 'error', message: mediaErrorMessage(r) })
  }

  return (
    <section className="panel" aria-labelledby="up-h">
      <h2 id="up-h">Upload new image</h2>
      <p className="muted">
        JPEG, PNG or WebP, up to 5 MiB. Uploading needs a media storage provider that has not been
        configured.
      </p>
      <div className="filters">
        <label>
          Image file
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0]
              setState({ kind: 'idle' })
              setFile(f ? { type: f.type, size: f.size } : undefined)
              setFileProblem(f ? checkFile(f) : undefined)
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={!file || !!fileProblem || state.kind === 'busy'}
          onClick={() => void check()}
        >
          Check upload readiness
        </button>
      </div>
      {fileProblem ? (
        <p className="field-error" role="alert">
          {fileProblem}
        </p>
      ) : null}
      {state.kind === 'blocked' ? (
        <p className="notice" role="status">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <p className="notice" role="status">
          The backend can issue an upload target. Direct upload is not enabled in this build (it
          needs the provider origin added to the CMS security policy), so nothing was uploaded.
        </p>
      ) : null}
    </section>
  )
}
