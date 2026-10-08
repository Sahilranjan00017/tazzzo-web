import 'server-only'
import { serverEnv } from '@/server/env'

/**
 * The ONE way the storefront reads the public Tazzzo API: from the Next.js server, never from the browser.
 *
 * Why server-side with a shared cache: the backend admits every public `/v1` read through a token-bucket limiter keyed
 * by the caller's IP (`ConsumerAdmissionGate` / `ClientIpResolver`); from the backend's point of view every visitor of
 * this website IS this server. Cached reads (`revalidate: 60`, matching `Cache-Control: public, max-age=60` on the
 * home content) keep the cost per page view near zero: one backend call per URL per minute per server instance, not
 * one per visitor. Client IPs are not forwarded (the backend ignores `X-Forwarded-For` from an untrusted peer) and no
 * installation id is sent (it would add a second shared bucket, never relieve the IP one).
 *
 * When `TAZZZO_CALLER_NAME`/`TAZZZO_CALLER_SECRET` are configured, every read carries them as `X-Tazzzo-Caller` /
 * `X-Tazzzo-Caller-Secret` so the backend can admit this website through its own trusted-caller bucket. They are sent
 * only to `TAZZZO_API_BASE_URL` (https in production; redirects are refused, so they cannot follow one elsewhere)
 * and never logged. Next's data-cache key is a hash that includes request headers, so rotating the secret simply
 * misses the cache once.
 *
 * Failures are typed, never thrown at the page: 404 is `not_found`, 400 is `bad_request`, everything else (429, 5xx,
 * timeout, network, non-JSON) is `unavailable`.
 *
 * The Next data cache stores only 200 responses, so two failure answers are remembered here (per server instance,
 * bounded) to keep them from costing a backend call on every page view:
 * - a 404 on a cacheable read (e.g. a hidden product in a rail) for the same 60 s;
 * - a 429 means this server's IP bucket is empty: uncached reads (search, paged lists) are not sent until its
 *   `Retry-After` (capped at 60 s) passes. Cacheable reads still go through `fetch`, which serves the cached (or
 *   stale) copy without waiting for the backend.
 */
export type BackendResult<T> =
  { ok: true; data: T } | { ok: false; kind: 'not_found' | 'bad_request' | 'unavailable' }

export const REVALIDATE_SECONDS = 60
const TIMEOUT_MS = 5_000
const NOT_FOUND_TTL_MS = REVALIDATE_SECONDS * 1_000
const NOT_FOUND_MAX_ENTRIES = 1_000
const BACKOFF_DEFAULT_S = 10

const notFoundUntil = new Map<string, number>()
let backoffUntil = 0

/** Test seam: forget remembered 404s and any 429 backoff. */
export function resetFailureMemory(): void {
  notFoundUntil.clear()
  backoffUntil = 0
}

function rememberNotFound(url: string, now: number): void {
  notFoundUntil.delete(url)
  notFoundUntil.set(url, now + NOT_FOUND_TTL_MS)
  // Map keeps insertion order: evict the oldest entries beyond the bound.
  for (const key of notFoundUntil.keys()) {
    if (notFoundUntil.size <= NOT_FOUND_MAX_ENTRIES) break
    notFoundUntil.delete(key)
  }
}

function retryAfterSeconds(response: Response): number {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0
    ? Math.min(value, REVALIDATE_SECONDS)
    : BACKOFF_DEFAULT_S
}

export interface GetOptions {
  /** `true` (default): cached for REVALIDATE_SECONDS. `false`: always fresh (search, paginated pages). */
  cache?: boolean
}

export async function getJson(
  pathAndQuery: string,
  options: GetOptions = {},
): Promise<BackendResult<unknown>> {
  if (!pathAndQuery.startsWith('/v1/')) throw new Error('public API paths only')
  const env = serverEnv()
  const url = `${env.apiBaseUrl}${pathAndQuery}`
  const cacheable = options.cache !== false
  const now = Date.now()
  if (cacheable) {
    const until = notFoundUntil.get(url)
    if (until !== undefined && until > now) return { ok: false, kind: 'not_found' }
    if (until !== undefined) notFoundUntil.delete(url)
  } else if (backoffUntil > now) {
    return { ok: false, kind: 'unavailable' }
  }
  const caching = cacheable
    ? { next: { revalidate: REVALIDATE_SECONDS } }
    : { cache: 'no-store' as const }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders(env.caller),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...caching,
    })
  } catch {
    console.warn(`storefront_backend_unreachable path=${routeLabel(pathAndQuery)}`)
    return { ok: false, kind: 'unavailable' }
  }
  if (response.status === 404) {
    if (cacheable) rememberNotFound(url, now)
    return { ok: false, kind: 'not_found' }
  }
  if (response.status === 400) return { ok: false, kind: 'bad_request' }
  if (response.status === 429) backoffUntil = Date.now() + retryAfterSeconds(response) * 1_000
  if (!response.ok) {
    console.warn(
      `storefront_backend_error path=${routeLabel(pathAndQuery)} status=${response.status} request_id=${requestId(response)}`,
    )
    return { ok: false, kind: 'unavailable' }
  }
  try {
    return { ok: true, data: (await response.json()) as unknown }
  } catch {
    console.warn(`storefront_backend_malformed path=${routeLabel(pathAndQuery)}`)
    return { ok: false, kind: 'unavailable' }
  }
}

export const CALLER_HEADER = 'X-Tazzzo-Caller'
export const CALLER_SECRET_HEADER = 'X-Tazzzo-Caller-Secret'

function requestHeaders(caller: { name: string; secret: string } | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (caller) {
    headers[CALLER_HEADER] = caller.name
    headers[CALLER_SECRET_HEADER] = caller.secret
  }
  return headers
}

/** A log label without the query string (search text is customer input and is never logged). */
function routeLabel(pathAndQuery: string): string {
  return pathAndQuery.split('?')[0] ?? ''
}

function requestId(response: Response): string {
  const id = response.headers.get('x-request-id') ?? ''
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'none'
}
