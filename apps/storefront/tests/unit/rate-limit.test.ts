import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isExpensivePath,
  parseRateLimitConfig,
  recordOutcome,
  resetVisitorLimiter,
  TokenBucketStore,
  VisitorLimiter,
  type RateLimitConfig,
} from '@/lib/security/rate-limit'

const T0 = 1_000_000

describe('TokenBucketStore', () => {
  it('admits a burst, then refuses with the seconds until the next token', () => {
    const store = new TokenBucketStore({ perMinute: 60, burst: 3 }, 100)
    expect([1, 2, 3].map(() => store.take('a', T0).allowed)).toEqual([true, true, true])
    expect(store.take('a', T0)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    // Keys are independent.
    expect(store.take('b', T0).allowed).toBe(true)
  })

  it('refills at perMinute, never beyond the burst', () => {
    const store = new TokenBucketStore({ perMinute: 6, burst: 2 }, 100) // one token per 10 s
    store.take('a', T0)
    store.take('a', T0)
    expect(store.take('a', T0)).toEqual({ allowed: false, retryAfterSeconds: 10 })
    expect(store.take('a', T0 + 4_000)).toEqual({ allowed: false, retryAfterSeconds: 6 })
    expect(store.take('a', T0 + 10_000).allowed).toBe(true)
    expect(store.take('a', T0 + 10_000).allowed).toBe(false)
    // An hour idle refills to the burst only.
    const later = T0 + 3_600_000
    expect([1, 2, 3].map(() => store.take('a', later).allowed)).toEqual([true, true, false])
  })

  it('a refused request does not reset the refill progress', () => {
    const store = new TokenBucketStore({ perMinute: 6, burst: 1 }, 100)
    store.take('a', T0)
    for (let t = T0; t < T0 + 10_000; t += 1_000) expect(store.take('a', t).allowed).toBe(false)
    expect(store.take('a', T0 + 10_000).allowed).toBe(true)
  })

  it('a clock step backwards refills nothing', () => {
    const store = new TokenBucketStore({ perMinute: 60, burst: 1 }, 100)
    store.take('a', T0)
    expect(store.take('a', T0 - 60_000).allowed).toBe(false)
  })

  it('is bounded: the least recently used key is evicted beyond maxKeys', () => {
    const store = new TokenBucketStore({ perMinute: 1, burst: 1 }, 3)
    for (const k of ['a', 'b', 'c']) store.take(k, T0)
    store.take('a', T0) // a is now most recently used (and refused)
    store.take('d', T0) // evicts b, the least recently used
    expect(store.size).toBe(3)
    expect(store.take('a', T0).allowed).toBe(false) // still remembered
    expect(store.take('c', T0).allowed).toBe(false) // still remembered
    expect(store.take('b', T0).allowed).toBe(true) // forgotten: a fresh bucket
    for (let i = 0; i < 10_000; i++) store.take(`k${i}`, T0)
    expect(store.size).toBe(3)
  })

  it('drops keys idle long enough to be full again (TTL), without waiting for the size bound', () => {
    const store = new TokenBucketStore({ perMinute: 60, burst: 10 }, 1_000) // full after 10 s
    for (let i = 0; i < 50; i++) store.take(`k${i}`, T0)
    expect(store.size).toBe(50)
    store.take('late', T0 + 10_000)
    expect(store.size).toBe(1)
  })
})

describe('isExpensivePath', () => {
  it.each([
    ['/search', '', true],
    ['/search', '?q=rice', true],
    ['/c/TZS-000001', '?cursor=abc', true],
    ['/c/TZS-000001', '', false],
    ['/', '', false],
    ['/p/TZP-1', '?cursor=abc', false],
    ['/searching', '', false],
  ])('%s%s -> %s', (path, query, expected) => {
    expect(isExpensivePath(path, new URLSearchParams(query))).toBe(expected)
  })
})

describe('parseRateLimitConfig', () => {
  it('defaults: 60/min burst 20 for pages, 12/min burst 6 for search and paged lists, XFF untrusted', () => {
    expect(parseRateLimitConfig({})).toEqual({
      page: { perMinute: 60, burst: 20 },
      expensive: { perMinute: 12, burst: 6 },
      maxClients: 10_000,
      trustProxy: false,
      trustedHops: 1,
    })
  })

  it('reads every STOREFRONT_RATE_LIMIT_* setting; 0 per minute switches that bucket off', () => {
    expect(
      parseRateLimitConfig({
        STOREFRONT_RATE_LIMIT_PER_MINUTE: '120',
        STOREFRONT_RATE_LIMIT_BURST: '40',
        STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE: '0',
        STOREFRONT_RATE_LIMIT_MAX_CLIENTS: '500',
        STOREFRONT_TRUST_PROXY: 'true',
        STOREFRONT_TRUSTED_PROXY_HOPS: '2',
      }),
    ).toEqual({
      page: { perMinute: 120, burst: 40 },
      expensive: null,
      maxClients: 500,
      trustProxy: true,
      trustedHops: 2,
    })
  })

  it.each([
    ['STOREFRONT_RATE_LIMIT_PER_MINUTE', '-1'],
    ['STOREFRONT_RATE_LIMIT_PER_MINUTE', '1e3'],
    ['STOREFRONT_RATE_LIMIT_BURST', '0'],
    ['STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST', 'ten'],
    ['STOREFRONT_RATE_LIMIT_MAX_CLIENTS', '10'],
    ['STOREFRONT_TRUSTED_PROXY_HOPS', '0'],
    ['STOREFRONT_TRUST_PROXY', 'yes'],
  ])('rejects %s=%j, naming only the variable', (field, value) => {
    expect(() => parseRateLimitConfig({ [field]: value })).toThrow(
      `invalid rate limit configuration: ${field}`,
    )
  })
})

describe('VisitorLimiter', () => {
  const config = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
    page: { perMinute: 60, burst: 5 },
    expensive: { perMinute: 6, burst: 2 },
    maxClients: 100,
    trustProxy: true,
    trustedHops: 1,
    ...over,
  })
  const from = (ip: string) => new Headers({ 'x-forwarded-for': ip })
  const url = (path: string) => new URL(`http://localhost${path}`)

  it('search has the stricter bucket; refusing it does not spend a page token', () => {
    const limiter = new VisitorLimiter(config())
    const ip = from('203.0.113.9')
    expect(limiter.check(url('/search?q=a'), ip, T0).kind).toBe('allowed')
    expect(limiter.check(url('/search?q=b'), ip, T0).kind).toBe('allowed')
    expect(limiter.check(url('/search?q=c'), ip, T0)).toEqual({
      kind: 'limited',
      bucket: 'expensive',
      retryAfterSeconds: 10,
      unresolvedClient: false,
    })
    // 2 page tokens spent by the admitted searches, 3 left for ordinary pages.
    expect([1, 2, 3, 4].map(() => limiter.check(url('/p/TZP-1'), ip, T0).kind)).toEqual([
      'allowed',
      'allowed',
      'allowed',
      'limited',
    ])
    // Another visitor is unaffected.
    expect(limiter.check(url('/search?q=a'), from('198.51.100.1'), T0).kind).toBe('allowed')
  })

  it('untrusted proxy: no visitor address, so nothing is limited (and spoofed XFF changes nothing)', () => {
    const limiter = new VisitorLimiter(config({ trustProxy: false }))
    for (let i = 0; i < 50; i++) {
      expect(limiter.check(url('/search'), from(`10.0.0.${i}`), T0)).toEqual({
        kind: 'no_client_address',
      })
    }
  })

  it('both buckets off: everything allowed without reading any header', () => {
    const limiter = new VisitorLimiter(config({ page: null, expensive: null, trustProxy: false }))
    expect(limiter.check(url('/search'), new Headers(), T0)).toEqual({ kind: 'allowed' })
  })

  it('marks refusals of the shared unresolved key', () => {
    const limiter = new VisitorLimiter(config({ page: { perMinute: 60, burst: 1 } }))
    limiter.check(url('/'), from('not-an-ip'), T0)
    expect(limiter.check(url('/'), from('still-not-an-ip'), T0)).toMatchObject({
      kind: 'limited',
      unresolvedClient: true,
    })
  })
})

describe('recordOutcome (logging)', () => {
  afterEach(() => {
    resetVisitorLimiter()
    vi.restoreAllMocks()
  })

  it('warns once that the limit is inactive without a trusted proxy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) recordOutcome({ kind: 'no_client_address' }, T0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^storefront_rate_limit_inactive /)
  })

  it('logs refusals as counts only, at most once a minute', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = {
      kind: 'limited',
      bucket: 'page',
      retryAfterSeconds: 1,
      unresolvedClient: false,
    } as const
    recordOutcome(page, T0)
    recordOutcome({ ...page, bucket: 'expensive' }, T0 + 1_000)
    recordOutcome({ ...page, unresolvedClient: true }, T0 + 2_000)
    expect(warn).toHaveBeenCalledTimes(1)
    recordOutcome(page, T0 + 61_000)
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'storefront_rate_limited page=1 expensive=0 unresolved_client=0',
      'storefront_rate_limited page=2 expensive=1 unresolved_client=1',
    ])
  })
})
