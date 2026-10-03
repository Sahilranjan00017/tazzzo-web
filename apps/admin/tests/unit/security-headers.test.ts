import { describe, expect, it } from 'vitest'
import {
  NO_STORE_CACHE_CONTROL,
  STATIC_SECURITY_HEADERS,
  buildContentSecurityPolicy,
  generateCspNonce,
} from '@/lib/security/headers'

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

describe('CSP nonce', () => {
  it('is non-empty base64 of 16 random bytes and differs per call', () => {
    const a = generateCspNonce()
    const b = generateCspNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(atob(a)).toHaveLength(16)
    expect(a).not.toEqual(b)
    expect(new Set(Array.from({ length: 50 }, generateCspNonce)).size).toBe(50)
  })
})

describe('production CSP', () => {
  const nonce = generateCspNonce()
  const csp = buildContentSecurityPolicy({ cspNonce: nonce, isDev: false })
  const d = directives(csp)

  it('allows scripts only from self with this request nonce', () => {
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"])
    expect(d.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`])
  })

  it('is restrictive: no framing, plugins, base hijack or foreign form targets', () => {
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'none'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('default-src')).toEqual(["'self'"])
  })

  it('has no wildcard or unsafe sources', () => {
    for (const values of d.values()) {
      for (const v of values) {
        expect(v).not.toBe('*')
        expect(v).not.toMatch(/^(https?:|\*)/)
      }
    }
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('rejects an empty or malformed nonce', () => {
    expect(() => buildContentSecurityPolicy({ cspNonce: '', isDev: false })).toThrow()
    expect(() =>
      buildContentSecurityPolicy({ cspNonce: "x' 'unsafe-inline", isDev: false }),
    ).toThrow()
  })
})

describe('development CSP', () => {
  it('adds unsafe-eval and inline styles only in development, keeping the nonce for scripts', () => {
    const nonce = generateCspNonce()
    const d = directives(buildContentSecurityPolicy({ cspNonce: nonce, isDev: true }))
    expect(d.get('script-src')).toContain("'unsafe-eval'")
    expect(d.get('script-src')).toContain(`'nonce-${nonce}'`)
    expect(d.get('style-src')).toContain("'unsafe-inline'")
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
  })
})

describe('static security headers', () => {
  it('set the safe baseline on every response', () => {
    expect(STATIC_SECURITY_HEADERS).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    })
    const permissions = STATIC_SECURITY_HEADERS['Permissions-Policy'] ?? ''
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(permissions).toContain(feature)
    }
  })

  it('leave HSTS to the TLS edge, and offer a no-store policy for authenticated responses', () => {
    expect(Object.keys(STATIC_SECURITY_HEADERS)).not.toContain('Strict-Transport-Security')
    expect(NO_STORE_CACHE_CONTROL).toBe('no-store')
  })
})
