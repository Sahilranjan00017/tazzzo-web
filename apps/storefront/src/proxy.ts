import { NextResponse, type NextRequest } from 'next/server'
import { parseMediaBase } from '@/lib/media-base'
import { buildContentSecurityPolicy, generateCspNonce } from '@/lib/security/headers'
import { recordOutcome, visitorLimiter } from '@/lib/security/rate-limit'

/**
 * Per-request CSP nonce (Next.js 16 `proxy.ts`) and the per-visitor rate limit (`src/lib/security/rate-limit.ts`;
 * per instance, in memory). The storefront has no authentication. `img-src` admits the configured media origin
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

export const config = {
  matcher: [
    {
      // There are no API routes: every page path gets the policy (only build assets and the favicon are skipped).
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
