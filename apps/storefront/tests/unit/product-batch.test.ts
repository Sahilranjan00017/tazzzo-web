import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BATCH_MAX_IDS, FakeBackend } from '../support/fake-backend'

/**
 * The batch product read against the fake public API (tests/support/fake-backend.ts mirrors CommerceReadController's
 * `GET /v1/products:batch`): real `fetch`, real catalog client, the fake's request log as the call counter.
 */
const backend = new FakeBackend()
type Catalog = typeof import('@/server/backend/catalog')
let catalog: Catalog

beforeAll(async () => {
  await backend.start()
  vi.stubEnv('TAZZZO_API_BASE_URL', backend.url)
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('TAZZZO_MEDIA_BASE_URL', `${backend.mediaUrl}/media`)
  vi.stubEnv('TAZZZO_CALLER_NAME', 'storefront')
  vi.stubEnv('TAZZZO_CALLER_SECRET', 'caller-secret-for-tests-only-0123456789')
  catalog = await import('@/server/backend/catalog')
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await backend.stop()
})
beforeEach(async () => {
  backend.requests.length = 0
  await fetch(`${backend.url}/__control/batch?down=0`, { method: 'POST' })
  backend.requests.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const calls = () => backend.requests.map((r) => `${r.method} ${r.path}${r.query}`)
const get = (query: string) => fetch(`${backend.url}/v1/products:batch${query}`)

describe('rail through getRailProducts', () => {
  it('N products, ONE backend call, request order kept, unknown and merged ids omitted', async () => {
    const products = await catalog.getRailProducts([
      'TZP-1002',
      'TZP-9999', // unknown
      'TZP-Merged-1', // merged into TZP-1002: the batch does not follow it
      'TZP-1001',
      'TZP-Mix-7',
      'TZP-2001',
    ])
    expect(products.map((p) => p.productId)).toEqual([
      'TZP-1002',
      'TZP-1001',
      'TZP-Mix-7',
      'TZP-2001',
    ])
    expect(calls()).toEqual([
      'GET /v1/products:batch?ids=TZP-1002,TZP-9999,TZP-Merged-1,TZP-1001,TZP-Mix-7,TZP-2001',
    ])
    expect(backend.requests[0]).toMatchObject({ caller: 'storefront' })
    expect(backend.requests[0]!.callerSecret).toBeTruthy()
  })

  it('a duplicated id renders once, at its first position', async () => {
    const products = await catalog.getRailProducts(['TZP-1002', 'TZP-1001', 'TZP-1002'])
    expect(products.map((p) => p.productId)).toEqual(['TZP-1002', 'TZP-1001'])
    expect(calls()).toHaveLength(1)
  })

  it('a serviceable PIN is sent once and enriches the cards; a non-canonical PIN is dropped', async () => {
    const located = await catalog.getRailProducts(['TZP-1001', 'TZP-1002'], '560001')
    expect(located.map((p) => [p.stockState, p.serviceable])).toEqual([
      ['IN_STOCK', true],
      ['LOW_STOCK', true],
    ])
    await catalog.getRailProducts(['TZP-1001'], '560001&x=1')
    expect(calls()).toEqual([
      'GET /v1/products:batch?ids=TZP-1001,TZP-1002&pin=560001',
      'GET /v1/products:batch?ids=TZP-1001',
    ])
  })

  it('a backend 503 degrades to an empty rail with ONE call and no single reads', async () => {
    await fetch(`${backend.url}/__control/batch?down=1`, { method: 'POST' })
    backend.requests.length = 0
    expect(await catalog.getRailProducts(['TZP-1001', 'TZP-1002', 'TZP-Mix-7'])).toEqual([])
    expect(calls()).toEqual(['GET /v1/products:batch?ids=TZP-1001,TZP-1002,TZP-Mix-7'])
  })

  it('lowercase and mixed-case prefixes are rejected, never folded; the rest still resolve', async () => {
    const r = await catalog.getProductsBatch([
      'tzp-1001',
      'Tzp-1001',
      'TZP-1001',
      'TZP-Mix-7',
      'TZP-mix-7',
    ])
    expect(r.ok && r.items.map((p) => p.productId)).toEqual(['TZP-1001', 'TZP-Mix-7'])
    // Valid but case-different suffix is a different (unknown) id and is reported missing by the backend.
    expect(r.ok && r.missing).toEqual(['TZP-mix-7', 'tzp-1001', 'Tzp-1001'])
    expect(calls()).toEqual(['GET /v1/products:batch?ids=TZP-1001,TZP-Mix-7,TZP-mix-7'])
    backend.requests.length = 0
    expect(await catalog.getRailProducts(['tzp-1001'])).toEqual([])
    expect(calls()).toEqual([]) // nothing valid to ask: no call at all
  })

  it('cards carry no gallery: the image is the thumbnail only', async () => {
    const [rice, dal] = await catalog.getRailProducts(['TZP-1001', 'TZP-1002'])
    expect(rice!.image?.url).toBe(backend.m('p1-thumb.png'))
    expect(dal!.image).toBeNull()
  })
})

describe('chunking at the backend cap', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `TZP-${5000 + i}`)

  it('exactly 50 distinct ids is one call; 51 is two; 120 is three; duplicates do not count', async () => {
    expect(BATCH_MAX_IDS).toBe(50)
    await catalog.getProductsBatch(ids(50))
    expect(calls()).toHaveLength(1)
    backend.requests.length = 0
    await catalog.getProductsBatch(ids(51))
    expect(calls()).toHaveLength(2)
    backend.requests.length = 0
    const r = await catalog.getProductsBatch([...ids(120), ...ids(30)])
    const sizes = backend.requests.map(
      (q) => new URLSearchParams(q.query).get('ids')!.split(',').length,
    )
    expect(sizes).toEqual([50, 50, 20])
    expect(r).toEqual({ ok: true, items: [], missing: ids(120) })
  })

  it('a failed chunk makes the whole call unavailable (no partial lists)', async () => {
    await fetch(`${backend.url}/__control/batch?down=1`, { method: 'POST' })
    expect(await catalog.getProductsBatch(ids(60))).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('the fake mirrors the real contract (what the client relies on)', () => {
  it('answers items in request order without gallery/attributes, missing without a reason', async () => {
    const res = await get('?ids=TZP-1002,TZP-9999,TZP-1001,TZP-1002,TZP-Merged-1')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('etag')).toBeNull()
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>
      missing: string[]
      resolvedReleaseId: string
      requestId: string
    }
    expect(body.items.map((i) => i.productId)).toEqual(['TZP-1002', 'TZP-1001'])
    expect(body.missing).toEqual(['TZP-9999', 'TZP-Merged-1'])
    expect(body.resolvedReleaseId).toBe('R1')
    expect(body.requestId).toBeTruthy()
    for (const item of body.items) {
      expect(item).not.toHaveProperty('gallery')
      expect(item).not.toHaveProperty('attributes')
    }
  })

  it('only-missing ids are a normal 200 with empty items; the single read follows a merged id', async () => {
    const body = (await (await get('?ids=TZP-9999')).json()) as {
      items: unknown[]
      missing: string[]
    }
    expect(body).toMatchObject({ items: [], missing: ['TZP-9999'] })
    const single = await fetch(`${backend.url}/v1/products/TZP-Merged-1`)
    expect(((await single.json()) as { productId: string }).productId).toBe('TZP-1002')
  })

  const many = (n: number) => Array.from({ length: n }, (_, i) => `TZP-${i}`).join(',')
  it.each([
    ['no ids', ''],
    ['empty ids', '?ids='],
    ['ids twice', '?ids=TZP-1&ids=TZP-2'],
    ['lowercase', '?ids=tzp-1'],
    ['trailing comma', '?ids=TZP-1,'],
    ['empty element', '?ids=TZP-1,,TZP-2'],
    ['whitespace', '?ids=TZP-1,%20TZP-2'],
    ['bad character', '?ids=TZP-1_2'],
    ['41 chars after the prefix', `?ids=TZP-${'a'.repeat(41)}`],
    ['51 ids', `?ids=${many(51)}`],
    ['51 with duplicates (duplicates count)', `?ids=${many(26)},${many(25)}`],
    ['lat/lng', '?ids=TZP-1&lat=12&lng=77'],
    ['malformed pin', '?ids=TZP-1&pin=56001'],
    ['query over 2866 chars', `?ids=TZP-1&release=${'r'.repeat(2866)}`],
  ])('400 INVALID_REQUEST for %s', async (_name, query) => {
    const res = await get(query)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_REQUEST')
  })

  it('exactly 50 ids (duplicates counted) is accepted', async () => {
    expect((await get(`?ids=${many(50)}`)).status).toBe(200)
    expect((await get(`?ids=${many(25)},${many(25)}`)).status).toBe(200)
  })
})
