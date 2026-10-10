import 'server-only'
import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { z } from 'zod'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { isSameOriginRead } from '@/server/auth/csrf'
import { backendRead } from '@/server/backend/read'
import { serverEnv } from '@/server/env'
import { sessionConfig } from '@/server/session/config'
import { checkSession, endSession } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { SessionStoreUnavailable, type SessionStore } from '@/server/store/types'
import { NO_STORE_CACHE_CONTROL } from '@/lib/security/headers'

/**
 * Narrow BFF READ layer, the sibling of `mutation.ts` for the few JSON GETs our own pages fetch from the browser (a
 * "Load more" list, a job status poll). Same trust model: a fixed backend path built by code from validated values (never
 * from the browser), the human's ID token as the only credential, no redirects, a bounded wait, no retry, a response
 * schema, and normalized `no-store` JSON with a BFF correlation id. It is not a proxy: each route declares its own call.
 */
export interface BffReadSpec<Out, Client> {
  routeId: string
  /** Static backend path (+ query) assembled from values the route has already validated. */
  path: string
  output: z.ZodType<Out>
  toClient: (output: Out) => Client
}

export interface BffReadDeps {
  store: SessionStore
  fetchImpl: typeof fetch
  now: () => number
}

const SAFE_CODE = /^[A-Z][A-Z_]{1,39}$/

export async function runBffRead<Out, Client>(
  spec: BffReadSpec<Out, Client>,
  request: NextRequest,
  deps: BffReadDeps = { store: sessionStore(), fetchImpl: fetch, now: Date.now },
): Promise<NextResponse> {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  const correlationId = `bff_${randomBytes(12).toString('hex')}`
  const started = deps.now()
  const respond = (
    status: number,
    outcome: string,
    body: Record<string, unknown>,
    extra?: Record<string, string>,
  ) => {
    console.info(
      JSON.stringify({
        event: status < 400 ? 'bff.read.succeeded' : 'bff.read.failed',
        routeId: spec.routeId,
        correlationId,
        outcome,
        status,
        durationMs: deps.now() - started,
      }),
    )
    const response = NextResponse.json({ ...body, correlationId }, { status })
    response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL)
    for (const [name, value] of Object.entries(extra ?? {})) response.headers.set(name, value)
    return response
  }

  if (request.method !== 'GET')
    return respond(405, 'method_not_allowed', { error: 'method_not_allowed' })
  if (!isSameOriginRead(request.headers, env.CMS_BASE_URL))
    return respond(403, 'csrf_rejected', { error: 'forbidden' })

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
      return respond(503, 'store_unavailable', { error: 'unavailable' })
    throw error
  }

  const result = await backendRead(
    { backendUrl: env.TAZZZO_BACKEND_URL, idToken, fetchImpl: deps.fetchImpl },
    spec.path,
    spec.output,
  )
  const trace =
    'backendRequestId' in result && result.backendRequestId
      ? { backendRequestId: result.backendRequestId }
      : {}
  switch (result.kind) {
    case 'ok':
      return respond(200, 'succeeded', { data: spec.toClient(result.data), ...trace })
    case 'unauthenticated':
      await endSession(deps.store, cookieValue).catch(() => undefined)
      return expireCookie(respond(401, 'unauthenticated', { error: 'unauthenticated' }))
    case 'forbidden':
      return respond(403, 'denied', { error: 'forbidden', ...trace })
    case 'not_found':
      return respond(404, 'not_found', { error: 'not_found', ...trace })
    case 'rate_limited':
      return respond(
        429,
        'rate_limited',
        { error: 'rate_limited', ...trace },
        result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : undefined,
      )
    case 'unavailable': {
      const code = result.code && SAFE_CODE.test(result.code) ? { code: result.code } : {}
      if (result.reason === 'timeout' || result.reason === 'network')
        return respond(504, 'upstream_unavailable', { error: 'upstream_unavailable' })
      // The backend's own refusals that a person can act on keep their status and stable machine code; nothing else
      // from the backend body is passed through.
      if (result.httpStatus === 503)
        return respond(503, 'upstream_unavailable', { error: 'unavailable', ...code, ...trace })
      if (result.httpStatus === 400 || result.httpStatus === 422)
        return respond(result.httpStatus, 'invalid_request', {
          error: 'invalid_request',
          ...code,
          ...trace,
        })
      return respond(502, 'upstream_error', { error: 'upstream_error', ...trace })
    }
  }
}
