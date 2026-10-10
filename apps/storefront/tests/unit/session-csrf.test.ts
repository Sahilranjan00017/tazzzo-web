import { describe, expect, it } from 'vitest'
import { isSameOriginMutation, isSameSiteNavigation } from '@/server/session/csrf'

const base = {
  'x-tazzzo-csrf': '1',
  origin: 'https://www.tazzzo.test',
  host: 'www.tazzzo.test',
  'sec-fetch-site': 'same-origin',
}
const h = (over: Record<string, string | null> = {}) => {
  const headers = new Headers()
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) headers.set(k, v)
  return headers
}

describe('isSameOriginMutation', () => {
  it('passes a same-origin request that carries the CSRF header', () => {
    expect(isSameOriginMutation(h())).toBe(true)
    expect(isSameOriginMutation(h({ 'sec-fetch-site': null }))).toBe(true) // older browsers
    expect(
      isSameOriginMutation(h({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe(true)
  })

  it('refuses without the header or with the wrong value', () => {
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': null }))).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '0' }))).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '' }))).toBe(false)
  })

  it('refuses another origin, a sibling subdomain, a missing or malformed Origin', () => {
    expect(isSameOriginMutation(h({ origin: 'https://evil.example' }))).toBe(false)
    expect(isSameOriginMutation(h({ origin: 'https://www.tazzzo.test.evil.example' }))).toBe(false)
    expect(isSameOriginMutation(h({ origin: 'https://www.tazzzo.test:8443' }))).toBe(false)
    expect(isSameOriginMutation(h({ origin: 'null' }))).toBe(false)
    expect(isSameOriginMutation(h({ origin: null }))).toBe(false)
    expect(isSameOriginMutation(h({ host: null }))).toBe(false)
    expect(isSameOriginMutation(h({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isSameOriginMutation(h({ 'sec-fetch-site': 'same-site' }))).toBe(false)
    expect(isSameOriginMutation(h({ 'sec-fetch-site': 'none' }))).toBe(false)
  })

  it('checks the per-session token in constant time form: exact match only', () => {
    const token = 'A'.repeat(43)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': token }), token)).toBe(true)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': '1' }), token)).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': token.slice(1) }), token)).toBe(false)
    expect(isSameOriginMutation(h({ 'x-tazzzo-csrf': `${token}A` }), token)).toBe(false)
  })
})

describe('isSameSiteNavigation', () => {
  it('serves our own pages and typed URLs, not cross-site links', () => {
    expect(isSameSiteNavigation(new Headers())).toBe(true)
    expect(isSameSiteNavigation(new Headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isSameSiteNavigation(new Headers({ 'sec-fetch-site': 'none' }))).toBe(true)
    expect(isSameSiteNavigation(new Headers({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isSameSiteNavigation(new Headers({ 'sec-fetch-site': 'same-site' }))).toBe(false)
  })
})
