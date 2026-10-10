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
      // W12-1: dot segments that normalise to a protocol-relative URL
      '/.//evil.com',
      '/x/..//evil.com',
      '/%2e//evil.com',
      '/%2e%2e//evil.com',
      '/%2E%2E//evil.com',
      '/x/%2e%2e//evil.com',
      '/..//evil.com',
      '/./evil.com',
      '/a/./b',
      '/a/../b',
      '/..',
      '/.',
      '/%252f/evil.com',
      '/%252e%252e//evil.com',
      '/%25252f/evil.com',
      '/%2525252525252f/evil.com',
      '/a%2fb',
      '/a%5cb',
      '/%5Cevil.com',
      '/a\\b',
      '/.\\/evil.com',
      '/\tevil.com',
      '/a\tb',
      '/a\nb',
      '/a%09b',
      '/a%0ab',
      '/////evil.com',
      '/api/auth/refresh?next=/',
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBe('/')
    }
  })

  it('keeps dots inside a segment and slashes inside the query', () => {
    for (const ok of ['/a.b/c..d', '/search?q=a//b/../c#x', '/c/x?cursor=a.b']) {
      expect(safeReturnTo(ok)).toBe(ok)
    }
    // a path the URL parser would rewrite (here percent-encoding a fullwidth full stop) fails closed
    expect(safeReturnTo('/\u3002\u3002/x')).toBe('/')
  })

  it('every accepted return is a same-origin relative URL', () => {
    const attempts = [
      '/.//evil.com',
      '/x/..//evil.com',
      '//evil.com',
      '/a/b?c=//d',
      '/%2e//e',
      '/%2e%2e//e',
      '/ok',
      '/p/1?x=1#y',
      '/\\e',
      '/\u3002//e',
      '/%E3%80%82%E3%80%82//evil.com',
      'https://evil.com',
    ]
    for (const attempt of attempts) {
      const out = safeReturnTo(attempt)
      expect(out.startsWith('/') && !out.startsWith('//') && !out.includes('\\'), out).toBe(true)
      expect(new URL(out, 'https://admin.test').origin).toBe('https://admin.test')
    }
  })
})
