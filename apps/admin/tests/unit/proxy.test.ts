import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config, proxy } from '@/proxy'

function nonceOf(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1]
}

describe('proxy: CSP nonce plumbing', () => {
  it('sends a nonce CSP on the response and passes the same nonce to rendering', () => {
    const res = proxy(new NextRequest('http://localhost:3000/login'))
    const csp = res.headers.get('content-security-policy')
    const nonce = nonceOf(csp)

    expect(nonce).toBeTruthy()
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce)
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
  })

  it('uses a fresh nonce for every request', () => {
    const a = nonceOf(
      proxy(new NextRequest('http://localhost:3000/login')).headers.get('content-security-policy'),
    )
    const b = nonceOf(
      proxy(new NextRequest('http://localhost:3000/login')).headers.get('content-security-policy'),
    )
    expect(a).toBeTruthy()
    expect(a).not.toEqual(b)
  })

  it('skips API routes, static assets and prefetches', () => {
    const [matcher] = config.matcher
    expect(matcher?.source).toBe('/((?!api|_next/static|_next/image|favicon.ico).*)')
  })
})

describe('proxy: UX-only session-cookie gate', () => {
  beforeEach(() => {
    process.env.CMS_BASE_URL = 'https://admin.tazzzo.example'
  })
  afterEach(() => {
    delete process.env.CMS_BASE_URL
  })

  it('sends a protected page without any session cookie to /login on CMS_BASE_URL, ignoring the request Host', () => {
    const res = proxy(
      new NextRequest('http://attacker-host.example/catalog?x=1', {
        headers: { 'x-forwarded-host': 'evil.example' },
      }),
    )
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      `https://admin.tazzzo.example/login?returnTo=${encodeURIComponent('/catalog?x=1')}`,
    )
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('without CMS_BASE_URL serves /login in place rather than trusting the Host', () => {
    delete process.env.CMS_BASE_URL
    const res = proxy(new NextRequest('http://attacker-host.example/catalog'))
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-middleware-rewrite')).toContain('/login')
  })

  it('lets /login through without a cookie', () => {
    expect(proxy(new NextRequest('http://localhost:3000/login')).status).toBe(200)
  })

  it('checks presence only: any session cookie (valid or forged) passes on to server-side validation', () => {
    for (const cookie of ['__Host-tz_cms_session=forged', 'tz_cms_session_dev=x']) {
      const res = proxy(new NextRequest('http://localhost:3000/', { headers: { cookie } }))
      expect(res.status).toBe(200)
      expect(res.headers.get('location')).toBeNull()
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })
})

describe('proxy: media origins use the same production test as the env schema', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })
  const csp = () =>
    proxy(new NextRequest('http://localhost:3000/login')).headers.get('content-security-policy') ??
    ''
  it('adds a loopback http upload origin outside production (NODE_ENV test or development)', () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      CMS_MEDIA_UPLOAD_ORIGIN: 'http://127.0.0.1:9090',
    })
    expect(csp()).toContain("connect-src 'self' http://127.0.0.1:9090")
  })
  it('never adds it in production, and never adds an invalid value', () => {
    Object.assign(process.env, {
      NODE_ENV: 'production',
      CMS_MEDIA_UPLOAD_ORIGIN: 'http://127.0.0.1:9090',
      CMS_MEDIA_PUBLIC_ORIGIN: 'https://*.cdn.example',
    })
    expect(csp()).toContain("connect-src 'self';")
    expect(csp()).toContain("img-src 'self' blob: data:;")
  })
})
