import 'server-only'
import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { z } from 'zod'
import { serverEnv } from '@/server/env'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { isSameOriginMutation } from '@/server/auth/csrf'
import { sessionConfig } from '@/server/session/config'
import { checkSession, endSession } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { SessionStoreUnavailable, type SessionStore } from '@/server/store/types'
import { NO_STORE_CACHE_CONTROL } from '@/lib/security/headers'

/**
 * Narrow BFF mutation layer. Every route declares, in code, exactly one backend path, method, request schema,
 * response schema and header allowlist. There is no generic proxy: the browser never chooses a backend path, method,
 * host or header. The BFF is a transport/security boundary only; the backend authorizes every mutation as the
 * signed-in human (Bearer = their Google ID token, never a service credential).
 */
export const BFF_MAX_BODY_BYTES = 16 * 1024
export const BFF_BACKEND_TIMEOUT_MS = 5_000
const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset=utf-8\s*)?$/i
const BACKEND_REQUEST_ID = /^req_[0-9a-f]{20}$/
const SAFE_CODE = /^[A-Z][A-Z_]{1,39}$/

export interface BackendCall {
  /** Static path (template filled only with validated values). */
  path: string
  /** Extra request headers, from the route's own fixed allowlist (e.g. If-Match). */
  headers?: Record<string, string>
  body: unknown
}

export interface BffMutationSpec<In, Out, Client> {
  routeId: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  input: z.ZodType<In>
  backend: (input: In) => BackendCall
  output: z.ZodType<Out>
  toClient: (output: Out) => Client
  /** Per-route override of the request body bound (default 16 KiB). Set only where a documented backend limit is larger. */
  maxBodyBytes?: number
  /** Per-route override of the backend timeout (default 5 s) for operations that are slow by design (bulk import). */
  timeoutMs?: number
  /**
   * For 400/422 only: extract a SAFE, bounded detail object from the backend's error body (e.g. import row errors).
   * Whatever it returns is merged under `detail`; nothing else from the backend body is ever passed through.
   */
  errorDetail?: (body: unknown) => unknown
  /**
   * A deployment-configuration gate checked after the session is validated and BEFORE the backend is called: a returned
   * machine code (e.g. `UPLOAD_ORIGIN_NOT_CONFIGURED`) is answered as 503 with that code and the backend is not contacted.
   */
  precondition?: () => string | undefined
}

export interface BffDeps {
  store: SessionStore
  fetchImpl: typeof fetch
  now: () => number
}

type Outcome =
  | 'succeeded'
  | 'invalid_request'
  | 'csrf_rejected'
  | 'unauthenticated'
  | 'denied'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_error'

const EVENT: Record<Outcome, string> = {
  succeeded: 'bff.mutation.succeeded',
  invalid_request: 'bff.mutation.invalid_request',
  csrf_rejected: 'bff.mutation.invalid_request',
  unauthenticated: 'bff.mutation.unauthenticated',
  denied: 'bff.mutation.denied',
  not_found: 'bff.mutation.upstream_error',
  conflict: 'bff.mutation.upstream_error',
  rate_limited: 'bff.mutation.upstream_error',
  upstream_error: 'bff.mutation.upstream_error',
}

/** Structured, secret-free event. Never: tokens, cookies, session ids, subjects, emails or request bodies. */
function logEvent(event: string, fields: Record<string, string | number>): void {
  console.info(JSON.stringify({ event, ...fields }))
}

class BodyTooLarge extends Error {}

async function readBoundedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Runs one declared mutation: CSRF -> content type -> bounded JSON -> strict schema -> server-side session ->
 * single backend call (no retry, no redirects, 5 s timeout, fixed headers) -> normalized, no-store JSON.
 */
export async function runBffMutation<In, Out, Client>(
  spec: BffMutationSpec<In, Out, Client>,
  request: NextRequest,
  pathParams: Record<string, string> = {},
  deps: BffDeps = { store: sessionStore(), fetchImpl: fetch, now: Date.now },
): Promise<NextResponse> {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  const correlationId = `bff_${randomBytes(12).toString('hex')}`
  const started = deps.now()
  logEvent('bff.mutation.started', { routeId: spec.routeId, correlationId })

  const respond = (
    status: number,
    outcome: Outcome,
    body: Record<string, unknown>,
    extra?: Record<string, string>,
  ) => {
    logEvent(EVENT[outcome], {
      routeId: spec.routeId,
      correlationId,
      outcome,
      status,
      durationMs: deps.now() - started,
    })
    const response = NextResponse.json({ ...body, correlationId }, { status })
    response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL)
    for (const [name, value] of Object.entries(extra ?? {})) response.headers.set(name, value)
    return response
  }

  if (request.method !== spec.method)
    return respond(405, 'invalid_request', { error: 'method_not_allowed' })
  if (!isSameOriginMutation(request.headers, env.CMS_BASE_URL)) {
    return respond(403, 'csrf_rejected', { error: 'forbidden' })
  }
  if (!JSON_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) {
    return respond(415, 'invalid_request', { error: 'unsupported_media_type' })
  }

  let raw: string
  try {
    raw = await readBoundedText(request, spec.maxBodyBytes ?? BFF_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLarge)
      return respond(413, 'invalid_request', { error: 'payload_too_large' })
    return respond(400, 'invalid_request', { error: 'invalid_request' })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return respond(400, 'invalid_request', { error: 'invalid_json' })
  }
  // Path parameters are merged after the bounded parse (and win over body fields); the strict schema validates both.
  const candidate =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? { ...json, ...pathParams }
      : json
  const parsed = spec.input.safeParse(candidate)
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ]
    return respond(400, 'invalid_request', { error: 'invalid_request', fields })
  }

  const cookieValue = request.cookies.get(policy.sessionName)?.value
  const expireCookie = (response: NextResponse) => {
    if (cookieValue !== undefined)
      response.cookies.set(policy.sessionName, '', cookieAttributes(policy, 0))
    return response
  }
  let idToken: string
  try {
    const session = await checkSession(deps.store, cookieValue, sessionConfig(env), deps.now())
    if (session.status !== 'valid')
      return expireCookie(respond(401, 'unauthenticated', { error: 'unauthenticated' }))
    idToken = session.idToken
  } catch (error) {
    if (error instanceof SessionStoreUnavailable)
      return respond(503, 'upstream_error', { error: 'unavailable' })
    throw error
  }

  const unmet = spec.precondition?.()
  if (unmet !== undefined)
    return respond(503, 'upstream_error', {
      error: 'unavailable',
      ...(SAFE_CODE.test(unmet) ? { code: unmet } : {}),
    })

  const call = spec.backend(parsed.data)
  let upstream: Response
  try {
    upstream = await deps.fetchImpl(new URL(call.path, env.TAZZZO_BACKEND_URL), {
      method: spec.method,
      // Built from scratch: never the browser's Cookie, Forwarded/X-Forwarded-*, or any other incoming header.
      headers: {
        ...call.headers,
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(call.body),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(spec.timeoutMs ?? BFF_BACKEND_TIMEOUT_MS),
    })
  } catch {
    return respond(504, 'upstream_error', { error: 'upstream_unavailable' })
  }

  const backendRequestId = upstream.headers.get('x-request-id') ?? ''
  const trace = BACKEND_REQUEST_ID.test(backendRequestId) ? { backendRequestId } : {}
  const code = await safeErrorCode(upstream)

  if (upstream.status >= 200 && upstream.status < 300) {
    const output = spec.output.safeParse(await upstream.json().catch(() => undefined))
    if (!output.success)
      return respond(502, 'upstream_error', { error: 'upstream_error', ...trace })
    return respond(200, 'succeeded', { data: spec.toClient(output.data), ...trace })
  }
  switch (upstream.status) {
    case 401:
      await endSession(deps.store, cookieValue).catch(() => undefined)
      return expireCookie(respond(401, 'unauthenticated', { error: 'unauthenticated', ...trace }))
    case 403:
      return respond(403, 'denied', { error: 'forbidden', ...trace })
    case 404:
      return respond(404, 'not_found', { error: 'not_found', ...trace })
    case 409:
      return respond(409, 'conflict', { error: 'conflict', ...(code ? { code } : {}), ...trace })
    case 400:
    case 422: {
      const detail = spec.errorDetail
        ? spec.errorDetail(await upstream.json().catch(() => undefined))
        : undefined
      return respond(upstream.status, 'invalid_request', {
        error: 'invalid_request',
        ...(code ? { code } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...trace,
      })
    }
    case 413:
      // The backend's own body bound (e.g. 2 MiB on imports) is answered as the same 413 the BFF's bound gives.
      return respond(413, 'invalid_request', { error: 'payload_too_large', ...trace })
    case 429: {
      const retryAfter = upstream.headers.get('retry-after') ?? ''
      const extra = /^[1-9][0-9]{0,3}$/.test(retryAfter) ? { 'Retry-After': retryAfter } : undefined
      return respond(429, 'rate_limited', { error: 'rate_limited', ...trace }, extra)
    }
    default:
      // 3xx (redirects are never followed), other 4xx and 5xx: nothing from the backend body is passed through, except
      // the stable machine code of a 503 (e.g. MEDIA_STORAGE_NOT_CONFIGURED) so the UI can name a known outage.
      return respond(502, 'upstream_error', {
        error: 'upstream_error',
        ...(upstream.status === 503 && code ? { code } : {}),
        ...trace,
      })
  }
}

/** The backend's stable error code (e.g. STALE_VERSION) if well-formed; never its message or other fields. */
async function safeErrorCode(response: Response): Promise<string | undefined> {
  if (response.ok) return undefined
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined
  const code = body?.error?.code
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined
}
