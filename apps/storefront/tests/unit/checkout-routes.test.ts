import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADDR,
  ORDER,
  QUOTE,
  SECRET_TEXT,
  SLOT,
  backendError,
  calls,
  cartBody,
  fetchMock,
  headers,
  jar,
  loadEnv,
  orderBody,
  post,
  reply,
  resetFetch,
  routeBackend,
  sentBody,
  sentHeaders,
  without,
  type Loaded,
} from './checkout-fixtures'

vi.mock('next/headers', () => ({ cookies: async () => jar }))

/**
 * `POST /api/orders`, `/api/orders/cancel` and `/api/checkout/refresh` end to end over a mocked backend `fetch` and a
 * cookie jar: CSRF, session, strict bodies, what is forwarded to the backend (and what never is), the closed error
 * mapping, and the lifecycle of the checkout cookie (kept on an unknown outcome, rotated when the quote ended, cleared
 * on success).
 */
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

async function routes() {
  return {
    orders: await import('@/app/api/orders/route'),
    cancel: await import('@/app/api/orders/cancel/route'),
    refresh: await import('@/app/api/checkout/refresh/route'),
  }
}

const PLACE = { quoteId: QUOTE, cartVersion: 3, addressId: ADDR, slotId: SLOT }

async function choose(r: Loaded, over: Record<string, string> = {}) {
  await r.cookies.writeCheckoutChoice({
    customerId: 'CUS_1',
    addressId: ADDR,
    slotId: SLOT,
    ...over,
  })
}

const happyBackend = () =>
  routeBackend({
    [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
    'POST /v1/customer/orders': () => reply(200, orderBody()),
  })

describe('CSRF guard on every mutation (before session, body and backend)', () => {
  const MUTATIONS = [
    ['orders', '/api/orders', PLACE],
    ['cancel', '/api/orders/cancel', { orderId: ORDER, reason: 'OTHER' }],
    ['refresh', '/api/checkout/refresh', {}],
  ] as const

  it('refuses a missing or wrong token, a cross-site or origin-less request', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    for (const [name, path, body] of MUTATIONS) {
      const bad: Array<[string, Record<string, string>]> = [
        ['no csrf header', without(headers(r.csrf), 'x-tazzzo-csrf')],
        ['pre-login literal 1 while signed in', headers('1')],
        ['wrong token', headers('x'.repeat(43))],
        ['cross-site', headers(r.csrf, { 'sec-fetch-site': 'cross-site' })],
        ['same-site sibling', headers(r.csrf, { 'sec-fetch-site': 'same-site' })],
        ['foreign origin', headers(r.csrf, { origin: 'https://evil.example' })],
        ['no origin', without(headers(r.csrf), 'origin')],
      ]
      for (const [why, h] of bad) {
        const res = await m[name].POST(post(path, body, h))
        expect(res.status, `${name}: ${why}`).toBe(403)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({ ok: false, error: 'forbidden' })
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signed out: a forged request is still 403, a well-formed one 401, and the backend is never called', async () => {
    const r = await loadEnv({ signedIn: false })
    const m = await routes()
    for (const [name, path, body] of MUTATIONS) {
      expect((await m[name].POST(post(path, body, headers('x')))).status).toBe(403)
      const res = await m[name].POST(post(path, body, headers('1')))
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ ok: false, error: 'unauthenticated' })
    }
    expect(r.csrf).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/orders: strict body', () => {
  it.each([
    ['an extra field', { ...PLACE, total: 1 }],
    ['a client price', { ...PLACE, totalPaise: 100 }],
    ['a payment method', { ...PLACE, paymentMethod: 'COD' }],
    ['a customer id', { ...PLACE, customerId: 'CUS_2' }],
    ['a missing field', { quoteId: QUOTE, cartVersion: 3, addressId: ADDR }],
    ['a quote id that is not the grammar', { ...PLACE, quoteId: 'CHKQ_../../x' }],
    ['a quote id with a path in it', { ...PLACE, quoteId: `${QUOTE}/../orders` }],
    ['a lowercase-prefix quote id', { ...PLACE, quoteId: 'chkq_abcdefghijklmnop' }],
    ['a non-integer cart version', { ...PLACE, cartVersion: 3.5 }],
    ['a negative cart version', { ...PLACE, cartVersion: -1 }],
    ['a string cart version', { ...PLACE, cartVersion: '3' }],
    ['an address id that is not the grammar', { ...PLACE, addressId: 'ADDR_x' }],
    ['a slot id that is not the grammar', { ...PLACE, slotId: 'morning/2026-10-11' }],
  ])('%s is 400 and never reaches the backend', async (_name, body) => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    const res = await m.orders.POST(post('/api/orders', body, headers(r.csrf)))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'bad_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a non-JSON content type, malformed JSON, an array and an oversized body are refused', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    expect(
      (
        await m.orders.POST(
          post('/api/orders', PLACE, headers(r.csrf, { 'content-type': 'text/plain' })),
        )
      ).status,
    ).toBe(400)
    expect((await m.orders.POST(post('/api/orders', '{nope', headers(r.csrf)))).status).toBe(400)
    expect((await m.orders.POST(post('/api/orders', '[]', headers(r.csrf)))).status).toBe(400)
    expect(
      (
        await m.orders.POST(
          post('/api/orders', { ...PLACE, pad: 'x'.repeat(4000) }, headers(r.csrf)),
        )
      ).status,
    ).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/orders: placing', () => {
  it('checks the cart version, then places the quote with the SERVER-held slot and nothing the client priced', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    happyBackend()
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, data: { orderId: ORDER, payablePaise: 99800 } })
    expect(calls()).toEqual([`GET /v1/customer/cart?addressId=${ADDR}`, 'POST /v1/customer/orders'])
    // Exactly the backend contract: the quote, COD, the slot. No customer id, no price, no total, no idempotency header
    // (placement is idempotent by (customer, quote); the backend has no such header on this route).
    expect(sentBody(1)).toEqual({ quoteId: QUOTE, paymentMethod: 'COD', deliverySlotId: SLOT })
    expect(sentHeaders(1)).toMatchObject({ Authorization: expect.stringMatching(/^Bearer AT\./) })
    expect(Object.keys(sentHeaders(1)).map((k) => k.toLowerCase())).not.toContain('idempotency-key')
    expect(Object.keys(sentHeaders(1)).map((k) => k.toLowerCase())).not.toContain('if-match')
  })

  it('marks the attempt as pending BEFORE the placement request is sent, so a lost answer leaves the mark', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    let atSend: string | undefined
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () => {
        atSend = undefined
        void r.cookies.readCheckoutChoice().then((c) => (atSend = c?.placing))
        return backendError(503, 'SERVICE_UNAVAILABLE')
      },
    })
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    await Promise.resolve()
    expect(atSend).toBe(QUOTE)
    expect((await r.cookies.readCheckoutChoice())?.placing).toBe(QUOTE)
  })

  it('clears the checkout choice after success; the location and session cookies are untouched', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    await r.cookies.writeLocation({ pin: '560001', serviceable: true })
    happyBackend()
    expect(jar.get('__Host-tz_checkout')).toBeDefined()
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(jar.get('__Host-tz_checkout')).toBeUndefined()
    expect(jar.get('__Host-tz_loc')).toBeDefined()
    expect(jar.get('__Host-tz_session')).toBeDefined()
  })

  it('a repeat of the same quote (double click, lost answer, refresh) asks for the same quote and gets the same order', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    happyBackend()
    const first = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    // The choice was cleared by the first success; a repeat that still holds the same cookie (second tab, lost answer):
    await choose(r)
    const again = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect((await first.json()).data.orderId).toBe((await again.json()).data.orderId)
    const placements = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(placements.map(([, init]) => JSON.parse(String(init!.body)).quoteId)).toEqual([
      QUOTE,
      QUOTE,
    ])
  })

  it('refuses when the reviewed address or slot is not the one the server holds, or none is held; nothing is sent', async () => {
    const r = await loadEnv()
    const m = await routes()
    // none held
    let res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: 'choice_changed' })
    // another slot held
    await choose(r, { slotId: 'evening~2026-10-12' })
    res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'choice_changed' })
    // another address held
    await choose(r, { addressId: 'ADDR_zzzzzzzzzzzz1' })
    res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'choice_changed' })
    // another customer's choice
    await choose(r, { customerId: 'CUS_2' })
    res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'choice_changed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cart changed in another tab: 409 cart_changed, nothing is placed, the quote seed is kept', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    const before = await r.cookies.readCheckoutChoice()
    routeBackend({ [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(4)) })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, error: 'cart_changed' })
    expect(calls()).toEqual([`GET /v1/customer/cart?addressId=${ADDR}`])
    expect((await r.cookies.readCheckoutChoice())?.quoteKey).toBe(before?.quoteKey)
  })

  it('the address vanishing (cart 404) is address_changed; a cart outage is "unavailable" and nothing was placed', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => backendError(404, 'NOT_FOUND'),
    })
    let res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'address_changed' })
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => backendError(503, 'SERVICE_UNAVAILABLE'),
    })
    res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'unavailable' })
  })

  const CASES: Array<[string, number, string, string, number]> = [
    // backend status, backend code -> closed error, HTTP status of the BFF answer
    ['QUOTE_EXPIRED', 410, 'QUOTE_EXPIRED', 'quote_expired', 409],
    ['an unknown or foreign quote', 404, 'NOT_FOUND', 'quote_expired', 409],
    ['ADDRESS_CHANGED', 409, 'ADDRESS_CHANGED', 'address_changed', 409],
    ['NOT_SERVICEABLE', 409, 'NOT_SERVICEABLE', 'unserviceable', 409],
    ['PRICE_CHANGED', 409, 'PRICE_CHANGED', 'price_changed', 409],
    ['PRODUCT_UNAVAILABLE', 409, 'PRODUCT_UNAVAILABLE', 'items_unavailable', 409],
    ['STOCK_UNAVAILABLE', 409, 'STOCK_UNAVAILABLE', 'items_unavailable', 409],
    ['RESERVATION_EXPIRED', 409, 'RESERVATION_EXPIRED', 'hold_expired', 409],
    [
      'CART_VERSION_ALREADY_PURCHASED',
      409,
      'CART_VERSION_ALREADY_PURCHASED',
      'already_ordered',
      409,
    ],
    ['DELIVERY_SLOT_UNAVAILABLE', 409, 'DELIVERY_SLOT_UNAVAILABLE', 'slot_unavailable', 409],
    ['INVALID_REQUEST', 400, 'INVALID_REQUEST', 'bad_request', 400],
    ['PAYMENT_METHOD_UNSUPPORTED', 400, 'PAYMENT_METHOD_UNSUPPORTED', 'bad_request', 400],
    ['an unsupported media type', 415, 'UNSUPPORTED_MEDIA_TYPE', 'unknown', 502],
    ['INTERNAL', 500, 'INTERNAL', 'unknown', 502],
    ['SERVICE_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE', 'unknown', 502],
    ['a bad gateway without a code', 502, 'x', 'unknown', 502],
  ]
  it.each(CASES)('%s maps to the closed error %s', async (_name, status, code, error, http) => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () => backendError(status, code),
    })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(http)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ ok: false, error, retryAfterSeconds: null })
    // No backend text, id or detail reaches the customer.
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT)
    expect(JSON.stringify(body)).not.toContain('req_x')
    expect(logs.join('\n')).not.toContain(SECRET_TEXT)
  })

  it('a 401 from the backend rotates the tokens once and places the order with the new one', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    let carts = 0
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () =>
        ++carts === 1 ? backendError(401, 'UNAUTHENTICATED') : reply(200, cartBody(3)),
      'POST /v1/auth/refresh': () =>
        reply(200, {
          accessToken: 'AT.' + 'y'.repeat(60),
          accessTokenExpiresIn: 900,
          refreshToken: 'SES_newnewnew1.' + 'n'.repeat(30),
          requestId: 'r',
        }),
      'POST /v1/customer/orders': () => reply(200, orderBody()),
    })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toEqual({ ok: true, data: { orderId: ORDER, payablePaise: 99800 } })
    expect(calls()).toEqual([
      `GET /v1/customer/cart?addressId=${ADDR}`,
      'POST /v1/auth/refresh',
      `GET /v1/customer/cart?addressId=${ADDR}`,
      'POST /v1/customer/orders',
    ])
  })

  it('a 429 carries its Retry-After hint to the screen', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () =>
        reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '42' }),
    })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSeconds: 42 })
  })

  it('a 200 that is not the order is an UNKNOWN outcome (it may have been placed), never a success', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () => reply(200, { orderId: 'nope', status: 'CONFIRMED' }),
    })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ ok: false, error: 'unknown' })
    expect(jar.get('__Host-tz_checkout')).toBeDefined()
  })

  it('an order whose lines do not add up is not trusted: unknown', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () => reply(200, orderBody({ subtotalPaise: 1 })),
    })
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'unknown' })
  })
})

describe('the checkout cookie across outcomes (the idempotency key lifecycle)', () => {
  const failing = (status: number, code: string) =>
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(3)),
      'POST /v1/customer/orders': () => backendError(status, code),
    })

  it('an UNKNOWN outcome keeps the seed, so a retry is the same quote and can only return the same order', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    const before = await r.cookies.readCheckoutChoice()
    failing(503, 'SERVICE_UNAVAILABLE')
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'unknown' })
    // the seed is kept, and the quote is remembered as pending
    expect(await r.cookies.readCheckoutChoice()).toEqual({ ...before, placing: QUOTE })
    // the retry: same body, same quote, and this time the answer arrives
    happyBackend()
    const retry = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await retry.json()).toEqual({ ok: true, data: { orderId: ORDER, payablePaise: 99800 } })
    const quotes = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init!.body)).quoteId)
    expect(quotes).toEqual([QUOTE, QUOTE])
  })

  it.each([
    ['QUOTE_EXPIRED', 410],
    ['PRICE_CHANGED', 409],
    ['STOCK_UNAVAILABLE', 409],
    ['PRODUCT_UNAVAILABLE', 409],
  ])(
    '%s ends the quote: the seed is replaced, the choice and its expiry are not',
    async (code, status) => {
      const r = await loadEnv()
      const m = await routes()
      await choose(r)
      const before = (await r.cookies.readCheckoutChoice())!
      failing(status, code)
      await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
      const after = (await r.cookies.readCheckoutChoice())!
      expect(after.quoteKey).not.toBe(before.quoteKey)
      expect(after).toMatchObject({
        customerId: before.customerId,
        addressId: before.addressId,
        slotId: before.slotId,
        expiresAt: before.expiresAt,
      })
    },
  )

  it.each([
    ['RESERVATION_EXPIRED', 409],
    ['DELIVERY_SLOT_UNAVAILABLE', 409],
    ['ADDRESS_CHANGED', 409],
    ['INTERNAL', 500],
  ])('%s leaves the seed alone', async (code, status) => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    const before = (await r.cookies.readCheckoutChoice())!
    failing(status, code)
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    const after = (await r.cookies.readCheckoutChoice())!
    expect(after.quoteKey).toBe(before.quoteKey)
    expect(after).toMatchObject({ addressId: before.addressId, slotId: before.slotId })
    expect(after.expiresAt).toBe(before.expiresAt)
    // only an unknown outcome leaves a pending marker
    expect(after.placing).toBe(code === 'INTERNAL' ? QUOTE : undefined)
  })

  it('the retry of an UNKNOWN attempt skips the "cart as reviewed" check, because the order that went through emptied the cart', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    failing(503, 'SERVICE_UNAVAILABLE')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    fetchMock.mockReset()
    // The backend did place it: the cart is now empty, at the next version. The retry must still reach the backend.
    routeBackend({
      [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(4, [])),
      'POST /v1/customer/orders': () => reply(200, orderBody()),
    })
    const retry = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await retry.json()).toEqual({ ok: true, data: { orderId: ORDER, payablePaise: 99800 } })
    expect(calls()).toEqual(['POST /v1/customer/orders'])
    expect(jar.get('__Host-tz_checkout')).toBeUndefined()
  })

  it('a different quote never inherits that: with the cart moved on, it is refused before anything is sent', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    failing(503, 'SERVICE_UNAVAILABLE')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    fetchMock.mockReset()
    routeBackend({ [`GET /v1/customer/cart?addressId=${ADDR}`]: () => reply(200, cartBody(4)) })
    const other = { ...PLACE, quoteId: 'CHKQ_zzzzzzzzzzzzzzzzzzzzz' }
    const res = await m.orders.POST(post('/api/orders', other, headers(r.csrf)))
    expect(await res.json()).toMatchObject({ error: 'cart_changed' })
    expect(calls()).toEqual([`GET /v1/customer/cart?addressId=${ADDR}`])
  })

  it('a definite failure after an unknown one forgets the pending marker; a rotation does too', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    failing(503, 'SERVICE_UNAVAILABLE')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect((await r.cookies.readCheckoutChoice())?.placing).toBe(QUOTE)
    failing(409, 'DELIVERY_SLOT_UNAVAILABLE')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect((await r.cookies.readCheckoutChoice())?.placing).toBeUndefined()
    failing(503, 'SERVICE_UNAVAILABLE')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    failing(409, 'PRICE_CHANGED')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect((await r.cookies.readCheckoutChoice())?.placing).toBeUndefined()
  })

  it('already ordered clears the choice (the cart was bought); a refresh request replaces the seed only', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    failing(409, 'CART_VERSION_ALREADY_PURCHASED')
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(jar.get('__Host-tz_checkout')).toBeUndefined()

    await choose(r)
    const before = (await r.cookies.readCheckoutChoice())!
    fetchMock.mockReset()
    const res = await m.refresh.POST(post('/api/checkout/refresh', {}, headers(r.csrf)))
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    const after = (await r.cookies.readCheckoutChoice())!
    expect(after.quoteKey).not.toBe(before.quoteKey)
    expect(after.expiresAt).toBe(before.expiresAt)
  })

  it('refresh without a held choice says so; a body with fields is refused', async () => {
    const r = await loadEnv()
    const m = await routes()
    const none = await m.refresh.POST(post('/api/checkout/refresh', {}, headers(r.csrf)))
    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ error: 'choice_changed' })
    await choose(r)
    const extra = await m.refresh.POST(
      post('/api/checkout/refresh', { quoteKey: 'x' }, headers(r.csrf)),
    )
    expect(extra.status).toBe(400)
  })

  it('the seed never leaves the sealed cookie: it is not in any response, request or log', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    const key = (await r.cookies.readCheckoutChoice())!.quoteKey
    happyBackend()
    const res = await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    expect(await res.text()).not.toContain(key)
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(key)
    expect(logs.join('\n')).not.toContain(key)
    expect(jar.get('__Host-tz_checkout')).toBeUndefined()
  })
})

describe('POST /api/orders/cancel', () => {
  const body = { orderId: ORDER, reason: 'CHANGED_MIND' }

  it('sends the closed reason for the caller-owned order id and returns only the status', async () => {
    const r = await loadEnv()
    const m = await routes()
    routeBackend({
      [`POST /v1/customer/orders/${ORDER}/cancel`]: () =>
        reply(200, orderBody({ status: 'CANCELLED', cancelledAt: '2026-10-11T05:00:00.000Z' })),
    })
    const res = await m.cancel.POST(post('/api/orders/cancel', body, headers(r.csrf)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, data: { status: 'CANCELLED' } })
    expect(sentBody(0)).toEqual({ reason: 'CHANGED_MIND' })
  })

  it.each([
    ['CANCELLATION_WINDOW_CLOSED', 409, 'window_closed'],
    ['ORDER_NOT_CANCELLABLE', 409, 'not_cancellable'],
    ['NOT_FOUND', 404, 'not_found'],
    ['SERVICE_UNAVAILABLE', 503, 'unavailable'],
  ])(
    '%s is the closed error %s (the default deployment refuses every cancel)',
    async (code, status, error) => {
      const r = await loadEnv()
      const m = await routes()
      routeBackend({
        [`POST /v1/customer/orders/${ORDER}/cancel`]: () => backendError(status, code),
      })
      const res = await m.cancel.POST(post('/api/orders/cancel', body, headers(r.csrf)))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ ok: false, error, retryAfterSeconds: null })
    },
  )

  it.each([
    ['an unknown reason', { orderId: ORDER, reason: 'BECAUSE' }],
    ['free text', { orderId: ORDER, reason: 'I do not like it' }],
    ['a staff reason', { orderId: ORDER, reason: 'OUT_OF_STOCK' }],
    ['a missing reason', { orderId: ORDER }],
    ['a traversal in the id', { orderId: 'ORD_../../admin', reason: 'OTHER' }],
    ['a path in the id', { orderId: `${ORDER}/cancel`, reason: 'OTHER' }],
    ['a lowercase id', { orderId: 'ord_abcdefghijklmnop', reason: 'OTHER' }],
    ['an extra field', { orderId: ORDER, reason: 'OTHER', customerId: 'CUS_2' }],
  ])('%s is 400 and never reaches the backend', async (_n, bad) => {
    const r = await loadEnv()
    const m = await routes()
    const res = await m.cancel.POST(post('/api/orders/cancel', bad, headers(r.csrf)))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ownership', () => {
  it('the customer id is never part of any backend request: the bearer token alone identifies the caller', async () => {
    const r = await loadEnv()
    const m = await routes()
    await choose(r)
    happyBackend()
    await m.orders.POST(post('/api/orders', PLACE, headers(r.csrf)))
    const wire = JSON.stringify(fetchMock.mock.calls)
    expect(wire).not.toContain('CUS_1')
    expect(wire.toLowerCase()).not.toContain('customerid')
  })
})
