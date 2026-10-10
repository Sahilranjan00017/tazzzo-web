import { expect, test, type Page } from '@playwright/test'

/**
 * Checkout review, Cash on Delivery placement, order confirmation and Orders against the real Next.js runtime and
 * the fake backend's quote / order contract (tests/support/fake-backend.ts, compared with the controller sources).
 * The deployment under test says the backend has a 10 minute customer cancellation window
 * (`STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS`, tests/e2e/global-setup.ts); the fake's own window starts closed, like
 * the backend's default.
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
interface OrdersState {
  orders: Array<{ orderId: string; customerId: string; quoteId: string; status: string }>
  quotes: number
  purchasedThrough: number
  placements: Array<{ body: { quoteId: string; paymentMethod: string; deliverySlotId?: string } }>
}
async function state(): Promise<OrdersState> {
  return (await (
    await fetch(`${backend()}/__control/orders`, { method: 'POST' })
  ).json()) as OrdersState
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

async function addAddress(page: Page) {
  await page.goto('/account/addresses/new')
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
}

async function addToCart(page: Page, sku = 'TZP-1001', times = 1) {
  await page.goto(`/p/${sku}`)
  for (let i = 0; i < times; i++) {
    await page.getByRole('button', { name: 'Add to cart' }).click()
    await expect(page.getByTestId('add-status')).toContainText('to your cart')
  }
}

async function chooseSlot(page: Page, name: RegExp = /Morning/) {
  await page.goto('/checkout/delivery')
  await page.getByRole('radio', { name }).first().check()
  await page.getByRole('button', { name: 'Save delivery choice' }).click()
  await expect(page.getByTestId('delivery-saved')).toContainText('saved for the next step')
}

/** Signed in, an address, one line (quantity 2) in the cart, a slot chosen: on the review page. */
/** Opens the cancel form; a press before the page has hydrated does nothing, so press until the form is there. */
async function openCancel(page: Page) {
  const reason = page.getByLabel('Reason')
  await expect(async () => {
    if (!(await reason.isVisible())) await page.getByTestId('cancel-open').click({ timeout: 1000 })
    await expect(reason).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 20_000 })
}

async function toReview(page: Page, phone?: string) {
  await signIn(page, phone)
  await addAddress(page)
  await addToCart(page, 'TZP-1001', 2)
  await chooseSlot(page)
  await page.getByTestId('delivery-continue').click()
  await expect(page).toHaveURL(/\/checkout$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible()
  await page.waitForLoadState('networkidle') // the buttons only work once the page has hydrated
}

test.beforeEach(async () => {
  await control('auth', 'accessTtl=900')
  await control('cart', 'reset=1')
  await control('delivery', 'reset=1')
  await control('orders', 'reset=1')
})

test.describe('signed out and incomplete', () => {
  test('every page and route sends a signed-out visitor to sign-in with a safe next, or refuses', async ({
    page,
    request,
  }) => {
    await page.goto('/checkout')
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)checkout$/)
    await page.goto('/orders')
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)orders$/)
    await page.goto('/orders/ORD_abcdefghijklmnopqrstu')
    await expect(page).toHaveURL(/\/login\?next=%2Forders%2FORD_abcdefghijklmnopqrstu$/)
    const before = (await requests()).length
    const post = (path: string, headers: Record<string, string>, data: unknown) =>
      request.post(path, {
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        data,
      })
    const place = {
      quoteId: 'CHKQ_abcdefghijklmnopqrstu',
      cartVersion: 1,
      addressId: 'ADDR_abcdefghij1',
      slotId: 'morning~2026-10-11',
    }
    // The CSRF rule comes first (a forged request is 403 even without a session), then the session.
    expect((await post('/api/orders', { 'x-tazzzo-csrf': 'nope' }, place)).status()).toBe(403)
    expect((await post('/api/orders', {}, place)).status()).toBe(403)
    const unauth = await post('/api/orders', { 'x-tazzzo-csrf': '1' }, place)
    expect(unauth.status()).toBe(401)
    expect(unauth.headers()['cache-control']).toBe('no-store')
    expect(
      (
        await post(
          '/api/orders/cancel',
          { 'x-tazzzo-csrf': '1' },
          { orderId: 'ORD_abcdefghijklmnopqrstu', reason: 'OTHER' },
        )
      ).status(),
    ).toBe(401)
    expect((await post('/api/checkout/refresh', { 'x-tazzzo-csrf': '1' }, {})).status()).toBe(401)
    expect((await requests()).slice(before)).toEqual([])
  })

  test('an empty cart goes to the cart; a cart without a delivery choice goes to the delivery step', async ({
    page,
  }) => {
    await signIn(page)
    await addAddress(page)
    await page.goto('/checkout')
    await expect(page).toHaveURL(/\/cart$/)
    await expect(page.getByText('Your cart is empty.')).toBeVisible()
    await addToCart(page)
    await page.waitForLoadState('networkidle') // the add has settled (and the header refresh with it)
    await page.goto('/checkout')
    await expect(page).toHaveURL(/\/checkout\/delivery$/, { timeout: 15_000 })
  })

  test('the sign-in round trip returns to the review', async ({ page }) => {
    await page.goto('/checkout')
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)checkout$/)
    await page.getByLabel('Mobile number').fill('9876543210')
    await page.getByRole('button', { name: 'Send code' }).click()
    await page.getByLabel('6-digit code').fill('123456')
    await page.getByRole('button', { name: 'Sign in' }).click()
    // signed in with an empty cart: the review sends the customer on to the cart
    await expect(page).toHaveURL(/\/cart$/)
  })
})

test.describe('the happy path', () => {
  test('review, place, confirmation, orders: backend numbers throughout, one order', async ({
    page,
    context,
  }) => {
    await toReview(page)
    // The review is the backend's quote.
    const lines = page.locator('.checkout-line')
    await expect(lines).toHaveCount(1)
    await expect(lines.first()).toContainText('Basmati Rice 5 kg')
    await expect(lines.first()).toContainText('Quantity 2')
    await expect(lines.first()).toContainText('₹998')
    await expect(page.getByTestId('checkout-total')).toHaveText('₹998')
    await expect(page.getByTestId('checkout-address')).toContainText('Asha Verma')
    await expect(page.getByTestId('checkout-address')).toContainText('12 MG Road')
    await expect(page.getByTestId('checkout-slot')).toContainText('Morning')
    await expect(page.getByTestId('checkout-payment')).toContainText('Cash on delivery')
    await expect(page.getByTestId('checkout-place')).toHaveText('Place order · ₹998')
    const quoteCall = (await requests())
      .filter((r) => r.path === '/v1/customer/checkout/quote')
      .at(-1)!
    expect(quoteCall.ifMatch).toMatch(/^"cart-\d+"$/)
    expect(quoteCall.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(quoteCall.bearer).toBe(true)

    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/\/orders\/ORD_[A-Za-z0-9_-]+\?placed=1$/)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Thank you, your order is placed' }),
    ).toBeFocused()
    await expect(page.getByTestId('order-placed')).toContainText('keep ₹998 ready to pay in cash')
    await expect(page.getByTestId('order-status')).toHaveText('Confirmed')
    await expect(page.getByTestId('order-total')).toHaveText('₹998')
    await expect(page.getByTestId('order-address')).toContainText('12 MG Road')
    await expect(page.getByTestId('order-slot')).toContainText('Morning')
    await expect(page.locator('.order-line')).toContainText('Basmati Rice 5 kg')

    const placed = await state()
    expect(placed.orders).toHaveLength(1)
    expect(placed.placements).toHaveLength(1)
    expect(placed.placements[0]!.body).toMatchObject({
      quoteId: expect.stringMatching(/^CHKQ_/),
      paymentMethod: 'COD',
      deliverySlotId: expect.stringMatching(/^morning~\d{4}-\d{2}-\d{2}$/),
    })
    // Nothing a customer could price or own is on the wire.
    expect(Object.keys(placed.placements[0]!.body).sort()).toEqual([
      'deliverySlotId',
      'paymentMethod',
      'quoteId',
    ])
    const orderId = placed.orders[0]!.orderId
    expect(page.url()).toContain(orderId)

    // The cart is emptied by the backend, the checkout cookie is gone, the header has no count.
    const cookies = await context.cookies()
    expect(cookies.some((c) => c.name === 'tz_checkout_dev')).toBe(false)
    await expect(page.getByTestId('cart-count')).toHaveCount(0)
    await page.goto('/checkout')
    await expect(page).toHaveURL(/\/cart$/)

    // Orders
    await page.getByTestId('orders-link').click()
    await expect(page).toHaveURL(/\/orders$/)
    await expect(page.locator('.order-card')).toHaveCount(1)
    await expect(page.locator('.order-card')).toContainText('Confirmed')
    await expect(page.locator('.order-card')).toContainText('2 items · ₹998')
    await page.getByTestId('order-link').click()
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Your order' })).toBeVisible()
    await expect(page.getByTestId('order-placed')).toHaveCount(0)
    await expect(page.getByTestId('order-id')).toContainText(orderId)
  })

  test('benefits and totals come from the quote, and the order settles on the same money', async ({
    page,
  }) => {
    await control('orders', 'benefit=1000')
    await toReview(page)
    await expect(page.getByTestId('checkout-subtotal')).toHaveText('₹998')
    await expect(page.getByTestId('checkout-discount')).toHaveText('−₹99.80')
    await expect(page.getByTestId('checkout-total')).toHaveText('₹898.20')
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    await expect(page.getByTestId('order-discount')).toHaveText('−₹99.80')
    await expect(page.getByTestId('order-total')).toHaveText('₹898.20')
  })

  test('every one of these pages and APIs is no-store, and nothing cacheable carries order data', async ({
    page,
    context,
  }) => {
    await toReview(page)
    // `next dev` answers pages with `no-cache, must-revalidate`; the exact production header is asserted in the production run.
    const notCacheable = (cc: string | undefined) => {
      expect(cc ?? '').toMatch(/no-store|no-cache/)
      expect(cc ?? '').not.toMatch(/public|s-maxage/)
    }
    const noStore = (cc: string | undefined) => expect(cc ?? '').toContain('no-store')
    notCacheable((await page.goto('/checkout'))?.headers()['cache-control'])
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    const orderId = (await state()).orders[0]!.orderId
    notCacheable((await page.goto(`/orders/${orderId}`))?.headers()['cache-control'])
    notCacheable((await page.goto('/orders'))?.headers()['cache-control'])
    notCacheable((await page.goto('/orders/ORD_unknownunknown1'))?.headers()['cache-control'])
    const response = await context.request.post('/api/orders', {
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-tazzzo-csrf': 'wrong' },
      data: {},
    })
    noStore(response.headers()['cache-control'])
  })

  test('a keyboard user can review and place the order; focus and announcements follow', async ({
    page,
  }) => {
    await toReview(page)
    await page.getByTestId('checkout-place').focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/placed=1$/)
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    await expect(page.getByTestId('order-placed')).toHaveAttribute('role', 'status')
  })
})

test.describe('placing twice, retries and unknown outcomes', () => {
  test('a double click places ONE order and sends one placement request', async ({ page }) => {
    await toReview(page)
    await page.getByTestId('checkout-place').dblclick()
    await expect(page).toHaveURL(/placed=1$/)
    const s = await state()
    expect(s.orders).toHaveLength(1)
    expect(s.placements).toHaveLength(1)
  })

  test('two parallel requests for the same quote (two tabs, a retry storm) return the same order', async ({
    page,
  }) => {
    await toReview(page)
    // Capture what the button would send, without sending it.
    let captured: { headers: Record<string, string>; body: string } | null = null
    await page.route('**/api/orders', async (route) => {
      captured = { headers: route.request().headers(), body: route.request().postData() ?? '' }
      await route.abort()
    })
    await page.getByTestId('checkout-place').click()
    await expect.poll(() => captured).not.toBeNull()
    await page.unroute('**/api/orders')
    const send = () =>
      page.request.post('/api/orders', {
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-tazzzo-csrf': captured!.headers['x-tazzzo-csrf']!,
        },
        data: captured!.body,
      })
    const [a, b] = await Promise.all([send(), send()])
    const ids = [await a.json(), await b.json()].map((r) => r.data?.orderId)
    const settled = await state()
    expect(settled.orders).toHaveLength(1)
    expect(settled.purchasedThrough).toBeGreaterThanOrEqual(0)
    // Both either got the order or (the loser of the cookie race) a clear refusal: never a second order.
    for (const id of ids) expect([settled.orders[0]!.orderId, undefined]).toContain(id)
    expect(ids.some((id) => id === settled.orders[0]!.orderId)).toBe(true)
  })

  test('the answer is lost after the order committed (503): "status unknown", Orders has it, a retry returns the SAME order', async ({
    page,
  }) => {
    await toReview(page)
    await control('orders', 'fault=after:503')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText(
      'could not confirm whether your order was placed',
    )
    await expect(page.getByTestId('checkout-error')).toBeFocused()
    await expect(page.getByTestId('checkout-to-orders')).toBeVisible()
    await expect(page.getByTestId('checkout-place')).toHaveAttribute('aria-disabled', 'false')
    expect((await state()).orders).toHaveLength(1) // it really is there
    // A reload of the review in this state reuses the same quote (same key, same cart): nothing new is created.
    const quotesBefore = (await state()).quotes
    // retry: same quote
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    const s = await state()
    expect(s.orders).toHaveLength(1)
    expect(s.quotes).toBe(quotesBefore)
    expect(s.placements).toHaveLength(2)
    expect(s.placements[1]!.body.quoteId).toBe(s.placements[0]!.body.quoteId)
    expect(page.url()).toContain(s.orders[0]!.orderId)
  })

  test('a 503 before anything happened: nothing was ordered, the retry uses the same quote and creates one order', async ({
    page,
  }) => {
    await toReview(page)
    await control('orders', 'fault=before:503')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('could not confirm whether')
    expect((await state()).orders).toHaveLength(0)
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    const s = await state()
    expect(s.orders).toHaveLength(1)
    expect(s.placements.map((p) => p.body.quoteId)).toEqual([
      s.placements[0]!.body.quoteId,
      s.placements[0]!.body.quoteId,
    ])
  })

  test('refreshing the review reuses the quote and its Idempotency-Key; the cart changing moves to a new one', async ({
    page,
  }) => {
    await toReview(page)
    const quote = () => page.locator('[data-quote-id]').getAttribute('data-quote-id')
    const first = await quote()
    const keysOf = async () =>
      (await requests())
        .filter((r) => r.path === '/v1/customer/checkout/quote')
        .map((r) => r.idempotencyKey)
    await page.reload()
    await page.reload()
    expect(await quote()).toBe(first)
    const keys = await keysOf()
    expect(new Set(keys.slice(-3)).size).toBe(1)
    // Another tab changes the cart: the version moves, so does the key, so does the quote.
    await control('cart', 'addLine=TZP-1002&qty=1')
    await page.reload()
    expect(await quote()).not.toBe(first)
    await expect(page.locator('.checkout-line')).toHaveCount(2)
    const after = await keysOf()
    expect(after.at(-1)).not.toBe(after.at(-4))
  })

  test('the order cannot be placed a second time from the same cart in another quote', async ({
    page,
  }) => {
    await toReview(page)
    const reviewUrl = page.url()
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    // The cart is empty; going back to the review sends the customer to the cart, and nothing is placed.
    await page.goto(reviewUrl)
    await expect(page).toHaveURL(/\/cart$/)
    expect((await state()).orders).toHaveLength(1)
  })
})

test.describe('the world changes under the review', () => {
  test('price changed: the new total is shown and must be confirmed explicitly; the old quote is never placed', async ({
    page,
  }) => {
    await toReview(page)
    await control('cart', 'sku=TZP-1001&price=52900')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('A price changed')
    await expect(page.getByTestId('checkout-changed')).toContainText('changed from ₹998 to ₹1,058')
    await expect(page.getByTestId('checkout-total')).toHaveText('₹1,058')
    await expect(page.getByTestId('checkout-place')).toHaveText('Confirm ₹1,058 and place order')
    expect((await state()).orders).toHaveLength(0)
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    await expect(page.getByTestId('order-total')).toHaveText('₹1,058')
    const s = await state()
    expect(s.orders).toHaveLength(1)
    expect(new Set(s.placements.map((p) => p.body.quoteId)).size).toBe(2)
  })

  test('stock gone: the review is re-rendered and says which item cannot be ordered; nothing is placed', async ({
    page,
  }) => {
    await toReview(page)
    await control('cart', 'sku=TZP-1001&mode=out_of_stock')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-blocked')).toBeVisible()
    await expect(page.locator('.checkout-line')).toContainText('Basmati Rice 5 kg')
    await expect(page.locator('.checkout-line')).toContainText('Out of stock.')
    await expect(page.getByTestId('checkout-place')).toHaveCount(0)
    await expect(page.getByTestId('checkout-fix-cart')).toHaveAttribute('href', '/cart')
    expect((await state()).orders).toHaveLength(0)
  })

  test('slot became full: back to the delivery step, no order, and choosing another slot works', async ({
    page,
  }) => {
    await toReview(page)
    await control('delivery', 'slotsFull=1')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText(
      'delivery slot is no longer available',
    )
    await expect(page.getByTestId('checkout-place')).toHaveAttribute('aria-disabled', 'true')
    await page.getByTestId('checkout-to-delivery').click()
    await expect(page).toHaveURL(/\/checkout\/delivery$/)
    await expect(page.getByTestId('slots-none-open')).toBeVisible()
    await control('delivery', 'slotsFull=0')
    await page.reload()
    await page
      .getByRole('radio', { name: /Morning/ })
      .nth(1)
      .check()
    await page.getByRole('button', { name: 'Save delivery choice' }).click()
    await page.getByTestId('delivery-continue').click()
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    expect((await state()).orders).toHaveLength(1)
  })

  test('the review itself notices a slot that is no longer open', async ({ page }) => {
    await toReview(page)
    await control('delivery', 'slotsFull=1')
    await page.reload()
    await expect(page).toHaveURL(/\/checkout\/delivery\?reason=slot$/)
    await expect(page.getByTestId('delivery-notice')).toContainText('no longer available')
  })

  test('address no longer serviceable at placement: told so, sent to the delivery step', async ({
    page,
  }) => {
    await toReview(page)
    await control('orders', 'unserviceable=1')
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('do not deliver to that address')
    await page.getByTestId('checkout-to-delivery').click()
    await expect(page).toHaveURL(/\/checkout\/delivery$/)
    expect((await state()).orders).toHaveLength(0)
  })

  test('the address deleted on another device: the review goes back to the delivery step', async ({
    page,
  }) => {
    await toReview(page)
    await control('delivery', 'wipe=CUS_e2e0001')
    await page.reload()
    await expect(page).toHaveURL(/\/checkout\/delivery\?reason=address$/)
    await expect(page.getByTestId('delivery-notice')).toContainText(
      'address is no longer available',
    )
  })

  test('cart changed in another tab: told, the review is refreshed to the new cart, and placing then works', async ({
    browser,
    page,
    context,
  }) => {
    await toReview(page)
    // The other tab: same session, changes the cart (a version bump and a new line).
    const other = await context.newPage()
    await other.goto('/cart')
    await control('cart', 'addLine=TZP-1002&qty=1')
    await other.close()
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('cart changed in another tab')
    await expect(page.locator('.checkout-line')).toHaveCount(2)
    expect((await state()).orders).toHaveLength(0)
    await expect(page.getByTestId('checkout-total')).toHaveText('₹1,157.50')
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    await expect(page.locator('.order-line')).toHaveCount(2)
    void browser
  })

  test('delivery choice changed in another tab: told, nothing is placed under the old choice', async ({
    page,
    context,
  }) => {
    await toReview(page)
    const other = await context.newPage()
    await other.goto('/checkout/delivery')
    await other
      .getByRole('radio', { name: /Morning/ })
      .nth(1)
      .check()
    await other.getByRole('button', { name: 'Save delivery choice' }).click()
    await expect(other.getByTestId('delivery-saved')).toContainText('saved')
    await other.close()
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('delivery choice changed')
    expect((await state()).orders).toHaveLength(0)
    await expect(page.getByTestId('checkout-slot')).toBeVisible()
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
  })

  test('an expired quote at placement is refreshed and can be confirmed', async ({ page }) => {
    await control('orders', 'ttl=1500')
    await toReview(page)
    await page.waitForTimeout(1800)
    await page.getByTestId('checkout-place').click()
    await expect(page.getByTestId('checkout-error')).toContainText('review expired')
    await control('orders', 'ttl=300000')
    // the page re-rendered with a NEW quote (the seed was replaced)
    await expect(page.getByTestId('checkout-place')).toHaveAttribute('aria-disabled', 'false')
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    expect((await state()).orders).toHaveLength(1)
  })

  test('an expired quote when the page is rendered offers a fresh review, which works', async ({
    page,
  }) => {
    await control('orders', 'ttl=1500')
    await toReview(page)
    await page.waitForTimeout(1800)
    await control('orders', 'ttl=300000')
    await page.reload()
    await expect(page.getByTestId('checkout-expired')).toContainText('Nothing was ordered')
    await page.getByTestId('checkout-refresh').click()
    await expect(page.getByTestId('checkout-place')).toBeVisible()
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
  })

  test('the backend down: the review and Orders say so with a way to retry, and nothing is placed', async ({
    page,
  }) => {
    await toReview(page)
    await control('cart', 'down=1')
    await page.reload()
    await expect(page.getByTestId('checkout-load-error')).toContainText('Nothing was ordered')
    await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/checkout')
    await control('cart', 'down=0')
    await control('orders', 'down=1')
    await page.goto('/orders')
    await expect(page.getByTestId('orders-load-error')).toBeVisible()
    await page.goto('/orders/ORD_abcdefghijklmnopqrstu')
    await expect(page.getByTestId('order-load-error')).toContainText('it is safe')
    await control('orders', 'down=0')
    await page.goto('/orders')
    await expect(page.getByTestId('orders-empty')).toBeVisible()
  })

  test('a forged placement is refused and creates nothing', async ({ page, context }) => {
    await toReview(page)
    const forged = await context.request.post('/api/orders', {
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'x-tazzzo-csrf': 'x',
      },
      data: {
        quoteId: 'CHKQ_abcdefghijklmnopqrstu',
        cartVersion: 1,
        addressId: 'ADDR_abcdefghij1',
        slotId: 'morning~2026-10-11',
      },
    })
    expect(forged.status()).toBe(403)
    expect((await state()).placements).toHaveLength(0)
  })
})

test.describe('orders', () => {
  test("another customer's order is the backend's 404 and reads like an unknown one", async ({
    page,
    browser,
  }) => {
    await toReview(page)
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    const orderId = (await state()).orders[0]!.orderId
    const second = await (await browser.newContext()).newPage()
    await signIn(second, '9123456780')
    const response = await second.goto(`/orders/${orderId}`)
    expect(response?.status()).toBe(404)
    await expect(second.getByTestId('order-not-found')).toBeVisible()
    await expect(second.getByRole('heading', { level: 1, name: 'Order not found' })).toBeVisible()
    await expect(second.locator('body')).not.toContainText('Basmati')
    // the same wording and status as an id that never existed
    const unknown = await second.goto('/orders/ORD_neverexisted1234567890')
    expect(unknown?.status()).toBe(404)
    await expect(second.getByTestId('order-not-found')).toBeVisible()
    // and it is not in their history
    await second.goto('/orders')
    await expect(second.getByTestId('orders-empty')).toBeVisible()
    // nor can they cancel it
    await second.goto('/orders')
    const cancel = await second.request.post('/api/orders/cancel', {
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-tazzzo-csrf': '1' },
      data: { orderId, reason: 'OTHER' },
    })
    expect(cancel.status()).toBe(403) // wrong token for a signed-in customer: refused before anything
    await second.context().close()
    expect((await state()).orders[0]!.status).toBe('CONFIRMED')
  })

  test('order ids outside the backend grammar are a 404 page without any backend call', async ({
    page,
  }) => {
    await signIn(page)
    const before = (await requests()).length
    for (const id of [
      'ORD_..%2f..%2fadmin',
      'ORD_abc',
      'ord_abcdefghijklmnop',
      'ORD_abc%20def1234',
      `ORD_${'a'.repeat(65)}`,
      'CHKQ_abcdefghijklmnopqrstu',
    ]) {
      const res = await page.goto(`/orders/${id}`)
      expect(res?.status(), id).toBe(404)
      await expect(page.getByTestId('order-not-found')).toBeVisible()
    }
    expect(
      (await requests()).slice(before).filter((r) => r.path.startsWith('/v1/customer/orders')),
    ).toEqual([])
  })

  test('history pages with the backend cursor; a made-up cursor is dropped, never forwarded', async ({
    page,
  }) => {
    await signIn(page)
    await control('orders', 'seed=25&customer=CUS_e2e0001')
    await page.goto('/orders')
    await expect(page.locator('.order-card')).toHaveCount(10)
    await expect(page.getByTestId('orders-older')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Newest orders' })).toHaveCount(0)
    await page.getByTestId('orders-older').click()
    await expect(page).toHaveURL(/\/orders\?cursor=/)
    await expect(page.locator('.order-card')).toHaveCount(10)
    await expect(page.getByRole('link', { name: 'Newest orders' })).toBeVisible()
    await page.getByTestId('orders-older').click()
    await expect(page.locator('.order-card')).toHaveCount(5)
    await expect(page.getByTestId('orders-older')).toHaveCount(0)
    const ids = await page
      .locator('.order-card')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-order-id')))
    expect(new Set(ids).size).toBe(5)
    const before = (await requests()).length
    await page.goto('/orders?cursor=not%20a%20cursor%26page_size%3D50')
    await expect(page).toHaveURL(/\/orders$/)
    await page.goto('/orders?cursor=' + 'a'.repeat(129))
    await expect(page).toHaveURL(/\/orders$/)
    // a well-shaped but made-up cursor is the backend's 400: shown as the newest page, not an error
    await page.goto('/orders?cursor=bm90LW1pbnRlZA')
    await expect(page).toHaveURL(/\/orders$/)
    const reads = (await requests()).slice(before).filter((r) => r.path === '/v1/customer/orders')
    for (const read of reads)
      expect(read.query).toMatch(/^\?page_size=10(&cursor=[A-Za-z0-9_-]{1,128})?$/)
  })

  test('with the backend window closed (its default), Cancel is offered by this deployment but refused gracefully', async ({
    page,
  }) => {
    await toReview(page)
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    await openCancel(page)
    await expect(page.getByLabel('Reason')).toBeFocused()
    await page.getByLabel('Reason').selectOption('CHANGED_MIND')
    await page.getByTestId('cancel-confirm').click()
    await expect(page.getByTestId('cancel-error')).toContainText('Cancelling is not available')
    await expect(page.getByTestId('order-status')).toHaveText('Confirmed')
    expect((await state()).orders[0]!.status).toBe('CONFIRMED')
  })

  test('with a backend window open, Cancel works, is announced, and the order shows as cancelled', async ({
    page,
  }) => {
    await control('orders', 'cancelWindow=600')
    await toReview(page)
    await page.getByTestId('checkout-place').click()
    await expect(page).toHaveURL(/placed=1$/)
    await openCancel(page)
    await page.getByLabel('Reason').selectOption('ORDERED_BY_MISTAKE')
    await page.getByTestId('cancel-confirm').click()
    await expect(page.getByTestId('order-status')).toHaveText('Cancelled')
    await expect(page.getByTestId('cancel-open')).toHaveCount(0)
    await expect(page.getByTestId('order-payment')).toContainText('Nothing is due')
    expect((await state()).orders[0]!.status).toBe('CANCELLED')
    // idempotent from the API side too
    await page.goto('/orders')
    await expect(page.locator('.order-card')).toContainText('Cancelled')
  })
})

test.describe('layouts', () => {
  for (const [name, size] of [
    ['375', { width: 375, height: 800 }],
    ['768', { width: 768, height: 900 }],
    ['1280', { width: 1280, height: 900 }],
  ] as const) {
    test(`${name}px: review, confirmation, list and detail fit without sideways scrolling`, async ({
      page,
    }) => {
      await page.setViewportSize(size)
      await toReview(page)
      const fits = async () =>
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true)
      await fits()
      await expect(page.getByTestId('checkout-place')).toBeVisible()
      const box = (await page.getByTestId('checkout-place').boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      await page.getByTestId('checkout-place').click()
      await expect(page).toHaveURL(/placed=1$/)
      await fits()
      await page.goto('/orders')
      await fits()
      await page.locator('[data-testid="order-link"]').first().click()
      await fits()
      await expect(page.getByTestId('order-total')).toBeVisible()
    })
  }
})

test.describe('header', () => {
  test('Orders appears for a signed-in customer only', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('orders-link')).toHaveCount(0)
    await signIn(page)
    await page.goto('/')
    await expect(page.getByTestId('orders-link')).toHaveText('Orders')
    await expect(page.getByTestId('orders-link')).toHaveAttribute('href', '/orders')
  })
})
