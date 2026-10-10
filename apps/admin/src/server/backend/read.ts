import 'server-only'
import type { z } from 'zod'
import type { BackendReadResult } from '@/lib/backend-result'

/**
 * Narrow server-side backend READ. Same trust model as the BFF mutation layer: a fixed backend path chosen by code
 * (never by the browser), the human's Google ID token as the only credential, no redirects, a bounded timeout, no
 * retry, and the response validated against a schema before any caller sees it. The result is a closed union so a
 * page can render every outcome (401/403/404/429/5xx/network/shape) distinctly.
 */
export const BACKEND_READ_TIMEOUT_MS = 5_000
/** Time to the response headers of a download; the body then streams for as long as the backend sends it. */
export const BACKEND_DOWNLOAD_TIMEOUT_MS = 30_000
const BACKEND_REQUEST_ID = /^req_[0-9a-f]{20}$/
const SAFE_CODE = /^[A-Z][A-Z_]{1,39}$/

/** The backend's stable error code (e.g. LIST_TIMEOUT) if well-formed; never its message or any other field. */
async function safeErrorCode(response: Response): Promise<string | undefined> {
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined
  const code = body?.error?.code
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined
}

export async function backendRead<T>(
  deps: {
    backendUrl: string
    /** Omit for the backend's unauthenticated endpoints (health): no Authorization header is sent at all. */
    idToken?: string
    fetchImpl?: typeof fetch
    /** Non-2xx statuses whose JSON body is still a valid payload (e.g. readiness reports 503 with its components). */
    parseAlso?: readonly number[]
  },
  path: string,
  schema: z.ZodType<T>,
): Promise<BackendReadResult<T>> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(new URL(path, deps.backendUrl), {
      method: 'GET',
      headers: {
        ...(deps.idToken ? { Authorization: `Bearer ${deps.idToken}` } : {}),
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(BACKEND_READ_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return { kind: 'unavailable', reason: timedOut ? 'timeout' : 'network' }
  }
  const id = response.headers.get('x-request-id') ?? ''
  const trace = BACKEND_REQUEST_ID.test(id) ? { backendRequestId: id } : {}
  if (response.status === 401) return { kind: 'unauthenticated' }
  if (response.status === 403) return { kind: 'forbidden', ...trace }
  if (response.status === 404) return { kind: 'not_found', ...trace }
  if (response.status === 429) {
    const header = response.headers.get('retry-after') ?? ''
    const retryAfterSeconds = /^[1-9][0-9]{0,3}$/.test(header) ? Number(header) : undefined
    return { kind: 'rate_limited', ...(retryAfterSeconds ? { retryAfterSeconds } : {}), ...trace }
  }
  if (!response.ok && !deps.parseAlso?.includes(response.status)) {
    const code = await safeErrorCode(response)
    return {
      kind: 'unavailable',
      reason: 'status',
      httpStatus: response.status,
      ...(code ? { code } : {}),
      ...trace,
    }
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  return parsed.success
    ? { kind: 'ok', data: parsed.data, httpStatus: response.status, ...trace }
    : { kind: 'unavailable', reason: 'shape', ...trace }
}

export type BackendDownloadResult =
  | { kind: 'ok'; body: ReadableStream<Uint8Array>; contentType: string; backendRequestId?: string }
  | Exclude<BackendReadResult<never>, { kind: 'ok' }>

/**
 * A server-side backend download (e.g. `errors.csv`): same trust model as {@link backendRead} (fixed path, the human's
 * ID token only, no redirects, bounded wait for the response HEADERS), but the body is handed back as a stream and is
 * neither buffered nor parsed. Only an exact `text/csv` answer is accepted.
 */
export async function backendDownload(
  deps: { backendUrl: string; idToken: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  path: string,
): Promise<BackendDownloadResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  // The wait is bounded only until the headers arrive: an overall timeout would also cut a long body off mid-file.
  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, deps.timeoutMs ?? BACKEND_DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(new URL(path, deps.backendUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${deps.idToken}`, Accept: 'text/csv' },
      cache: 'no-store',
      redirect: 'error',
      signal: abort.signal,
    })
  } catch {
    return { kind: 'unavailable', reason: timedOut ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
  const id = response.headers.get('x-request-id') ?? ''
  const trace = BACKEND_REQUEST_ID.test(id) ? { backendRequestId: id } : {}
  if (response.status === 401) return { kind: 'unauthenticated' }
  if (response.status === 403) return { kind: 'forbidden', ...trace }
  if (response.status === 404) return { kind: 'not_found', ...trace }
  if (response.status === 429) return { kind: 'rate_limited', ...trace }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !response.body || !/^text\/csv\s*(;|$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'unavailable', reason: response.ok ? 'shape' : 'status', ...trace }
  }
  return { kind: 'ok', body: response.body, contentType: 'text/csv; charset=utf-8', ...trace }
}
