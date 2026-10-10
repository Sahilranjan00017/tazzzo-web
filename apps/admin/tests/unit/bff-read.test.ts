import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

/** The BFF READ and DOWNLOAD layers: CSRF header, session, closed outcome mapping, nothing of the backend body leaks. */
const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })

let read: typeof import('@/server/bff/read')
let download: typeof import('@/server/bff/download')
let session: typeof import('@/server/session/session')
let store: MemoryStore
let sessionId: string
let calls: { url: string; init: RequestInit }[]

beforeAll(async () => {
  Object.assign(process.env, {
    CMS_BASE_URL: BASE,
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_HOSTED_DOMAIN: 'tazzzo.test',
    TAZZZO_BACKEND_URL: BACKEND,
    SESSION_STORE_URL: 'redis://127.0.0.1:6379',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  })
  read = await import('@/server/bff/read')
  download = await import('@/server/bff/download')
  session = await import('@/server/session/session')
})

beforeEach(async () => {
  store = new MemoryStore()
  calls = []
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const config = (await import('@/server/session/config')).sessionConfig(
    (await import('@/server/env')).serverEnv(),
  )
  sessionId = (await session.createSession(
    store,
    TOKEN,
    Math.floor(Date.now() / 1000) + 3600,
    config,
    Date.now(),
  ))!.sessionId
})
afterEach(() => vi.restoreAllMocks())

const upstream = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_0123456789abcdef0123',
        ...headers,
      },
    })
  }) as typeof fetch

function get(
  headers: Record<string, string> = {},
  cookie: string | null = `${COOKIE}=${sessionId}`,
) {
  return new NextRequest(`${BASE}/api/bff/x`, {
    method: 'GET',
    headers: { 'x-tazzzo-csrf': '1', ...(cookie ? { cookie } : {}), ...headers },
  })
}

const schema = z.object({ items: z.array(z.string()), nextCursor: z.string().nullish() })
const spec = {
  routeId: 'test.read',
  path: '/api/v1/admin/inventory?limit=50',
  output: schema,
  toClient: (v: z.infer<typeof schema>) => v,
}
const run = (request: NextRequest, fetchImpl: typeof fetch) =>
  read.runBffRead(spec, request, { store, fetchImpl, now: Date.now })

describe('runBffRead', () => {
  it('reads as the human with only the bearer, no cookie forwarded, and answers no-store JSON', async () => {
    const res = await run(get(), upstream(200, { items: ['a'], nextCursor: 'c1' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      data: unknown
      correlationId: string
      backendRequestId: string
    }
    expect(body.data).toEqual({ items: ['a'], nextCursor: 'c1' })
    expect(body.backendRequestId).toBe('req_0123456789abcdef0123')
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/inventory?limit=50`)
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' })
    expect(calls[0]!.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
    })
  })

  it('needs the CSRF header; an Origin, when present, must be the CMS origin; a missing Origin is fine for a GET', async () => {
    expect((await run(get({ 'x-tazzzo-csrf': '0' }), upstream(200, { items: [] }))).status).toBe(
      403,
    )
    expect(
      (await run(get({ origin: 'https://evil.example' }), upstream(200, { items: [] }))).status,
    ).toBe(403)
    expect((await run(get({ origin: BASE }), upstream(200, { items: [] }))).status).toBe(200)
    expect((await run(get(), upstream(200, { items: [] }))).status).toBe(200)
    const post = new NextRequest(`${BASE}/api/bff/x`, {
      method: 'POST',
      headers: { 'x-tazzzo-csrf': '1' },
    })
    expect((await run(post, upstream(200, { items: [] }))).status).toBe(405)
    expect(calls).toHaveLength(2)
  })

  it('no cookie or an unknown session is 401 and the backend is never called', async () => {
    expect((await run(get({}, null), upstream(200, { items: [] }))).status).toBe(401)
    expect(
      (await run(get({}, `${COOKIE}=${'f'.repeat(43)}`), upstream(200, { items: [] }))).status,
    ).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('a backend 401 ends the session; 403 keeps it', async () => {
    expect(store.data.size).toBe(1)
    expect((await run(get(), upstream(403, { error: { code: 'FORBIDDEN' } }))).status).toBe(403)
    expect(store.data.size).toBe(1)
    expect((await run(get(), upstream(401, { error: { code: 'UNAUTHENTICATED' } }))).status).toBe(
      401,
    )
    expect(store.data.size).toBe(0)
  })

  it('503 LIST_TIMEOUT stays a 503 with the stable code and nothing else of the body', async () => {
    const res = await run(
      get(),
      upstream(503, {
        error: {
          code: 'LIST_TIMEOUT',
          message: 'internal detail: maxTimeMS 2000 Foo.java:42',
          request_id: 'x',
        },
      }),
    )
    expect(res.status).toBe(503)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('LIST_TIMEOUT')
    expect(text).not.toMatch(/maxTimeMS|Foo\.java|internal detail/)
  })

  it('a malformed code is dropped; 422 keeps its status and code; other statuses become 502', async () => {
    const odd = await (
      await run(get(), upstream(503, { error: { code: 'lower case <script>' } }))
    ).json()
    expect(odd).not.toHaveProperty('code')
    expect(
      await (
        await run(get(), upstream(422, { error: { code: 'INVALID_INVENTORY', message: 'secret' } }))
      ).json(),
    ).toMatchObject({ code: 'INVALID_INVENTORY' })
    expect((await run(get(), upstream(500, { error: { code: 'INTERNAL' } }))).status).toBe(502)
    expect((await run(get(), upstream(418, {}))).status).toBe(502)
  })

  it('429 passes a valid Retry-After; a wrong shape is 502; a network failure is 504', async () => {
    const limited = await run(get(), upstream(429, {}, { 'retry-after': '12' }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('12')
    expect((await run(get(), upstream(200, { items: 'nope' }))).status).toBe(502)
    const down = (async () => {
      throw new TypeError('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const res = await run(get(), down)
    expect(res.status).toBe(504)
    expect(JSON.stringify(await res.json())).not.toMatch(/ECONNREFUSED/)
  })

  it('a session store outage is 503, not a redirect to login', async () => {
    const { SessionStoreUnavailable } = await import('@/server/store/types')
    const broken = {
      ...store,
      get: async () => {
        throw new SessionStoreUnavailable()
      },
    } as unknown as MemoryStore
    const res = await read.runBffRead(spec, get(), {
      store: broken,
      fetchImpl: upstream(200, { items: [] }),
      now: Date.now,
    })
    expect(res.status).toBe(503)
  })
})

describe('runBffDownload', () => {
  const dl = {
    routeId: 'test.download',
    path: '/api/v1/admin/imports/jobs/IMPJ-0123456789abcdef01234567/errors.csv',
    filename: 'IMPJ-0123456789abcdef01234567-errors.csv',
  }
  const csv =
    'row,line,id,phase,outcome,code,message\r\n3,4,tzp-bad,validation,INVALID,INVALID_ROW,"\'=HYPERLINK(""x"")"\r\n'
  const run2 = (request: NextRequest, fetchImpl: typeof fetch) =>
    download.runBffDownload(dl, request, { store, fetchImpl, now: Date.now })

  it('streams the CSV through byte for byte, as a no-store attachment with nosniff and a code-built filename', async () => {
    const res = await run2(
      get(),
      upstream(200, csv, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="../../evil"',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(csv)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${dl.filename}"`)
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: 'text/csv' })
  })

  it('needs the session and the CSRF header', async () => {
    expect(
      (await run2(get({ 'x-tazzzo-csrf': '' }), upstream(200, csv, { 'content-type': 'text/csv' })))
        .status,
    ).toBe(403)
    expect(
      (await run2(get({}, null), upstream(200, csv, { 'content-type': 'text/csv' }))).status,
    ).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('maps backend outcomes to JSON errors without the backend body; refuses a non-CSV answer', async () => {
    expect(
      (await run2(get(), upstream(404, { error: { code: 'IMPORT_JOB_NOT_FOUND', message: 'm' } })))
        .status,
    ).toBe(404)
    expect((await run2(get(), upstream(403, {}))).status).toBe(403)
    const bad = await run2(
      get(),
      upstream(200, '<html>login</html>', { 'content-type': 'text/html' }),
    )
    expect(bad.status).toBe(502)
    expect(await bad.text()).not.toContain('login')
    const boom = await run2(
      get(),
      upstream(500, 'Exception at Foo.java:42', { 'content-type': 'text/plain' }),
    )
    expect(boom.status).toBe(502)
    expect(await boom.text()).not.toMatch(/Foo\.java/)
    expect((await run2(get(), upstream(401, {}))).status).toBe(401)
    expect(store.data.size).toBe(0)
  })
})
