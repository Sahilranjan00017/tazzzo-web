import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const API = 'https://api.tazzzo.test'

beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', API)
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  vi.stubEnv('STOREFRONT_SESSION_SECRET', 'q'.repeat(43))
  vi.stubEnv('TAZZZO_CALLER_NAME', 'storefront')
  vi.stubEnv('TAZZZO_CALLER_SECRET', 's'.repeat(40))
})

const { resetFailureMemory } = await import('@/server/backend/client')
const { getFaqs, getLegal, getSupportContacts } = await import('@/server/backend/content')

const fetchMock =
  vi.fn<(input: string, init?: RequestInit & { next?: unknown }) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetFailureMemory()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getLegal', () => {
  const doc = {
    slug: 'terms',
    title: 'Terms',
    body: 'A.\n\nB.',
    effectiveDate: null,
    requestId: 'r',
  }

  it('reads /v1/content/legal/{slug} through the hardened client (cached, no redirects, trusted caller)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, doc))
    const result = await getLegal('terms')
    expect(result).toMatchObject({
      ok: true,
      document: { title: 'Terms', paragraphs: ['A.', 'B.'] },
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${API}/v1/content/legal/terms`)
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'X-Tazzzo-Caller': 'storefront' },
    })
  })

  it('a flat 404 is "unpublished", not an error', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: 'NOT_FOUND', message: 'x', requestId: 'r' }))
    expect(await getLegal('privacy')).toEqual({ ok: false, reason: 'unpublished' })
  })

  it.each([429, 500, 503])('%s is "unavailable"', async (status) => {
    fetchMock.mockResolvedValueOnce(json(status, {}))
    expect(await getLegal('terms')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('a malformed or mismatched body is "unavailable" (never half-rendered)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...doc, slug: 'privacy' }))
    expect(await getLegal('terms')).toEqual({ ok: false, reason: 'unavailable' })
    fetchMock.mockResolvedValueOnce(json(200, { slug: 'terms', title: 'T' }))
    expect(await getLegal('terms')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('never builds a path from anything but the two slugs', async () => {
    // @ts-expect-error deliberately outside the type
    expect(await getLegal('../../v1/customer/orders')).toEqual({ ok: false, reason: 'unpublished' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getFaqs', () => {
  it('reads /v1/content/faqs with no query string', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        faqs: [{ faqId: 'A', category: 'DELIVERY', question: 'Q?', answer: 'A.' }],
        requestId: 'r',
      }),
    )
    const result = await getFaqs()
    expect(result.ok && result.faqs).toHaveLength(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API}/v1/content/faqs`)
  })

  it('is unavailable on failure or a body without a list', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}))
    expect(await getFaqs()).toEqual({ ok: false, reason: 'unavailable' })
    fetchMock.mockResolvedValueOnce(json(200, { nope: 1 }))
    expect(await getFaqs()).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('getSupportContacts', () => {
  it('returns only validated contacts from /v1/app-config', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { storeOpen: true, support: { phone: '+918012345678', email: 'not an email' } }),
    )
    expect(await getSupportContacts()).toEqual({ phone: '+918012345678', email: null })
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API}/v1/app-config`)
  })

  it('is null when the config cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}))
    expect(await getSupportContacts()).toBeNull()
  })
})

describe('take-down and replacement reach the pages within the 60 s window', () => {
  const minutes = (n: number) => n * 60_000 // the body is fresh 60 s, then served up to 10 s more while a refresh runs
  const legal = (title: string) =>
    json(200, { slug: 'terms', title, body: 'A.', effectiveDate: null, requestId: 'r' })

  it('legal: 200 -> 404 shows "unpublished" after the minute; a replaced document shows its new text', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fetchMock.mockImplementation(async () => legal('Terms v1'))
      expect(await getLegal('terms')).toMatchObject({ ok: true, document: { title: 'Terms v1' } })
      fetchMock.mockImplementation(async () => legal('Terms v2'))
      expect(await getLegal('terms')).toMatchObject({ ok: true, document: { title: 'Terms v1' } })
      expect(fetchMock).toHaveBeenCalledTimes(1) // one backend call per URL per minute
      vi.setSystemTime(Date.now() + minutes(1) + 11_000)
      expect(await getLegal('terms')).toMatchObject({ ok: true, document: { title: 'Terms v2' } })
      fetchMock.mockImplementation(async () => json(404, { code: 'NOT_FOUND', requestId: 'r' }))
      vi.setSystemTime(Date.now() + minutes(1) + 11_000)
      expect(await getLegal('terms')).toEqual({ ok: false, reason: 'unpublished' })
      expect(await getLegal('terms')).toEqual({ ok: false, reason: 'unpublished' })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('FAQs and support contacts follow the backend within the minute too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const faq = { faqId: 'F1', category: 'DELIVERY', question: 'Q?', answer: 'A.' }
      fetchMock.mockImplementation(async () => json(200, { faqs: [faq], requestId: 'r' }))
      expect(await getFaqs()).toMatchObject({ ok: true, faqs: [{ question: 'Q?' }] })
      fetchMock.mockImplementation(async () => json(200, { faqs: [], requestId: 'r' }))
      vi.setSystemTime(Date.now() + minutes(1) + 11_000)
      expect(await getFaqs()).toEqual({ ok: true, faqs: [] })

      const config = (phone: string) => json(200, { support: { phone }, requestId: 'r' })
      fetchMock.mockImplementation(async () => config('+918012345678'))
      expect(await getSupportContacts()).toMatchObject({ phone: '+918012345678' })
      fetchMock.mockImplementation(async () => config('+918099999999'))
      vi.setSystemTime(Date.now() + minutes(1) + 11_000)
      expect(await getSupportContacts()).toMatchObject({ phone: '+918099999999' })
    } finally {
      vi.useRealTimers()
    }
  })
})
