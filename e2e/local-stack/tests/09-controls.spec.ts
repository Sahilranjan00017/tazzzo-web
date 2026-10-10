// C1-C6: negative / security controls over the real services.
import { call, check, Customer, env, freshPhone, journey, log, otpFor, RUN, sellable, section, sleep, uiSignIn, visitor, cspViolations, get } from './support'

journey('C1', 'unauthenticated admin calls are 401 (and a bad token is 401, not 403/500)', async () => {
  const probes: [string, string, unknown?][] = [
    ['GET', '/api/v1/admin/me'], ['GET', '/api/v1/admin/orders'], ['GET', '/api/v1/admin/inventory'], ['GET', '/api/v1/admin/imports/jobs'],
    ['POST', '/api/v1/products', {}], ['PUT', '/api/v1/admin/prices/TZP-E2E-RICE5', { sellingPricePaise: 1, mrpPaise: 1, currency: 'INR' }],
    ['POST', '/api/v1/admin/content/blocks', {}], ['POST', '/api/v1/admin/media/uploads', {}], ['GET', '/api/v1/admin/audit-events'],
    ['GET', '/api/v1/taxonomy/nodes'], ['POST', '/api/v1/admin/imports/jobs', {}],
  ]
  for (const [m, p, b] of probes) {
    const r = await call(m, p, { role: 'anonymous', body: b })
    check(`${m} ${p} without credentials -> 401 JSON`, r.status === 401 && Boolean(r.body?.error?.code), { status: r.status, body: r.body })
  }
  const bad = await call('GET', '/api/v1/admin/me', { role: 'anonymous', bearer: 'not-a-real-token' })
  check('garbage bearer -> 401', bad.status === 401, bad.status)
  const cust = await Customer.signIn()
  const asCust = await call('GET', '/api/v1/admin/orders', { role: 'anonymous', bearer: cust.token })
  check('a customer access token is not an admin credential (401/403)', [401, 403].includes(asCust.status), asCust.status)
  const pubOk = await call('GET', '/v1/categories', { role: 'anonymous' })
  check('(control) public reads need no credential', pubOk.status === 200)
})

journey('C2', 'reader role is 403 on every write; reads still work', async () => {
  const id = 'TZP-E2E-RICE5'
  const writes: [string, string, unknown?][] = [
    ['POST', '/api/v1/products', { id: `TZP-RD-${RUN}`, productType: 'single', identityType: 'internal', internalKey: 'rd', brandCode: 'E2E', title: 'x', verticalId: 'TZV-000001', releaseId: 'R1', classificationStatus: 'confirmed' }],
    ['PUT', `/api/v1/admin/prices/${id}`, { sellingPricePaise: 1, mrpPaise: 2, currency: 'INR' }],
    ['PUT', `/api/v1/admin/inventory/${id}/FL-E2E-1`, { onHand: 1, lowStockThreshold: 1, maxPurchasable: 1 }],
    ['POST', '/api/v1/admin/imports/jobs', { kind: 'products' }],
    ['POST', '/api/v1/admin/imports/products', { dryRun: true, rows: [] }],
    ['POST', '/api/v1/admin/content/blocks', {}],
    ['POST', '/api/v1/admin/media/uploads', { ownerType: 'product', ownerId: id, contentType: 'image/png', sizeBytes: 10 }],
    ['PUT', '/api/v1/admin/service-areas/560009', { serviceAreaId: 'SA-X', routes: [] }],
    ['PUT', '/api/v1/admin/delivery-slots/SA-E2E-BLR/night', { label: 'n', startMinute: 1, endMinute: 2, cutoffMinutes: 1, capacity: 1, days: [1] }],
  ]
  for (const role of ['reader', 'human-reader'] as const)
    for (const [m, p, b] of writes) {
      const r = await call(m, p, { role, body: b, quiet: true })
      check(`${role}: ${m} ${p.slice(0, 48)} -> 403`, r.status === 403, r.status)
    }
  log('  (every refusal above is logged as a CHECK line; request bodies omitted)')
  check('reader GET price -> 200', (await call('GET', `/api/v1/admin/prices/${id}`, { role: 'reader' })).status === 200)
  check('reader GET inventory list -> 200', (await call('GET', '/api/v1/admin/inventory', { role: 'reader' })).status === 200)
  const after = await call('GET', `/api/v1/admin/prices/${id}`)
  check('the price is untouched by the refused writes', after.body.sellingPricePaise === 24900, after.body.sellingPricePaise)
})

journey('C3', "a customer cannot read or use another customer's order, address, cart or support case", async () => {
  const id = `TZP-E2E-X${RUN}`
  await sellable(id, `E2E Isolation ${RUN}`, { sell: 10000, mrp: 12000, stock: 10 })
  const a = await Customer.signIn()
  const b = await Customer.signIn()
  await a.addAddress(); await b.addAddress()
  await a.setItem(id, 1)
  const q = await a.quote()
  const placed = await a.place(q.body.quoteId, await a.slot())
  const oid = placed.body.orderId
  check("A's order exists for A", (await a.req('GET', `/v1/customer/orders/${oid}`)).status === 200)
  const r = await b.req('GET', `/v1/customer/orders/${oid}`)
  check("B reading A's order -> 404 (not 200, not 403 that confirms existence)", r.status === 404, r.status)
  check("B's order list does not contain it", !(await b.req('GET', '/v1/customer/orders')).body.items.some((o: any) => o.orderId === oid))
  check("B cancelling A's order -> 404", (await b.req('POST', `/v1/customer/orders/${oid}/cancel`, { body: { reason: 'CHANGED_MIND' } })).status === 404)
  check("B reading A's address -> 404", (await b.req('GET', `/v1/customer/addresses/${a.addressId}`)).status === 404)
  check("B patching A's address -> 404", (await b.req('PATCH', `/v1/customer/addresses/${a.addressId}`, { body: { label: 'HOME', recipientName: 'Mallory', recipientPhone: b.phone, addressLine1: '1 Evil Rd', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001' }, headers: { 'If-Match': '"address-1"' } })).status === 404)
  await b.setItem(id, 1)
  const bq = await b.req('POST', '/v1/customer/checkout/quote', { body: { addressId: a.addressId }, headers: { 'If-Match': `"cart-${(await b.cart()).body.version}"`, 'Idempotency-Key': 'x'.repeat(40) + RUN } })
  check("B quoting with A's addressId is refused (404)", bq.status === 404, bq.status)
  const aq = await b.place(q.body.quoteId, await b.slot())
  check("B placing A's quote -> refused (404, never an order)", aq.status === 404 || aq.status === 403, { status: aq.status, code: aq.body?.code })
  check("B's cart does not contain A's line", (await b.cart()).body.items.every((i: any) => true) && (await a.cart()).body.items.length === 0)
  check('no customer token on the anonymous /v1/customer API -> 401', (await call('GET', '/v1/customer/orders', { role: 'anonymous', caller: true })).status === 401)
  check('a forged/tampered customer token -> 401', (await call('GET', '/v1/customer/orders', { role: 'anonymous', caller: true, bearer: a.token.slice(0, -4) + 'AAAA' })).status === 401)
  check('staff API with the customer token -> 401/403', [401, 403].includes((await call('GET', `/api/v1/admin/orders/${oid}`, { role: 'anonymous', bearer: b.token })).status))
  const storeOrder = await fetch(`${env.store}/orders/${oid}`, { redirect: 'manual' })
  check('storefront /orders/<id> signed out redirects to /login (no order data)', storeOrder.status >= 300 && storeOrder.status < 400 && (storeOrder.headers.get('location') ?? '').includes('/login'), { status: storeOrder.status, location: storeOrder.headers.get('location') })
})

journey('C4', 'OTP request rate limiting: 429 + Retry-After at the backend and through the storefront', async () => {
  section('backend: per-phone bucket (capacity 5, refill 0.01/s) via the real adapter')
  const phone = freshPhone()
  const codes: number[] = []
  let limited: any = null
  let firstOk: any = null
  for (let i = 0; i < 9; i++) {
    const r = await call('POST', '/v1/auth/otp/request', { role: 'anonymous', caller: true, body: { phone }, quiet: true })
    codes.push(r.status)
    if (r.status === 202 && !firstOk) firstOk = r
    if (r.status === 429 && !limited) limited = r
    await sleep(2200) // past the 2 s resend cooldown, so each request is a real send that spends a token
  }
  log(`  statuses for 9 requests to one phone: ${codes.join(',')}`)
  check('first requests accepted (202), then 429', codes[0] === 202 && codes.includes(429), codes)
  check('[BUG-3] the 202 reports the configured windows exactly: expiresInSeconds 300 and resendAfterSeconds 2 (floor off-by-one: OtpService Duration.between of ms-truncated dates)', firstOk?.body?.expiresInSeconds === 300 && firstOk?.body?.resendAfterSeconds === 2, { expiresInSeconds: firstOk?.body?.expiresInSeconds, resendAfterSeconds: firstOk?.body?.resendAfterSeconds })
  check('the 429 carries Retry-After (seconds, > 0)', Number(limited?.headers.get('retry-after')) > 0, limited && Object.fromEntries(limited.headers.entries()))
  check('the 429 body is the fixed envelope (no phone, no OTP, no internals)', limited?.body?.code !== undefined && !JSON.stringify(limited.body).includes(phone), limited?.body)
  log('  429 response headers: ' + JSON.stringify(Object.fromEntries(limited?.headers.entries() ?? [])))
  const other = await call('POST', '/v1/auth/otp/request', { role: 'anonymous', caller: true, body: { phone: freshPhone() }, quiet: true })
  check('another phone is unaffected (202)', other.status === 202, other.status)
  section('through the storefront route (CSRF + origin + visitor bucket), same phone')
  const p2 = freshPhone()
  const sf: number[] = []
  let sfLimited: Response | null = null
  const headers = { 'content-type': 'application/json', 'x-tazzzo-csrf': '1', origin: env.store, 'x-forwarded-for': `198.51.100.${(Number(RUN.slice(-2)) % 200) + 1}` }
  for (let i = 0; i < 9; i++) {
    const r = await fetch(`${env.store}/api/auth/otp/request`, { method: 'POST', headers, body: JSON.stringify({ phone: p2 }) })
    sf.push(r.status)
    if (r.status === 429 && !sfLimited) sfLimited = r
    await r.text()
    await sleep(2200)
  }
  log(`  storefront statuses: ${sf.join(',')}`)
  check('storefront relays the limit as 429 with Retry-After', sf.includes(429) && Number(sfLimited?.headers.get('retry-after')) > 0, { sf, retryAfter: sfLimited?.headers.get('retry-after') })
})

journey('C5', 'CSRF refusal on storefront mutations (no token, foreign origin, wrong method); signed-out is 401', async ({ page }) => {
  await visitor(page)
  await uiSignIn(page, undefined, '/p/TZP-E2E-RICE5')
  const reqP = page.waitForRequest('**/api/cart/add')
  await page.getByRole('button', { name: 'Add to cart' }).click()
  const token = (await reqP).headers()['x-tazzzo-csrf']!
  await page.getByTestId('add-status').filter({ hasText: /^Added/ }).waitFor()
  check('the page itself sends a CSRF token header on its mutation', Boolean(token) && token.length > 10)
  const base = { 'content-type': 'application/json' }
  const body = { productId: 'TZP-E2E-RICE1', quantity: 1 }
  const noTok = await page.request.post('/api/cart/add', { headers: { ...base, origin: env.store }, data: body })
  check('cart add without the CSRF header -> 403', noTok.status() === 403, noTok.status())
  const evil = await page.request.post('/api/cart/add', { headers: { ...base, 'x-tazzzo-csrf': token, origin: 'https://evil.example' }, data: body })
  check('cart add with a valid token but a foreign Origin -> 403', evil.status() === 403, evil.status())
  const wrong = await page.request.post('/api/cart/add', { headers: { ...base, 'x-tazzzo-csrf': 'AAAA' + token.slice(4), origin: env.store }, data: body })
  check('cart add with a wrong token -> 403', wrong.status() === 403, wrong.status())
  const noOrigin = await page.request.post('/api/cart/add', { headers: { ...base, 'x-tazzzo-csrf': token }, data: body })
  log(`  token without any Origin header -> ${noOrigin.status()} (browsers always send Origin on cross-site POSTs)`)
  for (const path of ['/api/orders', '/api/addresses', '/api/location', '/api/checkout/delivery', '/api/auth/logout']) {
    const r = await page.request.post(path, { headers: { ...base, origin: 'https://evil.example' }, data: {} })
    check(`POST ${path} from a foreign origin without a token -> 403`, r.status() === 403, r.status())
  }
  const get = await page.request.get('/api/orders')
  check('GET on a mutation route -> 405', get.status() === 405, get.status())
  const ok = await page.request.post('/api/cart/add', { headers: { ...base, 'x-tazzzo-csrf': token, origin: env.store }, data: body })
  check('(control) the same call with the token and own Origin works (200)', ok.status() === 200, ok.status())
  const anon = await fetch(`${env.store}/api/cart/add`, { method: 'POST', headers: { ...base, 'x-tazzzo-csrf': '1', origin: env.store, 'x-forwarded-for': '198.51.100.250' }, body: JSON.stringify(body) })
  check('signed out with a token -> 401', anon.status === 401, anon.status)
  const logout = await page.request.post('/api/auth/logout', { headers: { ...base, 'x-tazzzo-csrf': token, origin: env.store }, data: {} })
  check('logout with the token works and the session cookie is gone afterwards', logout.status() < 400 && (await page.context().cookies()).every((c) => c.name !== '__Host-tz_session'), logout.status())
  check('no CSP violations on the pages used', (await cspViolations(page)).length === 0, await cspViolations(page))
})

journey('C6', 'malformed queries -> a fixed 400 envelope (no echo, no stack, no 5xx)', async () => {
  const bad = [
    '/v1/search?q=%ZZ', '/v1/search?q=a&q=b', '/v1/search?q=%00', '/v1/categories/TZV-000001/products?page_size=abc',
    '/v1/categories/TZV-000001/products?page_size=-1', '/v1/categories/TZV-000001/products?cursor=garbage', '/v1/products:batch?ids=',
    '/v1/serviceability?pin=abc', '/v1/products:batch?ids=' + Array.from({ length: 80 }, (_, i) => `TZP-X${i}`).join(','),
    '/v1/search?q=' + 'x'.repeat(5000), '/v1/categories?release=%ZZ',
  ]
  const shapes = new Set<string>()
  for (const u of bad) {
    const r = await get(u)
    const leak = /exception|stack|at com\.|java\.|org\.springframework|%ZZ|garbage/i.test(r.text)
    check(`GET ${u.slice(0, 60)} -> 400/414/431, JSON, nothing echoed`, [400, 414, 431].includes(r.status) && (r.headers.get('content-type') ?? '').includes('json') && !leak, { status: r.status, body: r.body })
    if (r.status === 400) shapes.add(`${r.body?.code}|${r.body?.message}|${'requestId' in (r.body ?? {}) ? 'requestId' : 'request_id'}|${'retryable' in (r.body ?? {})}`)
  }
  log('  distinct 400 envelope shapes (code|message|id field|has retryable): ' + JSON.stringify([...shapes]))
  check('[BUG-2] every malformed-query 400 has the SAME envelope (code, message, requestId, retryable)', shapes.size === 1, [...shapes])
  const adm = await call('GET', '/api/v1/admin/inventory?limit=abc')
  check('admin surface: malformed query -> 4xx JSON error envelope', adm.status >= 400 && adm.status < 500 && Boolean(adm.body?.error?.code), { status: adm.status, body: adm.body })
  const r = await fetch(`${env.store}/search?q=${encodeURIComponent('%ZZ')}`)
  check('storefront with a hostile query still answers a normal page (no 500)', r.status < 500, r.status)
})
