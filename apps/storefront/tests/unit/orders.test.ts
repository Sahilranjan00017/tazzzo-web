import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORDER,
  SECRET_TEXT,
  backendError,
  calls,
  fetchMock,
  jar,
  loadEnv,
  orderBody,
  reply,
  resetFetch,
  routeBackend,
  sentHeaders,
  type Loaded,
} from './checkout-fixtures'
import {
  ORDER_ID,
  cancelOffered,
  formatInstant,
  isCancelReason,
  isOrderCursor,
  isOrderId,
  slotDate,
  statusOf,
  type Order,
} from '@/lib/orders/model'

vi.mock('next/headers', () => ({ cookies: async () => jar }))

describe('order ids and cursors (the grammar that guards every path and query)', () => {
  it('accepts the backend grammar exactly and nothing else', () => {
    expect(ORDER_ID.source).toBe('^ORD_[A-Za-z0-9_-]{6,64}$')
    for (const ok of [ORDER, 'ORD_abcdef', `ORD_${'a'.repeat(64)}`, 'ORD_a-b_C1234']) {
      expect(isOrderId(ok), ok).toBe(true)
    }
    for (const bad of [
      '',
      'ORD_',
      'ORD_abcde',
      `ORD_${'a'.repeat(65)}`,
      'ord_abcdefghij',
      'ORD-abcdefghij',
      ' ORD_abcdefghij',
      'ORD_abcdefghij ',
      'ORD_abcdefghij\n',
      'ORD_../../etc',
      'ORD_abc/def',
      'ORD_abc%2Fdef',
      'ORD_abc?x=1',
      'ORD_abc#frag',
      'ORD_abcdef\u0000',
      'ORD_ábcdefgh',
      'CHKQ_abcdefghij',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isOrderId(bad), String(bad)).toBe(false)
    }
  })

  it('cursors are URL-safe tokens of at most 128 characters', () => {
    expect(isOrderCursor('djF8MTc2MDE2MDAwMDAwMHxPUkRfYWJjZGVmZ2g')).toBe(true)
    expect(isOrderCursor('a'.repeat(128))).toBe(true)
    for (const bad of [
      '',
      'a'.repeat(129),
      'a b',
      'a=b',
      'a&page_size=50',
      'a/b',
      'a+b',
      '../x',
      null,
    ]) {
      expect(isOrderCursor(bad), String(bad)).toBe(false)
    }
  })

  it('cancel reasons are the backend customer set', () => {
    for (const ok of ['CHANGED_MIND', 'ORDERED_BY_MISTAKE', 'OTHER'])
      expect(isCancelReason(ok)).toBe(true)
    for (const bad of ['OUT_OF_STOCK', 'changed_mind', '', null, 'OTHER '])
      expect(isCancelReason(bad)).toBe(false)
  })

  it('statuses outside the known set read neutrally, never as a guess', () => {
    expect(statusOf('CONFIRMED')).toBe('CONFIRMED')
    expect(statusOf('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY')
    expect(statusOf('RETURNED')).toBe('UNKNOWN')
    expect(statusOf('CREATED')).toBe('UNKNOWN')
  })
})

describe('time and cancellation', () => {
  it('formats an instant in the delivery time zone, by hand (server and browser cannot disagree)', () => {
    expect(formatInstant('2026-10-11T04:30:20.000Z')).toBe('11 Oct 2026, 10:00 am')
    expect(formatInstant('2026-10-11T18:29:59.999Z')).toBe('11 Oct 2026, 11:59 pm')
    expect(formatInstant('2026-10-11T18:30:00Z')).toBe('12 Oct 2026, 12:00 am')
    expect(formatInstant('2026-12-31T20:00:00Z')).toBe('1 Jan 2027, 1:30 am')
    expect(formatInstant('2026-10-11T06:30:00Z')).toBe('11 Oct 2026, 12:00 pm')
    expect(formatInstant(null)).toBe('')
    expect(formatInstant('yesterday')).toBe('')
  })

  it('reads the date of a slot id', () => {
    expect(slotDate('morning~2026-10-11')).toBe('2026-10-11')
    expect(slotDate('morning')).toBeNull()
    expect(slotDate('morning~soon')).toBeNull()
  })

  const confirmed = (over: Partial<Pick<Order, 'status' | 'confirmedAt'>> = {}) => ({
    status: 'CONFIRMED' as const,
    confirmedAt: '2026-10-11T04:30:20.000Z',
    ...over,
  })
  const at = Date.parse('2026-10-11T04:30:20.000Z')

  it('offers Cancel only when the deployment has a window, the order is confirmed and the window is open', () => {
    expect(cancelOffered(confirmed(), 0, at)).toBe(false) // the backend default: closed
    expect(cancelOffered(confirmed(), 600, at + 599_000)).toBe(true)
    expect(cancelOffered(confirmed(), 600, at + 600_000)).toBe(true)
    expect(cancelOffered(confirmed(), 600, at + 600_001)).toBe(false)
    expect(cancelOffered(confirmed({ status: 'CANCELLED' }), 600, at)).toBe(false)
    expect(cancelOffered(confirmed({ status: 'OUT_FOR_DELIVERY' }), 600, at)).toBe(false)
    expect(cancelOffered(confirmed({ status: 'DELIVERED' }), 600, at)).toBe(false)
    expect(cancelOffered(confirmed({ confirmedAt: null }), 600, at)).toBe(false)
    expect(cancelOffered(confirmed({ confirmedAt: 'soon' }), 600, at)).toBe(false)
  })
})

let logs: string[]
beforeEach(() => {
  logs = []
  resetFetch(logs)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function service(r: Loaded) {
  const s = await import('@/server/orders/service')
  return { s, session: (await r.cookies.readSession())! }
}

describe('order detail', () => {
  it('reads the caller-owned order and keeps the snapshot as the backend returned it', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({ [`GET /v1/customer/orders/${ORDER}`]: () => reply(200, orderBody()) })
    const out = await s.pageOrder(session, ORDER)
    expect(out).toMatchObject({
      ok: true,
      data: {
        orderId: ORDER,
        status: 'CONFIRMED',
        paymentMethod: 'COD',
        paymentCondition: 'COD_DUE',
        itemCount: 2,
        subtotalPaise: 99800,
        money: { merchandiseSubtotalPaise: 99800, benefitDiscountPaise: 0, payablePaise: 99800 },
        address: {
          recipientName: 'Asha Verma',
          addressLine2: null,
          landmark: null,
          postalCode: '560001',
        },
        slot: { slotId: 'morning~2026-10-11', label: 'Morning' },
        lines: [
          { productId: 'TZP-1001', title: 'Basmati Rice 5 kg', quantity: 2, lineTotalPaise: 99800 },
        ],
        cancelledAt: null,
      },
    })
    expect(sentHeaders(0).Authorization).toMatch(/^Bearer /)
    // The customer id is not a parameter anywhere: the path is the order id, the bearer token is the owner.
    expect(calls()).toEqual([`GET /v1/customer/orders/${ORDER}`])
  })

  it('an order without money (created before the money model) has none: never a zero payable', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      [`GET /v1/customer/orders/${ORDER}`]: () => reply(200, orderBody({ money: undefined })),
    })
    expect(await s.pageOrder(session, ORDER)).toMatchObject({ ok: true, data: { money: null } })
  })

  it('a cancelled order has no payment condition and a cancellation time', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      [`GET /v1/customer/orders/${ORDER}`]: () =>
        reply(
          200,
          orderBody({
            status: 'CANCELLED',
            paymentCondition: undefined,
            cancelledAt: '2026-10-11T05:00:00.000Z',
          }),
        ),
    })
    expect(await s.pageOrder(session, ORDER)).toMatchObject({
      ok: true,
      data: {
        status: 'CANCELLED',
        paymentCondition: null,
        cancelledAt: '2026-10-11T05:00:00.000Z',
      },
    })
  })

  it("another customer's, an unknown and an internal order are all the backend's 404: not_found", async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({ [`GET /v1/customer/orders/${ORDER}`]: () => backendError(404, 'NOT_FOUND') })
    expect(await s.pageOrder(session, ORDER)).toEqual({
      ok: false,
      error: 'not_found',
      retryAfterSeconds: null,
    })
  })

  it.each([
    'ORD_../../x',
    'ORD_a/b',
    '../admin',
    'ORD_abc%2f..%2fdef',
    '',
    'ord_abcdefghij',
    `${ORDER}?x=1`,
  ])('the id %j never reaches a path: not_found without a backend call', async (id) => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    expect(await s.pageOrder(session, id)).toMatchObject({ ok: false, error: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an expired access token is handed to the page; a refused one is unauthenticated', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    expect(await s.pageOrder({ ...session, accessExpiresAt: Date.now() - 1 }, ORDER)).toMatchObject(
      {
        ok: false,
        error: 'unauthenticated',
      },
    )
    expect(fetchMock).not.toHaveBeenCalled()
    routeBackend({
      [`GET /v1/customer/orders/${ORDER}`]: () => backendError(401, 'UNAUTHENTICATED'),
    })
    expect(await s.pageOrder(session, ORDER)).toMatchObject({ error: 'unauthenticated' })
  })

  it.each([
    ['a 503', () => backendError(503, 'SERVICE_UNAVAILABLE'), 'unavailable'],
    ['a 500', () => backendError(500, 'INTERNAL'), 'unavailable'],
    ['a 429', () => reply(429, { code: 'X' }, { 'retry-after': '9' }), 'rate_limited'],
    ['a body that is not an order', () => reply(200, { orderId: ORDER }), 'unavailable'],
    [
      'an order with another id shape',
      () => reply(200, orderBody({ orderId: 'x' })),
      'unavailable',
    ],
    ['lines that do not add up', () => reply(200, orderBody({ subtotalPaise: 1 })), 'unavailable'],
    [
      'money that does not follow',
      () =>
        reply(
          200,
          orderBody({
            money: {
              merchandiseSubtotalPaise: 99800,
              benefitDiscountPaise: 1,
              payablePaise: 99800,
            },
          }),
        ),
      'unavailable',
    ],
  ])('%s is the closed error %s and shows no backend text', async (_n, response, error) => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({ [`GET /v1/customer/orders/${ORDER}`]: response })
    const out = await s.pageOrder(session, ORDER)
    expect(out).toMatchObject({ ok: false, error })
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT)
    expect(logs.join('\n')).not.toContain(SECRET_TEXT)
  })
})

describe('order history', () => {
  const summary = (n: number, over: Record<string, unknown> = {}) => ({
    orderId: `ORD_history${String(n).padStart(4, '0')}`,
    status: 'CONFIRMED',
    paymentMethod: 'COD',
    itemCount: 2,
    subtotalPaise: 99800,
    payablePaise: 89820,
    createdAt: '2026-10-11T04:30:20.000Z',
    ...over,
  })

  it('asks for a bounded page, newest first, and follows the cursor the backend minted', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      'GET /v1/customer/orders?page_size=10': () =>
        reply(200, {
          items: [
            summary(2),
            summary(1, { status: 'CANCELLED', cancelledAt: '2026-10-11T06:00:00.000Z' }),
          ],
          nextCursor: 'abc_DEF-123',
          requestId: 'r',
        }),
      'GET /v1/customer/orders?page_size=10&cursor=abc_DEF-123': () =>
        reply(200, { items: [summary(0)], requestId: 'r' }),
    })
    const first = await s.pageOrders(session, null)
    expect(first).toMatchObject({
      ok: true,
      data: {
        nextCursor: 'abc_DEF-123',
        orders: [
          { orderId: 'ORD_history0002', status: 'CONFIRMED', payablePaise: 89820 },
          {
            orderId: 'ORD_history0001',
            status: 'CANCELLED',
            cancelledAt: '2026-10-11T06:00:00.000Z',
          },
        ],
      },
    })
    const second = await s.pageOrders(session, 'abc_DEF-123')
    expect(second).toMatchObject({
      ok: true,
      data: { nextCursor: null, orders: [{ orderId: 'ORD_history0000' }] },
    })
    expect(calls()).toEqual([
      'GET /v1/customer/orders?page_size=10',
      'GET /v1/customer/orders?page_size=10&cursor=abc_DEF-123',
    ])
  })

  it('a summary without a payable has none (the amount shown falls back to the subtotal, honestly labelled)', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      'GET /v1/customer/orders?page_size=10': () =>
        reply(200, { items: [summary(1, { payablePaise: undefined })], requestId: 'r' }),
    })
    expect(await s.pageOrders(session, null)).toMatchObject({
      ok: true,
      data: { orders: [{ payablePaise: null }] },
    })
  })

  it('a cursor outside the grammar is never forwarded', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    for (const bad of ['a&page_size=50', 'a b', '', 'a'.repeat(129), '../x']) {
      expect(await s.pageOrders(session, bad)).toMatchObject({ ok: false, error: 'bad_request' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the backend refusing a cursor is bad_request; an empty history is an empty page', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      'GET /v1/customer/orders?page_size=10&cursor=zzzz': () =>
        backendError(400, 'INVALID_REQUEST'),
      'GET /v1/customer/orders?page_size=10': () => reply(200, { items: [], requestId: 'r' }),
    })
    expect(await s.pageOrders(session, 'zzzz')).toMatchObject({ ok: false, error: 'bad_request' })
    expect(await s.pageOrders(session, null)).toEqual({
      ok: true,
      data: { orders: [], nextCursor: null },
    })
  })

  it('a page with a malformed row or cursor is not shown', async () => {
    const r = await loadEnv()
    const { s, session } = await service(r)
    routeBackend({
      'GET /v1/customer/orders?page_size=10': () =>
        reply(200, { items: [summary(1, { orderId: 'nope' })], requestId: 'r' }),
    })
    expect(await s.pageOrders(session, null)).toMatchObject({ ok: false, error: 'unavailable' })
    routeBackend({
      'GET /v1/customer/orders?page_size=10': () =>
        reply(200, { items: [], nextCursor: 'a b', requestId: 'r' }),
    })
    expect(await s.pageOrders(session, null)).toMatchObject({ ok: false, error: 'unavailable' })
  })
})
