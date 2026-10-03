import { describe, expect, it } from 'vitest'
import { cookieAttributes, cookiePolicy, isOpaqueId } from '@/server/auth/cookies'
import { isSameOriginMutation } from '@/server/auth/csrf'

describe('cookie policy', () => {
  it('production: __Host- names, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain', () => {
    const policy = cookiePolicy('https://admin.tazzzo.example')
    expect(policy).toEqual({
      sessionName: '__Host-tz_cms_session',
      transactionName: '__Host-tz_cms_tx',
      secure: true,
    })
    const attributes = cookieAttributes(policy, 3600)
    expect(attributes).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    })
    expect(attributes).not.toHaveProperty('domain')
  })

  it('plain-http development uses separate *_dev names and relaxes only Secure', () => {
    const policy = cookiePolicy('http://localhost:3000')
    expect(policy).toEqual({
      sessionName: 'tz_cms_session_dev',
      transactionName: 'tz_cms_tx_dev',
      secure: false,
    })
    expect(cookieAttributes(policy, 10)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    })
  })

  it('accepts only 43-char base64url opaque ids', () => {
    expect(isOpaqueId('a'.repeat(43))).toBe(true)
    for (const bad of [
      undefined,
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}.`,
      'eyJ.eyJ.sig',
    ]) {
      expect(isOpaqueId(bad)).toBe(false)
    }
  })
})

describe('logout CSRF rule', () => {
  const base = 'https://admin.tazzzo.example'
  const h = (init: Record<string, string>) => new Headers(init)

  it('requires the custom header and the CMS origin', () => {
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', origin: base }), base)).toBe(true)
    expect(isSameOriginMutation(h({ origin: base }), base)).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '0', origin: base }), base)).toBe(false)
    expect(
      isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', origin: 'https://evil.example' }), base),
    ).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', origin: 'null' }), base)).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1' }), base)).toBe(false)
  })

  it('falls back to Referer only when Origin is absent', () => {
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', referer: `${base}/x` }), base)).toBe(true)
    expect(
      isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', referer: 'https://evil.example/x' }), base),
    ).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1', referer: 'not a url' }), base)).toBe(
      false,
    )
  })
})
