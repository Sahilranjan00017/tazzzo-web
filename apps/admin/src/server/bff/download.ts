import 'server-only'
import { randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { isSameOriginRead } from '@/server/auth/csrf'
import { backendDownload } from '@/server/backend/read'
import { serverEnv } from '@/server/env'
import { sessionConfig } from '@/server/session/config'
import { checkSession, endSession } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { SessionStoreUnavailable, type SessionStore } from '@/server/store/types'
import { NO_STORE_CACHE_CONTROL } from '@/lib/security/headers'

/**
 * A narrow BFF file download (the import errors.csv). Same trust model as the other BFF layers: fixed backend path chosen by
 * code, the human's ID token only, no redirects, session required, CSRF header required (only our own page script can ask).
 * The CSV is STREAMED through untouched: not buffered, not parsed, not re-interpreted (the backend already neutralises
 * formula cells; the leading quote it adds is part of the exported text). The response is an attachment, `no-store`, with
 * `nosniff` and a filename built by code from a grammar-checked id, never from the backend or the browser.
 */
export interface BffDownloadSpec {
  routeId: string
  path: string
  filename: string
}

export interface BffDownloadDeps {
  store: SessionStore
  fetchImpl: typeof fetch
  now: () => number
}

export async function runBffDownload(
  spec: BffDownloadSpec,
  request: NextRequest,
  deps: BffDownloadDeps = { store: sessionStore(), fetchImpl: fetch, now: Date.now },
): Promise<Response> {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  const correlationId = `bff_${randomBytes(12).toString('hex')}`
  const fail = (status: number, error: string, extra?: Record<string, string>) => {
    console.info(
      JSON.stringify({
        event: 'bff.download.failed',
        routeId: spec.routeId,
        correlationId,
        status,
      }),
    )
    const response = NextResponse.json({ error, correlationId }, { status })
    response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL)
    for (const [name, value] of Object.entries(extra ?? {})) response.headers.set(name, value)
    return response
  }
  if (request.method !== 'GET') return fail(405, 'method_not_allowed')
  if (!isSameOriginRead(request.headers, env.CMS_BASE_URL)) return fail(403, 'forbidden')

  const cookieValue = request.cookies.get(policy.sessionName)?.value
  const expired = () => {
    const response = fail(401, 'unauthenticated')
    if (cookieValue !== undefined)
      response.cookies.set(policy.sessionName, '', cookieAttributes(policy, 0))
    return response
  }
  let idToken: string
  try {
    const session = await checkSession(deps.store, cookieValue, sessionConfig(env), deps.now())
    if (session.status !== 'valid') return expired()
    idToken = session.idToken
  } catch (error) {
    if (error instanceof SessionStoreUnavailable) return fail(503, 'unavailable')
    throw error
  }

  const result = await backendDownload(
    { backendUrl: env.TAZZZO_BACKEND_URL, idToken, fetchImpl: deps.fetchImpl },
    spec.path,
  )
  switch (result.kind) {
    case 'ok':
      return new Response(result.body, {
        status: 200,
        headers: {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${spec.filename}"`,
          'Cache-Control': NO_STORE_CACHE_CONTROL,
          'X-Content-Type-Options': 'nosniff',
          'X-Tazzzo-Correlation-Id': correlationId,
        },
      })
    case 'unauthenticated':
      await endSession(deps.store, cookieValue).catch(() => undefined)
      return expired()
    case 'forbidden':
      return fail(403, 'forbidden')
    case 'not_found':
      return fail(404, 'not_found')
    case 'rate_limited':
      return fail(429, 'rate_limited')
    case 'unavailable':
      return result.reason === 'timeout' || result.reason === 'network'
        ? fail(504, 'upstream_unavailable')
        : fail(502, 'upstream_error')
  }
}
