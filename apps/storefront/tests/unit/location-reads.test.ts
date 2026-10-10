import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/** Where the delivery location reaches the backend: `?pin=` on public reads, `?addressId=` on the cart, slot parsing. */
const jar = new CookieJar()
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const KEY = randomBytes(32).toString('base64')
const API = 'https://api.tazzzo.test'
const TOKEN = 'AT.' + 'x'.repeat(60)
const ADDR = 'ADDR_abcdefghij123'
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const cartBody = (version = 1) => ({
  version,
  items: [],
  itemCount: 0,
  subtotalPaise: 0,
  freshness: 'FRESH',
})
const session = (customerId = 'CUS_1') => ({
  customerId,
  accessToken: TOKEN,
  accessExpiresAt: Date.now() + 900_000,
  refreshToken: 'SES_abcdef123.' + 'r'.repeat(30),
  csrf: 'c'.repeat(43),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
})

async function load() {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  vi.stubEnv('TAZZZO_API_BASE_URL', API)
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  return {
    cookies: await import('@/server/session/cookies'),
    cart: await import('@/server/cart/service'),
    catalog: await import('@/server/backend/catalog'),
    client: await import('@/server/backend/client'),
    slots: await import('@/server/backend/slots'),
    seal: await import('@/server/session/seal'),
  }
}
const urls = () => fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${u.replace(API, '')}`)

beforeEach(() => {
  jar.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the cart is located by the chosen saved address', () => {
  it('sends ?addressId= on read and every mutation, only for the customer it was chosen by', async () => {
    const m = await load()
    await m.cookies.writeLocation({
      pin: '560001',
      serviceable: true,
      addressId: ADDR,
      customerId: 'CUS_1',
    })
    fetchMock.mockImplementation(async () => reply(200, cartBody()))
    const s = session()
    await m.cart.viewCart(s)
    await m.cart.setQuantity(s, 'TZP-1001', 2, 1)
    await m.cart.removeLine(s, 'TZP-1001', 1)
    await m.cart.emptyCart(s, 1)
    expect(urls()).toEqual([
      `GET /v1/customer/cart?addressId=${ADDR}`,
      `PUT /v1/customer/cart/items/TZP-1001?addressId=${ADDR}`,
      `DELETE /v1/customer/cart/items/TZP-1001?addressId=${ADDR}`,
      `DELETE /v1/customer/cart?addressId=${ADDR}`,
    ])
  })

  it('add reads and writes under the address', async () => {
    const m = await load()
    await m.cookies.writeLocation({
      pin: '560001',
      serviceable: true,
      addressId: ADDR,
      customerId: 'CUS_1',
    })
    fetchMock.mockImplementation(async () => reply(200, cartBody()))
    await m.cart.addToCart(session(), 'TZP-1001', 1)
    expect(urls()).toEqual([
      `GET /v1/customer/cart?addressId=${ADDR}`,
      `PUT /v1/customer/cart/items/TZP-1001?addressId=${ADDR}`,
    ])
  })

  it('sends nothing for another customer, a PIN-only location or no location', async () => {
    const m = await load()
    fetchMock.mockImplementation(async () => reply(200, cartBody()))
    await m.cart.viewCart(session())
    await m.cookies.writeLocation({ pin: '560001', serviceable: true })
    await m.cart.viewCart(session())
    await m.cookies.writeLocation({
      pin: '560001',
      serviceable: true,
      addressId: ADDR,
      customerId: 'CUS_1',
    })
    await m.cart.viewCart(session('CUS_2'))
    expect(urls()).toEqual([
      'GET /v1/customer/cart',
      'GET /v1/customer/cart',
      'GET /v1/customer/cart',
    ])
  })

  it('a saved address the backend no longer knows (404) falls back to the cart without a location', async () => {
    const m = await load()
    await m.cookies.writeLocation({
      pin: '560001',
      serviceable: true,
      addressId: ADDR,
      customerId: 'CUS_1',
    })
    fetchMock
      .mockResolvedValueOnce(reply(404, { code: 'NOT_FOUND' }))
      .mockResolvedValueOnce(reply(200, cartBody(3)))
    const out = await m.cart.viewCart(session())
    expect(out.ok && out.cart.version).toBe(3)
    expect(urls()).toEqual([`GET /v1/customer/cart?addressId=${ADDR}`, 'GET /v1/customer/cart'])
  })

  it('a tampered location cookie is simply no location', async () => {
    const m = await load()
    jar.set('__Host-tz_loc', 'v1.AAAA.BBBB')
    expect(await m.cookies.readLocation()).toBeNull()
    await m.cookies.writeLocation({ pin: '560001', serviceable: true })
    const good = jar.get('__Host-tz_loc')!.value
    jar.set('__Host-tz_loc', good.slice(0, -2) + 'AA')
    expect(await m.cookies.readLocation()).toBeNull()
  })

  it('a location sealed for another cookie purpose does not open as a location', async () => {
    const m = await load()
    const keys = (await import('@/server/env')).serverEnv().sessionKeys!
    const wrong = m.seal.seal(
      'session',
      { pin: '560001', serviceable: true, expiresAt: Date.now() + 1e6 },
      Date.now() + 1e6,
      keys,
    )
    jar.set('__Host-tz_loc', wrong)
    expect(await m.cookies.readLocation()).toBeNull()
  })
})

describe('public reads carry ?pin= (a canonical PIN only)', () => {
  const okProduct = {
    productId: 'TZP-1001',
    name: 'Rice',
    stockState: 'IN_STOCK',
    serviceable: true,
  }
  it('product detail', async () => {
    const m = await load()
    m.client.resetFailureMemory()
    fetchMock.mockImplementation(async () => reply(200, okProduct))
    const p = await m.catalog.getProduct('TZP-1001', '560001')
    expect(p).toMatchObject({ stockState: 'IN_STOCK', serviceable: true })
    expect(urls()).toEqual(['GET /v1/products/TZP-1001?pin=560001'])
  })
  it('without a PIN the URL is unchanged; a non-canonical PIN is dropped, never sent', async () => {
    const m = await load()
    fetchMock.mockImplementation(async () => reply(200, okProduct))
    await m.catalog.getProduct('TZP-1001')
    await m.catalog.getProduct('TZP-1001', '560001&x=1')
    await m.catalog.getProduct('TZP-1001', '../')
    expect(urls()).toEqual([
      'GET /v1/products/TZP-1001',
      'GET /v1/products/TZP-1001',
      'GET /v1/products/TZP-1001',
    ])
  })
  it('rails (one batch read), category lists and search', async () => {
    const m = await load()
    fetchMock.mockImplementation(async (u) =>
      String(u).includes('/v1/products:batch')
        ? reply(200, { resolvedReleaseId: 'R1', items: [okProduct], missing: [], requestId: 'r' })
        : reply(200, { items: [okProduct], hasMore: false }),
    )
    await m.catalog.getRailProducts(['TZP-1001'], '560001')
    await m.catalog.getCategoryProducts('TZC-000002', null, '560001')
    await m.catalog.searchProducts('rice', null, '560001')
    expect(urls()).toEqual([
      'GET /v1/products:batch?ids=TZP-1001&pin=560001',
      'GET /v1/categories/TZC-000002/products?page_size=24&pin=560001',
      'GET /v1/search?q=rice&page_size=24&pin=560001',
    ])
  })
  it('a cursor refused after the location changed is a stale cursor, not a 404 or a rejected query', async () => {
    const m = await load()
    m.client.resetFailureMemory()
    fetchMock.mockImplementation(async () => reply(400, { code: 'INVALID_CURSOR' }))
    expect(await m.catalog.getCategoryProducts('TZC-000002', 'abc', '560001')).toBe('stale_cursor')
    expect(await m.catalog.searchProducts('rice', 'abc', '560001')).toBe('stale_cursor')
    expect(await m.catalog.searchProducts('rice', null, null)).toBe('rejected')
  })
})

describe('delivery slots', () => {
  const slot = (status: string, over: Record<string, unknown> = {}) => ({
    slotId: 'morning~2026-10-11',
    date: '2026-10-11',
    startsAt: '2026-10-11T09:00:00+05:30',
    endsAt: '2026-10-11T11:00:00+05:30',
    label: 'Morning',
    status,
    ...over,
  })
  it('parses statuses; an unknown one is closed; capacity is never read', async () => {
    const m = await load()
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        serviceable: true,
        timezone: 'Asia/Kolkata',
        slots: [slot('AVAILABLE', { remaining: 3 }), slot('FULL'), slot('NEW_STATUS')],
      }),
    )
    const r = await m.slots.listSlots(TOKEN, '560001')
    expect(r.ok && r.data.slots.map((s) => s.status)).toEqual(['AVAILABLE', 'FULL', 'CLOSED'])
    expect(JSON.stringify(r)).not.toContain('remaining')
    expect(urls()).toEqual(['GET /v1/customer/delivery/slots?pin=560001'])
  })
  it('unserviceable PIN: serviceable false and no slots', async () => {
    const m = await load()
    fetchMock.mockResolvedValueOnce(
      reply(200, { serviceable: false, timezone: 'Asia/Kolkata', slots: [] }),
    )
    const r = await m.slots.listSlots(TOKEN, '400001')
    expect(r).toMatchObject({ ok: true, data: { serviceable: false, slots: [] } })
  })
  it('refuses malformed bodies and slot ids outside the grammar', async () => {
    const m = await load()
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        serviceable: true,
        timezone: 'Asia/Kolkata',
        slots: [slot('AVAILABLE', { slotId: '../x' })],
      }),
    )
    expect(await m.slots.listSlots(TOKEN, '560001')).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    await expect(m.slots.listSlots(TOKEN, '56001')).rejects.toThrow()
  })
  it('maps 401, 429 and 400', async () => {
    const m = await load()
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHENTICATED' }))
    expect(await m.slots.listSlots(TOKEN, '560001')).toMatchObject({ reason: 'unauthenticated' })
    fetchMock.mockResolvedValueOnce(reply(400, { code: 'INVALID_REQUEST' }))
    expect(await m.slots.listSlots(TOKEN, '560001')).toMatchObject({ reason: 'bad_request' })
  })
})
