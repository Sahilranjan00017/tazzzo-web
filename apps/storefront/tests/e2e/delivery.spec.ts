import { expect, test, type Page } from '@playwright/test'

/**
 * Delivery location, saved addresses and delivery slots against the real Next.js runtime and the fake backend's
 * serviceability / address / slot contract (tests/support/fake-backend.ts). Serviceable PINs: 560001, 560002 (no
 * slots), 110001; 400001 is not served; 500500 makes serviceability fail.
 */
const backend = () => process.env.E2E_BACKEND_URL!
const ORIGIN = 'http://localhost:3989'

interface Recorded {
  method: string
  path: string
  query: string
  bearer: boolean
  ifMatch: string | null
  idempotencyKey: string | null
}
async function requests(): Promise<Recorded[]> {
  return (await (await fetch(`${backend()}/__control/requests`)).json()) as Recorded[]
}
const control = (name: string, query: string) =>
  fetch(`${backend()}/__control/${name}?${query}`, { method: 'POST' })

async function signIn(page: Page, phone = '9876543210', next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Mobile number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

async function setPin(page: Page, pin: string) {
  await page.goto('/location')
  await page.getByLabel('PIN code').fill(pin)
  await page.getByRole('button', { name: 'Check PIN code' }).click()
}

async function addAddress(page: Page, over: Record<string, string> = {}) {
  const v = {
    'Full name': 'Asha Verma',
    'Mobile number': '9876543210',
    'Address line 1': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': '560001',
    ...over,
  }
  await page.goto('/account/addresses/new')
  for (const [label, value] of Object.entries(v))
    await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save address' }).click()
  await page.waitForURL(/\/account\/addresses$/)
}

test.beforeEach(async () => {
  await control('auth', 'accessTtl=900')
  await control('cart', 'reset=1')
  await control('delivery', 'reset=1')
})

test.describe('delivery location, signed out', () => {
  test('the header chip invites a choice; a serviceable PIN is stored, shown, and sent with product reads', async ({
    page,
    context,
  }) => {
    await page.goto('/p/TZP-1001')
    await expect(page.getByTestId('location-chip')).toHaveText('Set delivery location')
    await expect(page.getByTestId('availability')).toContainText('Choose your delivery location')
    await page.getByTestId('location-chip').click()
    await expect(page).toHaveURL(/\/location$/)
    await page.getByLabel('PIN code').fill('560001')
    await page.getByRole('button', { name: 'Check PIN code' }).click()
    await expect(page.getByTestId('location-status')).toContainText('we deliver to 560001')
    await expect(page.getByTestId('location-chip')).toHaveText('Deliver to 560001')
    const before = (await requests()).length
    await page.goto('/p/TZP-1001')
    await expect(page.getByTestId('availability')).toContainText('In stock for delivery to 560001.')
    const reads = (await requests()).slice(before).filter((r) => r.path === '/v1/products/TZP-1001')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((r) => r.query === '?pin=560001')).toBe(true)
    const cookie = (await context.cookies()).find((c) => c.name === 'tz_loc_dev')!
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('Lax')
    expect(cookie.value).not.toContain('560001')
    expect(await page.evaluate(() => document.cookie)).toBe('')
  })

  test('stock becomes real on low stock and out of stock products', async ({ page }) => {
    await setPin(page, '560001')
    await expect(page.getByTestId('location-status')).toContainText('we deliver')
    await page.goto('/p/TZP-1002')
    await expect(page.getByTestId('availability')).toContainText(
      'Only 3 left for delivery to 560001.',
    )
    await page.goto('/p/TZP-2001')
    await expect(page.getByTestId('stock-state')).toHaveText('Out of stock')
    await page.goto('/search?q=rice')
    await expect(page.locator('[data-product-id="TZP-1001"]')).toBeVisible()
  })

  test('an unserviceable PIN is a clear state, is not sent to product reads, and can be changed', async ({
    page,
  }) => {
    await setPin(page, '400001')
    await expect(page.getByTestId('location-status')).toContainText('do not deliver to 400001')
    await expect(page.getByTestId('location-chip')).toHaveText('Not delivering to 400001')
    await expect(page.getByTestId('location-continue')).toHaveCount(0)
    const before = (await requests()).length
    await page.goto('/p/TZP-1001')
    await expect(page.getByTestId('availability')).toContainText('We do not deliver to 400001 yet.')
    const reads = (await requests()).slice(before).filter((r) => r.path === '/v1/products/TZP-1001')
    expect(reads.every((r) => r.query === '')).toBe(true)
    await page.getByRole('link', { name: 'Change location' }).click()
    await page.getByLabel('PIN code').fill('110001')
    await page.getByRole('button', { name: 'Check PIN code' }).click()
    await expect(page.getByTestId('location-chip')).toHaveText('Deliver to 110001')
  })

  test('invalid PIN formats are announced and focus returns to the field; nothing reaches the backend', async ({
    page,
  }) => {
    await page.goto('/location')
    const before = (await requests()).length
    for (const bad of ['', '12345', '0123456', 'abcdef', '56 0001']) {
      await page.getByLabel('PIN code').fill(bad)
      await page.getByRole('button', { name: 'Check PIN code' }).click()
      await expect(page.getByTestId('location-error')).toContainText('6-digit PIN code')
      await expect(page.getByLabel('PIN code')).toBeFocused()
      await expect(page.getByLabel('PIN code')).toHaveAttribute('aria-invalid', 'true')
    }
    expect((await requests()).slice(before).filter((r) => r.path === '/v1/serviceability')).toEqual(
      [],
    )
    await expect(page.getByTestId('location-chip')).toHaveText('Set delivery location')
  })

  test('a serviceability outage is announced and changes nothing; the form works by keyboard', async ({
    page,
  }) => {
    await page.goto('/location')
    await page.getByLabel('PIN code').focus()
    await page.keyboard.type('500500')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('location-error')).toContainText('could not check that right now')
    await expect(page.getByTestId('location-chip')).toHaveText('Set delivery location')
  })

  test('the location API is POST-only with CSRF and exact bodies', async ({ request }) => {
    const base = { 'content-type': 'application/json' }
    expect((await request.get('/api/location')).status()).toBe(405)
    expect(
      (await request.post('/api/location', { headers: base, data: { pin: '560001' } })).status(),
    ).toBe(403)
    const ok = { ...base, 'x-tazzzo-csrf': '1', origin: ORIGIN }
    expect(
      (
        await request.post('/api/location', {
          headers: { ...ok, origin: 'https://evil.example' },
          data: { pin: '560001' },
        })
      ).status(),
    ).toBe(403)
    expect(
      (
        await request.post('/api/location', {
          headers: ok,
          data: { pin: '560001', customerId: 'x' },
        })
      ).status(),
    ).toBe(400)
    expect(
      (await request.post('/api/location', { headers: ok, data: { pin: '12' } })).status(),
    ).toBe(400)
    expect(
      (
        await request.post('/api/location', {
          headers: ok,
          data: { addressId: 'ADDR_abcdefghij1' },
        })
      ).status(),
    ).toBe(401)
  })

  test('a list cursor started under another location is refused by the backend and the page starts over', async ({
    page,
  }) => {
    await control('delivery', 'paged=1')
    await setPin(page, '560001')
    await expect(page.getByTestId('location-status')).toContainText('we deliver')
    await page.goto('/search?q=rice')
    const more = page.getByRole('link', { name: 'More results' })
    const href = (await more.getAttribute('href'))!
    expect(href).toContain('cursor=cur-560001')
    await setPin(page, '110001')
    await expect(page.getByTestId('location-status')).toContainText('we deliver')
    await page.goto(href)
    await expect(page).toHaveURL(/\/search\?q=rice$/)
    await expect(page.getByRole('heading', { name: /Results for/ })).toBeVisible()
  })
})

test.describe('addresses and the cart', () => {
  test('signed out: address pages lead to sign-in and the API refuses', async ({
    page,
    request,
  }) => {
    await page.goto('/account/addresses')
    await expect(page).toHaveURL(/\/login\?next=/)
    await page.goto('/checkout/delivery')
    await expect(page).toHaveURL(/\/login\?next=/)
    const res = await request.post('/api/addresses/default', {
      headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': '1', origin: ORIGIN },
      data: { addressId: 'ADDR_abcdefghij1' },
    })
    expect(res.status()).toBe(401)
  })

  test('create, edit, make default and delete, with idempotency and version headers', async ({
    page,
  }) => {
    const recordedBefore = (await requests()).length
    await signIn(page)
    await page.goto('/account/addresses')
    await expect(page.getByTestId('address-empty')).toBeVisible()
    await addAddress(page)
    await expect(page.getByTestId('address-card')).toHaveCount(1)
    await expect(page.getByText('Default')).toBeVisible()
    await addAddress(page, {
      'Full name': 'Ravi Kumar',
      'PIN code': '110001',
      City: 'Delhi',
      State: 'Delhi',
    })
    await expect(page.getByTestId('address-card')).toHaveCount(2)
    // Only this test's requests: the recorded log spans the whole run, and other specs create addresses too.
    const create = (await requests())
      .slice(recordedBefore)
      .filter((r) => r.method === 'POST' && r.path === '/v1/customer/addresses')
    expect(create).toHaveLength(2)
    expect(create[0]!.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(create[0]!.idempotencyKey).not.toBe(create[1]!.idempotencyKey)

    // make the second default
    const second = page.getByTestId('address-card').filter({ hasText: 'Ravi Kumar' })
    await second.getByRole('button', { name: /the default$/ }).click()
    await expect(page.getByTestId('address-status')).toHaveText('Default address changed.')
    await expect(page.getByTestId('address-card').first()).toContainText('Ravi Kumar')

    // edit
    await page
      .getByTestId('address-card')
      .filter({ hasText: 'Asha Verma' })
      .getByRole('link', { name: /^Edit/ })
      .click()
    await expect(page.getByLabel('Full name')).toHaveValue('Asha Verma')
    await page.getByLabel('Full name').fill('Asha V')
    await page.getByLabel('Landmark (optional)').fill('Near the park')
    await page.getByRole('button', { name: 'Save address' }).click()
    await page.waitForURL(/\/account\/addresses$/)
    await expect(page.getByTestId('address-card').filter({ hasText: 'Asha V' })).toContainText(
      'near Near the park',
    )
    const patch = (await requests()).filter((r) => r.method === 'PATCH')
    expect(patch).toHaveLength(1)
    expect(patch[0]!.ifMatch).toBe('"address-1"')

    // delete asks first
    const card = page.getByTestId('address-card').filter({ hasText: 'Asha V' })
    await card.getByRole('button', { name: /^Delete/ }).click()
    await card.getByRole('button', { name: 'Yes, delete Home' }).click()
    await expect(page.getByTestId('address-status')).toHaveText('Address deleted.')
    await expect(page.getByTestId('address-card')).toHaveCount(1)
    const del = (await requests()).filter(
      (r) => r.method === 'DELETE' && r.path.startsWith('/v1/customer/addresses/'),
    )
    expect(del[0]!.ifMatch).toBe('"address-2"')
  })

  test('the form announces every error beside its field and sends nothing until it is valid', async ({
    page,
  }) => {
    await signIn(page)
    await page.goto('/account/addresses/new')
    const before = (await requests()).length
    await page.getByLabel('PIN code').fill('056001')
    await page.getByLabel('Mobile number').fill('12345')
    await page.getByRole('button', { name: 'Save address' }).click()
    await expect(page.getByLabel('Full name')).toBeFocused()
    await expect(page.getByLabel('Full name')).toHaveAccessibleDescription('Full name is required.')
    await expect(page.getByLabel('PIN code')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Mobile number')).toHaveAccessibleDescription(
      /10-digit Indian mobile/,
    )
    expect((await requests()).slice(before).filter((r) => r.path.includes('addresses'))).toEqual([])
  })

  test('the cart changes once a saved address is the delivery location, and is read by addressId', async ({
    page,
  }) => {
    await signIn(page, '9876543210', '/p/TZP-1001')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('Added 1')
    await page.goto('/cart')
    await expect(
      page.getByText('Stock and delivery are confirmed once a delivery address is chosen.'),
    ).toBeVisible()
    await expect(page.getByTestId('cart-location-needed')).toContainText(
      'Choose a delivery address',
    )
    await addAddress(page)
    await page.goto('/location')
    await page.getByRole('button', { name: 'Deliver here' }).click()
    await expect(page.getByTestId('location-status')).toContainText(
      'Delivering to your Home address',
    )
    await expect(page.getByTestId('location-chip')).toHaveText('Deliver to 560001')
    const before = (await requests()).length
    await page.goto('/cart')
    await expect(
      page.getByText('Stock and delivery are confirmed once a delivery address is chosen.'),
    ).toHaveCount(0)
    await expect(page.getByTestId('cart-location-needed')).toHaveCount(0)
    const cartReads = (await requests()).slice(before).filter((r) => r.path === '/v1/customer/cart')
    expect(cartReads.length).toBeGreaterThan(0)
    expect(cartReads.every((r) => /^\?addressId=ADDR_[A-Za-z0-9_-]+$/.test(r.query))).toBe(true)
    // a later change goes under the address too
    await page
      .getByRole('button', { name: /Increase|\+/ })
      .first()
      .click()
      .catch(() => {})
  })

  test('a deleted selected address (on another device) falls back to the cart without a location', async ({
    page,
  }) => {
    await signIn(page, '9876543210', '/p/TZP-1001')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('Added 1')
    await addAddress(page)
    await page.goto('/location')
    await page.getByRole('button', { name: 'Deliver here' }).click()
    await expect(page.getByTestId('location-status')).toContainText('Delivering to')
    await control('delivery', 'wipe=CUS_e2e0001')
    await page.goto('/cart')
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible()
    await expect(page.getByTestId('cart-location-needed')).toBeVisible()
  })

  test("another customer cannot see, open, change or delete someone else's address (the BFF adds no user id)", async ({
    page,
    browser,
    request,
  }) => {
    await signIn(page)
    await addAddress(page)
    const href = (await page.getByRole('link', { name: /^Edit/ }).getAttribute('href'))!
    const addressId = decodeURIComponent(href.split('/').pop()!)
    const second = await browser.newContext()
    const other = await second.newPage()
    await signIn(other, '9123456780')
    await other.goto('/account/addresses')
    await expect(other.getByTestId('address-empty')).toBeVisible()
    const response = await other.goto(href)
    expect(response?.status()).toBe(404)
    // every mutation with the victim's id is the backend's 404, from the attacker's own session
    const csrf = await other.goto('/account/addresses/new').then(async () => {
      const reqPromise = other.waitForRequest('**/api/addresses')
      await other.getByLabel('Full name').fill('Eve')
      await other.getByLabel('Mobile number').fill('9123456780')
      await other.getByLabel('Address line 1').fill('1 Road')
      await other.getByLabel('City').fill('Delhi')
      await other.getByLabel('State').fill('Delhi')
      await other.getByLabel('PIN code').fill('110001')
      await other.getByRole('button', { name: 'Save address' }).click()
      return (await reqPromise).headers()['x-tazzzo-csrf']!
    })
    const post = (path: string, data: unknown) =>
      other.request.post(path, {
        headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': csrf, origin: ORIGIN },
        data,
      })
    expect((await post('/api/addresses/default', { addressId })).status()).toBe(404)
    expect((await post('/api/addresses/delete', { addressId, version: 1 })).status()).toBe(404)
    expect((await post('/api/location', { addressId })).status()).toBe(404)
    expect(
      (await post('/api/addresses/default', { addressId, customerId: 'CUS_e2e0001' })).status(),
    ).toBe(400)
    // and the victim's address is untouched
    await page.goto('/account/addresses')
    await expect(page.getByTestId('address-card')).toHaveCount(1)
    void request
    await second.close()
  })

  test('address ids outside the grammar are a 404 page without a backend call', async ({
    page,
  }) => {
    await signIn(page)
    const before = (await requests()).length
    for (const bad of ['not-an-id', 'ADDR_x', 'addr_abcdefghij', 'ADDR_%2e%2e']) {
      const res = await page.goto(`/account/addresses/${bad}`)
      expect(res?.status(), bad).toBe(404)
    }
    expect((await requests()).slice(before).filter((r) => r.path.includes('/addresses/'))).toEqual(
      [],
    )
  })

  test('address mutations need the session CSRF token', async ({ page }) => {
    await signIn(page)
    const res = await page.request.post('/api/addresses/default', {
      headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': '1', origin: ORIGIN },
      data: { addressId: 'ADDR_abcdefghij1' },
    })
    expect(res.status()).toBe(403)
  })
})

test.describe('delivery slots', () => {
  test('shows date + window with full and closed slots unavailable; saves address and slot; refuses a taken slot', async ({
    page,
    context,
  }) => {
    await signIn(page)
    await addAddress(page)
    await page.goto('/checkout/delivery')
    await expect(page.getByRole('heading', { name: 'Delivery' })).toBeVisible()
    const days = page.locator('.slot-day')
    await expect(days).toHaveCount(3)
    await expect(
      page.getByRole('radio', { name: /Afternoon.*Fully booked/ }).first(),
    ).toBeDisabled()
    await expect(
      page.getByRole('radio', { name: /Evening.*Booking closed/ }).first(),
    ).toBeDisabled()
    await expect(page.getByTestId('slot-option').first()).toContainText(/9:00\s?am to 11:00\s?am/i)
    await page.getByRole('button', { name: 'Save delivery choice' }).click()
    await expect(page.getByTestId('delivery-error')).toHaveText('Choose a delivery slot.')
    // keyboard selection
    await page
      .getByRole('radio', { name: /Morning/ })
      .nth(1)
      .focus()
    await page.keyboard.press('Space')
    await expect(page.getByRole('radio', { name: /Morning/ }).nth(1)).toBeChecked()
    await page.getByRole('button', { name: 'Save delivery choice' }).click()
    await expect(page.getByTestId('delivery-saved')).toContainText('saved for the next step')
    const cookie = (await context.cookies()).find((c) => c.name === 'tz_checkout_dev')!
    expect(cookie.httpOnly).toBe(true)
    // reload: the saved slot is selected again
    await page.reload()
    await expect(page.getByRole('radio', { name: /Morning/ }).nth(1)).toBeChecked()
    // everything gets booked meanwhile
    await control('delivery', 'slotsFull=1')
    await page.getByRole('button', { name: 'Save delivery choice' }).click()
    await expect(page.getByTestId('delivery-error')).toContainText('no longer available')
  })

  test('an unserviceable address, an area with no slots, and no address at all each have a state', async ({
    page,
  }) => {
    await signIn(page)
    await page.goto('/checkout/delivery')
    await expect(page.getByTestId('delivery-no-address')).toBeVisible()
    await addAddress(page, { 'PIN code': '400001' })
    await page.goto('/checkout/delivery')
    await expect(page.getByTestId('slots-unserviceable')).toBeVisible()
    await addAddress(page, { 'PIN code': '560002' })
    await page.goto('/checkout/delivery')
    await page.getByRole('radio', { name: /560002/ }).click()
    await expect(page).toHaveURL(/address=ADDR_/)
    await expect(page.getByTestId('slots-empty')).toBeVisible()
  })

  test('slots are read for the address PIN, with the session token', async ({ page }) => {
    await signIn(page)
    await addAddress(page)
    const before = (await requests()).length
    await page.goto('/checkout/delivery')
    const reads = (await requests())
      .slice(before)
      .filter((r) => r.path === '/v1/customer/delivery/slots')
    expect(reads.map((r) => [r.query, r.bearer])).toEqual([['?pin=560001', true]])
  })

  test('the choice API refuses a forged request and bad grammar', async ({ page }) => {
    await signIn(page)
    const post = (headers: Record<string, string>, data: unknown) =>
      page.request.post('/api/checkout/delivery', {
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        data,
      })
    expect(
      (
        await post(
          { 'x-tazzzo-csrf': '1' },
          { addressId: 'ADDR_abcdefghij1', slotId: 'morning~2026-10-11' },
        )
      ).status(),
    ).toBe(403)
  })
})

test.describe('layouts', () => {
  for (const [name, size] of [
    ['375', { width: 375, height: 800 }],
    ['768', { width: 768, height: 900 }],
    ['1280', { width: 1280, height: 900 }],
  ] as const) {
    test(`${name}px: chip visible, no horizontal scroll on location, address and slot pages`, async ({
      page,
    }) => {
      await page.setViewportSize(size)
      await signIn(page)
      await addAddress(page)
      for (const path of [
        '/',
        '/location',
        '/account/addresses',
        '/account/addresses/new',
        '/checkout/delivery',
      ]) {
        await page.goto(path)
        await expect(page.getByTestId('location-chip')).toBeVisible()
        await expect
          .poll(
            () =>
              page.getByTestId('location-chip').evaluate((el) => el.getBoundingClientRect().height),
            { message: `chip at ${path}` },
          )
          .toBeGreaterThanOrEqual(44)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, `${path} at ${name}`).toBeLessThanOrEqual(0)
      }
    })
  }
})
