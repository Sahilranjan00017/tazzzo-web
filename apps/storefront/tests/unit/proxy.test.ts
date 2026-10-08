// Next 16.3.8 ships this helper under its pre-rename name (the docs call it unstable_doesProxyMatch).
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVisitorLimiter } from '@/lib/security/rate-limit'
import { config, proxy } from '@/proxy'

const matches = (url: string, headers?: Record<string, string>) =>
  unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers })

// Next patches console methods with a check that needs its request storage, absent outside its runtime: the proxy's
// operational warnings are silenced here (their content is covered in rate-limit.test.ts).
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetVisitorLimiter()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetVisitorLimiter()
})

describe('proxy matcher', () => {
  it('applies the CSP to every page path, including ones that merely start with "api"', () => {
    for (const url of [
      '/',
      '/p/TZP-1',
      '/c/TZS-000001',
      '/search?q=rice',
      '/apiary',
      '/api',
      '/robots.txt',
    ]) {
      expect(matches(url), url).toBe(true)
    }
  })

  it('skips build assets and the favicon only', () => {
    expect(matches('/_next/static/chunks/app.js')).toBe(false)
    expect(matches('/_next/image?url=x')).toBe(false)
    expect(matches('/favicon.ico')).toBe(false)
  })

  it('skips only a genuine router prefetch: rsc=1 AND next-router-prefetch=1 (the Next server rule)', () => {
    const genuine = { rsc: '1', 'next-router-prefetch': '1' }
    expect(matches('/search?q=rice', genuine)).toBe(false)
    expect(
      matches('/c/TZS-000001?cursor=a', { ...genuine, 'next-router-segment-prefetch': '/_tree' }),
    ).toBe(false)
    expect(matches('/', genuine)).toBe(false)
  })

  it('runs for every prefetch-LOOKING request Next renders in full (these used to skip the limit and the CSP)', () => {
    for (const headers of <Array<Record<string, string>>>[
      { 'next-router-prefetch': '1' },
      { purpose: 'prefetch' },
      { 'sec-purpose': 'prefetch' },
      { rsc: '1' }, // an ordinary client-side navigation
      { rsc: '1', 'next-router-prefetch': '0' },
      { rsc: '1', 'next-router-prefetch': '11' },
      { rsc: 'true', 'next-router-prefetch': '1' },
      { rsc: '1, 1', 'next-router-prefetch': '1' },
    ]) {
      expect(matches('/search?q=rice', headers), JSON.stringify(headers)).toBe(true)
    }
  })
})

describe('proxy', () => {
  it('sets a nonce CSP on the response and forwards the nonce to rendering', () => {
    const response = proxy(new NextRequest('http://localhost/apiary'))
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/)
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeTruthy()
  })
})

describe('proxy rate limit', () => {
  const request = (path: string, forwardedFor?: string) =>
    new NextRequest(`http://localhost${path}`, {
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    })

  function trustProxy(limits: Record<string, string> = {}): void {
    vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
    for (const [key, value] of Object.entries(limits)) vi.stubEnv(key, value)
  }

  it('default limits: a burst of 20 pages passes, the 21st is a plain-text 429 with Retry-After and the CSP', async () => {
    trustProxy()
    for (let i = 0; i < 20; i++) {
      expect(proxy(request('/', '203.0.113.9')).status, `request ${i + 1}`).toBe(200)
    }
    const refused = proxy(request('/p/TZP-1', '203.0.113.9'))
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
    expect(refused.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(refused.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/)
    expect(refused.headers.get('x-middleware-next')).toBeNull() // nothing is rendered
    expect(await refused.text()).toBe('Too many requests. Please wait a moment and try again.\n')
    // Another visitor behind the same proxy is unaffected.
    expect(proxy(request('/', '198.51.100.1')).status).toBe(200)
  })

  it('search is limited sooner than pages (default burst 6)', () => {
    trustProxy()
    const statuses = Array.from(
      { length: 8 },
      (_, i) => proxy(request(`/search?q=rice${i}`, '203.0.113.9')).status,
    )
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429, 429])
    expect(proxy(request('/search?q=x', '203.0.113.9')).headers.get('retry-after')).toBe('5')
    expect(proxy(request('/', '203.0.113.9')).status).toBe(200)
  })

  it('paged category lists use the stricter bucket; the first page does not', () => {
    trustProxy({ STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST: '1' })
    expect(proxy(request('/c/TZS-000001?cursor=a', '203.0.113.9')).status).toBe(200)
    expect(proxy(request('/c/TZS-000001?cursor=b', '203.0.113.9')).status).toBe(429)
    expect(proxy(request('/c/TZS-000001', '203.0.113.9')).status).toBe(200)
  })

  it('by default X-Forwarded-For is never trusted: no per-address limiting, a one-time warning', () => {
    const warn = vi.mocked(console.warn)
    for (let i = 0; i < 40; i++) {
      expect(proxy(request('/search?q=x', '203.0.113.9')).status).toBe(200)
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('inactive'))).toHaveLength(1)
  })

  it('trusted: the client-written left part of X-Forwarded-For cannot buy fresh buckets', () => {
    trustProxy({ STOREFRONT_RATE_LIMIT_BURST: '3' })
    const statuses = Array.from(
      { length: 5 },
      (_, i) => proxy(request('/', `10.9.9.${i}, 203.0.113.9`)).status,
    )
    expect(statuses).toEqual([200, 200, 200, 429, 429])
  })

  it('an invalid setting fails loudly, naming only the variable', () => {
    vi.stubEnv('STOREFRONT_RATE_LIMIT_BURST', 'lots')
    expect(() => proxy(request('/'))).toThrow(
      'invalid rate limit configuration: STOREFRONT_RATE_LIMIT_BURST',
    )
  })
})

describe('proxy rate limit: prefetch-header spoofing', () => {
  it('a burst to /search carrying a prefetch header is limited like any search (6, then 429)', () => {
    vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
    for (const spoof of <Array<Record<string, string>>>[
      { 'next-router-prefetch': '1' },
      { purpose: 'prefetch' },
    ]) {
      resetVisitorLimiter()
      const statuses = Array.from(
        { length: 8 },
        (_, i) =>
          proxy(
            new NextRequest(`http://localhost/search?q=x${i}`, {
              headers: { 'x-forwarded-for': '203.0.113.9', ...spoof },
            }),
          ).status,
      )
      expect(statuses, JSON.stringify(spoof)).toEqual([200, 200, 200, 200, 200, 200, 429, 429])
    }
  })
})
