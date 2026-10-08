import { NextResponse, type NextRequest } from 'next/server'
import { parseMediaBase } from '@/lib/media-base'
import { buildContentSecurityPolicy, generateCspNonce } from '@/lib/security/headers'

/**
 * Per-request CSP nonce (Next.js 16 `proxy.ts`). The storefront has no authentication; this only sets the policy.
 * `img-src` admits the configured media origin (`TAZZZO_MEDIA_BASE_URL`), validated exactly like the server env.
 */
export function proxy(request: NextRequest): NextResponse {
  const cspNonce = generateCspNonce()
  const media = parseMediaBase(process.env.TAZZZO_MEDIA_BASE_URL, process.env.NODE_ENV)
  const csp = buildContentSecurityPolicy({
    cspNonce,
    isDev: process.env.NODE_ENV === 'development',
    mediaOrigin: media?.origin ?? null,
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
      // There are no API routes: every page path gets the policy (only build assets and the favicon are skipped).
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
