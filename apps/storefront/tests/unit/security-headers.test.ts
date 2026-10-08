import { describe, expect, it } from 'vitest'
import {
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

describe('production CSP', () => {
  const nonce = generateCspNonce()
  const csp = buildContentSecurityPolicy({
    cspNonce: nonce,
    isDev: false,
    mediaOrigin: 'https://cdn.tazzzo.test',
  })
  const d = directives(csp)

  it('allows scripts and styles only from self with this request nonce', () => {
    expect(d.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"])
    expect(d.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`])
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('limits images to self and the configured media origin, nothing else', () => {
    expect(d.get('img-src')).toEqual(["'self'", 'https://cdn.tazzzo.test'])
    for (const [name, values] of d) {
      if (name === 'img-src') continue
      for (const v of values) expect(v).not.toMatch(/^(https?:|\*|data:|blob:)/)
    }
  })

  it('is restrictive: no framing, plugins, base hijack or foreign form targets', () => {
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'none'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('connect-src')).toEqual(["'self'"])
  })

  it('without a media host, images come from self only', () => {
    const none = directives(
      buildContentSecurityPolicy({ cspNonce: nonce, isDev: false, mediaOrigin: null }),
    )
    expect(none.get('img-src')).toEqual(["'self'"])
  })

  it('rejects a malformed nonce or a media origin that could inject directives', () => {
    expect(() =>
      buildContentSecurityPolicy({ cspNonce: '', isDev: false, mediaOrigin: null }),
    ).toThrow()
    expect(() =>
      buildContentSecurityPolicy({
        cspNonce: nonce,
        isDev: false,
        mediaOrigin: "https://cdn.test; script-src 'unsafe-inline'",
      }),
    ).toThrow()
    expect(() =>
      buildContentSecurityPolicy({
        cspNonce: nonce,
        isDev: false,
        mediaOrigin: 'https://cdn.test/path',
      }),
    ).toThrow()
  })
})

describe('development CSP', () => {
  it('adds unsafe-eval and inline styles only in development', () => {
    const nonce = generateCspNonce()
    const d = directives(
      buildContentSecurityPolicy({ cspNonce: nonce, isDev: true, mediaOrigin: null }),
    )
    expect(d.get('script-src')).toContain("'unsafe-eval'")
    expect(d.get('style-src')).toContain("'unsafe-inline'")
  })
})

describe('static security headers', () => {
  it('set the safe baseline and leave HSTS to the TLS edge', () => {
    expect(STATIC_SECURITY_HEADERS).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    })
    expect(Object.keys(STATIC_SECURITY_HEADERS)).not.toContain('Strict-Transport-Security')
  })
})
