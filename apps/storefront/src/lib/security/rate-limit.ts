import { clientKey, UNRESOLVED_CLIENT, type ClientIpOptions } from '@/lib/security/client-ip'

/**
 * Per-visitor rate limit for page requests (`src/proxy.ts`). Pure apart from the module-level limiter and its log
 * throttle; no secrets.
 *
 * PER INSTANCE: buckets live in this server process's memory. N instances behind a load balancer admit up to N times
 * the configured rate per visitor; a restart forgets every bucket. No shared store (Redis, edge) is involved.
 *
 * Two token buckets per visitor key (see `client-ip.ts` for the key):
 * - `page`: every request the proxy sees (pages, RSC navigations, robots/sitemap; build assets never reach it);
 * - `expensive`: additionally, the uncached paths that always cost a backend call: `/search`, paged category lists
 *   (`/c/<node>?cursor=...`) the sign-in code routes (`/api/auth/otp/*`), `POST /api/location` (a serviceability check) and `POST /api/checkout/delivery`. Checked first, so a refused expensive
 *   request does not also spend a page token.
 * The store is bounded: least recently used keys are evicted beyond `maxClients`, and keys idle long enough to have
 * refilled completely (indistinguishable from a new visitor) are dropped as they reach the old end.
 */
export interface BucketSpec {
  /** Sustained rate (tokens added per minute). */
  perMinute: number
  /** Bucket size: how many requests may arrive at once. */
  burst: number
}

export type Decision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

interface Bucket {
  tokens: number
  at: number
}

export class TokenBucketStore {
  private readonly buckets = new Map<string, Bucket>()
  private readonly perMs: number

  constructor(
    private readonly spec: BucketSpec,
    private readonly maxKeys: number,
  ) {
    this.perMs = spec.perMinute / 60_000
  }

  get size(): number {
    return this.buckets.size
  }

  take(key: string, now: number): Decision {
    const previous = this.buckets.get(key)
    if (previous) this.buckets.delete(key) // re-inserted below: Map order is the LRU order
    const tokens = previous ? this.tokensAt(previous, now) : this.spec.burst
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now })
      this.evict(now)
      return { allowed: true }
    }
    // Refused: only the LRU position changes. The refill reference is kept as it was, so polling neither delays
    // the next token nor accumulates rounding.
    this.buckets.set(key, previous ?? { tokens, at: now })
    this.evict(now)
    const seconds = Math.ceil((1 - tokens) / this.perMs / 1000)
    return { allowed: false, retryAfterSeconds: Math.max(1, seconds) }
  }

  private tokensAt(bucket: Bucket, now: number): number {
    const elapsed = Math.max(0, now - bucket.at) // a clock step backwards refills nothing
    return Math.min(this.spec.burst, bucket.tokens + elapsed * this.perMs)
  }

  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const full = this.tokensAt(bucket, now) >= this.spec.burst
      if (this.buckets.size <= this.maxKeys && !full) break
      this.buckets.delete(key)
    }
  }
}

export interface RateLimitConfig extends ClientIpOptions {
  /** null: this bucket is off (`..._PER_MINUTE=0`). */
  page: BucketSpec | null
  expensive: BucketSpec | null
  maxClients: number
}

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  STOREFRONT_RATE_LIMIT_PER_MINUTE: 60,
  STOREFRONT_RATE_LIMIT_BURST: 20,
  STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE: 12,
  STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST: 6,
  STOREFRONT_RATE_LIMIT_MAX_CLIENTS: 10_000,
  STOREFRONT_TRUSTED_PROXY_HOPS: 1,
})

type IntField = keyof typeof RATE_LIMIT_DEFAULTS

const INT_RANGES: Record<IntField, [number, number]> = {
  STOREFRONT_RATE_LIMIT_PER_MINUTE: [0, 100_000],
  STOREFRONT_RATE_LIMIT_BURST: [1, 10_000],
  STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE: [0, 100_000],
  STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST: [1, 10_000],
  STOREFRONT_RATE_LIMIT_MAX_CLIENTS: [100, 1_000_000],
  STOREFRONT_TRUSTED_PROXY_HOPS: [1, 10],
}

/** Reads the limit settings; an invalid value throws naming only the variable (like the server env). */
export function parseRateLimitConfig(env: Record<string, string | undefined>): RateLimitConfig {
  const bad: string[] = []
  const int = (field: IntField): number => {
    const raw = env[field]?.trim()
    if (raw === undefined || raw === '') return RATE_LIMIT_DEFAULTS[field]
    const [min, max] = INT_RANGES[field]
    const value = /^[0-9]{1,7}$/.test(raw) ? Number(raw) : NaN
    if (!(value >= min && value <= max)) bad.push(field)
    return value
  }
  const trust = env.STOREFRONT_TRUST_PROXY?.trim() ?? ''
  if (!['', 'true', 'false'].includes(trust)) bad.push('STOREFRONT_TRUST_PROXY')
  const spec = (perMinute: IntField, burst: IntField): BucketSpec | null => {
    const rate = int(perMinute)
    const size = int(burst)
    return rate === 0 ? null : { perMinute: rate, burst: size }
  }
  const config: RateLimitConfig = {
    page: spec('STOREFRONT_RATE_LIMIT_PER_MINUTE', 'STOREFRONT_RATE_LIMIT_BURST'),
    expensive: spec(
      'STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE',
      'STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST',
    ),
    maxClients: int('STOREFRONT_RATE_LIMIT_MAX_CLIENTS'),
    trustProxy: trust === 'true',
    trustedHops: int('STOREFRONT_TRUSTED_PROXY_HOPS'),
  }
  if (bad.length > 0) throw new Error(`invalid rate limit configuration: ${bad.join(', ')}`)
  return config
}

/** The uncached paths that cost a backend call on every request. */
export function isExpensivePath(pathname: string, searchParams: URLSearchParams): boolean {
  if (pathname === '/search') return true
  // Sending or checking a sign-in code: each is a backend call that texts a phone or spends an attempt.
  if (pathname.startsWith('/api/auth/otp/')) return true
  // Checking a PIN is one uncached `/v1/serviceability` call every time (and the slot step reads and re-checks slots).
  if (pathname === '/api/location' || pathname === '/api/checkout/delivery') return true
  return pathname.startsWith('/c/') && searchParams.has('cursor')
}

export type LimitOutcome =
  | { kind: 'allowed' }
  | { kind: 'no_client_address' }
  | {
      kind: 'limited'
      bucket: 'page' | 'expensive'
      retryAfterSeconds: number
      /** The shared fail-closed key (`UNRESOLVED_CLIENT`) was refused, not a single visitor. */
      unresolvedClient: boolean
    }

export class VisitorLimiter {
  private readonly page: TokenBucketStore | null
  private readonly expensive: TokenBucketStore | null

  constructor(private readonly config: RateLimitConfig) {
    this.page = config.page && new TokenBucketStore(config.page, config.maxClients)
    this.expensive = config.expensive && new TokenBucketStore(config.expensive, config.maxClients)
  }

  check(url: URL, headers: Headers, now: number): LimitOutcome {
    if (!this.page && !this.expensive) return { kind: 'allowed' }
    const key = clientKey(headers, this.config)
    if (key === null) return { kind: 'no_client_address' }
    if (this.expensive && isExpensivePath(url.pathname, url.searchParams)) {
      const decision = this.expensive.take(key, now)
      if (!decision.allowed) return limited('expensive', decision, key)
    }
    if (this.page) {
      const decision = this.page.take(key, now)
      if (!decision.allowed) return limited('page', decision, key)
    }
    return { kind: 'allowed' }
  }
}

function limited(
  bucket: 'page' | 'expensive',
  decision: { retryAfterSeconds: number },
  key: string,
): LimitOutcome {
  return {
    kind: 'limited',
    bucket,
    retryAfterSeconds: decision.retryAfterSeconds,
    unresolvedClient: key === UNRESOLVED_CLIENT,
  }
}

let current: VisitorLimiter | undefined
let inactiveWarned = false
const LOG_INTERVAL_MS = 60_000
let refused = { page: 0, expensive: 0, unresolved: 0 }
let lastLogAt = 0

/** The process-wide limiter, built from `process.env` on first use. */
export function visitorLimiter(): VisitorLimiter {
  current ??= new VisitorLimiter(parseRateLimitConfig(process.env))
  return current
}

/** Test seam: rebuild the limiter from the environment on next use and forget the log state. */
export function resetVisitorLimiter(): void {
  current = undefined
  inactiveWarned = false
  refused = { page: 0, expensive: 0, unresolved: 0 }
  lastLogAt = 0
}

/**
 * Operational log lines, counts only (never an address or a path): one warning per process when there is no trusted
 * visitor address, and at most one line a minute summarising refusals.
 */
export function recordOutcome(outcome: LimitOutcome, now: number): void {
  if (outcome.kind === 'no_client_address') {
    if (!inactiveWarned) {
      inactiveWarned = true
      console.warn(
        'storefront_rate_limit_inactive reason=untrusted_proxy (set STOREFRONT_TRUST_PROXY)',
      )
    }
    return
  }
  if (outcome.kind !== 'limited') return
  refused[outcome.bucket] += 1
  if (outcome.unresolvedClient) refused.unresolved += 1
  if (now - lastLogAt < LOG_INTERVAL_MS) return
  lastLogAt = now
  console.warn(
    `storefront_rate_limited page=${refused.page} expensive=${refused.expensive} unresolved_client=${refused.unresolved}`,
  )
  refused = { page: 0, expensive: 0, unresolved: 0 }
}
