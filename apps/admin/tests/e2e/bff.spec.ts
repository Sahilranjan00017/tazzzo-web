import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import { AUDIT_SUB, OPS_SUB, READER_SUB, SUPPORT_SUB, WRITER_SUB } from '../support/fake-backend'

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

test('products (mock backend): list, open, rename, activate; reader is read-only', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/products')
  await expect(page.getByRole('link', { name: 'TZP-REF-1' })).toBeVisible()
  await page.getByRole('link', { name: 'TZP-REF-1' }).click()
  await expect(page.getByRole('heading', { name: 'Basmati 5 kg' })).toBeVisible()

  await page.getByLabel('Title', { exact: true }).fill('Basmati 10 kg')
  await page.getByRole('button', { name: 'Save title' }).click()
  await expect(page.getByRole('heading', { name: 'Basmati 10 kg' })).toBeVisible()

  await page.getByRole('button', { name: 'Activate' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Activate' }).click()
  await expect(page.getByText('active', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retire' })).toBeVisible()

  const writes = (await backendRequests(request)).filter(
    (r) => r.method !== 'GET' && r.path.includes('/products/'),
  )
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
    'PATCH /api/v1/products/TZP-REF-1',
    'POST /api/v1/products/TZP-REF-1/activate',
  ])
  expect(writes.every((w) => w.sub === WRITER_SUB)).toBe(true)
})

test('products (mock backend): a concurrent edit gives a stale-version message and a reload, not an overwrite', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/products/TZP-REF-1')
  await page.getByLabel('Title', { exact: true }).fill('Mine')
  await control(request, 'bump-product', { id: 'TZP-REF-1' })
  await page.getByRole('button', { name: 'Save title' }).click()
  await expect(page.getByText(/changed this since you loaded/)).toBeVisible()
  await expect(page.getByRole('heading', { name: /edited elsewhere/ })).toBeVisible()
})

test('products (mock backend): read-only role sees no edit or create controls', async ({
  page,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/catalogue/products/TZP-REF-1')
  await expect(page.getByText('Read-only: editing needs the cms-writer role')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save title' })).toHaveCount(0)
  await page.goto('/catalogue/products')
  await expect(page.getByRole('link', { name: 'New product' })).toHaveCount(0)
})

test('taxonomy (mock backend): browse, rename is refused without an open release, then succeeds after opening one', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/taxonomy')
  await page.getByRole('link', { name: 'Staples' }).click()
  await expect(page.getByRole('heading', { name: 'Children' })).toBeVisible()
  await page.getByRole('link', { name: 'Rice' }).click()
  await expect(page.getByRole('heading', { name: 'Change “Rice”' })).toBeVisible()

  await page.getByLabel('Name', { exact: true }).fill('Rice and grains')
  await page.getByRole('button', { name: 'Rename' }).click()
  await expect(page.getByText(/Open a release first/)).toBeVisible()

  await page.goto('/catalogue/taxonomy/releases')
  await page.getByLabel('New release id').fill('REL-2026-10')
  await page.getByRole('button', { name: 'Open release' }).click()
  await expect(page.getByText('Release opened.')).toBeVisible()

  await page.goto('/catalogue/taxonomy?parent=TZC-000001')
  await page.getByLabel('Name', { exact: true }).fill('Rice and grains')
  await page.getByRole('button', { name: 'Rename' }).click()
  await expect(
    page.getByRole('heading', { name: 'Rice and grains', level: 2 }).first(),
  ).toBeVisible()
})

test('taxonomy (mock backend): a reader browses read-only', async ({ page }) => {
  await signIn(page, READER_SUB)
  await page.goto('/catalogue/taxonomy?parent=TZC-000001')
  await expect(
    page.getByText('Read-only: changing the taxonomy needs the cms-writer role'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename' })).toHaveCount(0)
})

test('pricing (mock backend): find a SKU, update price with a before/after confirmation, human-attributed', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/pricing?sku=TZP-REF-1')
  await expect(page.getByText('₹129.00')).toBeVisible()
  await page.getByLabel('Selling price (₹)').fill('119.50')
  await page.getByRole('button', { name: 'Review change' }).click()
  await expect(page.getByRole('dialog')).toContainText('₹129.00 → ₹119.50')
  await page.getByRole('dialog').getByRole('button', { name: 'Update price' }).click()
  await expect(page.getByText('Price saved.')).toBeVisible()
  const put = (await backendRequests(request)).filter((r) => r.method === 'PUT')
  expect(put).toHaveLength(1)
  expect(put[0]!.sub).toBe(WRITER_SUB)
})

test('pricing (mock backend): a reader sees the price read-only', async ({ page, request }) => {
  await signIn(page, READER_SUB)
  await page.goto('/pricing?sku=TZP-REF-1')
  await expect(page.getByText('Read-only: changing prices needs the cms-writer role')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review change' })).toHaveCount(0)
  await request.post(`${BACKEND()}/__control/reset`)
})

test('inventory (mock backend): absolute stock set, reserved floor enforced by the backend, deactivate', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/inventory?sku=TZP-REF-1&location=LOC-1')
  await expect(page.getByText('In stock')).toBeVisible()
  await page.getByLabel('On-hand quantity').fill('30')
  await page.getByRole('button', { name: 'Review change' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save stock' }).click()
  await expect(page.getByRole('term').filter({ hasText: 'On hand' })).toBeVisible()
  await expect(page.getByText('30', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Deactivate' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByText('Inactive')).toBeVisible()
})

test('inventory (mock backend): unknown location shows a create form with an orphan-record warning', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/inventory?sku=TZP-REF-1&location=NEW-LOC')
  await expect(
    page.getByText('No stock record exists for this product at this location.'),
  ).toBeVisible()
  await expect(page.getByText(/orphan record/)).toBeVisible()
})

const csv = (text: string) => ({
  name: 'prices.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(text),
})

test('imports (mock backend): upload, map, dry run, apply with a per-row failure and a failed-rows download', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/imports')
  await page
    .getByLabel('CSV file (UTF-8, up to 2 MiB)')
    .setInputFiles(csv('SKU,Price,MRP,Version\nTZP-REF-1,110,130,\n'))
  await expect(page.getByRole('heading', { name: /Map columns/ })).toBeVisible()
  await expect(page.getByText('1 valid')).toBeVisible()
  await page.getByRole('button', { name: 'Validate with the backend (dry run)' }).click()
  await expect(page.getByText(/The dry run passed for all 1 rows/)).toBeVisible()
  await page.getByRole('button', { name: 'Apply 1 rows…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply import' }).click()
  // The mock already has a price for TZP-REF-1 and the row has no expected version, so the backend reports a row failure.
  await expect(page.getByRole('heading', { name: '4. Result' })).toBeVisible()
  await expect(page.getByText('1 failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download failed rows (CSV)' })).toBeVisible()
  const calls = (await backendRequests(request)).filter((r) => r.path.includes('/imports/'))
  expect(calls).toHaveLength(2)
  expect(calls.every((c) => c.sub === WRITER_SUB)).toBe(true)
  expect(JSON.parse((calls[0] as unknown as { body: string }).body).dryRun).toBe(true)
  expect(JSON.parse((calls[1] as unknown as { body: string }).body).dryRun).toBe(false)
})

test('imports (mock backend): a backend rejection shows the row error and nothing is applied', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/imports')
  await page
    .getByLabel('CSV file (UTF-8, up to 2 MiB)')
    .setInputFiles(csv('SKU,Price,MRP\nTZP-REF-1,110,130\nTZP-NOPE,5,6\n'))
  await page.getByRole('button', { name: 'Validate with the backend (dry run)' }).click()
  await expect(page.getByText(/UNKNOWN_PRODUCT: no product TZP-NOPE/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Apply/ })).toHaveCount(0)
  const calls = (await backendRequests(request)).filter((r) => r.path.includes('/imports/'))
  expect(calls).toHaveLength(1)
})

test('imports (mock backend): invalid local rows block the run until skipped; non-CSV files are refused', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/catalogue/imports')
  await page.getByLabel('CSV file (UTF-8, up to 2 MiB)').setInputFiles({
    name: 'x.xlsx',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from('x'),
  })
  await expect(page.getByText('Only .csv files are supported')).toBeVisible()
  await page
    .getByLabel('CSV file (UTF-8, up to 2 MiB)')
    .setInputFiles(csv('SKU,Price,MRP\nTZP-REF-1,110,130\nTZP-2,abc,1\n'))
  await expect(page.getByText('1 with errors')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Validate with the backend (dry run)' }),
  ).toBeDisabled()
  await page.getByLabel(/Skip the 1 invalid rows/).check()
  await expect(
    page.getByRole('button', { name: 'Validate with the backend (dry run)' }),
  ).toBeEnabled()
})

test('orders (mock backend): order-ops lists, opens, advances and cancels with a required reason', async ({
  page,
  request,
}) => {
  await signIn(page, OPS_SUB)
  await page.goto('/orders')
  await expect(page.getByRole('link', { name: 'O-100' })).toBeVisible()
  await page.getByRole('link', { name: 'O-100' }).click()
  await expect(page.getByRole('heading', { name: 'Order O-100' })).toBeVisible()
  await expect(page.getByText('Basmati 5 kg')).toBeVisible()
  expect(await page.content()).not.toContain('77.6')

  await page.getByRole('button', { name: 'Mark out for delivery' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mark out for delivery' }).click()
  await expect(page.getByText('Order is out for delivery.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark delivered' })).toBeVisible()

  await page.getByRole('button', { name: 'Cancel order' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Cancel order' })).toBeDisabled()
  await dialog.getByLabel('Cancellation reason (required)').selectOption('CUSTOMER_UNREACHABLE')
  await dialog.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText('Order cancelled.')).toBeVisible()
  await expect(page.getByText(/final and has no further actions/)).toBeVisible()
  await expect(page.getByText(/Customer unreachable/)).toBeVisible()

  const writes = (await backendRequests(request)).filter((r) => r.method === 'POST')
  expect(writes.map((w) => w.path)).toEqual([
    '/api/v1/admin/orders/O-100/transition',
    '/api/v1/admin/orders/O-100/transition',
  ])
  expect(writes.every((w) => w.sub === OPS_SUB)).toBe(true)
})

test('orders (mock backend): support-agent reads orders but cannot transition (UI hidden, backend 403)', async ({
  page,
  request,
}) => {
  await signIn(page, SUPPORT_SUB)
  await page.goto('/orders/O-100')
  await expect(
    page.getByText('Read-only: changing an order needs the order-ops role'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0)
  // Direct POST as support-agent is refused by the (mock) backend with 403 and stays signed in.
  const r = await page.request.post('/api/bff/orders/O-100/transition', {
    headers: { origin: BASE, 'x-tazzzo-csrf': '1', 'content-type': 'application/json' },
    data: { to: 'OUT_FOR_DELIVERY', expectedVersion: 2 },
  })
  expect(r.status()).toBe(403)
  await request.post(`${BACKEND()}/__control/reset`)
})

test('orders (mock backend): a general role is refused by the backend and sees a permission state', async ({
  page,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/orders')
  await expect(page.locator('.panel-error')).toContainText('Not permitted')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('support (mock backend): support-agent opens a case, assigns, replies and resolves; message HTML stays inert', async ({
  page,
  request,
}) => {
  await signIn(page, SUPPORT_SUB)
  await page.goto('/support')
  await page.getByRole('link', { name: 'Late order' }).click()
  await expect(page.getByText('<b>where</b> is my order')).toBeVisible()
  await expect(page.locator('.msg-text b')).toHaveCount(0)

  await page.getByRole('button', { name: 'Assign to me' }).click()
  await expect(page.getByText('Assigned to you.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Assign to me' })).toHaveCount(0)

  await page.getByLabel('Reply to the customer').fill('We are checking this now.')
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('Reply sent.')).toBeVisible()
  await expect(page.getByText('We are checking this now.')).toBeVisible()

  await page.getByRole('button', { name: 'Mark resolved' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mark resolved' }).click()
  await expect(page.getByText('Status updated.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()

  const writes = (await backendRequests(request)).filter((r) => r.method === 'POST')
  expect(writes.map((w) => w.path.split('/').pop())).toEqual(['assign', 'messages', 'status'])
  expect(writes.every((w) => w.sub === SUPPORT_SUB)).toBe(true)
})

test('support (mock backend): order-ops reads cases but cannot work them; a general role is refused', async ({
  page,
}) => {
  await signIn(page, OPS_SUB)
  await page.goto('/support/SUP_1')
  await expect(
    page.getByText('Read-only: replying and changing cases needs the support-agent role'),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'O-100' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send reply' })).toHaveCount(0)
  const denied = await page.request.post('/api/bff/support/SUP_1/messages', {
    headers: { origin: BASE, 'x-tazzzo-csrf': '1', 'content-type': 'application/json' },
    data: { message: 'hi' },
  })
  expect(denied.status()).toBe(403)
})

test('support (mock backend): a general role sees a permission state', async ({ page }) => {
  await signIn(page, READER_SUB)
  await page.goto('/support')
  await expect(page.locator('.panel-error')).toContainText('Not permitted')
})

test('service areas (mock backend): edit routes as a whole replace, deactivate, create a new area', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/delivery/service-areas')
  await page.getByRole('link', { name: '560047' }).click()
  await expect(page.getByRole('heading', { name: 'Pincode 560047' })).toBeVisible()
  await page.getByRole('button', { name: 'Add route' }).click()
  await page.getByLabel('Location id').nth(1).fill('LOC-2')
  await page.getByLabel('Priority').nth(1).fill('2')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByRole('dialog')).toContainText('replaces ALL routes')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Service area saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Deactivate' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByText('service area deactivated.')).toBeVisible()
  await expect(page.getByText('Inactive').first()).toBeVisible()

  await page.goto('/delivery/service-areas/new')
  await page.getByLabel('Pincode').fill('560048')
  await page.getByLabel('Service area id (grouping label)').fill('Indiranagar')
  await page.getByRole('button', { name: 'Review new area' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/delivery\/service-areas\/560048$/)
  const puts = (await backendRequests(request)).filter((r) => r.method === 'PUT')
  expect(puts.map((p) => p.path)).toEqual([
    '/api/v1/admin/service-areas/560047',
    '/api/v1/admin/service-areas/560048',
  ])
  expect(puts.every((p) => p.sub === WRITER_SUB)).toBe(true)
})

test('delivery slots (mock backend): list windows, edit capacity, add a window, deactivate', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/delivery/slots?area=Ejipura')
  await expect(page.getByText('18:00–20:00')).toBeVisible()
  await page.getByRole('link', { name: 'Edit' }).click()
  await expect(page.getByRole('heading', { name: 'Edit “Evening”' })).toBeVisible()
  await page.getByLabel('Capacity (orders per day)').fill('35')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save window' }).click()
  await expect(page.getByText('Delivery window saved.')).toBeVisible()
  await expect(page.getByRole('cell', { name: '35' })).toBeVisible()

  await page.goto('/delivery/slots?area=Ejipura')
  await page.getByLabel('Window id').fill('morning')
  await page.getByLabel('Label shown to customers').fill('Morning')
  await page.getByLabel('Starts').fill('07:00')
  await page.getByLabel('Ends').fill('09:00')
  await page.getByRole('button', { name: 'Review new window' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save window' }).click()
  await expect(page.getByText('07:00–09:00')).toBeVisible()

  await page
    .getByRole('row', { name: /Morning/ })
    .getByRole('button', { name: 'Deactivate' })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByText('delivery window deactivated.')).toBeVisible()
})

test('delivery (mock backend): a reader browses areas and slots read-only', async ({ page }) => {
  await signIn(page, READER_SUB)
  await page.goto('/delivery/service-areas/560047')
  await expect(
    page.getByText('Read-only: changing service areas needs the cms-writer role'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0)
  await page.goto('/delivery/slots?area=Ejipura')
  await expect(
    page.getByText('Read-only: changing delivery windows needs the cms-writer role'),
  ).toBeVisible()
})

test('audit (mock backend): audit-reader filters the trail; a general role is refused', async ({
  page,
  request,
}) => {
  await signIn(page, AUDIT_SUB)
  await page.goto('/system/audit')
  await expect(page.getByText('CONTENT_BLOCK_CREATED')).toBeVisible()
  await page.getByLabel('Action').fill('PRICE_SET')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('CONTENT_BLOCK_CREATED')).toHaveCount(0)
  await expect(page.getByText('PRICE_SET').first()).toBeVisible()
  await page.getByText('Open').first().click()
  await expect(page.getByText('req_0123456789abcdef0123')).toBeVisible()
  const calls = (await backendRequests(request)).filter((r) =>
    r.path.startsWith('/api/v1/admin/audit-events'),
  )
  expect(calls.at(-1)!.path).toContain('action=PRICE_SET')
  expect(calls.at(-1)!.sub).toBe(AUDIT_SUB)
})

test('audit (mock backend): a reader gets a permission state and stays signed in', async ({
  page,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/system/audit')
  await expect(page.locator('.panel-error')).toContainText('audit-reader')
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('system status (mock backend): probes the health endpoints without sending any credential', async ({
  page,
  request,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/system/status')
  await expect(page.getByRole('heading', { name: 'Liveness' })).toBeVisible()
  await expect(page.getByText('UP').first()).toBeVisible()
  const health = (await backendRequests(request)).filter((r) => r.path.startsWith('/health/'))
  expect(health.length).toBeGreaterThanOrEqual(2)
  expect(health.every((h) => h.authorization === undefined)).toBe(true)
  expect(await page.content()).not.toContain('127.0.0.1')
})

test('notifications (mock backend): only the two counters; per-message detail is shown as unavailable', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/system/notifications')
  await expect(page.getByText('Pending', { exact: true })).toBeVisible()
  await expect(page.getByText(/Not available from the backend/)).toBeVisible()
  await expect(page.getByRole('button', { name: /retry|resend/i })).toHaveCount(0)
})

const MEDIA_PAGE = '/catalogue/media?type=product&id=TZP-REF-1'
const A1 = 'p/product/tzp-ref-1/a.jpg'
const A2 = 'p/product/tzp-ref-1/b.png'
/** A real (tiny) PNG: the browser sniff and the fake storage's verifier both read its magic bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
type StorageReq = { method: string; path: string; headers: Record<string, string>; bytes: number }
async function storageRequests(request: APIRequestContext): Promise<StorageReq[]> {
  return (await request.get(`${BACKEND()}/__control/storage-requests`)).json() as Promise<
    StorageReq[]
  >
}
async function chooseImage(page: Page, label = 'Image file', name = 'pack.png') {
  await page.getByLabel(label).setInputFiles({ name, mimeType: 'image/png', buffer: PNG_BYTES })
}

test('media (mock backend): edit metadata as a whole-set replace; removed assets leave the set', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto(MEDIA_PAGE)
  // Thumbnails come from the backend's resolved public URL (CSP img-src allows only that configured origin).
  await expect(page.locator('img.thumb')).toHaveCount(2)
  await page.getByLabel(`Alt text for ${A2}`).fill('Side view')
  await page.getByLabel(`Remove ${A1}`).check()
  await page.getByLabel(`Role for ${A2}`).selectOption('PRIMARY')
  await page.getByLabel(`Order for ${A2}`).fill('0')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save media' }).click()
  await expect(page.getByText('Media saved.')).toBeVisible()
  const put = (await backendRequests(request)).filter((r) => r.method === 'PUT')
  expect(put).toHaveLength(1)
  const body = JSON.parse((put[0] as unknown as { body: string }).body)
  expect(body.expectedVersion).toBe(3)
  expect(body.assets).toHaveLength(1)
  expect(put[0]!.sub).toBe(WRITER_SUB)
})

test('media (mock backend): upload goes browser -> storage directly (no cookie, no token), then the set is saved and verified', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  const html = await page.request.get(MEDIA_PAGE)
  const csp = html.headers()['content-security-policy'] ?? ''
  expect(csp).toContain(`connect-src 'self' ${BACKEND()}`)
  expect(csp).not.toMatch(/connect-src[^;]*\*/)
  await page.goto(MEDIA_PAGE)
  await chooseImage(page)
  const newAlt = page.getByLabel(/^Alt text for p\/product\/TZP-REF-1\//)
  await expect(newAlt).toBeVisible()
  await expect(page.getByText(/Uploaded pack.png/)).toBeVisible()
  await newAlt.fill('Pack, front')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByRole('dialog')).toContainText('3 images will remain, 1 added')
  await page.getByRole('dialog').getByRole('button', { name: 'Save media' }).click()
  await expect(page.getByText('Media saved.')).toBeVisible()

  const puts = (await storageRequests(request)).filter((r) => r.method === 'PUT')
  expect(puts).toHaveLength(1)
  expect(puts[0]!.headers['content-type']).toBe('image/png')
  expect(puts[0]!.headers['if-none-match']).toBe('*')
  expect(Number(puts[0]!.headers['content-length'])).toBe(PNG_BYTES.length)
  expect(puts[0]!.bytes).toBe(PNG_BYTES.length)
  expect(puts[0]!.headers.cookie).toBeUndefined()
  expect(puts[0]!.headers.authorization).toBeUndefined()
  const key = decodeURIComponent(puts[0]!.path.slice('/__storage/'.length))
  const saved = (await backendRequests(request)).filter(
    (r) => r.method === 'PUT' && r.path.startsWith('/api/v1/admin/media/'),
  )
  const body = JSON.parse((saved[0] as unknown as { body: string }).body)
  expect(body.assets.find((a: { assetKey: string }) => a.assetKey === key)).toMatchObject({
    role: 'GALLERY',
    sortOrder: 2,
    altText: 'Pack, front',
    contentType: 'image/png',
  })
  // After the refresh the new image is listed from the backend, with its stored thumbnail.
  await expect(page.getByLabel(`Alt text for ${key}`)).toHaveValue('Pack, front')
  await expect(page.locator('img.thumb')).toHaveCount(3)
})

test('media (mock backend): a failed storage PUT is retried with a fresh upload link', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto(MEDIA_PAGE)
  await control(request, 'storage', { failNext: { status: 403, count: 1 } })
  await chooseImage(page)
  await expect(page.getByText(/Storage refused the upload/)).toBeVisible()
  await page.getByRole('button', { name: 'Retry upload' }).click()
  await expect(page.getByLabel(/^Alt text for p\/product\/TZP-REF-1\//)).toBeVisible()
  const targets = (await backendRequests(request)).filter(
    (r) => r.method === 'POST' && r.path === '/api/v1/admin/media/uploads',
  )
  expect(targets).toHaveLength(2)
  const puts = (await storageRequests(request)).filter((r) => r.method === 'PUT')
  expect(new Set(puts.map((p) => p.path)).size).toBe(2)
})

test('media (mock backend): storage switched off or failing is named, nothing leaks, edits survive', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await control(request, 'storage', { enabled: false })
  await page.goto(MEDIA_PAGE)
  await chooseImage(page)
  await expect(page.getByText(/no media storage is configured/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry upload' })).toHaveCount(0)
  expect(await page.content()).not.toContain('bucket none')

  // Storage on, upload succeeds, then storage fails while the backend verifies the new key at save time.
  await control(request, 'storage', { enabled: true })
  await chooseImage(page)
  await expect(page.getByLabel(/^Alt text for p\/product\/TZP-REF-1\//)).toBeVisible()
  await control(request, 'storage', { outage: true })
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save media' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Media storage is unavailable right now',
  )
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('media (mock backend): the backend upload limit is named from its own refusal, then enforced locally', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await control(request, 'storage', { maxBytes: 10 })
  await page.goto(MEDIA_PAGE)
  await chooseImage(page)
  await expect(page.getByText(/this backend accepts images up to 1 KiB/)).toBeVisible({
    timeout: 30_000,
  })
  await chooseImage(page, 'Image file', 'again.png')
  await expect(page.getByText(/the limit is 1 KiB/)).toBeVisible()
  const targets = (await backendRequests(request)).filter(
    (r) => r.method === 'POST' && r.path === '/api/v1/admin/media/uploads',
  )
  expect(targets).toHaveLength(1)
  expect((await storageRequests(request)).filter((r) => r.method === 'PUT')).toHaveLength(0)
})

test('media (mock backend): a concurrent change gives a conflict that keeps the edits and offers a reload', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto(MEDIA_PAGE)
  await page.getByLabel(`Alt text for ${A2}`).fill('My unsaved alt text')
  await control(request, 'bump-media', { key: 'product|TZP-REF-1' })
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save media' }).click()
  await expect(page.getByText(/Someone else changed this media set/)).toBeVisible()
  await expect(page.getByLabel(`Alt text for ${A2}`)).toHaveValue('My unsaved alt text')
  await page.getByRole('button', { name: 'Reload latest version' }).click()
  await expect(page.getByText('version 4')).toBeVisible()
  await expect(page.getByLabel(`Alt text for ${A2}`)).toHaveValue('')
})

test('media (mock backend): a reader sees the set read-only and no upload control', async ({
  page,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/catalogue/media?type=product&id=TZP-REF-1')
  await expect(page.getByText('Read-only: changing media needs the cms-writer role')).toBeVisible()
  await expect(page.getByLabel('Image file')).toHaveCount(0)
})

test('FAQs (mock backend): create a draft, publish it with the delay disclosed, edit live content, unpublish', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/content/faqs')
  await expect(page.getByText('When do you deliver?')).toBeVisible()
  await expect(page.getByText('live', { exact: true }).first()).toBeVisible()

  await page.getByRole('link', { name: 'New FAQ' }).click()
  await page.getByLabel('Question', { exact: true }).fill('Do you deliver on Sundays?')
  await page.getByRole('textbox', { name: 'Answer', exact: true }).fill('Yes, every day.')
  await page.getByRole('button', { name: 'Review new FAQ' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/content\/faqs\/CB_/)
  await expect(page.getByText('draft', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByRole('dialog')).toContainText('emergency unpublish')
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published.', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Answer', exact: true }).fill('Yes, every single day.')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByRole('dialog')).toContainText('changes what customers see')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('FAQ saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Unpublish' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Unpublish' }).click()
  await expect(page.getByText('Unpublished.', { exact: true })).toBeVisible()
  const writes = (await backendRequests(request)).filter(
    (r) => r.method !== 'GET' && r.path.includes('/content/'),
  )
  expect(writes.map((w) => `${w.method} ${w.path.split('/').slice(-1)[0]}`)).toEqual([
    'POST blocks',
    'POST status',
    'PUT ' + writes[2]!.path.split('/').slice(-1)[0],
    'POST status',
  ])
  expect(writes.every((w) => w.sub === WRITER_SUB)).toBe(true)
})

test('FAQs (mock backend): a reader sees content read-only with inert text', async ({ page }) => {
  await signIn(page, READER_SUB)
  await page.goto('/content/faqs/CB_faqseed000000001')
  await expect(
    page.getByText('Read-only: changing content needs the cms-writer role'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0)
})

test('app config (mock backend): insecure links are blocked, first save sends nulls for blanks, closing the store is flagged', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/content/app-config')
  await expect(page.getByText(/backend defaults/)).toBeVisible()
  await page.getByLabel('Terms of service URL').fill('http://insecure.example')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.locator('.field-error')).toContainText('https://')
  await page.getByLabel('Terms of service URL').fill('https://tazzzo.com/terms')
  await page.getByLabel('Store open for orders').uncheck()
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByRole('dialog')).toContainText('CLOSED for orders')
  await page.getByRole('dialog').getByRole('button', { name: 'Save configuration' }).click()
  await expect(page.getByText('Configuration saved.')).toBeVisible()
  const put = (await backendRequests(request)).filter(
    (r) => r.method === 'PUT' && r.path.endsWith('/app-config'),
  )
  const body = JSON.parse((put[0] as unknown as { body: string }).body)
  expect(body).toMatchObject({
    storeOpen: false,
    expectedVersion: 0,
    termsUrl: 'https://tazzzo.com/terms',
    supportEmail: null,
  })
  await expect(page.getByText('Store closed')).toBeVisible()
})

test('go-to box and access matrix (mock backend)', async ({ page }) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/account')
  await expect(page.getByRole('heading', { name: 'What each role can do' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /cms-writer.*\(you\)/ })).toBeVisible()
  await page.getByRole('textbox', { name: 'Go to an id' }).fill('TZP-REF-1')
  await page.getByRole('textbox', { name: 'Go to an id' }).press('Enter')
  await expect(page).toHaveURL(/\/catalogue\/products\/TZP-REF-1$/)
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: 'Go to an id' })).toBeFocused()
  await page.getByRole('textbox', { name: 'Go to an id' }).fill('ORD_abcdef12')
  await page.getByRole('textbox', { name: 'Go to an id' }).press('Enter')
  await expect(page.locator('.goto-error')).toContainText('cannot open Orders')
})

test('home content (mock backend): create banner -> upload -> publish -> reorder -> preview per channel', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/content/home')
  await expect(page.getByRole('row', { name: /Mango season/ })).toContainText('Live')
  await expect(page.getByRole('row', { name: /Shop by category/ })).toContainText('Scheduled')
  await page.getByRole('link', { name: 'New banner' }).click()
  await expect(page).toHaveURL(/\/content\/home\/new\?type=BANNER/)
  await page.getByLabel(/^Title/).fill('E2E monsoon offer')
  await chooseImage(page, 'Mobile image', 'monsoon.png')
  // First calls of new BFF routes compile under `next dev`: allow for it.
  await expect(page.getByText(/Uploaded monsoon.png/)).toBeVisible({ timeout: 30_000 })
  await page.getByLabel('Link type').selectOption('category')
  await page.getByLabel('Category id').fill('tzc-000001')
  await expect(page.getByText('category:TZC-000001')).toBeVisible()
  await page.getByLabel(/^Order/).fill('15')
  await page.getByRole('button', { name: 'Review new draft' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/content\/home\/CB_/, { timeout: 30_000 })
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByRole('dialog')).toContainText('Both')
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpublish' })).toBeVisible()

  // Reorder with the keyboard controls: the new banner (order 15) moves below Bestsellers.
  await page.goto('/content/home')
  await page.getByRole('button', { name: 'Reorder' }).click()
  await page.getByRole('button', { name: 'Move E2E monsoon offer down' }).click()
  await expect(page.getByText(/E2E monsoon offer moved to position 3 of 4/)).toBeAttached()
  await page.getByRole('button', { name: 'Save order' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save order' }).click()
  await expect(page.getByText('Order saved.')).toBeVisible({ timeout: 30_000 })

  const calls = await backendRequests(request)
  const writes = calls.filter((r) => r.method !== 'GET' && r.path.includes('/content/'))
  const bodyOf = (r: Recorded) => JSON.parse((r as unknown as { body: string }).body)
  const create = writes.find((w) => w.path === '/api/v1/admin/content/blocks')!
  expect(bodyOf(create)).toMatchObject({
    placement: 'HOME',
    type: 'BANNER',
    audience: 'BOTH',
    sort: 15,
    payload: { link: 'category:TZC-000001' },
  })
  expect(bodyOf(create).payload.imageAssetKey).toMatch(/^c\/home\//)
  const reorder = writes.find((w) => w.path.endsWith('/reorder'))!
  const order = bodyOf(reorder).order as { blockId: string; expectedVersion: number }[]
  expect(order).toHaveLength(4)
  expect(order[0]).toEqual({ blockId: 'CB_homebanner000001', expectedVersion: 2 })
  expect(order[1]).toEqual({ blockId: 'CB_homerail00000001', expectedVersion: 2 })
  expect(order.map((o) => o.blockId)).not.toContain('CB_homearchived0001')
  expect(writes.every((w) => w.sub === WRITER_SUB)).toBe(true)
  const puts = (await storageRequests(request)).filter((r) => r.method === 'PUT')
  expect(puts).toHaveLength(1)
  expect(puts[0]!.path).toMatch(/^\/__storage\/c\/home\//)
  expect(puts[0]!.headers.cookie).toBeUndefined()
  expect(puts[0]!.headers.authorization).toBeUndefined()

  // Preview: app (phone) with drafts, in the new order; the scheduled grid is not yet visible.
  await page.goto('/content/home/preview')
  const items = page.locator('.preview-screen > li')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toContainText('Mango season')
  await expect(items.nth(1)).toContainText('Bestsellers')
  await expect(items.nth(1)).toContainText('Draft (preview only)')
  await expect(items.nth(2)).toContainText('E2E monsoon offer')
  await expect(items.nth(2).getByRole('img')).toHaveAttribute('src', /\/__storage\/c\/home\//)
  // Website desktop, published only: the app-only rail drops out.
  await page.getByRole('link', { name: 'Website, desktop' }).click()
  await expect(page).toHaveURL(/view=web-desktop/)
  await page.getByLabel('Drafts').selectOption('false')
  await page.getByRole('button', { name: 'Show preview' }).click()
  await expect(items).toHaveCount(2)
  await expect(page.locator('[data-view="web-desktop"]')).toBeVisible()
  // Neither banner has a desktop image, so the storefront keeps the carousel at 16:9 on desktop too.
  await expect(page.locator('[data-view="web-desktop"] [data-crop]').first()).toHaveAttribute(
    'data-crop',
    'web-16x9',
  )
  // Preview at a future time (IST): the scheduled grid appears for the website.
  await page.getByLabel('Preview at (IST, UTC+05:30)').fill('2099-01-02T10:00')
  await page.getByRole('button', { name: 'Show preview' }).click()
  await expect(items.filter({ hasText: 'Shop by category' })).toHaveCount(1)
  const previews = (await backendRequests(request)).filter((r) =>
    r.path.startsWith('/api/v1/admin/content/preview/home'),
  )
  expect(previews.at(-1)!.path).toContain('at=2099-01-02T04%3A30%3A00.000Z')
  expect(previews.every((r) => r.method === 'GET')).toBe(true)
})

test('home content (mock backend): a reader sees lists, details and previews with no mutation controls', async ({
  page,
}) => {
  await signIn(page, READER_SUB)
  await page.goto('/content/home')
  await expect(page.getByRole('row', { name: /Mango season/ })).toBeVisible()
  await expect(
    page.getByText('Read-only: changing Home content needs the cms-writer role'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reorder' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /^New / })).toHaveCount(0)
  await page.getByRole('link', { name: 'Mango season' }).click()
  await expect(page.getByRole('button', { name: /Publish|Unpublish|Archive|Review/ })).toHaveCount(
    0,
  )
  await expect(page.getByLabel('Mobile image', { exact: true })).toHaveCount(0)
  await page.goto('/content/home/preview?view=web-mobile')
  await expect(page.locator('[data-view="web-mobile"]')).toBeVisible()
})

test('home content (mock backend): a concurrent edit gives a conflict that keeps the edits and offers a reload', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  await page.goto('/content/home/CB_homebanner000001')
  await page.getByLabel(/^Title/).fill('My unsaved title')
  await control(request, 'bump-block', { id: 'CB_homebanner000001' })
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page
    .getByRole('dialog', { name: /Save changes/ })
    .getByRole('button', { name: 'Save' })
    .click()
  // The first call compiles this BFF route under `next dev`, which can take several seconds.
  await expect(page.getByText(/This block changed since you loaded it/)).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByLabel(/^Title/)).toHaveValue('My unsaved title')
  await page.getByRole('button', { name: 'Reload latest version' }).click()
  await expect(page.getByLabel(/^Title/)).toHaveValue('Mango season')
  await expect(page.getByText(/version 3/)).toBeVisible()
})

test('home content (mock backend): reorder stays complete when 200+ archived blocks fill the capped list; duplicates refuse FAQs', async ({
  page,
  request,
}) => {
  await control(request, 'seed-archived', { count: 200 })
  await signIn(page, WRITER_SUB)
  await page.goto('/content/home')
  await expect(page.getByText(/Showing the first 200 archived blocks/)).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('row', { name: /Mango season/ })).toBeVisible()
  await page.getByRole('button', { name: 'Reorder' }).click()
  await page.getByRole('button', { name: 'Move Bestsellers up' }).click()
  await page.getByRole('button', { name: 'Save order' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Save order' }).click()
  await expect(page.getByText('Order saved.')).toBeVisible({ timeout: 30_000 })
  const reorder = (await backendRequests(request)).find((r) => r.path.endsWith('/reorder'))!
  const order = JSON.parse((reorder as unknown as { body: string }).body).order as {
    blockId: string
  }[]
  expect(order.map((o) => o.blockId)).toEqual([
    'CB_homerail00000001',
    'CB_homebanner000001',
    'CB_homegrid00000001',
  ])

  await page.goto('/content/home/new?from=CB_faqseed000000001')
  await expect(page.getByRole('heading', { name: 'Cannot duplicate here' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review new draft' })).toHaveCount(0)
})
