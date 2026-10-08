import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BffMutationSpec } from '@/server/bff/mutation'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

/** The Home content BFF routes through the real mutation layer (CSRF, strict schema, session, mapping). */
const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const STORAGE = 'https://tazzzo-media.s3.ap-south-1.amazonaws.com'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })
const ID = 'CB_abcdefghijklmnop'

let bff: typeof import('@/server/bff/mutation')
let home: typeof import('@/server/bff/home-content-actions')
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
  home = await import('@/server/bff/home-content-actions')
})
beforeEach(async () => {
  store = new MemoryStore()
  calls = []
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const session = await import('@/server/session/session')
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

async function call<I, O, C>(
  spec: BffMutationSpec<I, O, C>,
  method: string,
  input: unknown,
  backend: { status: number; body: unknown } = {
    status: 200,
    body: { blockId: ID, status: 'DRAFT', version: 1 },
  },
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const res = await bff.runBffMutation(
    spec,
    new NextRequest(`${BASE}/api/bff/x`, {
      method,
      headers: {
        origin: BASE,
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        cookie: `${COOKIE}=${sessionId}`,
        ...headers,
      },
      body: JSON.stringify(input),
    }),
    params,
    {
      store,
      fetchImpl: (async (url: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify(backend.body), {
          status: backend.status,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
      now: Date.now,
    },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const sent = () => JSON.parse(String(calls[0]!.init.body))

const banner = {
  type: 'BANNER',
  title: 'Mango season',
  sort: 10,
  audience: 'APP_ONLY',
  startsAt: '2026-10-08T03:30:00.000Z',
  payload: { imageAssetKey: 'c/home/m.webp', link: 'search:ताज़ा आम', altText: 'Mangoes' },
}

describe('create', () => {
  it('fixes placement HOME on the server and forwards the validated block', async () => {
    const r = await call(home.createHomeBlockMutation, 'POST', banner)
    expect(r.status).toBe(200)
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/content/blocks`)
    expect(sent()).toEqual({ placement: 'HOME', ...banner })
  })
  it('refuses a browser-chosen placement, an FAQ type and bad payloads before any backend call', async () => {
    for (const bad of [
      { ...banner, placement: 'HELP' },
      { ...banner, type: 'FAQ' },
      { ...banner, payload: { ...banner.payload, link: 'https://evil.example' } },
      { ...banner, payload: { ...banner.payload, subtitle: 'x​y' } },
      { type: 'PRODUCT_RAIL', title: 'R', sort: 0, audience: 'BOTH', payload: { ids: [] } },
    ]) {
      expect((await call(home.createHomeBlockMutation, 'POST', bad)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
  it('maps 422 INVALID_CONTENT and 409 STATE_CONFLICT by code only', async () => {
    const env = (code: string) => ({
      error: { code, message: 'asset not found in storage: c/home/x' },
    })
    const r = await call(home.createHomeBlockMutation, 'POST', banner, {
      status: 422,
      body: env('INVALID_CONTENT'),
    })
    expect(r).toMatchObject({ status: 422, body: { code: 'INVALID_CONTENT' } })
    expect(JSON.stringify(r.body)).not.toContain('storage')
    expect(
      await call(home.createHomeBlockMutation, 'POST', banner, {
        status: 409,
        body: env('STATE_CONFLICT'),
      }),
    ).toMatchObject({ status: 409, body: { code: 'STATE_CONFLICT' } })
  })
  it('CSRF and session first', async () => {
    expect(
      (
        await call(
          home.createHomeBlockMutation,
          'POST',
          banner,
          undefined,
          {},
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          home.createHomeBlockMutation,
          'POST',
          banner,
          undefined,
          {},
          { cookie: `${COOKIE}=x` },
        )
      ).status,
    ).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe('update', () => {
  it('PUTs to the block path with its version and never sends type or placement', async () => {
    await call(home.updateHomeBlockMutation, 'PUT', { ...banner, expectedVersion: 4 }, undefined, {
      blockId: ID,
    })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/content/blocks/${ID}`)
    const body = sent()
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('placement')
    expect(body).not.toHaveProperty('blockId')
    expect(body).toMatchObject({ expectedVersion: 4, audience: 'APP_ONLY', title: 'Mango season' })
  })
  it('maps 409 STALE_VERSION and a 503 storage outage', async () => {
    const env = (code: string) => ({ error: { code } })
    expect(
      await call(
        home.updateHomeBlockMutation,
        'PUT',
        { ...banner, expectedVersion: 4 },
        { status: 409, body: env('STALE_VERSION') },
        { blockId: ID },
      ),
    ).toMatchObject({ status: 409, body: { code: 'STALE_VERSION' } })
    expect(
      await call(
        home.updateHomeBlockMutation,
        'PUT',
        { ...banner, expectedVersion: 4 },
        { status: 503, body: env('MEDIA_STORAGE_UNAVAILABLE') },
        { blockId: ID },
      ),
    ).toMatchObject({ status: 502, body: { code: 'MEDIA_STORAGE_UNAVAILABLE' } })
  })
  it('a path id that is not a block id is refused', async () => {
    expect(
      (
        await call(
          home.updateHomeBlockMutation,
          'PUT',
          { ...banner, expectedVersion: 4 },
          undefined,
          { blockId: '../app-config' },
        )
      ).status,
    ).toBe(400)
  })
})

describe('reorder', () => {
  const order = [
    { blockId: 'CB_aaaaaaaaaaaaaaaa', expectedVersion: 2 },
    { blockId: 'CB_bbbbbbbbbbbbbbbb', expectedVersion: 1 },
  ]
  it('sends one call for HOME with every entry and version', async () => {
    const r = await call(
      home.reorderHomeMutation,
      'POST',
      { order },
      {
        status: 200,
        body: { items: [{ blockId: 'CB_aaaaaaaaaaaaaaaa' }, { blockId: 'CB_bbbbbbbbbbbbbbbb' }] },
      },
    )
    expect(r).toMatchObject({ status: 200, body: { data: { count: 2 } } })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/content/blocks/reorder`)
    expect(sent()).toEqual({ placement: 'HOME', order })
  })
  it('refuses duplicates, empty orders and a browser placement', async () => {
    for (const bad of [
      { order: [order[0], order[0]] },
      { order: [] },
      { order, placement: 'HELP' },
    ])
      expect((await call(home.reorderHomeMutation, 'POST', bad)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
  it('a changed set or version is a 409', async () => {
    expect(
      await call(
        home.reorderHomeMutation,
        'POST',
        { order },
        {
          status: 409,
          body: { error: { code: 'STALE_VERSION' } },
        },
      ),
    ).toMatchObject({ status: 409, body: { code: 'STALE_VERSION' } })
  })
})

describe('banner upload target', () => {
  const target = {
    assetKey: 'c/home/1f.webp',
    method: 'PUT',
    url: `${STORAGE}/c/home/1f.webp?X-Amz-Signature=s`,
    headers: { 'Content-Type': 'image/webp', 'Content-Length': '99', 'If-None-Match': '*' },
    expiresAt: '2026-10-08T10:05:00Z',
    maxBytes: 5242880,
  }
  it('forwards a validated target from the content upload endpoint', async () => {
    const r = await call(
      home.requestContentUploadMutation,
      'POST',
      { contentType: 'image/webp', sizeBytes: 99 },
      { status: 201, body: target },
    )
    expect(r).toMatchObject({ status: 200, body: { data: target } })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/content/uploads`)
  })
  it('refuses a target off the storage origin, SVG input, and passes storage-off by code', async () => {
    expect(
      (
        await call(
          home.requestContentUploadMutation,
          'POST',
          { contentType: 'image/webp', sizeBytes: 99 },
          { status: 201, body: { ...target, url: 'https://evil.example/c/home/1f.webp' } },
        )
      ).status,
    ).toBe(502)
    expect(
      (
        await call(home.requestContentUploadMutation, 'POST', {
          contentType: 'image/svg+xml',
          sizeBytes: 9,
        })
      ).status,
    ).toBe(400)
    expect(
      await call(
        home.requestContentUploadMutation,
        'POST',
        { contentType: 'image/png', sizeBytes: 9 },
        { status: 503, body: { error: { code: 'MEDIA_STORAGE_NOT_CONFIGURED' } } },
      ),
    ).toMatchObject({ status: 502, body: { code: 'MEDIA_STORAGE_NOT_CONFIGURED' } })
  })
})
