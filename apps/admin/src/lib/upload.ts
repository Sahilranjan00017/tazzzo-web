import { z } from 'zod'
import type { BffResult } from './bff-client'

/**
 * Direct-to-storage image upload (client-safe). Flow: check the file locally (type, size, magic bytes) -> ask the BFF for
 * a presigned target (the backend issues one key, bound to type, size and `If-None-Match: *`) -> PUT the raw bytes from
 * the browser straight to that URL with exactly the returned headers -> hand the key to the caller, who references it in
 * a versioned save where the backend verifies the stored bytes.
 *
 * The storage request carries NO cookie and NO admin token: `withCredentials` is false, the CMS session cookie is
 * HttpOnly and host-bound to the CMS origin, and the backend's headers are filtered so no credential header is ever set.
 * A target URL is write-once (a second PUT is refused with 412), so every retry asks for a fresh target.
 */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
/** Backend default ceiling (`MediaUploadPolicy.DEFAULT_MAX_BYTES`); a deployment may lower or raise it up to 50 MiB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',')
const TYPE_LABEL: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
}

/** The same closed-world detection as the backend's `MediaSniffer` (JPEG 3 bytes, PNG 8, WebP 12). */
export function sniffImageType(head: Uint8Array): ImageType | undefined {
  const at = (i: number) => head[i]
  if (head.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length >= 8 && png.every((b, i) => at(i) === b)) return 'image/png'
  const ascii = (from: number, text: string) =>
    [...text].every((c, i) => at(from + i) === c.charCodeAt(0))
  if (head.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

async function readHead(file: Blob, bytes: number): Promise<Uint8Array> {
  const part = file.slice(0, bytes)
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer())
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(part)
  })
}

const mib = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`

export type FileCheck = { ok: true; contentType: ImageType } | { ok: false; message: string }

/**
 * Local checks before anything leaves the browser. The declared type is never trusted alone: the first bytes must be a
 * JPEG, PNG or WebP image, and when the browser reports a type it must agree with the bytes. SVG is never accepted.
 * The backend repeats every check on the stored object.
 */
export async function checkImageFile(
  file: Blob & { name?: string },
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<FileCheck> {
  if (/svg/i.test(file.type) || /\.svgz?$/i.test(file.name ?? ''))
    return { ok: false, message: 'SVG images are not accepted. Use JPEG, PNG or WebP.' }
  if (file.type && !(IMAGE_TYPES as readonly string[]).includes(file.type))
    return { ok: false, message: 'Only JPEG, PNG or WebP images are accepted.' }
  if (file.size < 1) return { ok: false, message: 'The file is empty.' }
  if (file.size > maxBytes)
    return {
      ok: false,
      message: `The file is ${mib(file.size)}; the limit is ${mib(maxBytes)}.`,
    }
  let head: Uint8Array
  try {
    head = await readHead(file, 16)
  } catch {
    return { ok: false, message: 'The file could not be read.' }
  }
  const sniffed = sniffImageType(head)
  if (!sniffed)
    return {
      ok: false,
      message: 'The file is not a JPEG, PNG or WebP image (its contents do not match).',
    }
  if (file.type && file.type !== sniffed)
    return {
      ok: false,
      message: `The file is labelled ${TYPE_LABEL[file.type]} but its contents are ${TYPE_LABEL[sniffed]}. Re-export it and try again.`,
    }
  return { ok: true, contentType: sniffed }
}

/** What the BFF hands the browser (validated server-side against the configured storage origin first). */
export const uploadTargetSchema = z.object({
  assetKey: z.string().min(1).max(512),
  method: z.literal('PUT'),
  url: z.string().min(1).max(4096),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.string().nullable(),
  maxBytes: z.number().int().positive().nullable(),
})
export type UploadTarget = z.infer<typeof uploadTargetSchema>

/** Headers the browser owns (it computes them itself, e.g. Content-Length from the body) and must not be set by script. */
const BROWSER_OWNED = new Set(['content-length', 'host', 'connection', 'keep-alive', 'expect'])
/** Never sent to storage, whatever the target says. */
const CREDENTIAL = /^(cookie|cookie2|authorization|proxy-authorization)$/i
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export type PutFailure =
  | 'invalid_target'
  | 'already_used'
  | 'rejected'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'storage_error'
export type PutOutcome = { ok: true } | { ok: false; reason: PutFailure; status?: number }

export interface PutOptions {
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
  timeoutMs?: number
  /** Test seam; defaults to the browser's XMLHttpRequest (fetch has no upload progress). */
  createXhr?: () => XMLHttpRequest
}

/** Validates a target against the chosen file before sending a byte. Returns the headers the script will set. */
export function prepareTargetHeaders(
  target: UploadTarget,
  file: { size: number },
  contentType: string,
): Record<string, string> | undefined {
  let url: URL
  try {
    url = new URL(target.url)
  } catch {
    return undefined
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  if (!secure || url.username || url.password || target.method !== 'PUT') return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(target.headers)) {
    const lower = name.toLowerCase()
    if (CREDENTIAL.test(lower) || /[\r\n]/.test(value)) return undefined
    if (lower === 'content-length' && value !== String(file.size)) return undefined
    if (lower === 'content-type' && value !== contentType) return undefined
    if (BROWSER_OWNED.has(lower)) continue
    out[name] = value
  }
  return out
}

/**
 * PUTs the file to the presigned URL with exactly the signed headers (minus those the browser computes itself), never
 * with credentials. Resolves (never rejects) with a closed outcome. 412 = the URL was already used (write-once);
 * 403 = storage refused the signature (expired, or the request did not match what was signed).
 */
export function putToStorage(
  target: UploadTarget,
  file: Blob,
  contentType: string,
  options: PutOptions = {},
): Promise<PutOutcome> {
  const headers = prepareTargetHeaders(target, file, contentType)
  if (!headers) return Promise.resolve({ ok: false, reason: 'invalid_target' })
  if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' })
  return new Promise((resolve) => {
    const xhr = options.createXhr ? options.createXhr() : new XMLHttpRequest()
    let settled = false
    const done = (outcome: PutOutcome) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      resolve(outcome)
    }
    const abort = () => xhr.abort()
    xhr.open('PUT', target.url, true)
    xhr.withCredentials = false
    xhr.timeout = options.timeoutMs ?? 120_000
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      const status = xhr.status
      if (status >= 200 && status < 300) return done({ ok: true })
      if (status === 412) return done({ ok: false, reason: 'already_used', status })
      if (status === 403 || status === 400) return done({ ok: false, reason: 'rejected', status })
      done({ ok: false, reason: 'storage_error', status })
    }
    xhr.onerror = () => done({ ok: false, reason: 'network' })
    xhr.ontimeout = () => done({ ok: false, reason: 'timeout' })
    xhr.onabort = () => done({ ok: false, reason: 'aborted' })
    options.signal?.addEventListener('abort', abort)
    xhr.send(file)
  })
}

export const PUT_FAILURE_COPY: Record<PutFailure, string> = {
  invalid_target:
    'The upload link from the backend did not match this file or is not a secure storage address, so nothing was sent.',
  already_used:
    'Storage says this upload link was already used (links are single-use). Retry to request a fresh link.',
  rejected:
    'Storage refused the upload: the link expired or the request did not match what was signed. Retry to request a fresh link.',
  network:
    'The upload did not reach storage (network problem, or the storage address is not allowed by this CMS). Retry to request a fresh link.',
  timeout: 'The upload took too long and was stopped. Retry to request a fresh link.',
  aborted: 'The upload was cancelled.',
  storage_error: 'Storage answered with an error. Retry to request a fresh link.',
}

export type Failed = Extract<BffResult<unknown>, { ok: false }>

export type UploadResult =
  | { ok: true; assetKey: string; contentType: ImageType }
  | { ok: false; message: string; retryable: boolean; reason?: PutFailure; status?: number }

/** Upload phases, for progress UI and screen-reader announcements. */
export type UploadPhase = 'requesting' | 'uploading'

/** Retryable target-request failures: transient outages and timeouts, never validation, permission or "not configured". */
export function targetFailureRetryable(f: Failed): boolean {
  if (f.code === 'MEDIA_STORAGE_NOT_CONFIGURED' || f.code === 'UPLOAD_ORIGIN_NOT_CONFIGURED')
    return false
  return (
    f.status === 0 || f.status === 429 || f.status === 502 || f.status === 503 || f.status === 504
  )
}

/**
 * One attempt: request a FRESH target, then PUT. Never reuses a target (write-once URLs), never retries by itself; the
 * caller offers a retry, which is simply another call.
 */
export async function uploadImage(
  file: Blob,
  contentType: ImageType,
  deps: {
    requestTarget: (contentType: ImageType, sizeBytes: number) => Promise<BffResult<unknown>>
    describe: (failure: Failed) => string
    onPhase?: (phase: UploadPhase) => void
    onProgress?: (loaded: number, total: number) => void
    signal?: AbortSignal
    createXhr?: () => XMLHttpRequest
  },
): Promise<UploadResult> {
  deps.onPhase?.('requesting')
  const r = await deps.requestTarget(contentType, file.size)
  if (!r.ok)
    return {
      ok: false,
      message: deps.describe(r),
      retryable: targetFailureRetryable(r),
      status: r.status,
    }
  const target = uploadTargetSchema.safeParse(r.data)
  if (!target.success)
    return { ok: false, message: PUT_FAILURE_COPY.invalid_target, retryable: false }
  if (target.data.maxBytes !== null && file.size > target.data.maxBytes)
    return {
      ok: false,
      message: `The file is ${mib(file.size)}; this backend accepts up to ${mib(target.data.maxBytes)}.`,
      retryable: false,
    }
  deps.onPhase?.('uploading')
  const put = await putToStorage(target.data, file, contentType, {
    onProgress: deps.onProgress,
    signal: deps.signal,
    createXhr: deps.createXhr,
  })
  if (put.ok) return { ok: true, assetKey: target.data.assetKey, contentType }
  return {
    ok: false,
    message: PUT_FAILURE_COPY[put.reason],
    retryable: put.reason !== 'invalid_target' && put.reason !== 'aborted',
    reason: put.reason,
    status: put.status,
  }
}

/** The upload field's state machine (pure, unit-tested). Each attempt starts from a fresh target request. */
export type UploadState =
  | { phase: 'idle' }
  | { phase: 'checking'; fileName: string }
  | { phase: 'invalid'; fileName: string; message: string }
  | { phase: 'requesting'; fileName: string; attempt: number }
  | { phase: 'uploading'; fileName: string; attempt: number; loaded: number; total: number }
  | { phase: 'failed'; fileName: string; attempt: number; message: string; retryable: boolean }
  | { phase: 'done'; fileName: string; assetKey: string }

export type UploadEvent =
  | { type: 'select'; fileName: string }
  | { type: 'invalid'; message: string }
  | { type: 'start' }
  | { type: 'uploading' }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'fail'; message: string; retryable: boolean }
  | { type: 'succeed'; assetKey: string }
  | { type: 'reset' }

export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  const busy = state.phase === 'requesting' || state.phase === 'uploading'
  switch (event.type) {
    case 'select':
      return busy ? state : { phase: 'checking', fileName: event.fileName }
    case 'invalid':
      return state.phase === 'checking'
        ? { phase: 'invalid', fileName: state.fileName, message: event.message }
        : state
    case 'start':
      // From a checked file, or a RETRY from a retryable failure (a new attempt, a new target).
      if (state.phase === 'checking')
        return { phase: 'requesting', fileName: state.fileName, attempt: 1 }
      if (state.phase === 'failed' && state.retryable)
        return { phase: 'requesting', fileName: state.fileName, attempt: state.attempt + 1 }
      return state
    case 'uploading':
      return state.phase === 'requesting'
        ? { ...state, phase: 'uploading', loaded: 0, total: 0 }
        : state
    case 'progress':
      return state.phase === 'uploading'
        ? { ...state, loaded: Math.min(event.loaded, event.total), total: event.total }
        : state
    case 'fail':
      return busy
        ? {
            phase: 'failed',
            fileName: state.fileName,
            attempt: state.attempt,
            message: event.message,
            retryable: event.retryable,
          }
        : state
    case 'succeed':
      return busy ? { phase: 'done', fileName: state.fileName, assetKey: event.assetKey } : state
    case 'reset':
      return busy ? state : { phase: 'idle' }
  }
}

/** Whole-percent progress (0-100) for display; announcements use coarser steps. */
export const percent = (loaded: number, total: number) =>
  total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0
