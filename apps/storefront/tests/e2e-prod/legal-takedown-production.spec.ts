import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * A legal take-down must reach the website within the minute the CMS promises. The storefront reads the document
 * through a 60 s per-URL memory; the Next data cache it used to rely on keeps serving a stale 200 for ever once the
 * backend answers 404 (it never stores the 404), which kept withdrawn Terms on screen. This runs against the
 * PRODUCTION build (`next start`) and the fake backend: Terms 200 -> 404 shows the friendly "not published" page
 * (HTTP 200, noindex, left out of the sitemap) within ~70 s, a published document comes back, and the backend sees
 * about one read per minute (the limiter is why reads are cached), not one per page view.
 */
const backend = () => process.env.E2E_BACKEND_URL!
const WINDOW_MS = 85_000

async function control(query: string): Promise<void> {
  const res = await fetch(`${backend()}/__control/content?${query}`, { method: 'POST' })
  expect(res.status).toBe(200)
}

async function termsReads(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${backend()}/__control/requests`)
  const all = (await res.json()) as { method: string; path: string }[]
  return all.filter((r) => r.method === 'GET' && r.path === '/v1/content/legal/terms').length
}

async function termsState(request: APIRequestContext) {
  const res = await request.get('/terms')
  const html = await res.text()
  return {
    status: res.status(),
    published: html.includes('By using Tazzzo you agree to these terms.'),
    unpublished: html.includes('This document hasn&#x27;t been published yet.'),
    noindex: /<meta name="robots" content="noindex/.test(html),
  }
}

async function until(
  request: APIRequestContext,
  want: 'published' | 'unpublished',
): Promise<number> {
  const started = Date.now()
  for (;;) {
    const state = await termsState(request)
    expect(state.status).toBe(200)
    if (state[want]) return Date.now() - started
    if (Date.now() - started > WINDOW_MS) {
      throw new Error(
        `/terms still not "${want}" after ${WINDOW_MS / 1000} s: ${JSON.stringify(state)}`,
      )
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

test.describe.configure({ mode: 'serial' })

test('Terms 200 -> 404 on the backend is "not published" within ~70 s, then published again within ~70 s', async ({
  request,
}) => {
  test.setTimeout(4 * 60_000)
  await control('terms=published')
  const before = await termsReads(request)
  // Warm: whatever the earlier specs left, wait until the page shows the published text.
  await until(request, 'published')
  expect(await termsState(request)).toMatchObject({ status: 200, published: true, noindex: false })

  await control('terms=unpublished')
  const tookDown = await until(request, 'unpublished')
  expect(tookDown).toBeLessThanOrEqual(WINDOW_MS)
  expect(await termsState(request)).toMatchObject({ status: 200, published: false, noindex: true })
  const sitemap = await (await request.get('/sitemap.xml')).text()
  expect(sitemap).not.toContain('/terms')

  // Rate-limit protection: dozens of page views, a handful of backend reads (one per minute per URL).
  const reads = (await termsReads(request)) - before
  expect(reads).toBeLessThanOrEqual(Math.ceil((tookDown + 60_000) / 60_000) + 2)

  // A document that comes back (or is replaced) shows up within the minute as well; this also restores the default state.
  await control('terms=published')
  await until(request, 'published')
})
