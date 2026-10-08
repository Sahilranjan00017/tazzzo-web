// Next 16.3.8 ships this helper under its pre-rename name (the docs call it unstable_doesProxyMatch).
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

const matches = (url: string, headers?: Record<string, string>) =>
  unstable_doesMiddlewareMatch({ config, nextConfig: {}, url, headers })

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

  it('skips build assets, the favicon and router prefetches', () => {
    expect(matches('/_next/static/chunks/app.js')).toBe(false)
    expect(matches('/_next/image?url=x')).toBe(false)
    expect(matches('/favicon.ico')).toBe(false)
    expect(matches('/', { 'next-router-prefetch': '1' })).toBe(false)
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
