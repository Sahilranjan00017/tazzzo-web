import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/** The `/api/cart/*` route handlers end to end over a mocked backend `fetch` and a cookie jar. */
const jar = new CookieJar()
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const KEY = randomBytes(32).toString('base64')
const SITE = 'https://www.tazzzo.test'
const TOKEN = 'AT.' + 'x'.repeat(60)
const REFRESH = 'SES_abcdef123.' + 'r'.repeat(30)
const TOKEN_2 = 'AT.' + 'y'.repeat(60)
const REFRESH_2 = 'SES_abcdef123.' + 's'.repeat(30)

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

const line = (sku: string, quantity: number) => ({
  skuId: sku,
  quantity,
  product: { title: `Item ${sku}`, brandCode: null, imageUrl: null },
  price: { unitPricePaise: 1000, mrpPaise: 1000, currency: 'INR' },
  availability: { stockState: 'UNKNOWN', maxOrderQuantity: 0, serviceable: null },
  lineTotalPaise: 1000 * quantity,
  buyable: false,
  issues: ['LOCATION_REQUIRED'],
})
const cart = (version: number, lines: Array<[string, number]> = []) => ({
  version,
  items: lines.map(([sku, q]) => line(sku, q)),
  itemCount: lines.reduce((n, [, q]) => n + q, 0),
  distinctItemCount: lines.length,
  subtotalPaise: lines.reduce((n, [, q]) => n + 1000 * q, 0),
  freshness: 'FRESH',
})
const backendError = (status: number, code: string) =>
  reply(status, { code, message: 'secret internal detail', requestId: 'req_x' })

async function routes(options: { accessExpiresInMs?: number } = {}) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true') // required in production
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', SITE)
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  const cookies = await import('@/server/session/cookies')
  const csrf = cookies.newCsrfToken()
  const now = Date.now()
  await cookies.writeSession({
    customerId: 'CUS_1',
    accessToken: TOKEN,
    accessExpiresAt: now + (options.accessExpiresInMs ?? 900_000),
    refreshToken: REFRESH,
    csrf,
    issuedAt: now,
    expiresAt: now + 3_600_000,
  })
  return {
    csrf,
    get: await import('@/app/api/cart/route'),
    add: await import('@/app/api/cart/add/route'),
    update: await import('@/app/api/cart/update/route'),
    remove: await import('@/app/api/cart/remove/route'),
    clear: await import('@/app/api/cart/clear/route'),
  }
}

const headers = (csrf: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-tazzzo-csrf': csrf,
  origin: SITE,
  host: 'www.tazzzo.test',
  'sec-fetch-site': 'same-origin',
  ...extra,
})
const without = (h: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => k !== key))
const post = (path: string, body: unknown, h: Record<string, string>) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const backendCalls = () =>
  fetchMock.mock.calls.map(
    ([url, init]) => `${init?.method} ${url.replace('https://api.tazzzo.test', '')}`,
  )

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

const MUTATIONS = [
  ['add', '/api/cart/add', { productId: 'TZP-1001', quantity: 1 }],
  ['update', '/api/cart/update', { productId: 'TZP-1001', quantity: 2, version: 1 }],
  ['remove', '/api/cart/remove', { productId: 'TZP-1001', version: 1 }],
  ['clear', '/api/cart/clear', { version: 1 }],
] as const

describe('CSRF and session guard on every mutation', () => {
  it('refuses a missing or wrong token, a cross-site or origin-less request, before the backend is touched', async () => {
    const r = await routes()
    for (const [name, path, body] of MUTATIONS) {
      const bad: Array<[string, Record<string, string>]> = [
        ['no csrf header', without(headers(r.csrf), 'x-tazzzo-csrf')],
        ['literal 1 (pre-login token)', headers('1')],
        ['wrong token', headers('x'.repeat(43))],
        ['cross-site fetch', headers(r.csrf, { 'sec-fetch-site': 'cross-site' })],
        ['same-site sibling', headers(r.csrf, { 'sec-fetch-site': 'same-site' })],
        ['foreign origin', headers(r.csrf, { origin: 'https://evil.example' })],
        ['no origin', without(headers(r.csrf), 'origin')],
      ]
      for (const [label, h] of bad) {
        const response = await r[name].POST(post(path, body, h))
        expect(response.status, `${name}: ${label}`).toBe(403)
        expect(await response.json()).toEqual({ ok: false, error: 'forbidden' })
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 401 without a session (after the CSRF rule), and never calls the backend', async () => {
    const r = await routes()
    jar.clear()
    for (const [name, path, body] of MUTATIONS) {
      const ok = await r[name].POST(post(path, body, headers('1')))
      expect(ok.status, name).toBe(401)
      expect(await ok.json()).toMatchObject({ ok: false, error: 'unauthenticated' })
      const forged = await r[name].POST(
        post(path, body, headers('1', { origin: 'https://evil.example' })),
      )
      expect(forged.status, name).toBe(403)
    }
    const read = await r.get.GET()
    expect(read.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves only POST on the mutation routes (no GET/PUT/DELETE handler exists)', async () => {
    const r = await routes()
    for (const route of [r.add, r.update, r.remove, r.clear]) {
      expect(Object.keys(route).filter((k) => /^(GET|PUT|DELETE|PATCH)$/.test(k))).toEqual([])
    }
  })
})

describe('input validation', () => {
  it('refuses malformed JSON, wrong content types, non-objects with 400 and oversized bodies with 413', async () => {
    const r = await routes()
    const cases: Array<[unknown, Record<string, string>]> = [
      ['{not json', headers(r.csrf)],
      ['[]', headers(r.csrf)],
      ['"TZP-1"', headers(r.csrf)],
      [{ productId: 'TZP-1001', quantity: 1 }, headers(r.csrf, { 'content-type': 'text/plain' })],
    ]
    for (const [body, h] of cases) {
      const response = await r.add.POST(post('/api/cart/add', body as string, h))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, error: 'bad_request' })
    }
    const big = await r.add.POST(
      post(
        '/api/cart/add',
        { productId: 'TZP-1001', quantity: 1, pad: 'x'.repeat(5000) },
        headers(r.csrf),
      ),
    )
    expect(big.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the canonical product id: lowercase and other non-canonical ids are refused, never upper-cased', async () => {
    const r = await routes()
    for (const productId of [
      'tzp-1',
      'Tzp-1001',
      'TZP-',
      'TZP-1/x',
      'TZP-' + 'A'.repeat(41),
      ' TZP-1',
      'x',
    ]) {
      const response = await r.add.POST(
        post('/api/cart/add', { productId, quantity: 1 }, headers(r.csrf)),
      )
      expect(response.status, productId).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces quantity 1..20 and a sane version, on add and update', async () => {
    const r = await routes()
    for (const quantity of [0, -1, 21, 1.5, '2', null, 1e9]) {
      const a = await r.add.POST(
        post('/api/cart/add', { productId: 'TZP-1001', quantity }, headers(r.csrf)),
      )
      const u = await r.update.POST(
        post('/api/cart/update', { productId: 'TZP-1001', quantity, version: 1 }, headers(r.csrf)),
      )
      expect([a.status, u.status], String(quantity)).toEqual([400, 400])
    }
    for (const version of [-1, 1.5, '1', null, 1e15]) {
      const response = await r.clear.POST(post('/api/cart/clear', { version }, headers(r.csrf)))
      expect(response.status, String(version)).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses extra fields, so no price, customer or cart id can be smuggled to the backend', async () => {
    const r = await routes()
    const response = await r.add.POST(
      post(
        '/api/cart/add',
        { productId: 'TZP-1001', quantity: 1, unitPricePaise: 1 },
        headers(r.csrf),
      ),
    )
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('flows', () => {
  it('GET /api/cart returns the cart, no-store, with no token or backend id in it', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(
      reply(200, { ...cart(2, [['TZP-1001', 2]]), requestId: 'req_secret' }),
    )
    const response = await r.get.GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ ok: true, cart: { version: 2, itemCount: 2 } })
    expect(text).not.toMatch(/AT\.|SES_|req_secret|CUS_1/)
    expect(backendCalls()).toEqual(['GET /v1/customer/cart'])
  })

  it('add reads the cart, then sets the SUM under the version it read', async () => {
    const r = await routes()
    fetchMock
      .mockResolvedValueOnce(reply(200, cart(4, [['TZP-1001', 2]])))
      .mockResolvedValueOnce(reply(200, cart(5, [['TZP-1001', 5]])))
    const response = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-1001', quantity: 3 }, headers(r.csrf)),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, cart: { version: 5 } })
    expect(backendCalls()).toEqual([
      'GET /v1/customer/cart',
      'PUT /v1/customer/cart/items/TZP-1001',
    ])
    const put = fetchMock.mock.calls[1]![1]!
    expect((put.headers as Record<string, string>)['If-Match']).toBe('"cart-4"')
    expect(put.body).toBe('{"quantity":5}')
    expect((put.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('add refuses (does not clamp) past 20 of one item and returns the cart it saw', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(reply(200, cart(4, [['TZP-1001', 19]])))
    const response = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-1001', quantity: 2 }, headers(r.csrf)),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'quantity_limit',
      cart: { version: 4 },
    })
    expect(backendCalls()).toEqual(['GET /v1/customer/cart'])
  })

  it('add retries once after losing a version race, and gives up after a second', async () => {
    const r = await routes()
    fetchMock
      .mockResolvedValueOnce(reply(200, cart(4)))
      .mockResolvedValueOnce(backendError(412, 'PRECONDITION_FAILED'))
      .mockResolvedValueOnce(reply(200, cart(5, [['TZP-2', 1]])))
      .mockResolvedValueOnce(
        reply(
          200,
          cart(6, [
            ['TZP-2', 1],
            ['TZP-1001', 1],
          ]),
        ),
      )
    const ok = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-1001', quantity: 1 }, headers(r.csrf)),
    )
    expect(ok.status).toBe(200)
    expect(backendCalls()).toHaveLength(4)

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(reply(200, cart(4)))
      .mockResolvedValueOnce(backendError(412, 'PRECONDITION_FAILED'))
      .mockResolvedValueOnce(reply(200, cart(5)))
      .mockResolvedValueOnce(backendError(412, 'PRECONDITION_FAILED'))
    const lost = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-1001', quantity: 1 }, headers(r.csrf)),
    )
    expect(lost.status).toBe(409)
    expect(await lost.json()).toMatchObject({ ok: false, error: 'conflict' })
    expect(backendCalls()).toHaveLength(4)
  })

  it('add maps the item limit and an unknown product to safe codes', async () => {
    const r = await routes()
    const many = Array.from({ length: 50 }, (_, i): [string, number] => [`TZP-${i}`, 1])
    fetchMock.mockResolvedValueOnce(reply(200, cart(9, many)))
    const full = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-1001', quantity: 1 }, headers(r.csrf)),
    )
    expect(full.status).toBe(422)
    expect(await full.json()).toMatchObject({ error: 'item_limit' })

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(reply(200, cart(1)))
      .mockResolvedValueOnce(backendError(404, 'NOT_FOUND'))
    const hidden = await r.add.POST(
      post('/api/cart/add', { productId: 'TZP-9999', quantity: 1 }, headers(r.csrf)),
    )
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('update presents the version the screen showed; a stale one answers 409 with the fresh cart', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(reply(200, cart(8, [['TZP-1001', 3]])))
    const ok = await r.update.POST(
      post('/api/cart/update', { productId: 'TZP-1001', quantity: 3, version: 7 }, headers(r.csrf)),
    )
    expect(ok.status).toBe(200)
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['If-Match']).toBe(
      '"cart-7"',
    )

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(backendError(412, 'PRECONDITION_FAILED'))
      .mockResolvedValueOnce(reply(200, cart(9, [['TZP-1001', 6]])))
    const stale = await r.update.POST(
      post('/api/cart/update', { productId: 'TZP-1001', quantity: 4, version: 7 }, headers(r.csrf)),
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: 'conflict',
      cart: { version: 9, itemCount: 6 },
    })
    expect(backendCalls()).toEqual([
      'PUT /v1/customer/cart/items/TZP-1001',
      'GET /v1/customer/cart',
    ])
  })

  it('remove: DELETE with If-Match; a line already gone is success; a stale version is a conflict', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(reply(200, cart(3)))
    const removed = await r.remove.POST(
      post('/api/cart/remove', { productId: 'TZP-1001', version: 2 }, headers(r.csrf)),
    )
    expect(removed.status).toBe(200)
    expect(backendCalls()).toEqual(['DELETE /v1/customer/cart/items/TZP-1001'])

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(backendError(404, 'NOT_FOUND'))
      .mockResolvedValueOnce(reply(200, cart(4)))
    const gone = await r.remove.POST(
      post('/api/cart/remove', { productId: 'TZP-1001', version: 3 }, headers(r.csrf)),
    )
    expect(gone.status).toBe(200)
    expect(await gone.json()).toMatchObject({ ok: true, cart: { version: 4 } })

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(backendError(412, 'PRECONDITION_FAILED'))
      .mockResolvedValueOnce(reply(200, cart(6, [['TZP-1001', 1]])))
    const stale = await r.remove.POST(
      post('/api/cart/remove', { productId: 'TZP-1001', version: 3 }, headers(r.csrf)),
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'conflict', cart: { version: 6 } })
  })

  it('clear: DELETE /v1/customer/cart under the version', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(reply(200, cart(5)))
    const response = await r.clear.POST(post('/api/cart/clear', { version: 4 }, headers(r.csrf)))
    expect(response.status).toBe(200)
    expect(backendCalls()).toEqual(['DELETE /v1/customer/cart'])
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['If-Match']).toBe(
      '"cart-4"',
    )
  })

  it('maps outages and rate limits to safe messages without backend text, internals or tokens', async () => {
    const r = await routes()
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.1.2.3:8080'))
    const down = await r.get.GET()
    expect(down.status).toBe(503)
    fetchMock.mockResolvedValueOnce(
      reply(429, { code: 'RATE_LIMITED', message: 'x' }, { 'retry-after': '30' }),
    )
    const limited = await r.get.GET()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('30')
    fetchMock.mockResolvedValueOnce(backendError(500, 'INTERNAL'))
    const broken = await r.get.GET()
    expect(broken.status).toBe(503)
    for (const response of [down, limited, broken]) {
      expect(JSON.stringify(await response.json())).not.toMatch(
        /ECONNREFUSED|10\.1\.2\.3|secret internal|AT\.|SES_/,
      )
    }
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/AT\.|SES_|secret internal|ECONNREFUSED|CUS_1/)
  })
})

describe('session handling', () => {
  it('rotates an expired access token first, rewrites the cookie, and uses the new token', async () => {
    const r = await routes({ accessExpiresInMs: 5_000 }) // inside the 30 s safety margin
    const before = jar.get('__Host-tz_session')!.value
    fetchMock
      .mockResolvedValueOnce(
        reply(200, { accessToken: TOKEN_2, accessTokenExpiresIn: 900, refreshToken: REFRESH_2 }),
      )
      .mockResolvedValueOnce(reply(200, cart(1)))
    const response = await r.get.GET()
    expect(response.status).toBe(200)
    expect(backendCalls()).toEqual(['POST /v1/auth/refresh', 'GET /v1/customer/cart'])
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN_2}`,
    )
    expect(jar.get('__Host-tz_session')!.value).not.toBe(before)
  })

  it('a token the backend refuses is rotated once and the call repeated; a dead session is cleared and reported', async () => {
    const r = await routes()
    fetchMock
      .mockResolvedValueOnce(backendError(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(
        reply(200, { accessToken: TOKEN_2, accessTokenExpiresIn: 900, refreshToken: REFRESH_2 }),
      )
      .mockResolvedValueOnce(reply(200, cart(1)))
    expect((await r.get.GET()).status).toBe(200)
    expect(backendCalls()).toEqual([
      'GET /v1/customer/cart',
      'POST /v1/auth/refresh',
      'GET /v1/customer/cart',
    ])

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(backendError(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(backendError(401, 'UNAUTHENTICATED'))
    const dead = await r.get.GET()
    expect(dead.status).toBe(401)
    expect(await dead.json()).toMatchObject({ error: 'unauthenticated' })
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })
})
