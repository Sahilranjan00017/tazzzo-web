import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const API = 'https://api.tazzzo.test'
const MEDIA = 'https://cdn.tazzzo.test/m'

beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', API)
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('STOREFRONT_SESSION_SECRET', 'q'.repeat(43)) // production requires the session sealing key
  vi.stubEnv('TAZZZO_MEDIA_BASE_URL', MEDIA)
})

const { getJson, resetFailureMemory, REVALIDATE_SECONDS } = await import('@/server/backend/client')
const catalog = await import('@/server/backend/catalog')

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string }
const fetchMock =
  vi.fn<(input: string, init?: RequestInit & { next?: unknown }) => Promise<Response>>()

function reply({ status, body, headers = {}, raw }: Reply): Response {
  return new Response(raw ?? (body === undefined ? null : JSON.stringify(body)), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

beforeEach(() => {
  resetFailureMemory()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getJson', () => {
  it('GETs the public API from the server with a 60 s cache, JSON only, no redirects, a timeout', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 200, body: { a: 1 } }))
    expect(await getJson('/v1/categories')).toEqual({ ok: true, data: { a: 1 } })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${API}/v1/categories`)
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      next: { revalidate: REVALIDATE_SECONDS },
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init).not.toHaveProperty('cache')
    expect(REVALIDATE_SECONDS).toBe(60)
  })

  it('uncached reads use no-store and no revalidate', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 200, body: {} }))
    await getJson('/v1/search?q=rice', { cache: false })
    const init = fetchMock.mock.calls[0]![1]
    expect(init).toMatchObject({ cache: 'no-store' })
    expect(init).not.toHaveProperty('next')
  })

  it('refuses anything but a public /v1 path', async () => {
    await expect(getJson('/api/v1/admin/me')).rejects.toThrow('public API paths only')
    await expect(getJson('https://evil.example/v1/x')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 400, body: { code: 'INVALID_REQUEST' } }, 'bad_request'],
    [{ status: 404, body: { code: 'NOT_FOUND' } }, 'not_found'],
    [{ status: 429, body: {}, headers: { 'retry-after': '3' } }, 'unavailable'],
    [{ status: 503, body: {} }, 'unavailable'],
    [{ status: 500, body: {} }, 'unavailable'],
    [{ status: 200, raw: '<html>' }, 'unavailable'],
  ])('maps %j to %s without throwing', async (r, kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(reply(r as Reply))
    expect(await getJson('/v1/categories')).toEqual({ ok: false, kind })
  })

  it('maps a network failure or timeout to unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await getJson('/v1/categories')).toEqual({ ok: false, kind: 'unavailable' })
    fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
    expect(await getJson('/v1/categories')).toEqual({ ok: false, kind: 'unavailable' })
  })

  it('remembers a 404 on a cacheable read so it does not cost a backend call per page view', async () => {
    fetchMock.mockResolvedValue(reply({ status: 404, body: {} }))
    expect(await getJson('/v1/products/TZP-9')).toEqual({ ok: false, kind: 'not_found' })
    expect(await getJson('/v1/products/TZP-9')).toEqual({ ok: false, kind: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    await getJson('/v1/products/TZP-9')
    vi.useRealTimers()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('after a 429, holds back uncached reads until Retry-After, but still serves cacheable reads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(
      reply({ status: 429, body: {}, headers: { 'retry-after': '5' } }),
    )
    await getJson('/v1/search?q=rice', { cache: false })
    expect(await getJson('/v1/search?q=dal', { cache: false })).toEqual({
      ok: false,
      kind: 'unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValueOnce(reply({ status: 200, body: { cached: true } }))
    expect(await getJson('/v1/categories')).toEqual({ ok: true, data: { cached: true } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never logs the query string (search text is customer input)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(
      reply({ status: 503, body: {}, headers: { 'x-request-id': 'req_abc' } }),
    )
    await getJson('/v1/search?q=my%20secret%20query', { cache: false })
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('path=/v1/search')
    expect(logged).toContain('request_id=req_abc')
    expect(logged).not.toContain('secret')
  })
})

describe('catalog reads', () => {
  const card = (id: string, name: string) => ({
    productId: id,
    skuId: id,
    name,
    sellingPricePaise: 1000,
    thumbnailUrl: `${MEDIA}/${id}.jpg`,
  })

  it('asks for home content with channel=web and nothing else', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 200, body: { blocks: [], requestId: 'r' } }))
    expect(await catalog.getHomeBlocks()).toEqual({ ok: true, blocks: [] })
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API}/v1/content/home?channel=web`)
  })

  it('reports home as unavailable on a backend failure or a malformed envelope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(reply({ status: 503, body: {} }))
    expect(await catalog.getHomeBlocks()).toEqual({ ok: false, reason: 'unavailable' })
    fetchMock.mockResolvedValueOnce(reply({ status: 200, body: { nope: true } }))
    expect(await catalog.getHomeBlocks()).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('rail products: one read per id, order kept, missing/failing/malformed ones skipped silently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/TZP-1')) return reply({ status: 200, body: card('TZP-1', 'Rice') })
      if (url.endsWith('/TZP-2')) return reply({ status: 404, body: {} })
      if (url.endsWith('/TZP-3')) return reply({ status: 503, body: {} })
      if (url.endsWith('/TZP-4')) return reply({ status: 200, body: { productId: 'TZP-4' } })
      return reply({ status: 200, body: card('TZP-5', 'Dal') })
    })
    const products = await catalog.getRailProducts(['TZP-5', 'TZP-2', 'TZP-1', 'TZP-3', 'TZP-4'])
    expect(products.map((p) => p.productId)).toEqual(['TZP-5', 'TZP-1'])
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('never calls the backend for a malformed product or node id', async () => {
    expect(await catalog.getProduct('../admin')).toBeNull()
    expect(await catalog.getChildCategories('TZC-1')).toBeNull()
    expect(await catalog.getCategoryProducts('x', null)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  const node = (id: string, name: string) => ({ id, name, resolvedReleaseId: 'R1', requestId: 'r' })

  it('reads one category by id, cached, at any depth; 404 is null; a body naming another node is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/TZG-000004'))
        return reply({ status: 200, body: node('TZG-000004', ' Basmati ') })
      if (url.endsWith('/TZG-000005'))
        return reply({ status: 200, body: node('TZG-000006', 'Other') })
      if (url.endsWith('/TZG-000007')) return reply({ status: 200, body: node('TZG-000007', '  ') })
      if (url.endsWith('/TZG-000008')) return reply({ status: 503, body: {} })
      return reply({ status: 404, body: {} })
    })
    expect(await catalog.getCategory('TZG-000004')).toEqual({ id: 'TZG-000004', name: 'Basmati' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${API}/v1/categories/TZG-000004`)
    expect(init).toMatchObject({ next: { revalidate: 60 } })
    expect(await catalog.getCategory('TZG-000003')).toBeNull()
    expect(await catalog.getCategory('TZG-000005')).toBe('unavailable')
    expect(await catalog.getCategory('TZG-000007')).toBe('unavailable')
    expect(await catalog.getCategory('TZG-000008')).toBe('unavailable')
    fetchMock.mockClear()
    expect(await catalog.getCategory('TZG-12')).toBeNull()
    expect(await catalog.getCategory('TZP-000001')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves category names with one by-id read per distinct id, never walking the tree', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/TZS-000001'))
        return reply({ status: 200, body: node('TZS-000001', 'Staples') })
      if (url.endsWith('/TZG-000004'))
        return reply({ status: 200, body: node('TZG-000004', 'Basmati') })
      if (url.endsWith('/TZC-000009')) return reply({ status: 429, body: {} })
      return reply({ status: 404, body: {} })
    })
    const names = await catalog.resolveCategoryNames(
      'TZS-000001,TZG-000004,TZG-000003,TZC-000009,TZS-000001,nope',
    )
    expect([...names]).toEqual([
      ['TZS-000001', 'Staples'],
      ['TZG-000004', 'Basmati'],
    ])
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${API}/v1/categories/TZS-000001`,
      `${API}/v1/categories/TZG-000004`,
      `${API}/v1/categories/TZG-000003`,
      `${API}/v1/categories/TZC-000009`,
    ])
  })

  it('search: rejected query is "rejected", paging cursor passed back untouched, never cached', async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: 400, body: {} }))
    expect(await catalog.searchProducts('x y', null)).toBe('rejected')
    fetchMock.mockResolvedValueOnce(
      reply({
        status: 200,
        body: { items: [card('TZP-1', 'Rice')], hasMore: true, nextCursor: 'abc.DEF_1' },
      }),
    )
    const page = await catalog.searchProducts('rice', 'c1')
    expect(page).toMatchObject({ nextCursor: 'abc.DEF_1', items: [{ productId: 'TZP-1' }] })
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe(`${API}/v1/search?q=rice&page_size=24&cursor=c1`)
    expect(init).toMatchObject({ cache: 'no-store' })
  })

  it('category first page is cached, cursor pages are not', async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { items: [], hasMore: false } }))
    await catalog.getCategoryProducts('TZC-000002', null)
    await catalog.getCategoryProducts('TZC-000002', 'next1')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ next: { revalidate: 60 } })
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ cache: 'no-store' })
  })
})

describe('home degradation log', () => {
  const report = (over: Partial<Record<string, number>> = {}) => ({
    unknownType: 0,
    malformed: 0,
    invalidIds: 0,
    invalidLinks: 0,
    imagesNotAllowed: 0,
    ...over,
  })

  it('logs counts only, once per change or per minute, and nothing for a clean response', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    catalog.logHomeReport(report(), true, 1_000)
    expect(warn).not.toHaveBeenCalled()
    catalog.logHomeReport(report({ unknownType: 1, imagesNotAllowed: 2 }), false, 1_000)
    catalog.logHomeReport(report({ unknownType: 1, imagesNotAllowed: 2 }), false, 30_000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toBe(
      'storefront_home_blocks_degraded unknown_type=1 malformed=0 invalid_ids=0 invalid_links=0 images_not_allowed=2 media_base=unset',
    )
    catalog.logHomeReport(report({ unknownType: 2 }), false, 31_000) // counts changed
    catalog.logHomeReport(report({ unknownType: 2 }), false, 92_000) // a minute later
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('home read logs the counts of a degraded response and still renders the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValueOnce(
      reply({
        status: 200,
        body: {
          blocks: [
            { blockId: 'V', type: 'VIDEO', title: 'v' },
            { blockId: 'R', type: 'PRODUCT_RAIL', title: 'R', ids: ['TZP-1', '../x?y=1'] },
          ],
        },
      }),
    )
    const home = await catalog.getHomeBlocks()
    expect(home).toMatchObject({ ok: true, blocks: [{ blockId: 'R', ids: ['TZP-1'] }] })
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('storefront_home'))
    expect(line).toContain('unknown_type=1')
    expect(line).toContain('invalid_ids=1')
    expect(line).toContain('media_base=configured')
    expect(line).not.toMatch(/TZP|\?|http/)
  })
})
