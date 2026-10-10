import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
})

const { resetFailureMemory } = await import('@/server/backend/client')
const fetchMock = vi.fn<(input: string) => Promise<Response>>()
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

function backend(legal: { terms: boolean; privacy: boolean }) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/v1/categories') {
      return json(200, { items: [{ id: 'TZS-000001', name: 'Staples' }], requestId: 'r' })
    }
    const slug = /^\/v1\/content\/legal\/(terms|privacy)$/.exec(path)?.[1] as 'terms' | 'privacy'
    if (slug && legal[slug]) {
      return json(200, { slug, title: slug, body: 'Text.', effectiveDate: null, requestId: 'r' })
    }
    return json(404, {})
  })
}

describe('sitemap.xml', () => {
  it('lists FAQ and Contact always, and each legal page only while it is published', async () => {
    backend({ terms: true, privacy: false })
    const sitemap = (await import('@/app/sitemap')).default
    const urls = (await sitemap()).map((e) => e.url)
    expect(urls).toEqual([
      'https://www.tazzzo.test/',
      'https://www.tazzzo.test/faq',
      'https://www.tazzzo.test/contact',
      'https://www.tazzzo.test/terms',
      'https://www.tazzzo.test/c/TZS-000001',
    ])
  })

  it('lists both legal pages when both are published', async () => {
    backend({ terms: true, privacy: true })
    const sitemap = (await import('@/app/sitemap')).default
    const urls = (await sitemap()).map((e) => e.url)
    expect(urls).toContain('https://www.tazzzo.test/privacy')
    expect(urls).toContain('https://www.tazzzo.test/terms')
  })

  it('still lists the static help pages when the backend is down', async () => {
    fetchMock.mockImplementation(async () => json(503, {}))
    const sitemap = (await import('@/app/sitemap')).default
    expect((await sitemap()).map((e) => e.url)).toEqual([
      'https://www.tazzzo.test/',
      'https://www.tazzzo.test/faq',
      'https://www.tazzzo.test/contact',
    ])
  })
})

describe('robots.txt', () => {
  it('does not disallow any help page (FAQ, privacy, terms, contact)', async () => {
    const robots = (await import('@/app/robots')).default
    const { rules } = robots() as { rules: { allow: string; disallow: string[] } }
    expect(rules.allow).toBe('/')
    for (const path of ['/faq', '/privacy', '/terms', '/contact']) {
      expect(rules.disallow.some((d) => path.startsWith(d))).toBe(false)
    }
  })
})

describe('proxy matcher semantics are unchanged by the launch pages', () => {
  it('the same five entries: two prefetch-exempt page entries, /api, sitemap, robots', async () => {
    const { config } = await import('@/proxy')
    expect(config.matcher).toEqual([
      {
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        missing: [{ type: 'header', key: 'rsc', value: '1' }],
      },
      {
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        missing: [{ type: 'header', key: 'next-router-prefetch', value: '1' }],
      },
      { source: '/api/:path*' },
      { source: '/sitemap.xml' },
      { source: '/robots.txt' },
    ])
  })

  it('the new routes are ordinary pages (matched by the page entries, not excluded)', async () => {
    const { config } = await import('@/proxy')
    const entry = config.matcher[0] as { source: string }
    const re = new RegExp(`^${entry.source}$`)
    for (const path of ['/faq', '/privacy', '/terms', '/contact']) expect(re.test(path)).toBe(true)
    expect(re.test('/favicon.ico')).toBe(false) // the static icon is deliberately outside the limiter
  })
})

describe('source policy for the launch pages', () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url))
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
    )

  it('no source file uses dangerouslySetInnerHTML', () => {
    const offenders = files(join(appRoot, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /dangerouslySetInnerHTML/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no NEXT_PUBLIC variable is read anywhere', () => {
    const offenders = files(join(appRoot, 'src'))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) =>
        /process\.env\.NEXT_PUBLIC_|NEXT_PUBLIC_[A-Z_]+\s*=/.test(readFileSync(f, 'utf8')),
      )
    expect(offenders).toEqual([])
  })

  it('a static favicon is served from public/ (the proxy matcher already excludes favicon.ico)', () => {
    const ico = readFileSync(join(appRoot, 'public', 'favicon.ico'))
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]) // ICONDIR: reserved 0, type 1 (icon)
  })
})
