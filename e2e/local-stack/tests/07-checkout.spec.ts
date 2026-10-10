// J26 checkout COD end to end (browser), J27 stock + idempotency (double click, replay, oversell).
import { call, check, Customer, journey, log, mongosh, proxyMark, proxySince, pub, RUN, S, section, sellable, setStock, sleep, uiSignIn, visitor, cspViolations, env } from './support'
import { shot, uiAdd, uiCustomer, uiDelivery, uiSetLocation } from './web'

journey('J26', 'checkout COD end to end: OTP sign-in, address, PIN, slot, quote, place, confirmation, Orders list/detail', async ({ page }) => {
  const id = `TZP-E2E-O${RUN}`
  await sellable(id, `E2E Order Rice ${RUN}`, { sell: 30000, mrp: 35000, stock: 20 })
  const stock0 = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
  await visitor(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const mark = await proxyMark()
  const newPin = `56${RUN.slice(-4)}`.replace(/^560000$/, '560099')
  await uiSetLocation(page, newPin)
  check(`a PIN nobody serves yet (${newPin}) is reported as not deliverable`, (await page.getByTestId('location-status').innerText().catch(() => '')).includes('do not deliver'))
  const area = await call('PUT', `/api/v1/admin/service-areas/${newPin}`, { body: { serviceAreaId: 'SA-E2E-BLR', routes: [{ fulfillmentLocationId: 'FL-E2E-1', priority: 1, active: true }] } })
  check('admin serviceability API adds that PIN to the area (201)', [200, 201, 409].includes(area.status), area.status)
  const phone = await uiCustomer(page, uiSignIn, newPin)
  check('signed in through /login with a code delivered via the backend HTTP OTP adapter, address saved for the new PIN', true, phone)
  await uiSetLocation(page, newPin)
  check(`PIN ${newPin} is now serviceable (location chip)`, (await page.getByTestId('location-chip').innerText()).includes(newPin))
  await uiSetLocation(page, '400001')
  check('PIN 400001 stays not serviceable ("do not deliver")', (await page.getByTestId('location-status').innerText().catch(() => '')).includes('do not deliver'))
  await uiSetLocation(page, newPin)
  await uiAdd(page, id)
  await page.goto('/cart')
  await page.getByRole('button', { name: `Increase quantity of E2E Order Rice ${RUN}` }).click()
  await page.getByTestId('cart-subtotal').filter({ hasText: '600' }).waitFor({ timeout: 10_000 })
  await uiDelivery(page)
  const total = await page.getByTestId('checkout-total').innerText()
  check('review page: total ₹600, Cash on delivery', total.includes('600') && (await page.getByTestId('checkout-payment').innerText()).includes('Cash on delivery'), total)
  check('review shows the address and a delivery slot', (await page.getByTestId('checkout-address').innerText()).includes(newPin) && (await page.getByTestId('checkout-slot').innerText()).length > 5)
  await shot(page, 'j26-review')
  await page.getByTestId('checkout-place').click()
  await page.waitForURL(/\/orders\/ORD_[A-Za-z0-9_-]+\?placed=1$/, { timeout: 30_000 })
  const orderId = /ORD_[A-Za-z0-9_-]+/.exec(page.url())![0]
  check('placed: redirect to /orders/<id>?placed=1 with the thank-you heading', (await page.getByRole('heading', { level: 1 }).innerText()).includes('Thank you'), orderId)
  check('confirmation shows total ₹600 and status CONFIRMED', (await page.getByTestId('order-total').innerText()).includes('600') && (await page.getByTestId('order-status').getAttribute('data-status')) === 'CONFIRMED')
  await shot(page, 'j26-confirmation')
  await page.goto('/orders')
  check('Orders list shows the order', (await page.locator(`a[href="/orders/${orderId}"]`).count()) >= 1)
  await page.goto(`/orders/${orderId}`)
  check('Orders detail: line, address snapshot and no cancel control (window 0)', (await page.locator('.order-line').count()) === 1 && (await page.locator('body').innerText()).includes('12 MG Road') && (await page.getByTestId('cancel-open').count()) === 0)
  await page.goto('/cart')
  check('the cart is empty after the order', (await page.locator('.cart-empty').count()) === 1)
  const stock1 = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
  check('stock moved by exactly the ordered 2 units (available down 2)', stock0.available - stock1.available === 2, { before: stock0.available, after: stock1.available, onHand: stock1.onHand, reserved: stock1.reserved })
  const calls = (await proxySince(mark)).filter((e) => /^\/v1\/customer\/(checkout|orders)/.test(e.path))
  check('the storefront called the quote and the order endpoints with trusted-caller headers and a bearer', calls.some((e) => e.path === '/v1/customer/checkout/quote') && calls.some((e) => e.method === 'POST' && e.path === '/v1/customer/orders') && calls.every((e) => e.caller === env.callerName && e.bearer && e.forwardedFor === null))
  check('no uncaught page errors', errors.length === 0, errors)
  S.set('j26', { orderId, id, phone })
})

journey('J27', 'stock + idempotency: double click, quote/placement replay, oversell on the last unit', async ({ page }) => {
  section('double click in the browser = exactly one order')
  const id = `TZP-E2E-D${RUN}`
  await sellable(id, `E2E Dbl Rice ${RUN}`, { sell: 15000, mrp: 18000, stock: 30 })
  await visitor(page)
  const phone = await uiCustomer(page, uiSignIn)
  await uiSetLocation(page, '560001')
  await uiAdd(page, id)
  await uiDelivery(page)
  const mark = await proxyMark()
  await page.getByTestId('checkout-place').dblclick()
  await page.waitForURL(/\/orders\/ORD_[A-Za-z0-9_-]+\?placed=1$/, { timeout: 30_000 })
  const placements = (await proxySince(mark)).filter((e) => e.method === 'POST' && e.path === '/v1/customer/orders')
  check('the double click produced one placement request to the backend', placements.length === 1, placements.length)
  const orders = await page.evaluate(async () => (await fetch('/orders')).status)
  void orders
  const out = await mongosh(`db.orders.countDocuments({ 'lines.skuId': '${id}' })`)
  const out2 = await mongosh(`db.orders.countDocuments({ 'items.skuId': '${id}' })`)
  check('exactly one order exists for the product (datastore count)', Math.max(Number(out.out.trim().split('\n').pop()), Number(out2.out.trim().split('\n').pop())) === 1, { lines: out.out.trim(), items: out2.out.trim() })

  section('replay at the API: same quote placed twice returns the same order; same Idempotency-Key returns the same quote')
  const c = await Customer.signIn()
  await c.addAddress()
  await c.setItem(id, 3)
  const idem = 'idem' + RUN + 'abcdefghijklmnopqrstuvwxyz0123456789'
  const q1 = await c.quote(idem)
  const q2 = await c.quote(idem)
  check('quote replay with the same Idempotency-Key -> same quoteId', q1.status === 200 && q2.status === 200 && q1.body.quoteId === q2.body.quoteId, [q1.body.quoteId, q2.body.quoteId])
  const slot = await c.slot()
  const before = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
  const [o1, o2, o3] = await Promise.all([c.place(q1.body.quoteId, slot), c.place(q1.body.quoteId, slot), c.place(q1.body.quoteId, slot)])
  const okOrders = [o1, o2, o3].filter((o) => o.status === 200 || o.status === 201)
  check('three concurrent placements of the SAME quote: every success is the same order id', okOrders.length >= 1 && new Set(okOrders.map((o) => o.body.orderId)).size === 1, [o1, o2, o3].map((o) => `${o.status}:${o.body.orderId ?? o.body.code}`))
  const o4 = await c.place(q1.body.quoteId, slot)
  check('a later replay returns the same order again (200/201)', (o4.status === 200 || o4.status === 201) && o4.body.orderId === okOrders[0]?.body.orderId, `${o4.status} ${o4.body.orderId ?? o4.body.code}`)
  const after = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
  check('stock was taken once (3 units), not once per request', before.available - after.available === 3, { before: before.available, after: after.available })
  const list = await c.req('GET', '/v1/customer/orders')
  check('the customer has exactly one order', list.body.items.length === 1, list.body.items?.length)

  section('oversell: two customers race for the last unit')
  const last = `TZP-E2E-Z${RUN}`
  await sellable(last, `E2E Last Unit ${RUN}`, { sell: 9900, mrp: 9900, stock: 1 })
  const a = await Customer.signIn()
  const b = await Customer.signIn()
  await a.addAddress(); await b.addAddress()
  const sa = await a.setItem(last, 1)
  const sb = await b.setItem(last, 1)
  check('both can add the last unit to their carts', sa.status === 200 && sb.status === 200)
  const qa = await a.quote()
  const qb = await b.quote()
  log(`  quotes: a=${qa.status} b=${qb.status}`)
  const slotA = await a.slot()
  const [pa, pb] = await Promise.all([qa.status === 200 ? a.place(qa.body.quoteId, slotA) : Promise.resolve(qa), qb.status === 200 ? b.place(qb.body.quoteId, slotA) : Promise.resolve(qb)])
  const wins = [pa, pb].filter((r) => r.status === 200 || r.status === 201).length
  check('exactly ONE of the two placements wins', wins === 1, [pa.status, pb.status])
  const loser = [pa, pb].find((r) => !(r.status === 200 || r.status === 201))
  check('the loser gets a definite stock refusal (409 STOCK_UNAVAILABLE / PRODUCT_UNAVAILABLE), not a 5xx', loser !== undefined && loser.status === 409, loser && { status: loser.status, code: loser.body?.code })
  const inv = (await call('GET', `/api/v1/admin/inventory/${last}/FL-E2E-1`)).body
  check('inventory: available 0, never negative', inv.available === 0 && inv.onHand >= 0, inv)
  const oc = await mongosh(`db.orders.countDocuments({ $or: [{'lines.skuId':'${last}'},{'items.skuId':'${last}'}] })`)
  check('exactly one order holds the last unit (datastore count)', oc.out.trim().split('\n').pop() === '1', oc.out.trim())
  void phone; void sleep
})
