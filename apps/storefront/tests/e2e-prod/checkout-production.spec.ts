import { expect, test, type Page } from '@playwright/test'

/**
 * Checkout review, Cash on Delivery placement, confirmation and Orders under the PRODUCTION build: the strict nonce CSP
 * with the client components (review, cancel), Secure `__Host-` cookies, the trusted-caller headers on the quote and
 * order calls, CSRF, the stricter per-visitor bucket in front of placement, and the no-store headers. No cancellation
 * window is configured on this deployment, so no Cancel control exists. Each test uses its own visitor address
 * (trusted `X-Forwarded-For`, as behind the ALB) and stays inside the stricter bucket's burst of 6.
 */
const ORIGIN = 'http://localhost:3990'
const backend = () => process.env.E2E_BACKEND_URL!
let counter = 0

async function visitor(page: Page): Promise<string> {
  counter += 1
  const ip = `203.0.113.${40 + counter}`
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = seen
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  return ip
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? [])

interface Recorded {
  method: string
  path: string
  query: string
  caller: string | null
  callerSecret: string | null
  forwardedFor: string | null
  bearer: boolean
  ifMatch: string | null
  idempotencyKey: string | null
}
const requests = async () =>
  (await (await fetch(`${backend()}/__control/requests`)).json()) as Recorded[]
interface OrdersState {
  orders: Array<{ orderId: string; customerId: string; quoteId: string; status: string }>
  quotes: number
  placements: Array<{ body: { quoteId: string } }>
}
const state = async () =>
  (await (await fetch(`${backend()}/__control/orders`, { method: 'POST' })).json()) as OrdersState
const control = (name: string, query: string) =>
  fetch(`${backend()}/__control/${name}?${query}`, { method: 'POST' })

test.beforeEach(async () => {
  await control('cart', 'reset=1')
  await control('delivery', 'reset=1')
  await control('orders', 'reset=1')
})

async function toReview(page: Page) {
  await page.goto('/login?next=%2Faccount%2Faddresses%2Fnew')
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/account\/addresses\/new$/)
  const v = {
    'Full name': 'Asha Verma',
    'Mobile number': '9876543210',
    'Address line 1': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': '560001',
  }
  for (const [label, value] of Object.entries(v))
    await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save address' }).click()
  await page.waitForURL(/\/account\/addresses$/)
  await page.goto('/p/TZP-1001')
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await expect(page.getByTestId('add-status')).toContainText('to your cart')
  await page.goto('/checkout/delivery')
  await page
    .getByRole('radio', { name: /Morning/ })
    .first()
    .check()
  await page.getByRole('button', { name: 'Save delivery choice' }).click()
  await expect(page.getByTestId('delivery-saved')).toContainText('saved for the next step')
  await page.getByTestId('delivery-continue').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible()
  await page.waitForLoadState('networkidle') // the buttons only work once the page has hydrated
}

test('review, place and confirmation under the strict CSP: Secure cookies, trusted-caller quote and order calls, no-store, no violations', async ({
  page,
  context,
}) => {
  await visitor(page)
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  await toReview(page)
  const review = await page.goto('/checkout')
  expect(review?.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-")
  expect(review?.headers()['cache-control']).toContain('no-store')
  await expect(page.getByTestId('checkout-total')).toHaveText('₹499')
  await expect(page.getByTestId('checkout-payment')).toContainText('Cash on delivery')
  const checkout = (await context.cookies()).find((c) => c.name === '__Host-tz_checkout')!
  expect(checkout).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  expect(await page.evaluate(() => document.cookie)).toBe('')

  await page.getByTestId('checkout-place').click()
  await expect(page).toHaveURL(/\/orders\/ORD_[A-Za-z0-9_-]+\?placed=1$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Thank you, your order is placed',
  )
  await expect(page.getByTestId('order-total')).toHaveText('₹499')
  expect((await context.cookies()).some((c) => c.name === '__Host-tz_checkout')).toBe(false)
  // Every order page is no-store in production (private, no-cache, no-store, ...), including a 404.
  const orderId = (await state()).orders[0]!.orderId
  for (const path of ['/orders', `/orders/${orderId}`, '/orders/ORD_neverexisted1234567890']) {
    const response = await page.goto(path)
    expect(response?.headers()['cache-control'], path).toContain('no-store')
  }

  const recorded = await requests()
  for (const path of ['/v1/customer/checkout/quote', '/v1/customer/orders']) {
    const call = recorded.filter((r) => r.path === path && r.method === 'POST').at(-1)!
    expect(call, path).toMatchObject({
      caller: 'storefront_test',
      callerSecret: 'e2e-throwaway-caller-secret-not-a-real-value-0001',
      forwardedFor: null,
      bearer: true,
    })
  }
  const quote = recorded.filter((r) => r.path === '/v1/customer/checkout/quote').at(-1)!
  expect(quote.ifMatch).toMatch(/^"cart-\d+"$/)
  expect(quote.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect((await state()).orders).toHaveLength(1)
  expect(await violations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('a double click is one order; the unknown outcome retries the same quote; the price change must be confirmed', async ({
  page,
}) => {
  await visitor(page)
  await toReview(page)
  await page.getByTestId('checkout-place').dblclick()
  await expect(page).toHaveURL(/placed=1$/)
  let s = await state()
  expect(s.orders).toHaveLength(1)
  expect(s.placements).toHaveLength(1)
  await control('orders', 'reset=1')
  await control('cart', 'reset=1')

  // lost answer after the commit: same quote, same order
  const second = await page.context().newPage()
  await visitor(second)
  await toReview(second)
  await control('orders', 'fault=after:503')
  await second.getByTestId('checkout-place').click()
  await expect(second.getByTestId('checkout-error')).toContainText('could not confirm whether')
  await second.getByTestId('checkout-place').click()
  await expect(second).toHaveURL(/placed=1$/)
  s = await state()
  expect(s.orders).toHaveLength(1)
  expect(s.placements).toHaveLength(2)
  expect(s.placements[1]!.body.quoteId).toBe(s.placements[0]!.body.quoteId)
  expect(await violations(second)).toEqual([])
})

test('price change in production: the new total is shown and needs an explicit confirmation', async ({
  page,
}) => {
  await visitor(page)
  await toReview(page)
  await control('cart', 'sku=TZP-1001&price=52900')
  await page.getByTestId('checkout-place').click()
  await expect(page.getByTestId('checkout-error')).toContainText('A price changed')
  await expect(page.getByTestId('checkout-changed')).toContainText('changed from ₹499 to ₹529')
  expect((await state()).orders).toHaveLength(0)
  await page.getByTestId('checkout-place').click()
  await expect(page).toHaveURL(/placed=1$/)
  await expect(page.getByTestId('order-total')).toHaveText('₹529')
  expect(await violations(page)).toEqual([])
})

test('API guards: CSRF first, then the session; a different customer gets a 404 for the order; no Cancel control without a configured window', async ({
  page,
  request,
  browser,
}) => {
  await visitor(page)
  // The direct API calls come from their own visitor address: the page's own bucket is not spent on them.
  const headers = { 'x-forwarded-for': '203.0.113.250', 'content-type': 'application/json' }
  const place = {
    quoteId: 'CHKQ_abcdefghijklmnopqrstu',
    cartVersion: 1,
    addressId: 'ADDR_abcdefghij1',
    slotId: 'morning~2026-10-11',
  }
  expect((await request.post('/api/orders', { headers, data: place })).status()).toBe(403)
  expect(
    (
      await request.post('/api/orders', {
        headers: { ...headers, 'x-tazzzo-csrf': '1', origin: 'https://evil.example' },
        data: place,
      })
    ).status(),
  ).toBe(403)
  const signedOut = await request.post('/api/orders', {
    headers: { ...headers, 'x-tazzzo-csrf': '1', origin: ORIGIN },
    data: place,
  })
  expect(signedOut.status()).toBe(401)
  expect(signedOut.headers()['cache-control']).toBe('no-store')
  expect((await request.get('/api/orders', { headers })).status()).toBe(405)

  await page.goto('/checkout')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)checkout$/)
  await page.goto('/orders')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)orders$/)

  // The first customer places an order; no Cancel control is offered (no window configured), the API refuses gracefully.
  await toReview(page)
  await page.getByTestId('checkout-place').click()
  await expect(page).toHaveURL(/placed=1$/)
  await expect(page.getByTestId('cancel-open')).toHaveCount(0)
  const orderId = (await state()).orders[0]!.orderId

  // Another customer: the same id is a 404 page, with no trace of the order.
  const other = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage()
  await visitor(other)
  await other.goto('/login?next=%2Forders')
  await other.getByLabel('Mobile number').fill('9123456780')
  await other.getByRole('button', { name: 'Send code' }).click()
  await other.getByLabel('6-digit code').fill('123456')
  await other.getByRole('button', { name: 'Sign in' }).click()
  await other.waitForURL(/\/orders$/)
  await expect(other.getByTestId('orders-empty')).toBeVisible()
  const res = await other.goto(`/orders/${orderId}`)
  expect(res?.status()).toBe(404)
  await expect(other.getByTestId('order-not-found')).toBeVisible()
  for (const id of ['ORD_..%2f..%2fadmin', 'ORD_abc', 'ord_abcdefghijklmnop']) {
    expect((await other.goto(`/orders/${id}`))?.status(), id).toBe(404)
  }
  expect(await violations(other)).toEqual([])
  await other.context().close()
})

test('placement is limited per visitor by the stricter bucket (burst 6), with a 429 and Retry-After; others are unaffected', async ({
  request,
}) => {
  counter += 1
  const headers = {
    'x-forwarded-for': `203.0.113.${40 + counter}`,
    'content-type': 'application/json',
    'x-tazzzo-csrf': '1',
    origin: ORIGIN,
  }
  const body = {
    quoteId: 'CHKQ_abcdefghijklmnopqrstu',
    cartVersion: 1,
    addressId: 'ADDR_abcdefghij1',
    slotId: 'morning~2026-10-11',
  }
  const statuses: number[] = []
  let retryAfter: string | undefined
  for (let i = 0; i < 9; i++) {
    const res = await request.post('/api/orders', { headers, data: body })
    statuses.push(res.status())
    if (res.status() === 429) retryAfter = res.headers()['retry-after']
  }
  expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401])
  expect(statuses.slice(6)).toContain(429)
  expect(Number(retryAfter)).toBeGreaterThan(0)
  const other = await request.post('/api/orders', {
    headers: { ...headers, 'x-forwarded-for': `198.51.100.${40 + counter}` },
    data: body,
  })
  expect(other.status()).toBe(401)
})

test('phone width: review and confirmation fit, the place button is a full-width touch target', async ({
  page,
}) => {
  await visitor(page)
  await page.setViewportSize({ width: 375, height: 800 })
  await toReview(page)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
  const box = (await page.getByTestId('checkout-place').boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.width).toBeGreaterThan(300)
  await page.getByTestId('checkout-place').click()
  await expect(page).toHaveURL(/placed=1$/)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
})
