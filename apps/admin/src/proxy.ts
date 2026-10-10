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
  // Same production test as the server env schema (`NODE_ENV === 'production'`), so both accept the same origins.
  const production = process.env.NODE_ENV === 'production'
  // Optional, explicit media origins. An invalid value is never added (fail closed); the server env schema rejects it.
  const csp = buildContentSecurityPolicy({
    cspNonce,
    isDev,
    uploadOrigin: parseCspOrigin(process.env.CMS_MEDIA_UPLOAD_ORIGIN, production),
    imageOrigin: parseCspOrigin(process.env.CMS_MEDIA_PUBLIC_ORIGIN, production),
  })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', cspNonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

/**
 * Runs for every page request except a genuine Next router prefetch: `rsc` exactly `1` AND `next-router-prefetch`
 * exactly `1` (same rule as the storefront). The two entries are alternatives, so the proxy is skipped only when BOTH
 * headers are present; a request with a lone prefetch header (or `purpose: prefetch`) is a full render and gets the CSP.
 * Written out twice because Next reads this object statically.
 */
export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'rsc', value: '1' }],
    },
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch', value: '1' }],
    },
  ],
}
