import { NextResponse, type NextRequest } from 'next/server'
import { parseMediaBase } from '@/lib/media-base'
import { buildContentSecurityPolicy, generateCspNonce } from '@/lib/security/headers'
import { recordOutcome, visitorLimiter } from '@/lib/security/rate-limit'

/**
 * Per-request CSP nonce (Next.js 16 `proxy.ts`) and the per-visitor rate limit (`src/lib/security/rate-limit.ts`;
 * per instance, in memory). The `/api/auth/*` customer routes pass through it as well (the OTP ones in the stricter bucket). `img-src` admits the configured media origin
 * (`TAZZZO_MEDIA_BASE_URL`), validated exactly like the server env. A refused request gets a plain-text 429 with
 * `Retry-After` and the same CSP; nothing is rendered and the backend is not called.
 */
export function proxy(request: NextRequest): NextResponse {
  const cspNonce = generateCspNonce()
  const media = parseMediaBase(process.env.TAZZZO_MEDIA_BASE_URL, process.env.NODE_ENV)
  const csp = buildContentSecurityPolicy({
    cspNonce,
    isDev: process.env.NODE_ENV === 'development',
    mediaOrigin: media?.origin ?? null,
  })

  const now = Date.now()
  const outcome = visitorLimiter().check(request.nextUrl, request.headers, now)
  recordOutcome(outcome, now)
  if (outcome.kind === 'limited') {
    return new NextResponse('Too many requests. Please wait a moment and try again.\n', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(outcome.retryAfterSeconds),
        'Content-Security-Policy': csp,
      },
    })
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', cspNonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

/**
 * The proxy runs for every page request EXCEPT a genuine Next router prefetch, recognised by the Next server's own
 * rule: `rsc` exactly `1` AND `next-router-prefetch` exactly `1` (base-server.js; matcher values are anchored
 * regexes). The two entries are alternatives, so the proxy is skipped only when both headers are present.
 *
 * Why not limit prefetches here: Next strips these flight headers before the proxy runs (server/web/adapter.js), so
 * inside the proxy a prefetch is indistinguishable from a navigation, and a home view alone sends ~10 of them; they
 * would spend the visitor's page and search tokens. Why skipping them is safe: Next answers such a request with a
 * prefetch payload that does not render the page body (measured: replayed /search and /c/?cursor prefetches with fresh
 * queries made no backend call). Any request with only ONE of the headers, or `purpose: prefetch`, is a full render
 * and goes through the proxy like any page (the old matcher let those skip the limit and the CSP). That holds only
 * while no route has a `loading` boundary and PPR/`cacheComponents` is off; tests/unit/prefetch-exemption-policy.test.ts
 * fails if either changes.
 *
 * `source` (both entries): every page path; only build assets and the favicon are never seen (the `/api/auth/*` routes are). It is
 * written out twice because Next reads this object statically (no references).
 */
export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'rsc', value: '1' }],
    },
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch', value: '1' }],
    },
    // Route handlers ignore the prefetch headers and always run in full (and a POST can carry them), so `/api/*` is
    // ALWAYS limited and given the security headers, whatever headers or method the request carries.
    { source: '/api/:path*' },
  ],
}
