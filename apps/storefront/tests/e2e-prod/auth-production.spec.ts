import { expect, test, type Page } from '@playwright/test'

/**
 * Customer sign-in under the production build: strict CSP with the sign-in pages and form handlers, the `__Host-`
 * prefixed Secure cookie (the site URL is https here, so the cookie is Secure even though the test browser reaches the
 * server over loopback http, which browsers treat as a secure context), and the proxy's rate limit on the code routes.
 * Each test uses its own visitor address (trusted `X-Forwarded-For`, as behind the ALB) so the buckets do not mix.
 */
const SESSION_COOKIE = '__Host-tz_session'
let counter = 0

async function visitor(page: Page): Promise<void> {
  counter += 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${100 + counter}` })
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

test('sign in and out under the production CSP: no violations, Secure __Host- cookie, sealed value', async ({
  page,
  context,
}) => {
  await visitor(page)
  const errors: string[] = []
  // The home page (signing out lands there) carries a banner whose image is missing on purpose.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))

  const login = await page.goto('/login')
  expect(login?.headers()['content-security-policy']).toContain("script-src 'self' 'nonce-")
  expect(login?.headers()['cache-control']).toMatch(/no-store|private/)
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByText('Asha Verma')).toBeVisible()
  expect(await violations(page)).toEqual([])

  const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })
  expect(cookie.value).not.toMatch(/AT\.|SES_/)
  expect(await page.evaluate(() => document.cookie)).toBe('')

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('signin-link')).toBeVisible()
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
  expect(await violations(page)).toEqual([])
  expect(errors).toEqual([])
})

test('the login page itself is clean under the CSP and has an accessible form', async ({
  page,
}) => {
  await visitor(page)
  await page.goto('/login')
  expect(await violations(page)).toEqual([])
  await expect(page.getByLabel('Mobile number')).toBeFocused()
  await expect(page.locator('.auth-live')).toHaveAttribute('aria-live', 'polite')
})

test('the code routes are rate limited per visitor by the proxy (stricter bucket), with Retry-After', async ({
  request,
}) => {
  counter += 1
  const headers = {
    'x-forwarded-for': `203.0.113.${100 + counter}`,
    'content-type': 'application/json',
    'x-tazzzo-csrf': '1',
    origin: 'http://localhost:3990',
  }
  const statuses: number[] = []
  let retryAfter = ''
  for (let i = 0; i < 9; i++) {
    const response = await request.post('/api/auth/otp/request', {
      headers,
      data: { phone: '9876543210' },
    })
    statuses.push(response.status())
    if (response.status() === 429) retryAfter = response.headers()['retry-after'] ?? ''
  }
  expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true)
  expect(statuses).toContain(429)
  expect(Number(retryAfter)).toBeGreaterThan(0)
})

test('CSRF holds in production too, and a spoofed X-Forwarded-For never reaches the backend', async ({
  request,
}) => {
  counter += 1
  const base = {
    'x-forwarded-for': `203.0.113.${100 + counter}`,
    'content-type': 'application/json',
  }
  const foreign = await request.post('/api/auth/otp/request', {
    headers: { ...base, 'x-tazzzo-csrf': '1', origin: 'https://evil.example' },
    data: { phone: '9876543210' },
  })
  expect(foreign.status()).toBe(403)
  const ok = await request.post('/api/auth/otp/request', {
    headers: {
      ...base,
      'x-tazzzo-csrf': '1',
      origin: 'http://localhost:3990',
      'x-forwarded-for': `198.51.100.9, ${base['x-forwarded-for']}`,
    },
    data: { phone: '9876543210' },
  })
  expect(ok.status()).toBe(200)
  const calls = (await (
    await fetch(`${process.env.E2E_BACKEND_URL}/__control/requests`)
  ).json()) as Array<{
    path: string
    forwardedFor: string | null
    caller: string | null
  }>
  const otp = calls.filter((c) => c.path === '/v1/auth/otp/request')
  expect(otp.length).toBeGreaterThan(0)
  for (const call of otp) {
    expect(call.forwardedFor).toBeNull()
    expect(call.caller).toBe('storefront_test') // the trusted-caller mechanism, nothing about the visitor
  }
})
