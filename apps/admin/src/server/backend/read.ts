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
const BACKEND_REQUEST_ID = /^req_[0-9a-f]{20}$/

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
  if (!response.ok && !deps.parseAlso?.includes(response.status))
    return { kind: 'unavailable', reason: 'status', ...trace }
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  return parsed.success
    ? { kind: 'ok', data: parsed.data, httpStatus: response.status, ...trace }
    : { kind: 'unavailable', reason: 'shape', ...trace }
}
