// J11 pricing, J12 inventory (admin + listStock + stock state on PDP/cart), J21 category by id + storefront category page.
import { call, check, Customer, journey, log, pub, RUN, S, sellable, setPrice, setStock, sleep, uiSignIn, visitor, get } from './support'
import { shot, uiSetLocation, untilPage } from './web'

journey('J11', 'pricing set (admin) and visible on the storefront: price + MRP, versioned writes', async ({ page }) => {
  const id = `TZP-E2E-P${RUN}`
  await sellable(id, `E2E Priced ${RUN}`, { sell: 25000, mrp: 30000 })
  const cur = await call('GET', `/api/v1/admin/prices/${id}`)
  check('admin read of the price: 25000 / 30000 paise, active', cur.body.sellingPricePaise === 25000 && cur.body.mrpPaise === 30000 && cur.body.active === true, cur.body)
  const d1 = await pub(`/v1/products/${id}?pin=560001`)
  check('public detail shows price, MRP and 16% discount', d1.body.sellingPricePaise === 25000 && d1.body.mrpPaise === 30000 && d1.body.discountPercent === 16, { p: d1.body.sellingPricePaise, m: d1.body.mrpPaise, d: d1.body.discountPercent })
  await page.goto(`/p/${id}`)
  check('browser PDP: ₹250 selling price and struck-through ₹300 MRP', (await page.locator('.price__selling').innerText()).includes('250') && (await page.locator('.price__mrp s').innerText()).includes('300'))
  await shot(page, 'j11-pdp-price-1')
  const up = await setPrice(id, 22500, 30000, cur.body.version)
  check('versioned price update -> 200', up.status === 200 && up.body.sellingPricePaise === 22500, up.body)
  const stale = await setPrice(id, 21000, 30000, cur.body.version)
  check('stale expectedVersion -> 409', stale.status === 409, { status: stale.status, code: stale.body?.error?.code })
  const bad = await setPrice(id, 40000, 30000)
  check('MRP below selling price -> 422 and the price is unchanged', bad.status === 422 && (await call('GET', `/api/v1/admin/prices/${id}`)).body.sellingPricePaise === 22500, bad.status)
  const neg = await setPrice(id, -5, 30000)
  check('negative price -> 4xx', neg.status >= 400 && neg.status < 500, neg.status)
  const rd = await call('PUT', `/api/v1/admin/prices/${id}`, { role: 'reader', body: { sellingPricePaise: 1, mrpPaise: 2, currency: 'INR' } })
  check('reader may not write prices (403)', rd.status === 403, rd.status)
  const d2 = await pub(`/v1/products/${id}?pin=560001`)
  check('public detail has the new price at once', d2.body.sellingPricePaise === 22500, d2.body.sellingPricePaise)
  const ok = await untilPage(page, 'PDP shows ₹225', `/p/${id}`, async (p) => (await p.locator('.price__selling').innerText()).includes('225'))
  check('storefront PDP converges to the new price (within the 60 s cache + revalidation window)', ok)
  let card: any = null
  for (let i = 0; i < 40; i++) {
    const l = await pub(`/v1/categories/TZV-000001/products?pin=560001&page_size=50`, { quiet: true })
    card = (l.body.items ?? []).find((x: any) => x.productId === id)
    if (card?.sellingPricePaise === 22500) break
    await sleep(1000)
  }
  check('category card carries the new price once the projection catches up', card?.sellingPricePaise === 22500, card)
  await shot(page, 'j11-pdp-price-2')
  S.set('j11', { id })
})

journey('J12', 'inventory set (admin) + admin stock list + stock state on PDP and cart', async ({ page }) => {
  const id = `TZP-E2E-S${RUN}`
  await sellable(id, `E2E Stocked ${RUN}`, { sell: 12000, mrp: 15000, stock: 10 })
  const list = async (q = '') => (await call('GET', `/api/v1/admin/inventory${q}`)).body
  let rows = (await list('?limit=200')).items as any[]
  const row = () => rows.find((r) => r.skuId === id)
  check('listStock shows the SKU with onHand 10, IN_STOCK', row()?.onHand === 10 && row()?.stockState === 'IN_STOCK' && row()?.available === 10, row())
  const cur = await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)
  const low = await setStock(id, 2, { expectedVersion: cur.body.version, maxPurchasable: 5 })
  check('set onHand 2 (threshold 3) -> 200', low.status === 200 && low.body.onHand === 2, low.body)
  rows = (await list('?limit=200')).items
  check('listStock now reports LOW_STOCK', row()?.stockState === 'LOW_STOCK', row()?.stockState)
  const pubLow = await pub(`/v1/products/${id}?pin=560001`)
  check('public detail with a PIN: LOW_STOCK, lowStockRemaining 2', pubLow.body.stockState === 'LOW_STOCK' && pubLow.body.lowStockRemaining === 2, { s: pubLow.body.stockState, r: pubLow.body.lowStockRemaining })
  const noPin = await pub(`/v1/products/${id}`)
  check('without a PIN the stock state is UNKNOWN (backend cannot say)', noPin.body.stockState === 'UNKNOWN', noPin.body.stockState)
  const stale = await setStock(id, 9, { expectedVersion: cur.body.version })
  check('stale expectedVersion -> 409', stale.status === 409, stale.status)
  check('reader may not write stock (403)', (await setStock(id, 9, {}, 'FL-E2E-1', 'reader')).status === 403)
  check('negative onHand -> 4xx', (await setStock(id, -1)).status >= 400)
  await visitor(page)
  const phone = await uiSignIn(page, undefined, '/location')
  await uiSetLocation(page, '560001')
  const okLow = await untilPage(page, 'PDP says Only 2 left for delivery to 560001', `/p/${id}`, async (p) => (await p.getByTestId('availability').innerText()).includes('Only 2 left'))
  check('browser PDP (PIN set): "Only 2 left for delivery to 560001."', okLow)
  const c = await Customer.signIn()
  await c.addAddress()
  await c.setItem(id, 2)
  const cur2 = await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)
  const out = await setStock(id, 0, { maxPurchasable: 1, expectedVersion: cur2.body.version }, 'FL-E2E-1')
  check('set onHand 0 -> 200', out.status === 200 && out.body.available === 0, out.body)
  rows = (await list('?limit=200')).items
  check('listStock reports OUT_OF_STOCK', row()?.stockState === 'OUT_OF_STOCK', row()?.stockState)
  const cart = await c.cart()
  check('the customer cart line flags OUT_OF_STOCK immediately (cart is never cached)', cart.body.items[0].issues.includes('OUT_OF_STOCK') && cart.body.items[0].buyable === false, cart.body.items[0])
  const okOut = await untilPage(page, 'PDP Add to cart disabled / Out of stock', `/p/${id}`, async (p) => (await p.getByTestId('stock-state').count()) > 0 && (await p.getByTestId('stock-state').innerText()).includes('Out of stock'))
  check('browser PDP: "Out of stock" with the Add to cart button disabled', okOut && (await page.getByRole('button', { name: 'Add to cart' }).isDisabled()))
  await shot(page, 'j12-pdp-out-of-stock')
  const restock = await setStock(id, 6, { expectedVersion: out.body.version })
  check('restock to 6 -> IN_STOCK again', restock.status === 200 && (await pub(`/v1/products/${id}?pin=560001`)).body.stockState === 'IN_STOCK')
  S.set('j12', { id })
})

journey('J21', 'category by id (/v1/categories/{id}) and the storefront category page', async ({ page }) => {
  for (const [nodeId, name] of [['TZV-000001', 'Basmati Rice'], ['TZS-000001', 'Staples'], ['TZC-000001', 'Rice & Grains']] as const) {
    const r = await pub(`/v1/categories/${nodeId}`)
    check(`GET /v1/categories/${nodeId} -> 200 "${name}"`, r.status === 200 && r.body.id === nodeId && r.body.name === name, r.body)
  }
  check('unknown node id -> 404', (await pub('/v1/categories/TZV-999999')).status === 404)
  const bad = await pub('/v1/categories/not-a-node')
  check('malformed node id -> 4xx JSON (never 5xx)', bad.status >= 400 && bad.status < 500, { status: bad.status, body: bad.body })
  const ch = await pub('/v1/categories/TZG-000001/children')
  check('children of a group list its verticals', ch.status === 200 && Array.isArray(ch.body.items), ch.body)
  const prods = await pub('/v1/categories/TZV-000001/products?pin=560001&page_size=2')
  check('products under the vertical are paged (page_size 2 -> nextCursor when more)', prods.status === 200 && prods.body.items.length <= 2, { n: prods.body.items?.length, more: prods.body.hasMore })
  const r = await page.goto('/c/TZV-000001')
  check('storefront /c/TZV-000001 -> 200 with the category title', r?.status() === 200 && (await page.locator('#category-title').innerText()) === 'Basmati Rice')
  check('the page lists seeded product cards', (await page.locator('article.card[data-product-id="TZP-E2E-RICE5"]').count()) === 1)
  await shot(page, 'j21-category-vertical')
  const parent = await page.goto('/c/TZC-000001')
  check('a parent category page (/c/TZC-000001) renders with sub-category links', parent?.status() === 200 && (await page.locator('nav[aria-label="Sub-categories"] a').count()) > 0)
  await page.locator('nav[aria-label="Sub-categories"] a').first().click()
  await page.waitForURL(/\/c\/TZ[GV]-\d{6}/, { timeout: 15_000 }).catch(() => undefined)
  check('clicking a sub-category navigates to /c/<id>', /\/c\/TZ[GV]-\d{6}/.test(page.url()), page.url())
  check('unknown category page -> 404', (await page.goto('/c/TZV-999999'))?.status() === 404)
})
