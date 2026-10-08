import { NextResponse, type NextRequest } from 'next/server'
import {
  buildContentSecurityPolicy,
  generateCspNonce,
  parseCspOrigin,
} from '@/lib/security/headers'

/** Session cookie names (production `__Host-` and plain-http development). Presence only: never trusted here. */
const SESSION_COOKIES = ['__Host-tz_cms_session', 'tz_cms_session_dev']
const PUBLIC_PATHS = new Set(['/login'])

/**
 * Request interception (Next.js 16 `proxy.ts`). Two responsibilities:
 * 1. the per-request CSP nonce (`cspNonce`; unrelated to the OIDC login nonce);
 * 2. a UX-only shortcut: a protected page requested with no session cookie at all is sent to /login.
 * No store lookup, no decryption, no authorization: protected pages validate the session server-side.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  if (!PUBLIC_PATHS.has(pathname) && !SESSION_COOKIES.some((name) => request.cookies.has(name))) {
    const loginPath = `/login?returnTo=${encodeURIComponent(`${pathname}${search}`)}`
    // Absolute target from CMS_BASE_URL only (Next requires an absolute Location); never the request Host. Without
    // it (misconfiguration) serve /login in place instead of building a URL from untrusted headers.
    const base = process.env.CMS_BASE_URL
    if (!base) return NextResponse.rewrite(new URL('/login', request.nextUrl))
    const response = NextResponse.redirect(new URL(loginPath, base), 307)
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  const cspNonce = generateCspNonce()
  const isDev = process.env.NODE_ENV === 'development'
  // Optional, explicit media origins. An invalid value is never added (fail closed); the server env schema rejects it.
  const csp = buildContentSecurityPolicy({
    cspNonce,
    isDev,
    uploadOrigin: parseCspOrigin(process.env.CMS_MEDIA_UPLOAD_ORIGIN, !isDev),
    imageOrigin: parseCspOrigin(process.env.CMS_MEDIA_PUBLIC_ORIGIN, !isDev),
  })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', cspNonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
