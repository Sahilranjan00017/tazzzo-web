import { expect, test, type Page } from '@playwright/test'

/**
 * Delivery location, addresses and slots under the production build: the strict nonce CSP with the location form,
 * the address form and the slot picker (client components), the Secure `__Host-` cookies, the trusted-caller headers
 * on serviceability, CSRF, and the proxy's stricter per-visitor bucket in front of the serviceability check. Each
 * test uses its own visitor address (trusted `X-Forwarded-For`, as behind the ALB).
 */
const ORIGIN = 'http://localhost:3990'
const backend = () => process.env.E2E_BACKEND_URL!
let counter = 0

async function visitor(page: Page): Promise<string> {
  counter += 1
  const ip = `203.0.113.${200 + counter}`
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

async function signIn(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.beforeEach(async () => {
  await fetch(`${backend()}/__control/cart?reset=1`, { method: 'POST' })
  await fetch(`${backend()}/__control/delivery?reset=1`, { method: 'POST' })
})

test('set a location signed out: Secure __Host- cookie, trusted-caller serviceability, stock on the product, no CSP violations', async ({
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
  const response = await page.goto('/location')
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-")
  await expect(page.getByTestId('location-chip')).toHaveText('Set delivery location')
  await page.getByLabel('PIN code').fill('12')
  await page.getByRole('button', { name: 'Check PIN code' }).click()
  await expect(page.getByTestId('location-error')).toContainText('6-digit PIN code')
  await page.getByLabel('PIN code').fill('560001')
  await page.getByRole('button', { name: 'Check PIN code' }).click()
  await expect(page.getByTestId('location-chip')).toHaveText('Deliver to 560001')
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-tz_loc')!
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  expect(cookie.value).not.toContain('560001')
  const recorded = (await (await fetch(`${backend()}/__control/requests`)).json()) as Array<{
    path: string
    query: string
    caller: string | null
    callerSecret: string | null
    forwardedFor: string | null
    bearer: boolean
  }>
  const svc = recorded.filter((r) => r.path === '/v1/serviceability')
  expect(svc.at(-1)).toMatchObject({
    query: '?pin=560001',
    caller: 'storefront_test',
    forwardedFor: null,
    bearer: false,
  })
  await page.goto('/p/TZP-1002')
  await expect(page.getByTestId('availability')).toContainText(
    'Only 3 left for delivery to 560001.',
  )
  expect(await violations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('an unserviceable PIN and the API guards hold in production', async ({ page, request }) => {
  const ip = await visitor(page)
  await page.goto('/location')
  await page.getByLabel('PIN code').fill('400001')
  await page.getByRole('button', { name: 'Check PIN code' }).click()
  await expect(page.getByTestId('location-status')).toContainText('do not deliver to 400001')
  expect(await violations(page)).toEqual([])
  const headers = { 'x-forwarded-for': ip, 'content-type': 'application/json' }
  expect((await request.get('/api/location', { headers })).status()).toBe(405)
  expect((await request.post('/api/location', { headers, data: { pin: '560001' } })).status()).toBe(
    403,
  )
  const forged = await request.post('/api/location', {
    headers: { ...headers, 'x-tazzzo-csrf': '1', origin: 'https://evil.example' },
    data: { pin: '560001' },
  })
  expect(forged.status()).toBe(403)
  const bad = await request.post('/api/location', {
    headers: { ...headers, 'x-tazzzo-csrf': '1', origin: ORIGIN },
    data: { pin: '056001' },
  })
  expect(bad.status()).toBe(400)
})

test('serviceability checks are limited per visitor (burst 6) with a 429 and Retry-After, and other visitors are unaffected', async ({
  request,
}) => {
  counter += 1
  const headers = {
    'x-forwarded-for': `203.0.113.${200 + counter}`,
    'content-type': 'application/json',
    'x-tazzzo-csrf': '1',
    origin: ORIGIN,
  }
  const statuses: number[] = []
  for (let i = 0; i < 9; i++) {
    statuses.push(
      (await request.post('/api/location', { headers, data: { pin: '560001' } })).status(),
    )
  }
  expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200])
  expect(statuses.slice(6)).toContain(429)
  const other = await request.post('/api/location', {
    headers: { ...headers, 'x-forwarded-for': `198.51.100.${10 + counter}` },
    data: { pin: '560001' },
  })
  expect(other.status()).toBe(200)
})

test('addresses and slots under the production CSP: create, pick a slot, keep it; Secure cookies; phone width', async ({
  page,
  context,
}) => {
  await visitor(page)
  await page.setViewportSize({ width: 375, height: 800 })
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  await signIn(page, '/account/addresses/new')
  await page.getByLabel('Full name').fill('Asha Verma')
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByLabel('Address line 1').fill('12 MG Road')
  await page.getByLabel('City').fill('Bengaluru')
  await page.getByLabel('State').fill('Karnataka')
  await page.getByLabel('PIN code').fill('560001')
  await page.getByRole('button', { name: 'Save address' }).click()
  await page.waitForURL(/\/account\/addresses$/)
  await expect(page.getByTestId('address-card')).toHaveCount(1)
  await page.goto('/location')
  await page.getByRole('button', { name: 'Deliver here' }).click()
  await expect(page.getByTestId('location-chip')).toHaveText('Deliver to 560001')
  await page.goto('/checkout/delivery')
  await page
    .getByRole('radio', { name: /Morning/ })
    .nth(1)
    .check()
  await page.getByRole('button', { name: 'Save delivery choice' }).click()
  await expect(page.getByTestId('delivery-saved')).toContainText('saved for the next step')
  const names = (await context.cookies()).map((c) => c.name)
  expect(names).toEqual(
    expect.arrayContaining(['__Host-tz_session', '__Host-tz_loc', '__Host-tz_checkout']),
  )
  for (const c of await context.cookies()) {
    expect(c, c.name).toMatchObject({ httpOnly: true, secure: true })
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
  expect(await violations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('prefetch headers do not exempt route handlers: a POST carrying them is limited and gets the security headers', async ({
  request,
}) => {
  counter += 1
  const headers = {
    'x-forwarded-for': `198.51.100.${60 + counter}`,
    'content-type': 'application/json',
    'x-tazzzo-csrf': '1',
    origin: ORIGIN,
    rsc: '1',
    'next-router-prefetch': '1',
  }
  for (const path of ['/api/location', '/api/auth/otp/request']) {
    const body = path === '/api/location' ? { pin: '560001' } : { phone: '9999999999' }
    let limited = null
    for (let i = 0; i < 12 && limited === null; i++) {
      const res = await request.post(path, {
        headers: { ...headers, 'x-forwarded-for': `198.51.100.${70 + counter + path.length}` },
        data: body,
      })
      if (res.status() === 429) limited = res
      else
        expect(res.headers()['content-security-policy'], path).toContain(
          "script-src 'self' 'nonce-",
        )
    }
    expect(limited, path).not.toBeNull()
    expect(limited!.headers()['retry-after']).toBeTruthy()
    expect(limited!.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-")
  }
})
