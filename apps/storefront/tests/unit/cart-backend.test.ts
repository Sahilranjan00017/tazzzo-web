import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The typed cart client over a mocked backend `fetch`: requests it sends, bodies it accepts, failures it maps. */
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

const TOKEN = 'AT.' + 'x'.repeat(60)
const MEDIA = 'https://cdn.tazzzo.test/media'

async function client() {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('TAZZZO_MEDIA_BASE_URL', MEDIA)
  vi.stubEnv('STOREFRONT_SESSION_SECRET', 'q'.repeat(43))
  return import('@/server/backend/cart')
}

const item = (over: Record<string, unknown> = {}) => ({
  skuId: 'TZP-1001',
  quantity: 2,
  addedAt: '2026-10-09T10:00:00Z',
  updatedAt: '2026-10-09T10:00:00Z',
  product: { title: 'Basmati Rice 5 kg', brandCode: 'TZB-1', imageUrl: `${MEDIA}/p1.png` },
  price: { unitPricePaise: 49900, mrpPaise: 59900, currency: 'INR' },
  availability: { stockState: 'UNKNOWN', maxOrderQuantity: 0, serviceable: null },
  lineTotalPaise: 99800,
  buyable: false,
  issues: ['LOCATION_REQUIRED'],
  ...over,
})
const cart = (over: Record<string, unknown> = {}) => ({
  version: 3,
  items: [item()],
  itemCount: 2,
  distinctItemCount: 1,
  subtotalPaise: 99800,
  expiresAt: '2026-10-16T10:00:00Z',
  freshness: 'FRESH',
  requestId: 'req_1',
  ...over,
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('requests', () => {
  it('GET sends the bearer token and nothing else customer-specific', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(reply(200, cart()))
    await c.getCart(TOKEN)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.tazzzo.test/v1/customer/cart')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` })
    expect(init?.headers).not.toHaveProperty('If-Match')
    expect(init?.cache).toBe('no-store')
    expect(init?.redirect).toBe('error')
  })

  it('PUT sets an exact quantity under the quoted cart version, with only {quantity} as the body', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(reply(200, cart({ version: 4 })))
    const result = await c.setCartItem(TOKEN, 'TZP-1001', 5, 3)
    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.tazzzo.test/v1/customer/cart/items/TZP-1001')
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({
      'If-Match': '"cart-3"',
      'Content-Type': 'application/json',
    })
    expect(init?.body).toBe('{"quantity":5}')
  })

  it('DELETE of a line and of the cart carry If-Match and no body', async () => {
    const c = await client()
    fetchMock.mockResolvedValue(reply(200, cart({ items: [], itemCount: 0, subtotalPaise: 0 })))
    await c.removeCartItem(TOKEN, 'TZP-1001', 8)
    await c.clearCart(TOKEN, 9)
    const [[u1, i1], [u2, i2]] = fetchMock.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ]
    expect([u1, i1.method, (i1.headers as Record<string, string>)['If-Match'], i1.body]).toEqual([
      'https://api.tazzzo.test/v1/customer/cart/items/TZP-1001',
      'DELETE',
      '"cart-8"',
      undefined,
    ])
    expect([u2, i2.method, (i2.headers as Record<string, string>)['If-Match']]).toEqual([
      'https://api.tazzzo.test/v1/customer/cart',
      'DELETE',
      '"cart-9"',
    ])
  })

  it('sends a mixed-case canonical id exactly as given, and refuses a non-canonical one before any request', async () => {
    const c = await client()
    fetchMock.mockResolvedValue(reply(200, cart()))
    await c.removeCartItem(TOKEN, 'TZP-Mix-7', 1)
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.tazzzo.test/v1/customer/cart/items/TZP-Mix-7',
    )
    fetchMock.mockClear()
    for (const bad of ['tzp-1', 'TZP-', 'TZP-1/../x', 'TZP-1?x=1']) {
      await expect(c.setCartItem(TOKEN, bad, 1, 0)).rejects.toThrow('canonical product ids only')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('response parsing', () => {
  it('maps the backend cart to the storefront model and drops what the page does not need', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(reply(200, cart()))
    const result = await c.getCart(TOKEN)
    expect(result).toEqual({
      ok: true,
      data: {
        version: 3,
        itemCount: 2,
        subtotalPaise: 99800,
        freshness: 'FRESH',
        lines: [
          {
            productId: 'TZP-1001',
            quantity: 2,
            title: 'Basmati Rice 5 kg',
            brandCode: 'TZB-1',
            imageUrl: `${MEDIA}/p1.png`,
            unitPricePaise: 49900,
            mrpPaise: 59900,
            lineTotalPaise: 99800,
            stockState: 'UNKNOWN',
            maxOrderQuantity: 0,
            serviceable: null,
            buyable: false,
            issues: ['LOCATION_REQUIRED'],
          },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/requestId|expiresAt|addedAt/)
  })

  it('keeps a line the backend could not enrich: no product, no price, PRODUCT_UNAVAILABLE', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(
      reply(
        200,
        cart({
          items: [
            item({
              product: null,
              price: null,
              lineTotalPaise: null,
              issues: ['PRODUCT_UNAVAILABLE'],
            }),
          ],
          subtotalPaise: 0,
        }),
      ),
    )
    const result = await c.getCart(TOKEN)
    expect(result.ok && result.data.lines[0]).toMatchObject({
      title: null,
      unitPricePaise: null,
      lineTotalPaise: null,
      imageUrl: null,
      issues: ['PRODUCT_UNAVAILABLE'],
    })
  })

  it('shows an image only from the media base, and turns an unknown issue code into UNRECOGNISED', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(
      reply(
        200,
        cart({
          items: [
            item({
              product: { title: 'X', imageUrl: 'https://evil.example/x.png' },
              issues: ['PRICE_CHANGED', 'SOMETHING_NEW', 'SOMETHING_ELSE'],
            }),
          ],
        }),
      ),
    )
    const result = await c.getCart(TOKEN)
    expect(result.ok && result.data.lines[0]?.imageUrl).toBeNull()
    expect(result.ok && result.data.lines[0]?.issues).toEqual(['PRICE_CHANGED', 'UNRECOGNISED'])
  })

  it('reports a body that does not match the contract as unavailable, logging only the path', async () => {
    const c = await client()
    const bad: unknown[] = [
      { ...cart(), version: -1 },
      { ...cart(), freshness: 'STALE' },
      cart({ items: [item({ skuId: 'tzp-1001' })] }),
      cart({ items: [item({ quantity: 0 })] }),
      cart({ items: [item({ availability: { stockState: 'MAYBE', maxOrderQuantity: 1 } })] }),
      cart({ items: [item({ price: { unitPricePaise: -5 } })] }),
      { items: [] },
      'not an object',
    ]
    for (const body of bad) {
      fetchMock.mockResolvedValueOnce(reply(200, body))
      expect(await c.getCart(TOKEN), JSON.stringify(body).slice(0, 40)).toEqual({
        ok: false,
        reason: 'unavailable',
        retryAfterSeconds: null,
      })
    }
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(logged).toContain('storefront_backend_malformed path=/v1/customer/cart')
    expect(logged).not.toMatch(/Basmati|AT\./)
  })
})

describe('error mapping', () => {
  const error = (status: number, code: string, headers: Record<string, string> = {}) =>
    reply(
      status,
      { code, message: 'internal detail: mongo replica-set rs0', requestId: 'req_x' },
      headers,
    )

  it('maps the backend codes to the closed set, never carrying backend text', async () => {
    const c = await client()
    const cases: Array<[Response, string]> = [
      [error(401, 'UNAUTHENTICATED'), 'unauthenticated'],
      [error(412, 'PRECONDITION_FAILED'), 'conflict'],
      [error(404, 'NOT_FOUND'), 'not_found'],
      [error(409, 'CART_ITEM_LIMIT_REACHED'), 'item_limit'],
      [error(400, 'INVALID_REQUEST'), 'bad_request'],
      [error(428, 'PRECONDITION_REQUIRED'), 'unavailable'],
      [error(415, 'UNSUPPORTED_MEDIA_TYPE'), 'unavailable'],
      [error(503, 'SERVICE_UNAVAILABLE'), 'unavailable'],
      [error(500, 'INTERNAL'), 'unavailable'],
      [reply(502), 'unavailable'],
    ]
    for (const [response, reason] of cases) {
      fetchMock.mockResolvedValueOnce(response)
      const result = await c.getCart(TOKEN)
      expect(result, reason).toMatchObject({ ok: false, reason })
      expect(JSON.stringify(result)).not.toMatch(/mongo|replica/)
    }
  })

  it('carries Retry-After on a 429 and treats a network failure as unavailable', async () => {
    const c = await client()
    fetchMock.mockResolvedValueOnce(error(429, 'RATE_LIMITED', { 'retry-after': '17' }))
    expect(await c.getCart(TOKEN)).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 17,
    })
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.9:8080'))
    expect(await c.getCart(TOKEN)).toEqual({
      ok: false,
      reason: 'unavailable',
      retryAfterSeconds: null,
    })
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/10\.0\.0\.9|ECONNREFUSED|AT\./)
  })
})
