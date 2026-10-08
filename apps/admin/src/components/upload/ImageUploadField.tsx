'use client'

import { useEffect, useId, useReducer, useRef, useState, type DragEvent } from 'react'
import type { BffResult } from '@/lib/bff-client'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  IMAGE_ACCEPT,
  checkImageFile,
  percent,
  uploadImage,
  uploadReducer,
  type Failed,
  type ImageType,
} from '@/lib/upload'

export interface UploadedImage {
  assetKey: string
  contentType: ImageType
  fileName: string
  /** Local object URL of the chosen file (never uploaded anywhere else); owned by the receiver from now on. */
  previewUrl?: string
  width?: number
  height?: number
}

const MAX_DIMENSION = 20_000

/** Natural size of a local image, or undefined (unsupported, unreadable or slower than 3 s). */
function measure(url: string | undefined): Promise<{ width: number; height: number } | undefined> {
  if (!url || typeof Image === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const img = new Image()
    const timer = setTimeout(() => resolve(undefined), 3000)
    img.onload = () => {
      clearTimeout(timer)
      const { naturalWidth: width, naturalHeight: height } = img
      resolve(
        width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION
          ? { width, height }
          : undefined,
      )
    }
    img.onerror = () => {
      clearTimeout(timer)
      resolve(undefined)
    }
    img.src = url
  })
}

const objectUrl = (file: Blob) =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined
const revoke = (url: string | undefined) => {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

/**
 * Pick or drop one image, check it locally (type, size, magic bytes), upload it straight to storage with visible progress,
 * and hand the stored key to the caller. A failed upload can be retried: each retry requests a FRESH target (presigned
 * URLs are single-use). Progress is announced politely in 25 % steps. Nothing is saved here: the caller references the
 * key in its own versioned save, where the backend verifies the stored bytes.
 */
export function ImageUploadField({
  label,
  hint,
  requestTarget,
  describe,
  onUploaded,
  disabled = false,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
  createXhr,
}: {
  label: string
  hint?: string
  requestTarget: (contentType: ImageType, sizeBytes: number) => Promise<BffResult<unknown>>
  describe: (failure: Failed) => string
  onUploaded: (image: UploadedImage) => void
  disabled?: boolean
  maxBytes?: number
  /** Test seam for the storage PUT. */
  createXhr?: () => XMLHttpRequest
}) {
  const id = useId()
  const [state, dispatch] = useReducer(uploadReducer, { phase: 'idle' })
  const [dragging, setDragging] = useState(false)
  const [announce, setAnnounce] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const chosen = useRef<{
    file: File
    contentType: ImageType
    preview?: string
    dims: Promise<{ width: number; height: number } | undefined>
  }>(undefined)
  const abort = useRef<AbortController>(undefined)
  const lastStep = useRef(-1)
  const lastFile = useRef<File>(undefined)

  useEffect(
    () => () => {
      abort.current?.abort()
      // A preview never handed over (failed or abandoned) is released here.
      if (chosen.current) revoke(chosen.current.preview)
    },
    [],
  )

  async function attempt() {
    const c = chosen.current
    if (!c) return
    dispatch({ type: 'start' })
    lastStep.current = -1
    setAnnounce(`Requesting an upload link for ${c.file.name}.`)
    abort.current = new AbortController()
    const result = await uploadImage(c.file, c.contentType, {
      requestTarget,
      describe,
      signal: abort.current.signal,
      createXhr,
      onPhase: (phase) => {
        if (phase === 'uploading') {
          dispatch({ type: 'uploading' })
          setAnnounce(`Uploading ${c.file.name}.`)
        }
      },
      onProgress: (loaded, total) => {
        dispatch({ type: 'progress', loaded, total })
        const step = Math.floor(percent(loaded, total) / 25)
        if (step > lastStep.current && step < 4) {
          lastStep.current = step
          if (step > 0) setAnnounce(`Uploaded ${step * 25} percent.`)
        }
      },
    })
    if (!result.ok) {
      dispatch({ type: 'fail', message: result.message, retryable: result.retryable })
      // The reason itself is in the alert below; the live region only marks the transition.
      setAnnounce('Upload failed.')
      return
    }
    // Dimensions were measured while uploading; never hold the result back for long.
    const size = await Promise.race([
      c.dims,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 300)),
    ])
    dispatch({ type: 'succeed', assetKey: result.assetKey })
    setAnnounce(`${c.file.name} uploaded.`)
    chosen.current = undefined
    onUploaded({
      assetKey: result.assetKey,
      contentType: result.contentType,
      fileName: c.file.name,
      previewUrl: c.preview,
      ...(size ?? {}),
    })
  }

  async function handle(file: File | undefined) {
    if (!file || disabled) return
    if (state.phase === 'requesting' || state.phase === 'uploading') return
    // The same selection can arrive twice (pre-hydration pickup and a replayed change event): handle it once.
    if (lastFile.current === file) return
    lastFile.current = file
    if (chosen.current) revoke(chosen.current.preview)
    chosen.current = undefined
    dispatch({ type: 'select', fileName: file.name })
    const check = await checkImageFile(file, maxBytes)
    if (!check.ok) {
      dispatch({ type: 'invalid', message: check.message })
      setAnnounce('')
      if (input.current) input.current.value = ''
      return
    }
    const preview = objectUrl(file)
    chosen.current = { file, contentType: check.contentType, preview, dims: measure(preview) }
    await attempt()
    if (input.current) input.current.value = ''
  }

  // A file chosen before hydration finished is still on the input but unknown to React: pick it up once.
  useEffect(() => {
    const f = input.current?.files?.[0]
    if (f) void handle(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, [])

  const busy =
    state.phase === 'requesting' || state.phase === 'uploading' || state.phase === 'checking'
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    void handle(e.dataTransfer.files?.[0])
  }
  return (
    <div
      className={`dropzone${dragging ? ' dropzone-active' : ''}${disabled ? ' dropzone-disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled && !busy) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <label htmlFor={`${id}-file`}>{label}</label>
      <p className="muted" id={`${id}-hint`}>
        {hint ?? 'JPEG, PNG or WebP. Choose a file or drop it here.'}
      </p>
      <input
        ref={input}
        id={`${id}-file`}
        type="file"
        accept={IMAGE_ACCEPT}
        aria-describedby={`${id}-hint`}
        disabled={disabled || busy}
        onChange={(e) => void handle(e.target.files?.[0])}
      />
      {state.phase === 'requesting' ? (
        <p className="muted">Requesting an upload link for {state.fileName}…</p>
      ) : null}
      {state.phase === 'uploading' ? (
        <div className="upload-progress">
          <progress
            max={100}
            value={percent(state.loaded, state.total)}
            aria-label={`Uploading ${state.fileName}`}
          />
          <span>{percent(state.loaded, state.total)}%</span>
        </div>
      ) : null}
      {state.phase === 'invalid' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.phase === 'failed' ? (
        <div className="field-error" role="alert">
          <p>{state.message}</p>
          {state.retryable ? (
            <button type="button" className="btn" onClick={() => void attempt()}>
              Retry upload
            </button>
          ) : null}
        </div>
      ) : null}
      {state.phase === 'done' ? (
        <p className="muted">
          Uploaded {state.fileName}. It is not saved until you save the changes below.
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
