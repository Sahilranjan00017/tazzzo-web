import 'server-only'
import { PRODUCT_ID } from '@/lib/ids'
import { serverEnv } from '@/server/env'

/**
 * The ONE way the storefront reads the public Tazzzo API: from the Next.js server, never from the browser.
 *
 * Why server-side with a shared cache: the backend admits every public `/v1` read through a token-bucket limiter keyed
 * by the caller's IP (`ConsumerAdmissionGate` / `ClientIpResolver`); from the backend's point of view every visitor of
 * this website IS this server. Cached reads (60 s, matching `Cache-Control: public, max-age=60` on the home content)
 * keep the cost per page view near zero: one backend call per URL per minute per server instance, not one per
 * visitor. Client IPs are not forwarded (the backend ignores `X-Forwarded-For` from an untrusted peer) and no
 * installation id is sent (it would add a second shared bucket, never relieve the IP one).
 *
 * When `TAZZZO_CALLER_NAME`/`TAZZZO_CALLER_SECRET` are configured, every read carries them as `X-Tazzzo-Caller` /
 * `X-Tazzzo-Caller-Secret` so the backend can admit this website through its own trusted-caller bucket. They are sent
 * only to `TAZZZO_API_BASE_URL` (https in production; redirects are refused, so they cannot follow one elsewhere)
 * and never logged.
 *
 * Failures are typed, never thrown at the page: 404 is `not_found`, 400 is `bad_request`, everything else (429, 5xx,
 * timeout, network, non-JSON) is `unavailable`.
 *
 * Why the 60 s cache is held HERE and not in the Next data cache (`fetch(..., { next: { revalidate } })`): the Next
 * data cache only ever writes 200 responses. When a cached 200 goes stale and the revalidating fetch answers 404, the
 * 404 is not stored and the stale 200 is served again, indefinitely (reproduced on a production build: an unpublished
 * legal document kept being shown for as long as the server ran). A take-down (200 -> 404) must show within the
 * minute, so every cacheable read here is `cache: 'no-store'` at the fetch layer and kept per server instance, bounded:
 * - a 200 body for 60 s (concurrent reads of the same URL share one in-flight request);
 * - a 404 for the same 60 s (e.g. a hidden product in a rail), which also drops any remembered 200;
 * - after a 429, 5xx, timeout or network error, the last good body is served for up to STALE_ON_ERROR_S so a backend
 *   hiccup does not blank the site (a 404 or 400 is an answer and is never masked by it);
 * - a 429 means this server's IP bucket is empty: uncached reads (search, paged lists) are not sent until its
 *   `Retry-After` (capped at 60 s) passes.
 */
export type BackendResult<T> =
  { ok: true; data: T } | { ok: false; kind: 'not_found' | 'bad_request' | 'unavailable' }

export const REVALIDATE_SECONDS = 60
const TIMEOUT_MS = 5_000
const NOT_FOUND_TTL_MS = REVALIDATE_SECONDS * 1_000
const NOT_FOUND_MAX_ENTRIES = 1_000
const BODY_TTL_MS = REVALIDATE_SECONDS * 1_000
const BODY_MAX_ENTRIES = 500
const STALE_ON_ERROR_S = 300
const BACKOFF_DEFAULT_S = 10

// Next bundles the pages, route handlers and the sitemap separately, each with its own copy of this module: the
// memory lives on `globalThis` so the whole server process shares it (one backend call per URL per minute, and a
// take-down is seen by the sitemap exactly when it is seen by the page).
interface ReadMemory {
  notFoundUntil: Map<string, number>
  /** Last good 200 body per cacheable URL: fresh until `freshUntil`, served as a fallback while the backend fails. */
  bodies: Map<string, { data: unknown; freshUntil: number }>
  inFlight: Map<string, Promise<BackendResult<unknown>>>
}
const memoryHost = globalThis as { __tazzzoBackendReads?: ReadMemory }
const { notFoundUntil, bodies, inFlight } = (memoryHost.__tazzzoBackendReads ??= {
  notFoundUntil: new Map(),
  bodies: new Map(),
  inFlight: new Map(),
})
let backoffUntil = 0

/** Test seam: forget remembered 404s, cached bodies and any 429 backoff. */
export function resetFailureMemory(): void {
  notFoundUntil.clear()
  bodies.clear()
  inFlight.clear()
  backoffUntil = 0
}

function rememberBody(url: string, data: unknown, now: number): void {
  bodies.delete(url)
  bodies.set(url, { data, freshUntil: now + BODY_TTL_MS })
  for (const key of bodies.keys()) {
    if (bodies.size <= BODY_MAX_ENTRIES) break
    bodies.delete(key)
  }
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
  if (options.cache === false) {
    if (backoffUntil > Date.now()) return { ok: false, kind: 'unavailable' }
    return fetchJson(url, pathAndQuery, env.caller, false)
  }
  const now = Date.now()
  const until = notFoundUntil.get(url)
  if (until !== undefined && until > now) return { ok: false, kind: 'not_found' }
  if (until !== undefined) notFoundUntil.delete(url)
  const body = bodies.get(url)
  if (body !== undefined && body.freshUntil > now) return { ok: true, data: body.data }
  const pending = inFlight.get(url)
  if (pending !== undefined) return pending
  const request = fetchJson(url, pathAndQuery, env.caller, true).finally(() => inFlight.delete(url))
  inFlight.set(url, request)
  return request
}

async function fetchJson(
  url: string,
  pathAndQuery: string,
  caller: { name: string; secret: string } | null,
  cacheable: boolean,
): Promise<BackendResult<unknown>> {
  const unavailable = (): BackendResult<unknown> => {
    // A cacheable read that cannot be refreshed falls back to the last good body, for a bounded time.
    const last = cacheable ? bodies.get(url) : undefined
    if (last !== undefined && Date.now() < last.freshUntil + STALE_ON_ERROR_S * 1_000) {
      return { ok: true, data: last.data }
    }
    return { ok: false, kind: 'unavailable' }
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: requestHeaders(caller),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never the Next data cache (see the header comment): freshness is decided above.
      cache: 'no-store',
    })
  } catch {
    console.warn(`storefront_backend_unreachable path=${routeLabel(pathAndQuery)}`)
    return unavailable()
  }
  if (response.status === 404) {
    if (cacheable) {
      bodies.delete(url)
      rememberNotFound(url, Date.now())
    }
    return { ok: false, kind: 'not_found' }
  }
  if (response.status === 400) return { ok: false, kind: 'bad_request' }
  if (response.status === 429) backoffUntil = Date.now() + retryAfterSeconds(response) * 1_000
  if (!response.ok) {
    console.warn(
      `storefront_backend_error path=${routeLabel(pathAndQuery)} status=${response.status} request_id=${requestId(response)}`,
    )
    return unavailable()
  }
  try {
    const data = (await response.json()) as unknown
    if (cacheable) rememberBody(url, data, Date.now())
    return { ok: true, data }
  } catch {
    console.warn(`storefront_backend_malformed path=${routeLabel(pathAndQuery)}`)
    return unavailable()
  }
}

export const CALLER_HEADER = 'X-Tazzzo-Caller'
export const CALLER_SECRET_HEADER = 'X-Tazzzo-Caller-Secret'

export function requestHeaders(
  caller: { name: string; secret: string } | null,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (caller) {
    headers[CALLER_HEADER] = caller.name
    headers[CALLER_SECRET_HEADER] = caller.secret
  }
  return headers
}

/** A log label without the query string (search text is customer input and is never logged). */
export function routeLabel(pathAndQuery: string): string {
  // A saved-address id is customer data: the label names the route, not the address.
  return (pathAndQuery.split('?')[0] ?? '')
    .replace(/\/addresses\/[^/]+/, '/addresses/{id}')
    .replace(/\/orders\/[^/]+/, '/orders/{id}')
}

function requestId(response: Response): string {
  const id = response.headers.get('x-request-id') ?? ''
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'none'
}

/**
 * Outcome of a customer call (`sendJson`). Only a closed vocabulary leaves this module; the backend's message text is
 * never read. `code` is the backend's public error code (`OTP_INVALID`, ...) when it sent a well-formed one.
 */
export type SendResult =
  | { ok: true; status: number; data: unknown }
  | {
      ok: false
      kind: 'unauthenticated' | 'rejected' | 'rate_limited' | 'unavailable'
      code: string | null
      retryAfterSeconds: number | null
      /** The per-line rejections of a refused checkout quote (`CHECKOUT_ITEM_UNAVAILABLE`), otherwise absent. */
      items?: RejectedItem[]
    }

/** One cart line a checkout quote refused, with the backend's closed reason code. */
export interface RejectedItem {
  skuId: string
  reason: string
}

const SEND_RETRY_AFTER_MAX_S = 3_600
const ERROR_CODE = /^[A-Z][A-Z_]{0,39}$/

/**
 * Customer-session calls (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`; `ifMatch` sets the cart's or an address's `If-Match`, `idempotencyKey` an address create's or a checkout quote's `Idempotency-Key`): `/v1/auth/**` and
 * `/v1/customer/**`, never cached, never retried. Same transport rules as
 * `getJson` (timeout, redirects refused, trusted-caller headers, only `TAZZZO_API_BASE_URL`), plus an optional bearer
 * access token. No client address or any incoming header is forwarded: the backend takes the visitor address only from
 * its own trusted proxy's `X-Forwarded-For` and ignores it from this server (`ClientIpResolver`), and the trusted-caller
 * credential carries nothing about the visitor. The body and the response body are never logged.
 */
export async function sendJson(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; bearer?: string; ifMatch?: string; idempotencyKey?: string } = {},
): Promise<SendResult> {
  if (!/^\/v1\/(auth|customer)\//.test(path)) throw new Error('customer API paths only')
  const env = serverEnv()
  const headers = requestHeaders(env.caller)
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.ifMatch) headers['If-Match'] = options.ifMatch
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  let response: Response
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    console.warn(`storefront_backend_unreachable path=${routeLabel(path)}`)
    return { ok: false, kind: 'unavailable', code: null, retryAfterSeconds: null }
  }
  if (response.ok) {
    if (response.status === 204) return { ok: true, status: 204, data: undefined }
    try {
      return { ok: true, status: response.status, data: (await response.json()) as unknown }
    } catch {
      console.warn(`storefront_backend_malformed path=${routeLabel(path)}`)
      return { ok: false, kind: 'unavailable', code: null, retryAfterSeconds: null }
    }
  }
  console.warn(
    `storefront_backend_error path=${routeLabel(path)} status=${response.status} request_id=${requestId(response)}`,
  )
  const { code, items } = await errorBody(response)
  const retry = Number(response.headers.get('retry-after'))
  const retryAfterSeconds =
    Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), SEND_RETRY_AFTER_MAX_S) : null
  if (response.status === 401)
    return { ok: false, kind: 'unauthenticated', code, retryAfterSeconds: null }
  if (response.status === 429) {
    return {
      ok: false,
      kind: 'rate_limited',
      code,
      retryAfterSeconds: retryAfterSeconds ?? BACKOFF_DEFAULT_S,
    }
  }
  if (response.status === 400 || response.status === 422) {
    return { ok: false, kind: 'rejected', code, retryAfterSeconds: null }
  }
  return {
    ok: false,
    kind: 'unavailable',
    code,
    retryAfterSeconds,
    ...(items.length > 0 ? { items } : {}),
  }
}

const MAX_REJECTED_ITEMS = 50

/** The backend's public error `code` and, when it sent them, the bounded per-line rejections. Nothing else is read. */
async function errorBody(
  response: Response,
): Promise<{ code: string | null; items: RejectedItem[] }> {
  try {
    const body = (await response.json()) as { code?: unknown; items?: unknown }
    const code = typeof body.code === 'string' && ERROR_CODE.test(body.code) ? body.code : null
    const items: RejectedItem[] = []
    if (Array.isArray(body.items)) {
      for (const entry of body.items.slice(0, MAX_REJECTED_ITEMS) as unknown[]) {
        const row = entry as { skuId?: unknown; reason?: unknown } | null
        if (
          row !== null &&
          typeof row === 'object' &&
          typeof row.skuId === 'string' &&
          PRODUCT_ID.test(row.skuId) &&
          typeof row.reason === 'string' &&
          ERROR_CODE.test(row.reason)
        ) {
          items.push({ skuId: row.skuId, reason: row.reason })
        }
      }
    }
    return { code, items }
  } catch {
    return { code: null, items: [] }
  }
}
