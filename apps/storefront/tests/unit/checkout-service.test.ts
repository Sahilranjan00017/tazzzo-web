import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADDR,
  QUOTE,
  SLOT,
  addressBody,
  backendError,
  calls,
  cartBody,
  cartItem,
  fetchMock,
  jar,
  loadEnv,
  quoteBody,
  reply,
  resetFetch,
  routeBackend,
  sentBody,
  sentHeaders,
  slotsBody,
  type Loaded,
} from './checkout-fixtures'

vi.mock('next/headers', () => ({ cookies: async () => jar }))

/**
 * The review page's data (`reviewCheckout`): which earlier step a customer is sent back to, what the quote request
 * carries (the `Idempotency-Key` lifecycle above all), and how each way the backend can refuse the cart is shown.
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

async function review(r: Loaded) {
  const service = await import('@/server/checkout/service')
  const session = (await r.cookies.readSession())!
  return service.reviewCheckout(session)
}

async function choose(r: Loaded, over: Record<string, string> = {}) {
  await r.cookies.writeCheckoutChoice({
    customerId: 'CUS_1',
    addressId: ADDR,
    slotId: SLOT,
    ...over,
  })
}

const CART = `GET /v1/customer/cart?addressId=${ADDR}`
const ready = (over: Record<string, () => Response> = {}) =>
  routeBackend({
    [CART]: () => reply(200, cartBody(3)),
    [`GET /v1/customer/addresses/${ADDR}`]: () => reply(200, addressBody()),
    'GET /v1/customer/delivery/slots?pin=560001': () => reply(200, slotsBody()),
    'POST /v1/customer/checkout/quote': () => reply(200, quoteBody()),
    ...over,
  })

describe('where an incomplete checkout goes', () => {
  it('nothing chosen and a cart with items: on to the delivery step', async () => {
    const r = await loadEnv()
    routeBackend({ 'GET /v1/customer/cart': () => reply(200, cartBody(3)) })
    expect(await review(r)).toEqual({ kind: 'redirect', to: '/checkout/delivery' })
  })

  it('nothing chosen and an empty cart: back to the cart', async () => {
    const r = await loadEnv()
    routeBackend({ 'GET /v1/customer/cart': () => reply(200, cartBody(3, [])) })
    expect(await review(r)).toEqual({ kind: 'redirect', to: '/cart' })
  })

  it("another customer's choice counts as none", async () => {
    const r = await loadEnv()
    await choose(r, { customerId: 'CUS_2' })
    routeBackend({ 'GET /v1/customer/cart': () => reply(200, cartBody(3)) })
    expect(await review(r)).toEqual({ kind: 'redirect', to: '/checkout/delivery' })
  })

  it('an emptied cart (bought elsewhere, or by the order that just succeeded) goes back to the cart', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({ [CART]: () => reply(200, cartBody(4, [])) })
    expect(await review(r)).toEqual({ kind: 'redirect', to: '/cart' })
    expect(calls().some((c) => c.includes('/checkout/quote'))).toBe(false)
  })

  it('a deleted address goes back to the delivery step with a reason', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({ [`GET /v1/customer/addresses/${ADDR}`]: () => backendError(404, 'NOT_FOUND') })
    expect(await review(r)).toEqual({ kind: 'redirect', to: '/checkout/delivery?reason=address' })
  })

  it('an address that is no longer serviceable goes back to the delivery step', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({
      [`GET /v1/customer/addresses/${ADDR}`]: () =>
        reply(200, addressBody({ serviceability: { serviceable: false } })),
    })
    expect(await review(r)).toEqual({
      kind: 'redirect',
      to: '/checkout/delivery?reason=unserviceable',
    })
  })

  it.each(['FULL', 'CLOSED', 'WEIRD'])(
    'a %s slot goes back to the delivery step',
    async (status) => {
      const r = await loadEnv()
      await choose(r)
      ready({ 'GET /v1/customer/delivery/slots?pin=560001': () => reply(200, slotsBody(status)) })
      expect(await review(r)).toEqual({ kind: 'redirect', to: '/checkout/delivery?reason=slot' })
      expect(calls().some((c) => c.includes('/checkout/quote'))).toBe(false)
    },
  )

  it('an unusable access token is handed to the page for a refresh before anything is asked', async () => {
    const r = await loadEnv()
    const session = (await r.cookies.readSession())!
    const service = await import('@/server/checkout/service')
    const out = await service.reviewCheckout({ ...session, accessExpiresAt: Date.now() - 1 })
    expect(out).toEqual({ kind: 'unauthenticated', rejected: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the quote request', () => {
  it('carries only the address, the reviewed cart version as If-Match and an Idempotency-Key in the backend grammar', async () => {
    const r = await loadEnv()
    await choose(r)
    ready()
    const out = await review(r)
    expect(out.kind).toBe('ready')
    const i = calls().indexOf('POST /v1/customer/checkout/quote')
    expect(sentBody(i)).toEqual({ addressId: ADDR })
    expect(sentHeaders(i)['If-Match']).toBe('"cart-3"')
    expect(sentHeaders(i)['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sentHeaders(i).Authorization).toMatch(/^Bearer /)
  })

  it('shows the backend quote, with the cart titles and MRP, and never anything the browser supplied', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({
      'POST /v1/customer/checkout/quote': () =>
        reply(
          200,
          quoteBody({
            benefitPreview: { applied: true, discountPaise: 9980, discountBps: 1000 },
            moneyPreview: {
              merchandiseSubtotalPaise: 99800,
              benefitDiscountPaise: 9980,
              payablePaise: 89820,
            },
          }),
        ),
    })
    const out = await review(r)
    expect(out).toMatchObject({
      kind: 'ready',
      view: {
        quoteId: QUOTE,
        cartVersion: 3,
        addressId: ADDR,
        slotId: SLOT,
        subtotalPaise: 99800,
        discountPaise: 9980,
        payablePaise: 89820,
        itemCount: 2,
        lines: [
          {
            productId: 'TZP-1001',
            title: 'Basmati Rice 5 kg',
            quantity: 2,
            unitPricePaise: 49900,
            mrpPaise: 59900,
            lineTotalPaise: 99800,
          },
        ],
        slot: { slotId: SLOT, label: 'Morning', date: '2026-10-11', window: '9:00 am to 11:00 am' },
        address: { postalCode: '560001', recipientName: 'Asha Verma' },
      },
    })
  })

  it('a quote without money shows no payable at all, never zero', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({
      'POST /v1/customer/checkout/quote': () =>
        reply(200, quoteBody({ moneyPreview: undefined, benefitPreview: undefined })),
    })
    expect(await review(r)).toMatchObject({
      kind: 'ready',
      view: { payablePaise: null, discountPaise: 0, subtotalPaise: 99800 },
    })
  })

  describe('Idempotency-Key lifecycle', () => {
    const keyOf = () => {
      const i = calls().lastIndexOf('POST /v1/customer/checkout/quote')
      return sentHeaders(i)['Idempotency-Key']!
    }

    it('is identical for every render of the same attempt (refresh, double click, a second tab)', async () => {
      const r = await loadEnv()
      await choose(r)
      ready()
      await review(r)
      const first = keyOf()
      await review(r)
      await review(r)
      expect(keyOf()).toBe(first)
      const keys = fetchMock.mock.calls
        .filter(([url]) => url.endsWith('/checkout/quote'))
        .map(([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key'])
      expect(new Set(keys).size).toBe(1)
    })

    it('moves on by itself when the cart version changes (the backend would call the old key a conflict)', async () => {
      const r = await loadEnv()
      await choose(r)
      ready()
      await review(r)
      const first = keyOf()
      ready({ [CART]: () => reply(200, cartBody(4)) })
      await review(r)
      expect(keyOf()).not.toBe(first)
    })

    it('differs between addresses and between attempts (a new delivery choice starts a new attempt)', async () => {
      const r = await loadEnv()
      await choose(r)
      ready()
      await review(r)
      const first = keyOf()
      await choose(r) // saving the delivery step again: a fresh seed
      await review(r)
      expect(keyOf()).not.toBe(first)
    })

    it('is replaced only by an explicit renewal; the new key stays stable afterwards', async () => {
      const r = await loadEnv()
      await choose(r)
      ready()
      await review(r)
      const first = keyOf()
      const service = await import('@/server/checkout/service')
      await service.renewReview((await r.cookies.readSession())!)
      await review(r)
      const second = keyOf()
      expect(second).not.toBe(first)
      await review(r)
      expect(keyOf()).toBe(second)
    })

    it('is a pure function of seed, version and address, in the backend grammar, and never contains the seed', async () => {
      await loadEnv()
      const { deriveQuoteKey } = await import('@/server/checkout/key')
      const seed = 's'.repeat(43)
      const k = deriveQuoteKey(seed, 3, ADDR)
      expect(k).toBe(deriveQuoteKey(seed, 3, ADDR))
      expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(k).not.toContain(seed)
      expect(
        new Set([
          k,
          deriveQuoteKey(seed, 4, ADDR),
          deriveQuoteKey(seed, 3, 'ADDR_other12345'),
          deriveQuoteKey('t'.repeat(43), 3, ADDR),
        ]).size,
      ).toBe(4)
    })
  })
})

describe('how the backend can refuse the cart', () => {
  it('the cart moving between reading and quoting: read it again, quote that version, once', async () => {
    const r = await loadEnv()
    await choose(r)
    let quotes = 0
    let carts = 0
    ready({
      [CART]: () => reply(200, cartBody(++carts === 1 ? 3 : 4)),
      'POST /v1/customer/checkout/quote': () =>
        ++quotes === 1
          ? backendError(412, 'PRECONDITION_FAILED')
          : reply(200, quoteBody({ cartVersion: 4 })),
    })
    expect(await review(r)).toMatchObject({ kind: 'ready', view: { cartVersion: 4 } })
    const quoteCalls = calls().flatMap((c, i) => (c.endsWith('/checkout/quote') ? [i] : []))
    expect(quoteCalls.map((i) => sentHeaders(i)['If-Match'])).toEqual(['"cart-3"', '"cart-4"'])
  })

  it('a cart that keeps moving is "unavailable", not a loop', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({ 'POST /v1/customer/checkout/quote': () => backendError(412, 'PRECONDITION_FAILED') })
    expect(await review(r)).toMatchObject({ kind: 'unavailable' })
    expect(calls().filter((c) => c.endsWith('/checkout/quote'))).toHaveLength(2)
  })

  it('names the blocked lines with the backend reason and the cart title; unknown reasons fail closed', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({
      [CART]: () =>
        reply(200, cartBody(3, [cartItem('TZP-1001', 2), cartItem('TZP-1002', 1, 15950)])),
      'POST /v1/customer/checkout/quote': () =>
        backendError(409, 'CHECKOUT_ITEM_UNAVAILABLE', {
          items: [
            { skuId: 'TZP-1001', reason: 'OUT_OF_STOCK' },
            { skuId: 'TZP-1002', reason: 'SOMETHING_NEWER' },
            { skuId: 'not a sku', reason: 'OUT_OF_STOCK' },
          ],
        }),
    })
    const out = await review(r)
    expect(out).toMatchObject({
      kind: 'blocked',
      lines: [
        { productId: 'TZP-1001', title: 'Basmati Rice 5 kg', quantity: 2, reason: 'OUT_OF_STOCK' },
        { productId: 'TZP-1002', reason: 'NOT_BUYABLE' },
      ],
    })
    if (out.kind === 'blocked') expect(out.lines).toHaveLength(2)
  })

  it.each([
    ['CHECKOUT_CART_EMPTY', 409, { kind: 'redirect', to: '/cart' }],
    [
      'CHECKOUT_UNSERVICEABLE',
      409,
      { kind: 'redirect', to: '/checkout/delivery?reason=unserviceable' },
    ],
    ['NOT_FOUND', 404, { kind: 'redirect', to: '/checkout/delivery?reason=address' }],
    ['QUOTE_EXPIRED', 410, { kind: 'expired' }],
    ['IDEMPOTENCY_CONFLICT', 409, { kind: 'expired' }],
    ['UNAUTHENTICATED', 401, { kind: 'unauthenticated', rejected: true }],
    [
      'SERVICE_UNAVAILABLE',
      503,
      { kind: 'unavailable', rateLimited: false, retryAfterSeconds: null },
    ],
    ['INTERNAL', 500, { kind: 'unavailable', rateLimited: false, retryAfterSeconds: null }],
    [
      'PRECONDITION_REQUIRED',
      428,
      { kind: 'unavailable', rateLimited: false, retryAfterSeconds: null },
    ],
    ['INVALID_REQUEST', 400, { kind: 'unavailable', rateLimited: false, retryAfterSeconds: null }],
  ])('%s', async (code, status, expected) => {
    const r = await loadEnv()
    await choose(r)
    ready({ 'POST /v1/customer/checkout/quote': () => backendError(status, code) })
    expect(await review(r)).toEqual(expected)
  })

  it('a 429 is shown with its Retry-After', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({
      'POST /v1/customer/checkout/quote': () => reply(429, { code: 'X' }, { 'retry-after': '17' }),
    })
    expect(await review(r)).toEqual({
      kind: 'unavailable',
      rateLimited: true,
      retryAfterSeconds: 17,
    })
  })

  it.each([
    ['lines that do not add up', { subtotalPaise: 5 }],
    [
      'money that does not follow',
      {
        moneyPreview: {
          merchandiseSubtotalPaise: 99800,
          benefitDiscountPaise: 1,
          payablePaise: 99800,
        },
      },
    ],
    [
      'money for another subtotal',
      { moneyPreview: { merchandiseSubtotalPaise: 1, benefitDiscountPaise: 0, payablePaise: 1 } },
    ],
    ['a quote id outside the grammar', { quoteId: 'CHKQ_../x' }],
    ['another currency', { currency: 'USD' }],
    ['no lines', { items: [], itemCount: 0, subtotalPaise: 0 }],
    [
      'a line total that is not price times quantity',
      {
        items: [{ skuId: 'TZP-1001', quantity: 2, unitPricePaise: 49900, lineTotalPaise: 99799 }],
        subtotalPaise: 99799,
        moneyPreview: undefined,
      },
    ],
  ])('%s is not trusted: unavailable, with a log line that carries no data', async (_n, over) => {
    const r = await loadEnv()
    await choose(r)
    ready({ 'POST /v1/customer/checkout/quote': () => reply(200, quoteBody(over)) })
    expect(await review(r)).toMatchObject({ kind: 'unavailable' })
    expect(logs.join('\n')).toContain(
      'storefront_backend_malformed path=/v1/customer/checkout/quote',
    )
    expect(logs.join('\n')).not.toContain('99800')
  })

  it('a backend outage on the cart or the slots is "unavailable" and no quote is requested', async () => {
    const r = await loadEnv()
    await choose(r)
    ready({ [CART]: () => backendError(503, 'SERVICE_UNAVAILABLE') })
    expect(await review(r)).toMatchObject({ kind: 'unavailable' })
    ready({ 'GET /v1/customer/delivery/slots?pin=560001': () => backendError(503, 'X') })
    expect(await review(r)).toMatchObject({ kind: 'unavailable' })
    expect(calls().some((c) => c.endsWith('/checkout/quote'))).toBe(false)
  })
})
