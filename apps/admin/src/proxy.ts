import { NextResponse, type NextRequest } from 'next/server'
import { buildContentSecurityPolicy, generateCspNonce } from '@/lib/security/headers'

/**
 * Request interception (Next.js 16 `proxy.ts`, formerly `middleware.ts`). W1 responsibility is ONLY the per-request
 * CSP nonce: generate it, pass it to rendering (Next reads it from the request CSP header and applies it to its
 * scripts) and send the CSP on the response. No authentication, no session or cookie checks, no redirects.
 */
export function proxy(request: NextRequest): NextResponse {
  const cspNonce = generateCspNonce()
  const csp = buildContentSecurityPolicy({
    cspNonce,
    isDev: process.env.NODE_ENV === 'development',
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
