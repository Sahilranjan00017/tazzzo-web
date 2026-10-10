import { expect, test, type Page } from '@playwright/test'

/**
 * The cart under the production build: the strict nonce CSP with the cart page, the quantity stepper and Add to cart
 * (client components that call `/api/cart/*`), the Secure `__Host-` session cookie, CSRF on the cart routes and the
 * proxy's per-visitor limit in front of them. Each test uses its own visitor address (trusted `X-Forwarded-For`, as
 * behind the ALB) so the buckets do not mix.
 */
const ORIGIN = 'http://localhost:3990'
const backend = () => process.env.E2E_BACKEND_URL!
let counter = 0

async function visitor(page: Page): Promise<void> {
  counter += 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${150 + counter}` })
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = seen
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? [])

async function reset(): Promise<void> {
  await fetch(`${backend()}/__control/cart?reset=1`, { method: 'POST' })
}

async function signIn(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.beforeEach(reset)

test('add, step, remove and clear under the production CSP: no violations, no errors, Secure __Host- cookie', async ({
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

  await signIn(page, '/p/TZP-1001')
  await expect(page).toHaveURL(/\/p\/TZP-1001$/)
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await expect(page.getByTestId('add-status')).toHaveText('Added 1 to your cart. You now have 1.')
  await expect(page.getByTestId('cart-count')).toHaveText('1')

  const cookie = (await context.cookies()).find((c) => c.name === '__Host-tz_session')!
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })

  const cart = await page.goto('/cart')
  expect(cart?.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-")
  expect(cart?.headers()['cache-control']).toMatch(/no-store|private/)
  await expect(page.getByTestId('cart-subtotal')).toHaveText('₹499')
  await page.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }).click()
  await expect(page.getByTestId('cart-subtotal')).toHaveText('₹998')
  await expect(page.getByTestId('cart-count')).toHaveText('2')
  await page.getByRole('button', { name: 'Remove Basmati Rice 5 kg from cart' }).click()
  await expect(page.locator('.cart-empty p')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeFocused()
  expect(await violations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('signed out: /cart redirects to sign-in, the API refuses, and a forged mutation is a 403', async ({
  page,
  request,
}) => {
  await visitor(page)
  await page.goto('/cart')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)cart$/)
  expect(await violations(page)).toEqual([])
  const headers = {
    'x-forwarded-for': `203.0.113.${150 + counter}`,
    'content-type': 'application/json',
  }
  const body = { productId: 'TZP-1001', quantity: 1 }
  const read = await request.get('/api/cart', { headers })
  expect(read.status()).toBe(401)
  expect(read.headers()['cache-control']).toBe('no-store')
  expect((await request.post('/api/cart/add', { headers, data: body })).status()).toBe(403)
  const anonymous = await request.post('/api/cart/add', {
    headers: { ...headers, 'x-tazzzo-csrf': '1', origin: ORIGIN },
    data: body,
  })
  expect(anonymous.status()).toBe(401)
  const foreign = await request.post('/api/cart/add', {
    headers: { ...headers, 'x-tazzzo-csrf': '1', origin: 'https://evil.example' },
    data: body,
  })
  expect(foreign.status()).toBe(403)
})

test('canonical ids and quantity bounds hold in production: lowercase and 0/21 are refused before the backend', async ({
  page,
}) => {
  await visitor(page)
  await signIn(page, '/p/TZP-1001')
  const request = page.waitForRequest('**/api/cart/add')
  await page.getByRole('button', { name: 'Add to cart' }).click()
  const token = (await request).headers()['x-tazzzo-csrf']!
  await expect(page.getByTestId('add-status')).toContainText('Added 1')
  const send = (data: unknown) =>
    page.request.post('/api/cart/add', {
      data,
      headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': token, origin: ORIGIN },
    })
  for (const data of [
    { productId: 'tzp-1001', quantity: 1 },
    { productId: 'TZP-1001', quantity: 0 },
    { productId: 'TZP-1001', quantity: 21 },
  ]) {
    expect((await send(data)).status(), JSON.stringify(data)).toBe(400)
  }
  const stored = (await (
    await fetch(`${backend()}/__control/cart`, { method: 'POST' })
  ).json()) as {
    lines: Array<{ sku: string; quantity: number }>
  }
  expect(stored.lines.map((l) => [l.sku, l.quantity])).toEqual([['TZP-1001', 1]])
})

test('the cart page is clean at phone width under the CSP', async ({ page }) => {
  await visitor(page)
  await page.setViewportSize({ width: 375, height: 800 })
  await fetch(`${backend()}/__control/cart?addLine=TZP-1001&qty=2`, { method: 'POST' })
  await signIn(page, '/cart')
  await expect(page.getByTestId('cart-subtotal')).toHaveText('₹998')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
  expect(await violations(page)).toEqual([])
})
