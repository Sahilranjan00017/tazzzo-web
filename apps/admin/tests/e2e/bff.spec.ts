import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import { READER_SUB, WRITER_SUB } from '../support/fake-backend'

const BASE = `http://localhost:3988`
const OIDC = () => process.env.E2E_OIDC_URL!
const BACKEND = () => process.env.E2E_BACKEND_URL!
const DEV_SESSION_COOKIE = 'tz_cms_session_dev'
const BFF = '/api/bff/catalog/products/TZP-REF-1/title'

type Recorded = {
  method: string
  path: string
  authorization?: string
  sub?: string
  headers: Record<string, unknown>
}

async function control(request: APIRequestContext, path: string, body?: unknown) {
  return request.post(`${BACKEND()}/__control/${path}`, { data: body ?? {} })
}
async function backendRequests(request: APIRequestContext): Promise<Recorded[]> {
  return (await request.get(`${BACKEND()}/__control/requests`)).json() as Promise<Recorded[]>
}

async function signIn(page: Page, sub: string) {
  await page.request.post(`${OIDC()}/__control/identity`, {
    data: { sub, email: `${sub}@tazzzo.test` },
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?returnTo=/)
  await page.getByRole('link', { name: 'Sign in with Google' }).click()
  await expect(page).toHaveURL(`${BASE}/`)
  await expect(
    page.getByRole('button', { name: `Account menu for ${sub}@tazzzo.test` }),
  ).toBeVisible()
}

async function renameViaUi(page: Page, title: string, version: number) {
  await page.goto('/reference/product-title')
  await page.getByLabel('Product id').fill('TZP-REF-1')
  await page.getByLabel('Expected version').fill(String(version))
  await page.getByLabel('New title').fill(title)
  await page.getByRole('button', { name: 'Save title' }).click()
}

test.beforeEach(async ({ request }) => {
  await control(request, 'reset')
})

test('unauthenticated -> login -> mock Google -> protected page', async ({ page }) => {
  await signIn(page, WRITER_SUB)
  await expect(page.getByText('You can view and edit catalogue content.')).toBeVisible()
})

test('a writer mutation goes browser -> BFF -> backend as the human and succeeds', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await renameViaUi(page, 'Basmati Rice 5 kg', 3)
  await expect(page.getByRole('status')).toHaveText('Saved. New version 4.')
  const patch = (await backendRequests(request)).filter((r) => r.method === 'PATCH')
  expect(patch).toHaveLength(1)
  expect(patch[0]).toMatchObject({ path: '/api/v1/products/TZP-REF-1', sub: WRITER_SUB })
  expect(patch[0]!.headers.cookie).toBeUndefined()
})

test('a reader is denied by the backend and stays signed in', async ({ page }) => {
  await signIn(page, READER_SUB)
  await renameViaUi(page, 'Nope', 3)
  await expect(page.getByRole('status')).toHaveText(
    'Access denied: your role cannot make this change.',
  )
  await page.goto('/')
  await expect(
    page.getByRole('button', { name: `Account menu for ${READER_SUB}@tazzzo.test` }),
  ).toBeVisible()
})

test('a backend 401 ends the session and returns the browser to login', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await control(request, 'mutation', { status: 401 })
  await renameViaUi(page, 'x', 3)
  await expect(page).toHaveURL(/\/login\?error=expired/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?returnTo=/)
})

test('CSRF: only a same-origin request with the custom header may mutate', async ({
  page,
  context,
}) => {
  await signIn(page, WRITER_SUB)
  const send = (headers: Record<string, string>) =>
    context.request.patch(BFF, {
      headers: { 'content-type': 'application/json', ...headers },
      data: { title: 'T', expectedVersion: 3 },
    })
  expect((await send({ origin: BASE })).status()).toBe(403)
  expect((await send({ origin: 'https://evil.example', 'x-tazzzo-csrf': '1' })).status()).toBe(403)
  expect((await send({ origin: 'null', 'x-tazzzo-csrf': '1' })).status()).toBe(403)
  expect(
    (await send({ referer: 'https://evil.example/page', 'x-tazzzo-csrf': '1' })).status(),
  ).toBe(403)
  const ok = await send({ origin: BASE, 'x-tazzzo-csrf': '1' })
  expect(ok.status()).toBe(200)
})

test('a forged cookie without a stored session cannot mutate', async ({ browser, request }) => {
  const context: BrowserContext = await browser.newContext({ baseURL: BASE })
  await context.addCookies([{ name: DEV_SESSION_COOKIE, value: 'f'.repeat(43), url: BASE }])
  const res = await context.request.patch(BFF, {
    headers: { 'content-type': 'application/json', origin: BASE, 'x-tazzzo-csrf': '1' },
    data: { title: 'T', expectedVersion: 3 },
  })
  expect(res.status()).toBe(401)
  expect((await backendRequests(request)).filter((r) => r.method === 'PATCH')).toEqual([])
  await context.close()
})

test('the ID token never reaches the browser, and every backend call carries a verified human token', async ({
  page,
  context,
  request,
}) => {
  const seen: string[] = []
  page.on('console', (m) => seen.push(m.text()))
  page.on('framenavigated', (f) => seen.push(f.url()))
  page.on('response', async (r) => {
    seen.push(r.url(), JSON.stringify(await r.allHeaders()))
    try {
      seen.push(await r.text())
    } catch {
      // redirects have no body
    }
  })
  await signIn(page, WRITER_SUB)
  await renameViaUi(page, 'Leak check', 3)
  await expect(page.getByRole('status')).toContainText('Saved')
  seen.push(JSON.stringify(await context.cookies()))
  // Read-only inspection proving browser storage holds no token (the storage ban targets product code).
  /* eslint-disable no-restricted-globals */
  seen.push(
    await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    ),
  )
  /* eslint-enable no-restricted-globals */

  const calls = await backendRequests(request)
  const tokens = [
    ...new Set(calls.map((c) => c.authorization?.replace(/^Bearer /, '')).filter(Boolean)),
  ] as string[]
  expect(tokens.length).toBeGreaterThan(0)
  const browserView = seen.join('\n')
  for (const token of tokens) {
    expect(browserView).not.toContain(token)
    expect(browserView).not.toContain(token.split('.')[1]!)
  }
  for (const call of calls) {
    expect(call.sub, `${call.method} ${call.path}`).toBeTruthy()
    expect(String(call.authorization)).not.toMatch(/cms-writer|service/i)
  }
})

test('security headers on pages and BFF responses', async ({ page, context }) => {
  await signIn(page, WRITER_SUB)
  const html = await page.request.get('/reference/product-title')
  const pageHeaders = html.headers()
  expect(pageHeaders['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(pageHeaders['content-security-policy']).toMatch(/script-src 'self' 'nonce-/)
  const api = await context.request.patch(BFF, {
    headers: { 'content-type': 'application/json', origin: BASE, 'x-tazzzo-csrf': '1' },
    data: { title: 'H', expectedVersion: 3 },
  })
  for (const headers of [pageHeaders, api.headers()]) {
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('no-referrer')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
  }
  expect(api.headers()['cache-control']).toBe('no-store')
})

test('dashboard (mock backend): shows counts, flags capped values, forwards only the human token', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  const low = page.locator('.kpi', { hasText: 'Low-stock' })
  await expect(low).toContainText('10,000+')
  await expect(low).toContainText('Lower bound')
  await expect(page.locator('.kpi', { hasText: 'Open: confirmed' })).toContainText('7')
  const calls = (await backendRequests(request)).filter((r) =>
    r.path.endsWith('/dashboard/summary'),
  )
  expect(calls).toHaveLength(1)
  expect(calls[0]!.sub).toBe(WRITER_SUB)
  expect(calls[0]!.authorization).toMatch(/^Bearer ey/)
  expect(calls[0]!.headers['cookie']).toBeUndefined()
})

test('dashboard (mock backend): a backend outage shows an error with retry and no numbers', async ({
  page,
  request,
}) => {
  await signIn(page, READER_SUB)
  await control(request, 'dashboard', { status: 503 })
  await page.goto('/dashboard')
  await expect(page.locator('.panel-error')).toContainText('Dashboard unavailable')
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(page.locator('.kpi')).toHaveCount(0)
})
