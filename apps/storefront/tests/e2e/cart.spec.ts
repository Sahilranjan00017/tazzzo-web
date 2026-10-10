import { expect, test, type Page } from '@playwright/test'

/**
 * The customer cart against the real Next.js runtime and the fake backend's cart contract (tests/support/fake-backend.ts).
 * The fake mirrors CartController: `If-Match` versions (412 when stale), quantity 1..20, enrichment per line. With no
 * delivery address the backend reports every line as `LOCATION_REQUIRED`; `POST /__control/cart` switches a sku to the
 * answers a located cart would give (out of stock, price changed, ...).
 */
const backend = () => process.env.E2E_BACKEND_URL!

interface Recorded {
  method: string
  path: string
  bearer: boolean
  ifMatch: string | null
  forwardedFor: string | null
}
async function requests(): Promise<Recorded[]> {
  return (await (await fetch(`${backend()}/__control/requests`)).json()) as Recorded[]
}
async function cartControl(query: string) {
  return (await (
    await fetch(`${backend()}/__control/cart?${query}`, { method: 'POST' })
  ).json()) as {
    version: number
    lines: Array<{ sku: string; quantity: number }>
  }
}
async function authControl(query: string) {
  return (await (
    await fetch(`${backend()}/__control/auth?${query}`, { method: 'POST' })
  ).json()) as {
    refreshCount: number
  }
}

async function signIn(page: Page, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

const ORIGIN = `http://localhost:3989`

/** The CSRF token the page sends, read from the request the page itself makes. */
async function csrfFrom(page: Page): Promise<string> {
  await page.goto('/p/TZP-1001')
  const request = page.waitForRequest('**/api/cart/add')
  await page.getByRole('button', { name: 'Add to cart' }).click()
  const token = (await request).headers()['x-tazzzo-csrf']!
  await expect(page.getByTestId('add-status')).toContainText('Added 1')
  return token
}

test.beforeEach(async () => {
  await authControl('accessTtl=900')
  await cartControl('reset=1')
})

test.describe('signed out', () => {
  test('the header cart link and /cart lead to sign-in and back to the cart', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart')
    await expect(page.getByTestId('cart-count')).toHaveCount(0)
    await page.getByTestId('cart-link').click()
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)cart$/)
    await page.getByLabel('Mobile number').fill('9876543210')
    await page.getByRole('button', { name: 'Send code' }).click()
    await page.getByLabel('6-digit code').fill('123456')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/cart$/)
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
    await expect(page.getByText('Your cart is empty.', { exact: true }).first()).toBeVisible()
  })

  test('Add to cart on a product sends the visitor to sign-in with a safe next, and back to the product', async ({
    page,
  }) => {
    await page.goto('/p/TZP-1001')
    await expect(page.getByRole('button', { name: 'Add to cart' })).toHaveCount(0)
    await page.getByTestId('add-signin').click()
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)p(%2F|\/)TZP-1001$/)
    await page.getByLabel('Mobile number').fill('9876543210')
    await page.getByRole('button', { name: 'Send code' }).click()
    await page.getByLabel('6-digit code').fill('123456')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/p\/TZP-1001$/)
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeVisible()
  })

  test('the cart API refuses a signed-out caller, and CSRF is checked before the session', async ({
    request,
  }) => {
    const before = (await requests()).length
    const read = await request.get('/api/cart')
    expect(read.status()).toBe(401)
    const base = { 'content-type': 'application/json' }
    const body = { productId: 'TZP-1001', quantity: 1 }
    const noCsrf = await request.post('/api/cart/add', { headers: base, data: body })
    expect(noCsrf.status()).toBe(403)
    const origin = ORIGIN
    const anonymous = await request.post('/api/cart/add', {
      headers: { ...base, 'x-tazzzo-csrf': '1', origin },
      data: body,
    })
    expect(anonymous.status()).toBe(401)
    expect(await anonymous.json()).toMatchObject({ ok: false, error: 'unauthenticated' })
    expect((await requests()).slice(before)).toEqual([])
  })
})

test.describe('signed in', () => {
  test('add from the product page: announced, header count, cart shows the line with prices', async ({
    page,
  }) => {
    await signIn(page, '/p/TZP-1001')
    await expect(page).toHaveURL(/\/p\/TZP-1001$/)
    await expect(page.getByTestId('cart-link')).toHaveAccessibleName('Cart')
    await page.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }).click()
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toHaveText('Added 2 to your cart. You now have 2.')
    await expect(page.getByTestId('cart-count')).toHaveText('2')
    await expect(page.getByTestId('cart-link')).toHaveAccessibleName('Cart, 2 items')
    // Adding again accumulates on the same line.
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('You now have 4.')

    await page.getByRole('link', { name: 'View cart' }).click()
    await expect(page).toHaveURL(/\/cart$/)
    const row = page.locator('[data-product-id="TZP-1001"]')
    await expect(row.getByRole('link', { name: 'Basmati Rice 5 kg' })).toHaveAttribute(
      'href',
      '/p/TZP-1001',
    )
    await expect(row.locator('.price__selling')).toHaveText('₹499')
    await expect(row.locator('.price__mrp s')).toHaveText('₹599')
    await expect(row.getByText('Line total')).toBeVisible()
    await expect(row.locator('.cart-line__total')).toContainText('₹1,996')
    await expect(page.getByTestId('cart-subtotal')).toHaveText('₹1,996')
    await expect(row.locator('img.cart-line__image')).toHaveAttribute('src', /p1-thumb\.png$/)
    // The backend had no delivery location: its LOCATION_REQUIRED is shown as information, not as an error.
    await expect(row.getByText(/delivery address is chosen/)).toBeVisible()
    await expect(row).toHaveAttribute('data-blocked', 'false')
  })

  test('the backend sees If-Match versions, the bearer only on customer calls, and no forwarded address', async ({
    page,
  }) => {
    await signIn(page, '/p/TZP-1001')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('Added 1')
    const calls = (await requests()).filter((r) => r.path.startsWith('/v1/customer/cart'))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put).toMatchObject({
      path: '/v1/customer/cart/items/TZP-1001',
      bearer: true,
      ifMatch: '"cart-0"',
    })
    for (const call of calls) expect(call.forwardedFor).toBeNull()
  })

  test('stepper, remove and clear update the totals; focus and the live region follow', async ({
    page,
  }) => {
    await cartControl('addLine=TZP-1001&qty=1')
    await cartControl('addLine=TZP-1002&qty=2')
    await signIn(page, '/cart')
    await expect(page).toHaveURL(/\/cart$/)
    await expect(page.getByTestId('cart-subtotal')).toHaveText('₹818') // 499 + 2 x 159.50
    const status = page.getByTestId('cart-status')
    await expect(status).toHaveAttribute('aria-live', 'polite')

    const plus = page.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' })
    await plus.focus()
    await page.keyboard.press('Enter')
    await expect(status).toHaveText('Basmati Rice 5 kg: quantity 2. Subtotal ₹1,317.')
    await expect(plus).toBeFocused() // focus is not lost while updating
    await expect(page.getByTestId('cart-count')).toHaveText('4')

    await page.getByRole('button', { name: 'Decrease quantity of Basmati Rice 5 kg' }).click()
    await expect(status).toHaveText('Basmati Rice 5 kg: quantity 1. Subtotal ₹818.')

    await page.getByRole('button', { name: 'Remove Toor Dal 1 kg from cart' }).click()
    await expect(page.locator('[data-product-id="TZP-1002"]')).toHaveCount(0)
    await expect(page.getByTestId('cart-subtotal')).toHaveText('₹499')
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeFocused()

    await page.getByRole('button', { name: 'Clear cart' }).click()
    await expect(page.getByRole('button', { name: 'Yes, clear cart' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.cart-empty p')).toBeVisible()
    await expect(page.getByTestId('cart-count')).toHaveCount(0)
    expect((await cartControl('x=1')).lines).toEqual([])
  })

  test('stale and unavailable lines are reported exactly as the backend says', async ({ page }) => {
    await cartControl('addLine=TZP-1001&qty=3')
    await cartControl('addLine=TZP-2001&qty=1')
    await cartControl('addLine=TZP-1002&qty=5')
    await cartControl('addLine=TZP-Mix-7&qty=1')
    await cartControl('sku=TZP-1001&mode=price_changed&price=45900&freshness=REVALIDATE')
    await cartControl('sku=TZP-2001&mode=out_of_stock')
    await cartControl('sku=TZP-1002&mode=insufficient')
    await cartControl('sku=TZP-Mix-7&mode=unavailable')
    await signIn(page, '/cart')
    await expect(page).toHaveURL(/\/cart$/)
    const row = (id: string) => page.locator(`[data-product-id="${id}"]`)
    await expect(row('TZP-1001')).toContainText('The price changed since you added this')
    await expect(row('TZP-1001').locator('.price__selling')).toHaveText('₹459')
    await expect(row('TZP-1001')).toHaveAttribute('data-blocked', 'false')
    await expect(row('TZP-2001')).toContainText('Out of stock.')
    await expect(row('TZP-2001')).toHaveAttribute('data-blocked', 'true')
    await expect(row('TZP-1002')).toContainText('Only 2 available. Lower the quantity to continue.')
    await expect(
      row('TZP-1002').getByRole('button', { name: /Increase quantity/ }),
    ).toHaveAttribute('aria-disabled', 'true')
    await expect(row('TZP-Mix-7')).toContainText('No longer available. Remove it to continue.')
    await expect(row('TZP-Mix-7').getByRole('button', { name: /Remove/ })).toBeVisible()
    await expect(page.getByTestId('cart-blocked')).toHaveText(
      '3 items need your attention before you can buy.',
    )
    await expect(page.getByText(/It has been a while since you changed your cart/)).toBeVisible()
    // The unavailable line has no price: the subtotal says so instead of guessing.
    await expect(page.getByText('1 item has no price right now and is not included.')).toBeVisible()
    // Lowering the quantity of the scarce line clears its problem (the backend decides).
    await row('TZP-1002')
      .getByRole('button', { name: /Decrease quantity/ })
      .click({ clickCount: 1 })
    await expect(page.getByTestId('cart-status')).toContainText('quantity 4')
  })

  test('a cart changed in another tab: the change is refused, the screen catches up and says why', async ({
    page,
  }) => {
    await cartControl('addLine=TZP-1001&qty=1')
    await signIn(page, '/cart')
    await expect(page.getByTestId('cart-subtotal')).toHaveText('₹499')
    await cartControl('addLine=TZP-1002&qty=1') // another tab added a line: the version moved
    await page.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }).click()
    await expect(page.getByTestId('cart-error')).toContainText(
      'Your cart changed in another tab or window',
    )
    await expect(page.locator('[data-product-id="TZP-1002"]')).toBeVisible()
    await expect(page.locator('[data-product-id="TZP-1001"] .stepper__value')).toHaveText('1') // not applied
    // With the version now current, the same press works.
    await page.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }).click()
    await expect(page.getByTestId('cart-status')).toContainText('quantity 2')
    await expect(page.getByTestId('cart-error')).toHaveText('')
  })

  test('a product the backend reports out of stock is shown so and cannot be added', async ({
    page,
  }) => {
    await signIn(page, '/p/TZP-2001')
    await expect(page.getByTestId('stock-state')).toHaveText('Out of stock')
    await expect(page.getByRole('button', { name: 'Add to cart' })).toBeDisabled()
  })

  test('ids keep their case end to end: mixed case works, lowercase is refused and never upper-cased', async ({
    page,
  }) => {
    await signIn(page, '/p/TZP-Mix-7')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('Added 1')
    const paths = (await requests()).map((r) => r.path)
    expect(paths).toContain('/v1/customer/cart/items/TZP-Mix-7')
    await page.goto('/cart')
    await expect(page.locator('[data-product-id="TZP-Mix-7"] a')).toHaveAttribute(
      'href',
      '/p/TZP-Mix-7',
    )

    const token = await csrfFrom(page)
    const before = (await requests()).length
    const send = (path: string, data: unknown, headers: Record<string, string> = {}) =>
      page.request.post(path, {
        data,
        headers: {
          'content-type': 'application/json',
          'x-tazzzo-csrf': token,
          origin: ORIGIN,
          ...headers,
        },
      })
    for (const productId of [
      'tzp-1001',
      'Tzp-1001',
      'TZP-',
      'TZP-1001/../x',
      'TZP-' + 'A'.repeat(41),
    ]) {
      const response = await send('/api/cart/add', { productId, quantity: 1 })
      expect(response.status(), productId).toBe(400)
    }
    expect(
      (await requests())
        .slice(before)
        .filter((r) => r.path.startsWith('/v1/customer/cart') && r.method !== 'GET'),
    ).toEqual([])
    const lowercasePage = await page.goto('/p/tzp-1001')
    expect(lowercasePage?.status()).toBe(404)
  })

  test('quantity bounds are enforced by the route (1..20) before the backend is called', async ({
    page,
  }) => {
    await signIn(page)
    const token = await csrfFrom(page)
    const before = (await requests()).length
    const send = (path: string, data: unknown) =>
      page.request.post(path, {
        data,
        headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': token, origin: ORIGIN },
      })
    for (const quantity of [0, -3, 21, 1.5, '2']) {
      expect(
        (await send('/api/cart/add', { productId: 'TZP-1001', quantity })).status(),
        String(quantity),
      ).toBe(400)
      expect(
        (await send('/api/cart/update', { productId: 'TZP-1001', quantity, version: 1 })).status(),
        String(quantity),
      ).toBe(400)
    }
    const extra = await send('/api/cart/add', { productId: 'TZP-1001', quantity: 1, price: 1 })
    expect(extra.status()).toBe(400)
    // (a refresh of the header count may read the cart; nothing may be written)
    expect((await requests()).slice(before).filter((r) => r.method !== 'GET')).toEqual([])
    // Exactly 20 is allowed; one more through "add" is refused rather than clamped.
    const atLimit = await send('/api/cart/update', {
      productId: 'TZP-1001',
      quantity: 20,
      version: (await cartControl('x=1')).version,
    })
    expect(atLimit.status()).toBe(200)
    const over = await send('/api/cart/add', { productId: 'TZP-1001', quantity: 1 })
    expect(over.status()).toBe(422)
    expect(await over.json()).toMatchObject({ ok: false, error: 'quantity_limit' })
    expect((await cartControl('x=1')).lines).toEqual(
      [
        {
          sku: 'TZP-1001',
          quantity: 20,
          addedAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ].map((l) => ({ sku: l.sku, quantity: l.quantity })),
    )
  })

  test('CSRF: a forged cross-origin mutation is refused and changes nothing', async ({ page }) => {
    await signIn(page)
    const token = await csrfFrom(page)
    const version = (await cartControl('x=1')).version
    const body = { productId: 'TZP-1002', quantity: 3 }
    const post = (headers: Record<string, string>) =>
      page.request.post('/api/cart/add', {
        data: body,
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      })
    expect((await post({})).status()).toBe(403) // no token
    expect((await post({ 'x-tazzzo-csrf': '1' })).status()).toBe(403) // the pre-login token is not the session's
    expect((await post({ 'x-tazzzo-csrf': token, origin: 'https://evil.example' })).status()).toBe(
      403,
    )
    expect((await post({ 'x-tazzzo-csrf': token, 'sec-fetch-site': 'cross-site' })).status()).toBe(
      403,
    )
    // A cross-site form post (cannot set the header) is refused too.
    const form = await page.request.post('/api/cart/clear', { form: { version: String(version) } })
    expect(form.status()).toBe(403)
    expect((await cartControl('x=1')).version).toBe(version)
    // The same body with the right token and origin goes through.
    const ok = await post({ 'x-tazzzo-csrf': token })
    expect(ok.status()).toBe(200)
  })

  test('no token, customer id or backend request id reaches the page, storage or the cart responses', async ({
    page,
  }) => {
    await cartControl('addLine=TZP-1001&qty=1')
    await signIn(page, '/cart')
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    const html = await page.content()
    expect(html).not.toMatch(/AT\.[A-Za-z0-9_-]{20}|SES_[A-Za-z0-9_-]{6}\.|CUS_e2e|req_cart/)
    expect(
      await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }])),
    ).toBe('[{},{}]')
    const response = await page.request.get('/api/cart')
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(await response.text()).not.toMatch(/AT\.|SES_|CUS_e2e|req_cart|expiresAt/)
  })

  test('a backend outage is explained without internals and recovers', async ({ page }) => {
    await signIn(page, '/p/TZP-1001')
    await cartControl('down=1')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-error')).toHaveText(
      'We could not update your cart right now. Please try again in a moment.',
    )
    await page.goto('/cart')
    await expect(page.getByTestId('cart-load-error')).toContainText(
      'We could not load your cart right now.',
    )
    await expect(page.getByTestId('cart-link')).toBeVisible() // the rest of the page still renders
    await cartControl('down=0')
    await page.getByRole('link', { name: 'Try again' }).click()
    await expect(page.locator('.cart-empty p')).toBeVisible()
  })

  test('an expired access token is rotated for the cart page and for a mutation', async ({
    page,
  }) => {
    await authControl('accessTtl=33')
    await signIn(page, '/p/TZP-1001')
    const refreshes = (await authControl('accessTtl=33')).refreshCount
    await page.waitForTimeout(3500)
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('Added 1')
    expect((await authControl('accessTtl=33')).refreshCount).toBeGreaterThan(refreshes)
    await page.waitForTimeout(3500)
    await page.goto('/cart')
    await expect(page.getByTestId('cart-subtotal')).toBeVisible()
    await expect(page).toHaveURL(/\/cart$/)
  })
})

test.describe('responsive', () => {
  for (const [name, width, height] of [
    ['phone 375', 375, 800],
    ['tablet 768', 768, 1024],
    ['desktop 1280', 1280, 800],
  ] as const) {
    test(`${name}: the cart has no horizontal scroll and touch-sized controls`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height })
      await cartControl('addLine=TZP-1001&qty=2')
      await cartControl('addLine=TZP-2001&qty=1')
      await cartControl('sku=TZP-2001&mode=out_of_stock')
      await signIn(page, '/cart')
      await expect(page.getByTestId('cart-subtotal')).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      for (const button of await page.locator('.stepper__button').all()) {
        const box = (await button.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
      }
      await expect(page.locator('[data-product-id="TZP-1001"] .cart-line__total')).toBeVisible()
    })
  }
})
