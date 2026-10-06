import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })

type Mod = typeof import('@/server/bff/mutation')
let bff: Mod
let spec: typeof import('@/server/bff/product-title').productTitleMutation
let session: typeof import('@/server/session/session')
let config: import('@/server/session/session').SessionConfig

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
  bff = await import('@/server/bff/mutation')
  spec = (await import('@/server/bff/product-title')).productTitleMutation
  session = await import('@/server/session/session')
  config = (await import('@/server/session/config')).sessionConfig(
    (await import('@/server/env')).serverEnv(),
  )
})

type Call = { url: string; init: RequestInit }
let store: MemoryStore
let calls: Call[]
let sessionId: string
let logs: string[]

function backend(
  status: number,
  body: unknown = { id: 'TZP-REF-1', title: 'New', version: 4 },
  headers: Record<string, string> = {},
) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_0123456789abcdef0123',
        ...headers,
      },
    })
  }) as typeof fetch
}

beforeEach(async () => {
  store = new MemoryStore()
  calls = []
  logs = []
  vi.spyOn(console, 'info').mockImplementation((line: unknown) => void logs.push(String(line)))
  sessionId = (await session.createSession(
    store,
    TOKEN,
    Math.floor(Date.now() / 1000) + 3600,
    config,
    Date.now(),
  ))!.sessionId
})
afterEach(() => vi.restoreAllMocks())

function request(
  opts: {
    body?: string
    headers?: Record<string, string>
    method?: string
    cookie?: string | null
    url?: string
  } = {},
) {
  const headers: Record<string, string> = {
    origin: BASE,
    'x-tazzzo-csrf': '1',
    'content-type': 'application/json',
    ...opts.headers,
  }
  const cookie = opts.cookie === undefined ? `${COOKIE}=${sessionId}` : opts.cookie
  if (cookie !== null) headers.cookie = cookie
  return new NextRequest(opts.url ?? `${BASE}/api/bff/catalog/products/TZP-REF-1/title`, {
    method: opts.method ?? 'PATCH',
    headers,
    body: opts.body ?? JSON.stringify({ title: 'New', expectedVersion: 3 }),
  })
}

async function run(req: NextRequest, fetchImpl: typeof fetch = backend(200)) {
  const res = await bff.runBffMutation(
    spec,
    req,
    { productId: 'TZP-REF-1' },
    { store, fetchImpl, now: Date.now },
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

describe('request gate (before any session or backend work)', () => {
  it('CSRF: requires the custom header and the exact CMS origin', async () => {
    const cases: Array<Record<string, string>> = [
      { 'x-tazzzo-csrf': '' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'https://cms.test.evil.example' },
      { origin: 'https://sub.cms.test' },
      { origin: 'http://cms.test' },
      { origin: 'https://cms.test, https://evil.example' },
    ]
    for (const headers of cases) {
      const { res } = await run(request({ headers }))
      expect(res.status, JSON.stringify(headers)).toBe(403)
    }
    const noOrigin = new NextRequest(`${BASE}/x`, {
      method: 'PATCH',
      headers: {
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        referer: 'https://evil.example/',
        cookie: `${COOKIE}=${sessionId}`,
      },
      body: '{}',
    })
    expect((await run(noOrigin)).res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('rejects a method other than the declared one', async () => {
    expect((await run(request({ method: 'POST' }))).res.status).toBe(405)
  })

  it('requires application/json', async () => {
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      '',
      'application/jsonx',
    ]) {
      expect((await run(request({ headers: { 'content-type': type } }))).res.status, type).toBe(415)
    }
    expect(
      (await run(request({ headers: { 'content-type': 'application/json; charset=utf-8' } }))).res
        .status,
    ).toBe(200)
  })

  it('bounds the body at 16 KiB, declared or streamed', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(bff.BFF_MAX_BODY_BYTES), expectedVersion: 3 })
    expect((await run(request({ body: big }))).res.status).toBe(413)
    const streamed = new NextRequest(`${BASE}/x`, {
      method: 'PATCH',
      headers: {
        origin: BASE,
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        cookie: `${COOKIE}=${sessionId}`,
      },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 40; i++)
            controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
          controller.close()
        },
      }),
      duplex: 'half',
    } as unknown as ConstructorParameters<typeof NextRequest>[1])
    expect((await run(streamed)).res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('validates strictly: bad JSON, unknown or missing fields, invalid id', async () => {
    expect((await run(request({ body: '{not json' }))).res.status).toBe(400)
    const unknown = await run(
      request({ body: JSON.stringify({ title: 'a', expectedVersion: 1, path: '/api/v1/admin' }) }),
    )
    expect(unknown.res.status).toBe(400)
    expect(unknown.body.fields).toEqual(['(root)'])
    expect((await run(request({ body: JSON.stringify({ title: 'a' }) }))).res.status).toBe(400)
    expect(
      (await run(request({ body: JSON.stringify({ title: '', expectedVersion: 1 }) }))).res.status,
    ).toBe(400)
    const badId = await bff.runBffMutation(
      spec,
      request(),
      { productId: '../admin' },
      { store, fetchImpl: backend(200), now: Date.now },
    )
    expect(badId.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('session', () => {
  it('no cookie, or a stale cookie with no stored session: 401, cookie expired, backend never called', async () => {
    expect((await run(request({ cookie: null }))).res.status).toBe(401)
    const stale = await run(request({ cookie: `${COOKIE}=${'s'.repeat(43)}` }))
    expect(stale.res.status).toBe(401)
    expect(stale.res.headers.getSetCookie().join()).toMatch(/__Host-tz_cms_session=;.*Max-Age=0/i)
    expect(calls).toHaveLength(0)
  })
})

describe('backend call', () => {
  it('sends exactly one PATCH to the static backend path with only the human bearer and route headers', async () => {
    const { res, body } = await run(
      request({
        url: 'https://attacker-host.example/api/bff/catalog/products/TZP-REF-1/title',
        headers: {
          'x-forwarded-for': '6.6.6.6',
          'x-forwarded-host': 'evil.example',
          forwarded: 'for=6.6.6.6',
          'x-real-ip': '6.6.6.6',
          'x-request-id': 'req_forged',
        },
        body: JSON.stringify({ title: 'New', expectedVersion: 3 }),
      }),
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(url).toBe(`${BACKEND}/api/v1/products/TZP-REF-1`)
    expect(init.method).toBe('PATCH')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(
      Object.keys(init.headers as Record<string, string>)
        .map((h) => h.toLowerCase())
        .sort(),
    ).toEqual(['accept', 'authorization', 'content-type', 'if-match'])
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect((init.headers as Record<string, string>)['If-Match']).toBe('3')
    expect(JSON.parse(String(init.body))).toEqual({ title: 'New' })
    expect(body).toMatchObject({
      data: { id: 'TZP-REF-1', title: 'New', version: 4 },
      backendRequestId: 'req_0123456789abcdef0123',
    })
    expect(body.correlationId).toMatch(/^bff_[0-9a-f]{24}$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('maps backend statuses without leaking backend bodies, and never retries', async () => {
    const leaky = { error: { code: 'X_Y', message: 'internal detail: stack trace at Foo.java:42' } }
    const cases: Array<[number, number, Record<string, unknown>]> = [
      [403, 403, { error: 'forbidden' }],
      [404, 404, { error: 'not_found' }],
      [409, 409, { error: 'conflict' }],
      [400, 400, { error: 'invalid_request' }],
      [422, 422, { error: 'invalid_request' }],
      [500, 502, { error: 'upstream_error' }],
      [503, 502, { error: 'upstream_error' }],
      [302, 502, { error: 'upstream_error' }],
      [418, 502, { error: 'upstream_error' }],
    ]
    for (const [upstream, expected, shape] of cases) {
      calls = []
      const { res, body } = await run(
        request(),
        backend(
          upstream,
          leaky,
          upstream === 302 ? { location: 'https://evil.example/steal' } : {},
        ),
      )
      expect(res.status, String(upstream)).toBe(expected)
      expect(body, String(upstream)).toMatchObject(shape)
      expect(JSON.stringify(body)).not.toContain('stack trace')
      expect(calls, String(upstream)).toHaveLength(1)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('503 passes only a well-formed backend code, never the message', async () => {
    const ok = await run(
      request(),
      backend(503, {
        error: { code: 'MEDIA_STORAGE_NOT_CONFIGURED', message: 'secret internal detail' },
      }),
    )
    expect(ok.res.status).toBe(502)
    expect(ok.body).toMatchObject({ error: 'upstream_error', code: 'MEDIA_STORAGE_NOT_CONFIGURED' })
    expect(JSON.stringify(ok.body)).not.toContain('secret')
    const bad = await run(request(), backend(503, { error: { code: '<script>', message: 'x' } }))
    expect(bad.body).not.toHaveProperty('code')
  })

  it('409 passes only a well-formed backend code (e.g. STALE_VERSION)', async () => {
    const stale = await run(
      request(),
      backend(409, { error: { code: 'STALE_VERSION', message: 'expected 4' } }),
    )
    expect(stale.body).toMatchObject({ error: 'conflict', code: 'STALE_VERSION' })
    expect(JSON.stringify(stale.body)).not.toContain('expected 4')
    const weird = await run(request(), backend(409, { error: { code: '<script>' } }))
    expect(weird.body).not.toHaveProperty('code')
  })

  it('401 ends the session and expires the cookie; 403 keeps it', async () => {
    const denied = await run(request(), backend(403))
    expect(denied.res.headers.getSetCookie()).toEqual([])
    expect(store.data.size).toBe(1)
    const unauth = await run(request(), backend(401))
    expect(unauth.res.status).toBe(401)
    expect(unauth.res.headers.getSetCookie().join()).toMatch(/__Host-tz_cms_session=;.*Max-Age=0/i)
    expect(store.data.size).toBe(0)
  })

  it('429 keeps only a sane Retry-After', async () => {
    expect(
      (await run(request(), backend(429, {}, { 'retry-after': '30' }))).res.headers.get(
        'retry-after',
      ),
    ).toBe('30')
    expect(
      (
        await run(request(), backend(429, {}, { 'retry-after': '30\r\nSet-Cookie: x=1' }))
      ).res.headers.get('retry-after'),
    ).toBeNull()
  })

  it('timeouts and network failures are 504 with no retry; a malformed success body is 502', async () => {
    const failing = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      throw new DOMException('timed out', 'TimeoutError')
    }) as typeof fetch
    expect((await run(request(), failing)).res.status).toBe(504)
    expect(calls).toHaveLength(1)
    expect((await run(request(), backend(200, { unexpected: true }))).res.status).toBe(502)
  })
})

describe('observability', () => {
  it('emits bounded events with route, correlation id, outcome and duration, and never secrets', async () => {
    await run(request())
    await run(request(), backend(403))
    await run(request({ headers: { origin: 'https://evil.example' } }))
    const events = logs.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(events.map((e) => e.event)).toEqual([
      'bff.mutation.started',
      'bff.mutation.succeeded',
      'bff.mutation.started',
      'bff.mutation.denied',
      'bff.mutation.started',
      'bff.mutation.invalid_request',
    ])
    for (const e of events) expect(e.routeId).toBe('catalog.product.title')
    const all = logs.join('\n')
    for (const secret of [TOKEN, sessionId, 'Bearer', 'New']) expect(all).not.toContain(secret)
  })
})

describe('per-route overrides (bulk import support)', () => {
  const importSpec = () => ({
    routeId: 'test.import',
    method: 'POST' as const,
    input: z.object({ rows: z.array(z.string()) }).strict(),
    backend: (i: { rows: string[] }) => ({ path: '/api/v1/admin/imports/x', body: i }),
    output: z.object({ ok: z.boolean() }),
    toClient: (o: { ok: boolean }) => o,
  })
  const post = (rows: string[]) =>
    new NextRequest(`${BASE}/api/bff/imports/x`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        cookie: `${COOKIE}=${sessionId}`,
      },
      body: JSON.stringify({ rows }),
    })
  const big = Array(2000).fill('x'.repeat(50)) // ~110 KB: over the 16 KiB default

  it('keeps the 16 KiB default for specs that do not opt in', async () => {
    const res = await bff.runBffMutation(
      importSpec(),
      post(big),
      {},
      { store, fetchImpl: backend(200, { ok: true }), now: Date.now },
    )
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('allows a larger body only where the spec declares it, and still bounds it', async () => {
    const spec = { ...importSpec(), maxBodyBytes: 200_000 }
    const ok = await bff.runBffMutation(
      spec,
      post(big),
      {},
      { store, fetchImpl: backend(200, { ok: true }), now: Date.now },
    )
    expect(ok.status).toBe(200)
    const tooBig = await bff.runBffMutation(
      { ...spec, maxBodyBytes: 50_000 },
      post(big),
      {},
      { store, fetchImpl: backend(200, { ok: true }), now: Date.now },
    )
    expect(tooBig.status).toBe(413)
  })

  it('passes only the spec-sanitized error detail on 422, never the raw backend body', async () => {
    const spec = {
      ...importSpec(),
      errorDetail: (b: unknown) => ((b as { rowErrors?: unknown[] }).rowErrors ?? []).length,
    }
    const upstream = backend(422, {
      error: { code: 'INVALID_IMPORT', message: 'secret stack Foo.java:42' },
      rowErrors: [{ row: 1 }, { row: 2 }],
    })
    const res = await bff.runBffMutation(
      spec,
      post(['a']),
      {},
      { store, fetchImpl: upstream, now: Date.now },
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(res.status).toBe(422)
    expect(body).toMatchObject({ code: 'INVALID_IMPORT', detail: 2 })
    expect(JSON.stringify(body)).not.toMatch(/secret|Foo\.java|rowErrors/)
  })

  it('applies a custom timeout to the backend call', async () => {
    const spec = { ...importSpec(), timeoutMs: 123_000 }
    let signal: AbortSignal | null | undefined
    const f = (async (_u: URL | RequestInfo, init?: RequestInit) => {
      signal = init?.signal
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    await bff.runBffMutation(spec, post(['a']), {}, { store, fetchImpl: f, now: Date.now })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })
})
