import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { backendRead } from '@/server/backend/read'
import { dashboardSchema } from '@/lib/dashboard'

const schema = z.object({ n: z.number() })
const deps = (fetchImpl: typeof fetch) => ({
  backendUrl: 'https://api.test',
  idToken: 'tok',
  fetchImpl,
})
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers }))

describe('backendRead', () => {
  it('sends only the bearer, never follows redirects, and validates the body', async () => {
    const f = reply(200, { n: 1 }, { 'x-request-id': 'req_0123456789abcdef0123' })
    const r = await backendRead(deps(f), '/api/v1/x', schema)
    expect(r).toEqual({
      kind: 'ok',
      data: { n: 1 },
      httpStatus: 200,
      backendRequestId: 'req_0123456789abcdef0123',
    })
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe('https://api.test/api/v1/x')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' })
    expect(init?.headers).toEqual({ Authorization: 'Bearer tok', Accept: 'application/json' })
  })

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
  ])('maps %i to %s', async (status, kind) => {
    expect((await backendRead(deps(reply(status)), '/p', schema)).kind).toBe(kind)
  })

  it('honours a well-formed Retry-After and ignores a malformed one', async () => {
    expect(
      await backendRead(deps(reply(429, {}, { 'retry-after': '30' })), '/p', schema),
    ).toMatchObject({
      retryAfterSeconds: 30,
    })
    const bad = await backendRead(deps(reply(429, {}, { 'retry-after': 'soon' })), '/p', schema)
    expect(bad).toEqual({ kind: 'rate_limited' })
  })

  it('treats 5xx, network failure, timeout and a wrong shape as distinct unavailable reasons', async () => {
    expect(await backendRead(deps(reply(503)), '/p', schema)).toMatchObject({ reason: 'status' })
    expect(await backendRead(deps(reply(200, { n: 'x' })), '/p', schema)).toMatchObject({
      reason: 'shape',
    })
    const net = vi.fn<typeof fetch>(async () => {
      throw new TypeError('down')
    })
    expect(await backendRead(deps(net), '/p', schema)).toEqual({
      kind: 'unavailable',
      reason: 'network',
    })
    const slow = vi.fn<typeof fetch>(async () => {
      throw new DOMException('t', 'TimeoutError')
    })
    expect(await backendRead(deps(slow), '/p', schema)).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    })
  })

  it('drops a forged request id instead of echoing it', async () => {
    const r = await backendRead(deps(reply(403, {}, { 'x-request-id': '<script>' })), '/p', schema)
    expect(r).toEqual({ kind: 'forbidden' })
  })
})

describe('dashboard schema', () => {
  const c = (value: number, capped = false) => ({ value, capped })
  const valid = {
    orders: {
      open_confirmed: c(1),
      open_out_for_delivery: c(0),
      last24h_confirmed: c(2),
      last24h_out_for_delivery: c(0),
      last24h_delivered: c(3),
      last24h_cancelled: c(0),
    },
    inventory: { out_of_stock: c(0), low_stock: c(4) },
    catalog: { products_total: c(10000, true), active: c(5), draft: c(2) },
    serviceability: { service_areas_total: c(1), active: c(1) },
    support: { open: c(0), in_progress: c(0) },
    notifications: { pending: c(0), failed: c(0) },
    generatedAt: '2026-10-06T00:00:00Z',
    bounds: { cap: 10000, maxTimeMs: 2000, recentWindowHours: 24 },
  }
  it('accepts the documented shape and rejects a missing or negative count', () => {
    expect(dashboardSchema.safeParse(valid).success).toBe(true)
    expect(dashboardSchema.safeParse({ ...valid, support: { open: c(0) } }).success).toBe(false)
    expect(
      dashboardSchema.safeParse({ ...valid, inventory: { out_of_stock: c(-1), low_stock: c(0) } })
        .success,
    ).toBe(false)
  })
})
