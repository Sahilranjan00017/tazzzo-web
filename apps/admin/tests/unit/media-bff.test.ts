import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

/**
 * The media BFF routes through the real mutation layer (CSRF, schema, session, backend call, error mapping), with the
 * upload-target validation that decides what the browser may be told to PUT to.
 */
const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const STORAGE = 'https://tazzzo-media.s3.ap-south-1.amazonaws.com'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })

let bff: typeof import('@/server/bff/mutation')
let media: typeof import('@/server/bff/media-actions')
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
    CMS_MEDIA_UPLOAD_ORIGIN: STORAGE,
  })
  bff = await import('@/server/bff/mutation')
  media = await import('@/server/bff/media-actions')
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

const backend =
  (status: number, body: unknown) =>
  async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

function req(path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      'x-tazzzo-csrf': '1',
      'content-type': 'application/json',
      cookie: `${COOKIE}=${sessionId}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function upload(
  status: number,
  body: unknown,
  input: unknown = {
    ownerType: 'product',
    ownerId: 'TZP-1',
    contentType: 'image/png',
    sizeBytes: 32,
  },
  headers?: Record<string, string>,
) {
  const res = await bff.runBffMutation(
    media.requestUploadMutation,
    req('/api/bff/media/uploads', 'POST', input, headers),
    {},
    { store, fetchImpl: backend(status, body) as typeof fetch, now: Date.now },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const issued = (over: Record<string, unknown> = {}) => ({
  assetKey: 'p/product/TZP-1/0b8f.png',
  method: 'PUT',
  url: `${STORAGE}/p/product/TZP-1/0b8f.png?X-Amz-Signature=abc`,
  headers: { 'Content-Type': 'image/png', 'Content-Length': '32', 'If-None-Match': '*' },
  expiresAt: '2026-10-08T10:05:00Z',
  maxBytes: 5242880,
  ...over,
})

describe('upload target route', () => {
  it('forwards a validated target as the signed-in human, on a fixed backend path', async () => {
    const r = await upload(201, issued())
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual(issued())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/media/uploads`)
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('refuses (502) a target outside the configured storage origin, with credentials, or non-PUT', async () => {
    for (const bad of [
      issued({ url: 'https://evil.example/p/x' }),
      issued({ url: `${STORAGE.replace('https', 'http')}/p/x` }),
      issued({ url: `https://user:pw@${new URL(STORAGE).host}/p/x` }),
      issued({ headers: { Authorization: 'Bearer leaked' } }),
      issued({ headers: { Cookie: 'a=b' } }),
      issued({ method: 'POST' }),
      issued({ assetKey: '../escape' }),
    ]) {
      const r = await upload(201, bad)
      expect(r.status, JSON.stringify(bad)).toBe(502)
      expect(JSON.stringify(r.body)).not.toContain('leaked')
      expect(r.body.data).toBeUndefined()
    }
  })

  it('maps backend refusals by code and never echoes backend text', async () => {
    const env = (code: string) => ({ error: { code, message: 'internal: bucket tazzzo-prod' } })
    const notConfigured = await upload(503, env('MEDIA_STORAGE_NOT_CONFIGURED'))
    expect(notConfigured).toMatchObject({
      status: 502,
      body: { code: 'MEDIA_STORAGE_NOT_CONFIGURED' },
    })
    const outage = await upload(503, env('MEDIA_STORAGE_UNAVAILABLE'))
    expect(outage).toMatchObject({ status: 502, body: { code: 'MEDIA_STORAGE_UNAVAILABLE' } })
    const invalid = await upload(422, env('INVALID_MEDIA'))
    expect(invalid).toMatchObject({ status: 422, body: { code: 'INVALID_MEDIA' } })
    expect((await upload(403, env('FORBIDDEN'))).status).toBe(403)
    for (const r of [notConfigured, outage, invalid])
      expect(JSON.stringify(r.body)).not.toContain('bucket')
  })

  it('validates input before any backend call: SVG, oversize, unknown fields, bad owner', async () => {
    for (const input of [
      { ownerType: 'product', ownerId: 'TZP-1', contentType: 'image/svg+xml', sizeBytes: 32 },
      { ownerType: 'product', ownerId: 'TZP-1', contentType: 'image/png', sizeBytes: 0 },
      { ownerType: 'banner', ownerId: 'TZP-1', contentType: 'image/png', sizeBytes: 32 },
      { ownerType: 'product', ownerId: 'TZP-1', contentType: 'image/png', sizeBytes: 32, url: 'x' },
    ]) {
      expect((await upload(201, issued(), input)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('CSRF and session gates come first', async () => {
    expect(
      (await upload(201, issued(), undefined, { origin: 'https://evil.example' })).status,
    ).toBe(403)
    expect((await upload(201, issued(), undefined, { cookie: `${COOKIE}=nope` })).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('without CMS_MEDIA_UPLOAD_ORIGIN the route answers 503 UPLOAD_ORIGIN_NOT_CONFIGURED and never calls the backend', async () => {
    vi.resetModules()
    const saved = process.env.CMS_MEDIA_UPLOAD_ORIGIN
    delete process.env.CMS_MEDIA_UPLOAD_ORIGIN
    try {
      const freshBff = await import('@/server/bff/mutation')
      const freshMedia = await import('@/server/bff/media-actions')
      const freshSession = await import('@/server/session/session')
      const config = (await import('@/server/session/config')).sessionConfig(
        (await import('@/server/env')).serverEnv(),
      )
      const s = new MemoryStore()
      const id = (await freshSession.createSession(
        s,
        TOKEN,
        Math.floor(Date.now() / 1000) + 3600,
        config,
        Date.now(),
      ))!.sessionId
      const res = await freshBff.runBffMutation(
        freshMedia.requestUploadMutation,
        new NextRequest(`${BASE}/api/bff/media/uploads`, {
          method: 'POST',
          headers: {
            origin: BASE,
            'x-tazzzo-csrf': '1',
            'content-type': 'application/json',
            cookie: `${COOKIE}=${id}`,
          },
          body: JSON.stringify({
            ownerType: 'product',
            ownerId: 'TZP-1',
            contentType: 'image/png',
            sizeBytes: 32,
          }),
        }),
        {},
        { store: s, fetchImpl: backend(201, issued()) as typeof fetch, now: Date.now },
      )
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({
        error: 'unavailable',
        code: 'UPLOAD_ORIGIN_NOT_CONFIGURED',
      })
      expect(calls).toHaveLength(0)
    } finally {
      process.env.CMS_MEDIA_UPLOAD_ORIGIN = saved
      vi.resetModules()
    }
  })
})

describe('size refusals pass on only the limit', () => {
  it('a target-time 422 carries { reason: size, maxBytes } and nothing else', async () => {
    const r = await upload(422, {
      error: { code: 'INVALID_MEDIA', message: 'sizeBytes must be between 1 and 2097152' },
    })
    expect(r).toMatchObject({
      status: 422,
      body: { code: 'INVALID_MEDIA', detail: { reason: 'size', maxBytes: 2097152 } },
    })
    expect(JSON.stringify(r.body)).not.toContain('sizeBytes must')
    const other = await upload(422, {
      error: { code: 'INVALID_MEDIA', message: 'unsupported contentType' },
    })
    expect(other.body.detail).toBeUndefined()
  })
})

describe('media set route', () => {
  const body = {
    assets: [
      {
        assetId: 'img-1',
        assetKey: 'p/product/TZP-1/0b8f.png',
        role: 'PRIMARY',
        sortOrder: 0,
        altText: 'Front',
        contentType: 'image/png',
      },
    ],
    expectedVersion: 3,
  }
  const put = async (status: number, out: unknown, input: unknown = body) => {
    const res = await bff.runBffMutation(
      media.putMediaSetMutation,
      req('/api/bff/media/product/TZP-1', 'PUT', input),
      { ownerType: 'product', ownerId: 'TZP-1' },
      { store, fetchImpl: backend(status, out) as typeof fetch, now: Date.now },
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  it('sends the whole set with the version to the fixed path', async () => {
    const r = await put(200, { ownerType: 'product', ownerId: 'TZP-1', version: 4 })
    expect(r).toMatchObject({ status: 200, body: { data: { version: 4 } } })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/media/product/TZP-1`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body)
  })
  it('maps 409 STALE_VERSION, 422 INVALID_MEDIA and 503 storage codes', async () => {
    const env = (code: string) => ({ error: { code, message: 'asset not found in storage: k' } })
    expect(await put(409, env('STALE_VERSION'))).toMatchObject({
      status: 409,
      body: { code: 'STALE_VERSION' },
    })
    expect(await put(422, env('INVALID_MEDIA'))).toMatchObject({
      status: 422,
      body: { code: 'INVALID_MEDIA' },
    })
    expect(
      await put(422, {
        error: { code: 'INVALID_MEDIA', message: 'stored object size is outside 1..5242880' },
      }),
    ).toMatchObject({ status: 422, body: { detail: { reason: 'size', maxBytes: 5242880 } } })
    expect(await put(503, env('MEDIA_STORAGE_UNAVAILABLE'))).toMatchObject({
      status: 502,
      body: { code: 'MEDIA_STORAGE_UNAVAILABLE' },
    })
  })
  it('refuses a control character in alt text before calling the backend', async () => {
    const bad = { ...body, assets: [{ ...body.assets[0]!, altText: 'Front\u0007view' }] }
    expect((await put(200, {}, bad)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
