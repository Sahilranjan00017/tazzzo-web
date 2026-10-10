import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/**
 * `/api/location*`, `/api/addresses/*` and `/api/checkout/delivery` end to end over a mocked backend `fetch` and a
 * cookie jar: CSRF, session, body grammar, what is forwarded to the backend (and what never is), error mapping, cookies.
 */
const jar = new CookieJar()
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const KEY = randomBytes(32).toString('base64')
const SITE = 'https://www.tazzzo.test'
const API = 'https://api.tazzzo.test'
const TOKEN = 'AT.' + 'x'.repeat(60)
const REFRESH = 'SES_abcdef123.' + 'r'.repeat(30)
const ADDR = 'ADDR_abcdefghij123'

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
const backendError = (status: number, code: string) =>
  reply(status, { code, message: 'secret internal detail 560001 Asha', requestId: 'req_x' })

const addressBody = (over: Record<string, unknown> = {}) => ({
  addressId: ADDR,
  label: 'HOME',
  recipientName: 'Asha Verma',
  recipientPhone: '+919876543210',
  addressLine1: '12 MG Road',
  addressLine2: null,
  landmark: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  latitude: null,
  longitude: null,
  isDefault: true,
  version: 1,
  serviceability: { serviceable: true },
  requestId: 'req_a',
  ...over,
})
const fields = {
  label: 'HOME',
  recipientName: 'Asha Verma',
  recipientPhone: '9876543210',
  addressLine1: '12 MG Road',
  addressLine2: '',
  landmark: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
}
const IDEM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab'

async function load(options: { signedIn?: boolean; customerId?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  vi.stubEnv('TAZZZO_API_BASE_URL', API)
  vi.stubEnv('TAZZZO_SITE_URL', SITE)
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  const cookies = await import('@/server/session/cookies')
  const csrf = cookies.newCsrfToken()
  if (options.signedIn !== false) {
    const now = Date.now()
    await cookies.writeSession({
      customerId: options.customerId ?? 'CUS_1',
      accessToken: TOKEN,
      accessExpiresAt: now + 900_000,
      refreshToken: REFRESH,
      csrf,
      issuedAt: now,
      expiresAt: now + 3_600_000,
    })
  }
  return {
    csrf,
    cookies,
    location: await import('@/app/api/location/route'),
    clear: await import('@/app/api/location/clear/route'),
    create: await import('@/app/api/addresses/route'),
    update: await import('@/app/api/addresses/update/route'),
    remove: await import('@/app/api/addresses/delete/route'),
    makeDefault: await import('@/app/api/addresses/default/route'),
    delivery: await import('@/app/api/checkout/delivery/route'),
    service: await import('@/server/location/service'),
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
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url.replace(API, '')}`)
const sent = (i = 0) =>
  fetchMock.mock.calls[i]![1] as RequestInit & { headers: Record<string, string> }

let logs: string[]
beforeEach(() => {
  jar.clear()
  fetchMock.mockReset()
  logs = []
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation((m) => void logs.push(String(m)))
  vi.spyOn(console, 'error').mockImplementation((m) => void logs.push(String(m)))
  vi.spyOn(console, 'log').mockImplementation((m) => void logs.push(String(m)))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const MUTATIONS = [
  ['location', '/api/location', { pin: '560001' }],
  ['clear', '/api/location/clear', {}],
  ['create', '/api/addresses', { ...fields, idempotencyKey: IDEM }],
  ['update', '/api/addresses/update', { ...fields, addressId: ADDR, version: 1 }],
  ['remove', '/api/addresses/delete', { addressId: ADDR, version: 1 }],
  ['makeDefault', '/api/addresses/default', { addressId: ADDR }],
  ['delivery', '/api/checkout/delivery', { addressId: ADDR, slotId: 'morning~2026-10-11' }],
] as const

describe('CSRF guard on every mutation (before session, body and backend)', () => {
  it('refuses a missing or wrong token, a cross-site or origin-less request', async () => {
    const r = await load()
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
      for (const [label, h] of bad) {
        const res = await r[name].POST(post(path, body, h))
        expect(res.status, `${name}: ${label}`).toBe(403)
        expect(await res.json()).toEqual({ ok: false, error: 'forbidden' })
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jar.get('__Host-tz_loc')).toBeUndefined()
  })

  it('signed out: the literal 1 is the token; session-only routes answer 401 and never call the backend', async () => {
    const r = await load({ signedIn: false })
    for (const [name, path, body] of MUTATIONS) {
      if (name === 'location' || name === 'clear') continue
      const res = await r[name].POST(post(path, body, headers('1')))
      expect(res.status, name).toBe(401)
      expect(await res.json()).toMatchObject({ ok: false, error: 'unauthenticated' })
      const forged = await r[name].POST(
        post(path, body, headers('1', { origin: 'https://evil.example' })),
      )
      expect(forged.status, `${name} forged`).toBe(403)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/location {pin}', () => {
  it('a serviceable PIN is checked with GET /v1/serviceability and stored in a sealed HttpOnly cookie, signed out too', async () => {
    const r = await load({ signedIn: false })
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        serviceable: true,
        serviceAreaId: 'SA_1',
        serviceAreaVersion: 2,
        requestId: 'r',
      }),
    )
    const res = await r.location.POST(post('/api/location', { pin: ' 560001 ' }, headers('1')))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      ok: true,
      data: { pin: '560001', serviceable: true, viaAddress: false },
    })
    expect(calls()).toEqual(['GET /v1/serviceability?pin=560001'])
    expect(sent().headers.Authorization).toBeUndefined()
    const cookie = jar.set_.get('__Host-tz_loc')!
    expect(cookie.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    expect(cookie.options).not.toHaveProperty('domain')
    expect(cookie.value).toMatch(/^v1\./)
    expect(cookie.value).not.toContain('560001')
    expect(await r.service.catalogPin()).toBe('560001')
    expect(await r.service.currentLocation(null)).toEqual({
      pin: '560001',
      serviceable: true,
      viaAddress: false,
    })
  })

  it('an unserviceable PIN is remembered as such but is NOT passed to product reads', async () => {
    const r = await load({ signedIn: false })
    fetchMock.mockResolvedValueOnce(reply(200, { serviceable: false, requestId: 'r' }))
    const res = await r.location.POST(post('/api/location', { pin: '400001' }, headers('1')))
    expect(await res.json()).toEqual({
      ok: true,
      data: { pin: '400001', serviceable: false, viaAddress: false },
    })
    expect(await r.service.catalogPin()).toBeNull()
    expect((await r.service.currentLocation(null))?.serviceable).toBe(false)
  })

  it.each(['', '56001', '5600011', '056001', 'abcdef', '56 0001', '560001; drop', '１２３４５６'])(
    'refuses the malformed PIN %j before the backend (400 invalid_pin)',
    async (pin) => {
      const r = await load({ signedIn: false })
      const res = await r.location.POST(post('/api/location', { pin }, headers('1')))
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_pin' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(jar.get('__Host-tz_loc')).toBeUndefined()
    },
  )

  it('accepts exactly one field: extra keys, non-string values and arrays are 400', async () => {
    const r = await load({ signedIn: false })
    for (const body of [
      {},
      { pin: '560001', lat: 12 },
      { pin: 560001 },
      { pin: '560001', addressId: ADDR },
      { lat: '1', lng: '2' },
      '[]',
      'null',
      '{',
    ]) {
      const res = await r.location.POST(post('/api/location', body, headers('1')))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a backend outage or garbage stores nothing and says unavailable', async () => {
    const r = await load({ signedIn: false })
    for (const answer of [
      backendError(503, 'SERVICE_UNAVAILABLE'),
      reply(200, { serviceable: 'yes' }),
      backendError(429, 'RATE_LIMITED'),
    ]) {
      fetchMock.mockResolvedValueOnce(answer)
      const res = await r.location.POST(post('/api/location', { pin: '560001' }, headers('1')))
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ ok: false, error: 'unavailable' })
    }
    expect(jar.get('__Host-tz_loc')).toBeUndefined()
  })

  it('a new PIN replaces a saved-address location; clear forgets it', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(200, addressBody()))
    await r.location.POST(post('/api/location', { addressId: ADDR }, headers(r.csrf)))
    expect(await r.service.cartAddressId(await r.cookies.readSession())).toBe(ADDR)
    fetchMock.mockResolvedValueOnce(reply(200, { serviceable: true }))
    await r.location.POST(post('/api/location', { pin: '110001' }, headers(r.csrf)))
    expect(await r.service.cartAddressId(await r.cookies.readSession())).toBeNull()
    const res = await r.clear.POST(post('/api/location/clear', {}, headers(r.csrf)))
    expect(res.status).toBe(200)
    expect(await r.cookies.readLocation()).toBeNull()
    expect(
      (await r.clear.POST(post('/api/location/clear', { x: 1 }, headers(r.csrf)))).status,
    ).toBe(400)
  })
})

describe('POST /api/location {addressId}', () => {
  it('uses the saved address (scoped by the backend), keeps only id + customer + PIN, never the street', async () => {
    const r = await load({ customerId: 'CUS_1' })
    fetchMock.mockResolvedValueOnce(reply(200, addressBody()))
    const res = await r.location.POST(post('/api/location', { addressId: ADDR }, headers(r.csrf)))
    expect(await res.json()).toEqual({
      ok: true,
      data: { pin: '560001', serviceable: true, viaAddress: true },
    })
    expect(calls()).toEqual([`GET /v1/customer/addresses/${ADDR}`])
    expect(sent().headers.Authorization).toBe(`Bearer ${TOKEN}`)
    const stored = await r.cookies.readLocation()
    expect(stored).toMatchObject({
      pin: '560001',
      serviceable: true,
      addressId: ADDR,
      customerId: 'CUS_1',
    })
    expect(JSON.stringify(stored)).not.toMatch(/Asha|MG Road|9876/)
    const session = await r.cookies.readSession()
    expect(await r.service.cartAddressId(session)).toBe(ADDR)
    // another customer in the same browser, or nobody: the address id is not honoured
    expect(await r.service.cartAddressId({ ...session!, customerId: 'CUS_2' })).toBeNull()
    expect(await r.service.cartAddressId(null)).toBeNull()
    expect(
      (await r.service.currentLocation({ ...session!, customerId: 'CUS_2' }))?.viaAddress,
    ).toBe(false)
  })

  it("another customer's id is the backend's 404 and nothing is stored", async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(backendError(404, 'NOT_FOUND'))
    const res = await r.location.POST(
      post('/api/location', { addressId: 'ADDR_someoneelse1' }, headers(r.csrf)),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'not_found' })
    expect(jar.get('__Host-tz_loc')).toBeUndefined()
  })

  it('a malformed id is refused here (no backend call); signed out is 401', async () => {
    const r = await load()
    const res = await r.location.POST(
      post('/api/location', { addressId: '../../customer/profile' }, headers(r.csrf)),
    )
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    jar.clear()
    const out = await load({ signedIn: false })
    const anon = await out.location.POST(post('/api/location', { addressId: ADDR }, headers('1')))
    expect(anon.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an unknown serviceability (null) is kept as unknown, not as unserviceable', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(
      reply(200, addressBody({ serviceability: { serviceable: null } })),
    )
    const res = await r.location.POST(post('/api/location', { addressId: ADDR }, headers(r.csrf)))
    expect((await res.json()).data.serviceable).toBeNull()
    expect(await r.service.catalogPin()).toBeNull()
  })
})

describe('address mutations', () => {
  it('create: forwards the nine fields + Idempotency-Key, no customer id, empty optionals left out; 201', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(201, addressBody()))
    const res = await r.create.POST(
      post('/api/addresses', { ...fields, idempotencyKey: IDEM }, headers(r.csrf)),
    )
    expect(res.status).toBe(201)
    expect((await res.json()).data).toMatchObject({
      addressId: ADDR,
      label: 'HOME',
      serviceable: true,
      isDefault: true,
    })
    expect(calls()).toEqual(['POST /v1/customer/addresses'])
    const init = sent()
    expect(init.headers['Idempotency-Key']).toBe(IDEM)
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(init.body))).toEqual({
      label: 'HOME',
      recipientName: 'Asha Verma',
      recipientPhone: '+919876543210',
      addressLine1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
    })
  })

  it('refuses client-supplied user ids and every unlisted field without calling the backend', async () => {
    const r = await load()
    for (const extra of [
      { customerId: 'CUS_victim' },
      { userId: 'CUS_victim' },
      { ownerId: 'x' },
      { latitude: 1, longitude: 2 },
      { isDefault: true },
      { version: 1 },
    ]) {
      const res = await r.create.POST(
        post('/api/addresses', { ...fields, idempotencyKey: IDEM, ...extra }, headers(r.csrf)),
      )
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
    for (const extra of [{ customerId: 'CUS_victim' }, { userId: 'x' }]) {
      expect(
        (
          await r.update.POST(
            post(
              '/api/addresses/update',
              { ...fields, addressId: ADDR, version: 1, ...extra },
              headers(r.csrf),
            ),
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await r.remove.POST(
            post(
              '/api/addresses/delete',
              { addressId: ADDR, version: 1, ...extra },
              headers(r.csrf),
            ),
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await r.makeDefault.POST(
            post('/api/addresses/default', { addressId: ADDR, ...extra }, headers(r.csrf)),
          )
        ).status,
      ).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses invalid fields, ids and versions before the backend (400)', async () => {
    const r = await load()
    const bad = [
      { ...fields, postalCode: '056001' },
      { ...fields, recipientPhone: '12345' },
      { ...fields, label: 'home' },
      { ...fields, recipientName: 'x'.repeat(81) },
      { ...fields, city: 'a\u0000b' },
      { ...fields, state: '' },
    ]
    for (const b of bad) {
      expect(
        (
          await r.create.POST(
            post('/api/addresses', { ...b, idempotencyKey: IDEM }, headers(r.csrf)),
          )
        ).status,
      ).toBe(400)
    }
    expect(
      (
        await r.create.POST(
          post('/api/addresses', { ...fields, idempotencyKey: 'x' }, headers(r.csrf)),
        )
      ).status,
    ).toBe(400)
    for (const addressId of [
      'addr_abcdefghij',
      'ADDR_x',
      '../x',
      `ADDR_${'a'.repeat(70)}`,
      'ADDR_abc def1',
    ]) {
      expect(
        (
          await r.remove.POST(
            post('/api/addresses/delete', { addressId, version: 1 }, headers(r.csrf)),
          )
        ).status,
        addressId,
      ).toBe(400)
      expect(
        (await r.makeDefault.POST(post('/api/addresses/default', { addressId }, headers(r.csrf))))
          .status,
        addressId,
      ).toBe(400)
    }
    for (const version of [-1, 1.5, '1', null, 10 ** 15]) {
      expect(
        (
          await r.remove.POST(
            post('/api/addresses/delete', { addressId: ADDR, version }, headers(r.csrf)),
          )
        ).status,
        String(version),
      ).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts a body above 2 KiB up to the address cap, refuses beyond it (413)', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(201, addressBody()))
    const long = {
      ...fields,
      recipientName: '😀'.repeat(80),
      addressLine1: '😀'.repeat(160),
      addressLine2: '😀'.repeat(160),
      landmark: '😀'.repeat(120),
      idempotencyKey: IDEM,
    }
    expect(JSON.stringify(long).length).toBeGreaterThan(600)
    expect(Buffer.byteLength(JSON.stringify(long))).toBeGreaterThan(2048)
    expect((await r.create.POST(post('/api/addresses', long, headers(r.csrf)))).status).toBe(201)
    const huge = { ...long, recipientName: 'x'.repeat(9000) }
    expect((await r.create.POST(post('/api/addresses', huge, headers(r.csrf)))).status).toBe(413)
  })

  it('update sends PATCH with If-Match "address-<version>" and every field (emptied optionals as null)', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(200, addressBody({ version: 5 })))
    const res = await r.update.POST(
      post('/api/addresses/update', { ...fields, addressId: ADDR, version: 4 }, headers(r.csrf)),
    )
    expect(res.status).toBe(200)
    expect(calls()).toEqual([`PATCH /v1/customer/addresses/${ADDR}`])
    expect(sent().headers['If-Match']).toBe('"address-4"')
    expect(JSON.parse(String(sent().body))).toMatchObject({
      addressLine2: null,
      landmark: null,
      recipientPhone: '+919876543210',
    })
    expect(JSON.parse(String(sent().body))).not.toHaveProperty('addressId')
  })

  it('editing the address that is the delivery location moves the stored PIN; deleting it forgets the address, keeps the PIN', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(200, addressBody()))
    await r.location.POST(post('/api/location', { addressId: ADDR }, headers(r.csrf)))
    fetchMock.mockResolvedValueOnce(
      reply(
        200,
        addressBody({ postalCode: '400001', version: 2, serviceability: { serviceable: false } }),
      ),
    )
    await r.update.POST(
      post(
        '/api/addresses/update',
        { ...fields, postalCode: '400001', addressId: ADDR, version: 1 },
        headers(r.csrf),
      ),
    )
    expect(await r.cookies.readLocation()).toMatchObject({
      pin: '400001',
      serviceable: false,
      addressId: ADDR,
    })
    fetchMock.mockResolvedValueOnce(reply(204))
    const gone = await r.remove.POST(
      post('/api/addresses/delete', { addressId: ADDR, version: 2 }, headers(r.csrf)),
    )
    expect(gone.status).toBe(200)
    expect(fetchMock.mock.calls.at(-1)![1]!.method).toBe('DELETE')
    expect(await r.cookies.readLocation()).toMatchObject({ pin: '400001', serviceable: false })
    expect((await r.cookies.readLocation())?.addressId).toBeUndefined()
  })

  it('set default sends PUT .../default', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(200, addressBody()))
    expect(
      (
        await r.makeDefault.POST(
          post('/api/addresses/default', { addressId: ADDR }, headers(r.csrf)),
        )
      ).status,
    ).toBe(200)
    expect(calls()).toEqual([`PUT /v1/customer/addresses/${ADDR}/default`])
  })

  it.each([
    [404, 'NOT_FOUND', 404, 'not_found'],
    [412, 'PRECONDITION_FAILED', 409, 'conflict'],
    [409, 'ADDRESS_LIMIT_REACHED', 409, 'limit_reached'],
    [409, 'IDEMPOTENCY_CONFLICT', 409, 'idempotency_conflict'],
    [400, 'INVALID_REQUEST', 400, 'bad_request'],
    [428, 'PRECONDITION_REQUIRED', 503, 'unavailable'],
    [500, 'INTERNAL', 503, 'unavailable'],
    [503, 'SERVICE_UNAVAILABLE', 503, 'unavailable'],
  ])(
    'maps the backend %s %s to a closed code and never leaks its text',
    async (status, code, expectStatus, expectError) => {
      const r = await load()
      fetchMock.mockResolvedValueOnce(backendError(status, code))
      const res = await r.create.POST(
        post('/api/addresses', { ...fields, idempotencyKey: IDEM }, headers(r.csrf)),
      )
      expect(res.status).toBe(expectStatus)
      const body = await res.json()
      expect(body).toMatchObject({ ok: false, error: expectError })
      expect(JSON.stringify(body)).not.toMatch(/secret|Asha|560001/)
    },
  )

  it('429 passes Retry-After; a malformed 200 body is unavailable', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(429, { code: 'RATE_LIMITED' }, { 'retry-after': '17' }))
    const res = await r.makeDefault.POST(
      post('/api/addresses/default', { addressId: ADDR }, headers(r.csrf)),
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('17')
    fetchMock.mockResolvedValueOnce(reply(200, { addressId: ADDR, label: 'HOME' }))
    const bad = await r.makeDefault.POST(
      post('/api/addresses/default', { addressId: ADDR }, headers(r.csrf)),
    )
    expect(bad.status).toBe(503)
  })

  it('logs no personal data or address ids, only route labels', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(backendError(404, 'NOT_FOUND'))
    await r.remove.POST(
      post('/api/addresses/delete', { addressId: ADDR, version: 1 }, headers(r.csrf)),
    )
    fetchMock.mockResolvedValueOnce(reply(200, { nope: true }))
    await r.update.POST(
      post('/api/addresses/update', { ...fields, addressId: ADDR, version: 1 }, headers(r.csrf)),
    )
    const all = logs.join('\n')
    expect(all).toContain('storefront_backend_error')
    expect(all).not.toMatch(/ADDR_|Asha|MG Road|9876|560001|secret/)
  })

  it('a refused access token is rotated once and the call repeated', async () => {
    const r = await load()
    fetchMock
      .mockResolvedValueOnce(backendError(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(
        reply(200, {
          accessToken: 'AT.' + 'n'.repeat(60),
          accessTokenExpiresIn: 900,
          refreshToken: 'SES_abcdef123.' + 'q'.repeat(30),
        }),
      )
      .mockResolvedValueOnce(reply(200, addressBody()))
    const res = await r.makeDefault.POST(
      post('/api/addresses/default', { addressId: ADDR }, headers(r.csrf)),
    )
    expect(res.status).toBe(200)
    expect(calls()).toEqual([
      `PUT /v1/customer/addresses/${ADDR}/default`,
      'POST /v1/auth/refresh',
      `PUT /v1/customer/addresses/${ADDR}/default`,
    ])
  })
})

describe('POST /api/checkout/delivery', () => {
  const SLOT = 'morning~2026-10-11'
  const slots = (status: string, serviceable = true) =>
    reply(200, {
      serviceable,
      timezone: 'Asia/Kolkata',
      requestId: 'r',
      slots: [
        {
          slotId: SLOT,
          date: '2026-10-11',
          startsAt: '2026-10-11T09:00:00+05:30',
          endsAt: '2026-10-11T11:00:00+05:30',
          label: 'Morning',
          status,
        },
      ],
    })

  it('checks the address (owned, serviceable) and the slot (offered, AVAILABLE) with the backend, then keeps the choice sealed', async () => {
    const r = await load({ customerId: 'CUS_1' })
    fetchMock
      .mockResolvedValueOnce(reply(200, addressBody()))
      .mockResolvedValueOnce(slots('AVAILABLE'))
    const res = await r.delivery.POST(
      post('/api/checkout/delivery', { addressId: ADDR, slotId: SLOT }, headers(r.csrf)),
    )
    expect(res.status).toBe(200)
    expect(calls()).toEqual([
      `GET /v1/customer/addresses/${ADDR}`,
      'GET /v1/customer/delivery/slots?pin=560001',
    ])
    expect(await r.cookies.readCheckoutChoice()).toMatchObject({
      customerId: 'CUS_1',
      addressId: ADDR,
      slotId: SLOT,
    })
    expect(jar.set_.get('__Host-tz_checkout')!.options).toMatchObject({
      httpOnly: true,
      secure: true,
      maxAge: 1800,
    })
  })

  it.each(['FULL', 'CLOSED', 'WEIRD'])(
    'a %s slot is refused (409 slot_unavailable) and nothing is kept',
    async (status) => {
      const r = await load()
      fetchMock
        .mockResolvedValueOnce(reply(200, addressBody()))
        .mockResolvedValueOnce(slots(status))
      const res = await r.delivery.POST(
        post('/api/checkout/delivery', { addressId: ADDR, slotId: SLOT }, headers(r.csrf)),
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'slot_unavailable' })
      expect(jar.get('__Host-tz_checkout')).toBeUndefined()
    },
  )

  it('a slot the backend does not offer for that PIN, an unserviceable address and a foreign address are refused', async () => {
    const r = await load()
    fetchMock
      .mockResolvedValueOnce(reply(200, addressBody()))
      .mockResolvedValueOnce(slots('AVAILABLE'))
    const other = await r.delivery.POST(
      post(
        '/api/checkout/delivery',
        { addressId: ADDR, slotId: 'evening~2026-10-11' },
        headers(r.csrf),
      ),
    )
    expect(other.status).toBe(409)
    fetchMock.mockResolvedValueOnce(
      reply(200, addressBody({ serviceability: { serviceable: false } })),
    )
    const no = await r.delivery.POST(
      post('/api/checkout/delivery', { addressId: ADDR, slotId: SLOT }, headers(r.csrf)),
    )
    expect(no.status).toBe(422)
    expect(await no.json()).toMatchObject({ error: 'unserviceable' })
    fetchMock.mockResolvedValueOnce(backendError(404, 'NOT_FOUND'))
    const foreign = await r.delivery.POST(
      post(
        '/api/checkout/delivery',
        { addressId: 'ADDR_someoneelse1', slotId: SLOT },
        headers(r.csrf),
      ),
    )
    expect(foreign.status).toBe(404)
    expect(jar.get('__Host-tz_checkout')).toBeUndefined()
  })

  it('exact fields and grammar only', async () => {
    const r = await load()
    for (const body of [
      { addressId: ADDR },
      { slotId: SLOT },
      { addressId: ADDR, slotId: SLOT, customerId: 'x' },
      { addressId: ADDR, slotId: 'Morning~2026-10-11' },
      { addressId: 'nope', slotId: SLOT },
    ]) {
      expect(
        (await r.delivery.POST(post('/api/checkout/delivery', body, headers(r.csrf)))).status,
        JSON.stringify(body),
      ).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the choice is bound to the customer, expires, and dies with sign-out and with the address', async () => {
    const r = await load({ customerId: 'CUS_1' })
    fetchMock
      .mockResolvedValueOnce(reply(200, addressBody()))
      .mockResolvedValueOnce(slots('AVAILABLE'))
    await r.delivery.POST(
      post('/api/checkout/delivery', { addressId: ADDR, slotId: SLOT }, headers(r.csrf)),
    )
    expect(await r.cookies.readCheckoutChoice(Date.now() + 31 * 60_000)).toBeNull()
    fetchMock.mockResolvedValueOnce(reply(204))
    await r.remove.POST(
      post('/api/addresses/delete', { addressId: ADDR, version: 1 }, headers(r.csrf)),
    )
    expect(await r.cookies.readCheckoutChoice()).toBeNull()
  })
})

describe('sign-out', () => {
  it('forgets the saved address and the order-step choice, keeps the browser PIN', async () => {
    const r = await load()
    fetchMock.mockResolvedValueOnce(reply(200, addressBody()))
    await r.location.POST(post('/api/location', { addressId: ADDR }, headers(r.csrf)))
    await r.cookies.writeCheckoutChoice({
      customerId: 'CUS_1',
      addressId: ADDR,
      slotId: 'morning~2026-10-11',
    })
    const { signOut } = await import('@/server/session/service')
    fetchMock.mockResolvedValueOnce(reply(204))
    await signOut(await r.cookies.readSession())
    expect(await r.cookies.readCheckoutChoice()).toBeNull()
    const loc = await r.cookies.readLocation()
    expect(loc).toMatchObject({ pin: '560001' })
    expect(loc?.addressId).toBeUndefined()
  })
})
