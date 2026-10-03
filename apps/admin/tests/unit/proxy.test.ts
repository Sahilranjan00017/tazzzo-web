import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

function nonceOf(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1]
}

describe('proxy (CSP nonce plumbing only)', () => {
  it('sends a nonce CSP on the response and passes the same nonce to rendering', () => {
    const res = proxy(new NextRequest('http://localhost:3000/login'))
    const csp = res.headers.get('content-security-policy')
    const nonce = nonceOf(csp)

    expect(nonce).toBeTruthy()
    expect(csp).toContain("frame-ancestors 'none'")
    // NextResponse.next({ request: { headers } }) forwards overridden request headers to rendering.
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce)
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
  })

  it('uses a fresh nonce for every request', () => {
    const a = nonceOf(
      proxy(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy'),
    )
    const b = nonceOf(
      proxy(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy'),
    )
    expect(a).not.toEqual(b)
  })

  it('does no authentication: no redirect, no cookie, whatever the request carries', () => {
    const req = new NextRequest('http://localhost:3000/', { headers: { cookie: 'anything=1' } })
    const res = proxy(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('skips static assets and prefetches as documented', () => {
    const [matcher] = config.matcher
    expect(matcher?.source).toBe('/((?!api|_next/static|_next/image|favicon.ico).*)')
  })
})
