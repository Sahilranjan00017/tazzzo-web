import { expect, test, type Page } from '@playwright/test'

/**
 * Customer sign-in against the real Next.js runtime and the fake backend's auth contract (tests/support/fake-backend.ts).
 * Phones: `9876543210` works, `9999999999` is rate limited, `9888888888` fails delivery. Codes: `123456` is right,
 * `654321` is expired, `999999` is rate limited, anything else is wrong.
 */
const backend = () => process.env.E2E_BACKEND_URL!
const SESSION_COOKIE = 'tz_session_dev'

interface Recorded {
  method: string
  path: string
  bearer: boolean
  forwardedFor: string | null
}

async function requests(): Promise<Recorded[]> {
  return (await (await fetch(`${backend()}/__control/requests`)).json()) as Recorded[]
}
async function control(query: string): Promise<{ refreshCount: number; logoutCount: number }> {
  return (await (
    await fetch(`${backend()}/__control/auth?${query}`, { method: 'POST' })
  ).json()) as {
    refreshCount: number
    logoutCount: number
  }
}

async function signIn(page: Page, next?: string, phone = '9876543210') {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.beforeEach(async () => {
  await control('accessTtl=900')
})

test('signed out: the header offers Sign in, and /account sends the visitor to /login with a return path', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('signin-link')).toHaveText('Sign in')
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)account$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('phone, then code: lands on the account with the profile, the header shows the signed-in state', async ({
  page,
}) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
  await expect(page.getByText('Asha Verma')).toBeVisible()
  await expect(page.getByText('asha@example.test')).toBeVisible()
  await expect(page.getByTestId('account-link')).toHaveText('Your account')
  await expect(page.getByTestId('signin-link')).toHaveCount(0)
})

test('keyboard only: type the number, Enter, type the code, Enter', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByLabel('Mobile number')).toBeFocused()
  await page.keyboard.type('9876543210')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('6-digit code')).toBeFocused()
  await page.keyboard.type('123456')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/account$/)
})

test('the session cookie is sealed, HttpOnly and SameSite=Lax; no token reaches page scripts, storage or HTML', async ({
  page,
  context,
}) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' })
  expect(cookie.value).not.toMatch(/AT\.|SES_/)
  expect(await page.evaluate(() => document.cookie)).toBe('')
  const html = await page.content()
  expect(html).not.toMatch(
    /AT\.[A-Za-z0-9_-]{20}|SES_[A-Za-z0-9_-]{6}\.|GRANT_|OTP_[A-Za-z0-9_-]{20}/,
  )
  const storage = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  )
  expect(storage).toBe('[{},{}]')
})

test('the backend sees the bearer token only on the profile call, and never a forwarded address', async ({
  page,
}) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  const calls = (await requests()).filter((r) => /^\/v1\/(auth|customer)\//.test(r.path))
  expect(calls.length).toBeGreaterThanOrEqual(4)
  for (const call of calls) expect(call.forwardedFor, call.path).toBeNull()
  expect(calls.filter((c) => c.bearer).every((c) => c.path === '/v1/customer/profile')).toBe(true)
})

test('a wrong code is announced and recoverable; an expired one asks for a new code', async ({
  page,
}) => {
  await page.goto('/login')
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('111111')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#auth-error')).toContainText('That code is not right.')
  await expect(page.getByLabel('6-digit code')).toBeFocused()
  await page.getByLabel('6-digit code').fill('654321')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#auth-error')).toContainText('That code has expired.')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/account$/)
})

test('rate limits and outages are explained without internals', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Mobile number').fill('9999999999')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.locator('#auth-error')).toHaveText(
    'Too many attempts. Please wait 42 seconds and try again.',
  )
  await page.getByLabel('Mobile number').fill('9888888888')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.locator('#auth-error')).toHaveText(
    'We could not sign you in right now. Please try again in a moment.',
  )
  await page.getByLabel('Mobile number').fill('12345')
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.locator('#auth-error')).toHaveText(
    'Enter a valid 10-digit Indian mobile number.',
  )
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('999999')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#auth-error')).toContainText('Please wait 2 minutes')
})

test('next: a same-origin path is honoured; an absolute or protocol-relative one is ignored', async ({
  page,
}) => {
  await signIn(page, '/p/TZP-1001')
  await expect(page).toHaveURL(/\/p\/TZP-1001$/)
  await page.context().clearCookies()
  await signIn(page, 'https://evil.example/phish')
  await expect(page).toHaveURL(/\/account$/)
  await page.context().clearCookies()
  await signIn(page, '//evil.example')
  await expect(page).toHaveURL(/\/account$/)
})

test('next: dot-segment tricks that collapse to //host are ignored', async ({ page }) => {
  for (const next of [
    '/.//evil.com',
    '/..//evil.com',
    '/%2e//evil.com',
    '/x/..//evil.com',
    '/%252f/evil.com',
  ]) {
    await page.context().clearCookies()
    await signIn(page, next)
    await expect(page, next).toHaveURL(/^http:\/\/localhost:3989\/account$/)
  }
})

test('a signed-in visitor on /login is sent straight on', async ({ page }) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  await page.goto('/login?next=/search')
  await expect(page).toHaveURL(/\/search$/)
})

test('sign out: backend session revoked, cookie gone, header and /account signed out', async ({
  page,
  context,
}) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  const before = (await control('accessTtl=900')).logoutCount
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('signin-link')).toBeVisible()
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
  expect((await control('accessTtl=900')).logoutCount).toBe(before + 1)
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)account$/)
})

test('an expired access token is rotated server-side, transparently, and the cookie changes', async ({
  page,
  context,
}) => {
  // Deterministic: a 1 s lifetime is already inside the 30 s safety margin, so the access token in the cookie is
  // expired the moment it is issued. Sign in to a page that does not need the profile, then let the backend hand out
  // normal tokens again; /account must refresh before reading the profile.
  await control('accessTtl=1')
  await signIn(page, '/search')
  await expect(page).toHaveURL(/\/search$/)
  const first = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!.value
  const refreshes = (await control('accessTtl=900')).refreshCount
  await page.goto('/account')
  await expect(page.getByText('Asha Verma')).toBeVisible()
  await expect(page).toHaveURL(/\/account$/)
  expect((await control('accessTtl=900')).refreshCount).toBe(refreshes + 1)
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)!.value).not.toBe(first)
})

test('a session the backend has revoked ends cleanly with a notice, not a loop', async ({
  page,
  context,
}) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  await control('revokeAll=1')
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)account&reason=expired$/)
  await expect(page.getByText('Your session has ended. Please sign in again.')).toBeVisible()
  expect((await context.cookies()).find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
})

test('a forged or tampered session cookie is just signed out', async ({ page, context }) => {
  await signIn(page)
  await expect(page).toHaveURL(/\/account$/)
  const real = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!
  await context.addCookies([{ ...real, value: real.value.slice(0, -3) + 'AAA' }])
  await page.goto('/account')
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)account$/)
  await context.addCookies([
    { ...real, value: 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
  ])
  await page.goto('/')
  await expect(page.getByTestId('signin-link')).toBeVisible()
})

test('CSRF: state-changing routes refuse a missing header, a foreign origin and a form post', async ({
  request,
}) => {
  const url = '/api/auth/otp/request'
  const body = JSON.stringify({ phone: '9876543210' })
  const json = { 'content-type': 'application/json' }
  expect((await request.post(url, { headers: json, data: body })).status()).toBe(403)
  expect(
    (
      await request.post(url, {
        headers: { ...json, 'x-tazzzo-csrf': '1', origin: 'https://evil.example' },
        data: body,
      })
    ).status(),
  ).toBe(403)
  expect(
    (
      await request.post(url, {
        headers: { ...json, 'x-tazzzo-csrf': '1', 'sec-fetch-site': 'cross-site' },
        data: body,
      })
    ).status(),
  ).toBe(403)
  expect(
    (
      await request.post(url, {
        form: { phone: '9876543210' },
        headers: { origin: 'http://localhost:3989' },
      })
    ).status(),
  ).toBe(403)
  expect((await request.post('/api/auth/logout', { headers: json, data: '{}' })).status()).toBe(403)
  const ok = await request.post(url, {
    headers: { ...json, 'x-tazzzo-csrf': '1', origin: 'http://localhost:3989' },
    data: body,
  })
  expect(ok.status()).toBe(200)
})
