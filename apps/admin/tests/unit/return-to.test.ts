import { describe, expect, it } from 'vitest'
import { safeReturnTo } from '@/server/auth/return-to'

describe('return URL validation', () => {
  it('keeps same-origin relative paths', () => {
    for (const ok of [
      '/',
      '/catalog',
      '/catalog/items?page=2',
      '/a/b#section',
      '/search?q=%20rice',
    ]) {
      expect(safeReturnTo(ok)).toBe(ok)
    }
  })

  it('falls back to / for anything that could leave the origin or misbehave', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'catalog',
      'https://evil.com',
      'http://evil.com/x',
      '//evil.com',
      '///evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      '/%2F%2Fevil.com',
      '/%2f/evil.com',
      '/%5Cevil.com',
      '/%5c%5cevil.com',
      'javascript:alert(1)',
      '/javascript:alert(1)?x=%0d',
      '%2F%2Fevil.com',
      'jav%61script:alert(1)',
      '/ok\u0000',
      '/ok\nLocation: https://evil.com',
      '/ok%0a',
      '/ok%00',
      '/%E0%A4%A',
      '/api/auth/logout',
      '/api/auth/google/start',
      `/${'a'.repeat(600)}`,
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBe('/')
    }
  })
})
