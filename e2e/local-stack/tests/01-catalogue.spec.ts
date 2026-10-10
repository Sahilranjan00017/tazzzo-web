// J1-J4: catalogue create / update / canonical product ids / invalid ids (create, import, cart).
import {
  check,
  createProduct,
  productBody,
  activate,
  setPrice,
  setStock,
  call,
  get,
  pub,
  journey,
  log,
  section,
  RUN,
  sleep,
  Customer,
  uiSignIn,
  visitor,
  S,
  appendCsv,
  createJob,
  jobAction,
  waitJob,
  call as api,
} from './support'
import { shot, untilPage } from './web'

const ID1 = `TZP-E2E-C${RUN}`

journey('J01', 'catalogue create (admin -> backend -> storefront PDP)', async ({ page }) => {
  section('create (draft) -> not public -> activate -> price + stock -> public -> PDP in a browser')
  const c = await createProduct(productBody(ID1, `E2E Created Rice ${RUN}`))
  check('POST /api/v1/products -> 201', c.status === 201, c.status)
  check(
    'created as draft, version 1',
    c.body?.lifecycle === 'draft' && c.body?.version === 1,
    c.body,
  )
  const g = await call('GET', `/api/v1/products/${ID1}`)
  check(
    'admin GET returns the product',
    g.status === 200 && g.body.title === `E2E Created Rice ${RUN}`,
  )
  const dup = await createProduct(productBody(ID1, 'duplicate'))
  check('a second create of the same id is refused (409)', dup.status === 409, {
    status: dup.status,
    body: dup.body,
  })
  const pubDraft = await pub(`/v1/products/${ID1}`)
  check('a DRAFT product is not on the public API (404)', pubDraft.status === 404, pubDraft.status)
  const a = await activate(ID1, c.body.version)
  check(
    'activate (If-Match 1) -> 200 active v2',
    a.status === 200 && a.body.lifecycle === 'active' && a.body.version === 2,
    a.body,
  )
  check('price set -> 201', (await setPrice(ID1, 32900, 39900)).status === 201)
  check('stock set -> 201', (await setStock(ID1, 12)).status === 201)
  const d = await pub(`/v1/products/${ID1}?pin=560001`)
  check(
    'public detail 200 with price, MRP, IN_STOCK, buyable',
    d.status === 200 &&
      d.body.sellingPricePaise === 32900 &&
      d.body.mrpPaise === 39900 &&
      d.body.stockState === 'IN_STOCK' &&
      d.body.buyable === true,
    d.body,
  )
  // card projection -> category listing + search
  let listed = false
  for (let i = 0; i < 40 && !listed; i++) {
    const l = await pub(`/v1/categories/TZV-000001/products?pin=560001&page_size=50`, {
      quiet: true,
    })
    listed = (l.body.items ?? []).some((x: any) => x.productId === ID1)
    if (!listed) await sleep(1000)
  }
  check('the card projection lists it under its vertical', listed)
  const r = await page.goto(`/p/${ID1}`)
  check('storefront /p/<id> -> 200', r?.status() === 200)
  check(
    'PDP shows the title',
    (await page.locator('article.pdp h1').innerText()) === `E2E Created Rice ${RUN}`,
  )
  check(
    'PDP shows ₹329 selling price',
    (await page.locator('.price__selling').innerText()).includes('329'),
  )
  await shot(page, 'j01-pdp-created')
  S.set('j01', { id: ID1 })
})

journey(
  'J02',
  'catalogue update (title PATCH, stale version, price change flows to PDP and cards)',
  async ({ page }) => {
    const id = S.get('j01')?.id ?? ID1
    const cur = await call('GET', `/api/v1/products/${id}`)
    const v = cur.body.version
    const t2 = `E2E Renamed Rice ${RUN}`
    const p = await call('PATCH', `/api/v1/products/${id}`, {
      body: { title: t2 },
      headers: { 'If-Match': String(v) },
    })
    check(
      'PATCH title with If-Match -> 200 and version bumped',
      p.status === 200 && p.body.title === t2 && p.body.version === v + 1,
      p.body,
    )
    const stale = await call('PATCH', `/api/v1/products/${id}`, {
      body: { title: 'stale' },
      headers: { 'If-Match': String(v) },
    })
    check('PATCH with the old version -> 409 (stale)', stale.status === 409, {
      status: stale.status,
      code: stale.body?.error?.code,
    })
    const none = await call('PATCH', `/api/v1/products/${id}`, { body: { title: 'x' } })
    check(
      'PATCH without If-Match is refused (4xx)',
      none.status >= 400 && none.status < 500,
      none.status,
    )
    const after = await call('GET', `/api/v1/products/${id}`)
    check('stored title is the renamed one (stale write changed nothing)', after.body.title === t2)
    const pr = await call('GET', `/api/v1/admin/prices/${id}`)
    check(
      'price update with expectedVersion -> 200',
      (await setPrice(id, 29900, 39900, pr.body.version)).status === 200,
    )
    const d = await pub(`/v1/products/${id}?pin=560001`)
    check(
      'public detail: new title and new price immediately',
      d.body.name === t2 && d.body.sellingPricePaise === 29900,
      { name: d.body.name, price: d.body.sellingPricePaise },
    )
    // cards (grid/search) follow via the projection worker
    let card: any = null
    for (let i = 0; i < 40; i++) {
      const s = await pub(`/v1/search?q=Renamed&pin=560001`, { quiet: true })
      card = (s.body.items ?? []).find((x: any) => x.productId === id)
      if (card && card.sellingPricePaise === 29900 && card.name === t2) break
      await sleep(1000)
    }
    check(
      'search card shows the new title and price (projection caught up)',
      card?.name === t2 && card?.sellingPricePaise === 29900,
      card,
    )
    const ok = await untilPage(
      page,
      'renamed title and ₹299 on the PDP',
      `/p/${id}`,
      async (p) =>
        (await p.locator('article.pdp h1').innerText()) === t2 &&
        (await p.locator('.price__selling').innerText()).includes('299'),
    )
    check('storefront PDP converges to the update within the cache window', ok)
    await shot(page, 'j02-pdp-updated')
  },
)

journey(
  'J03',
  'canonical product id accepted: TZP-Mix-7 style, case preserved end to end',
  async ({ page }) => {
    const literal = await createProduct(
      productBody('TZP-Mix-7', 'E2E literal TZP-Mix-7', { internalKey: 'literal-mix-7' }),
    )
    check(
      'the literal id TZP-Mix-7 is created exactly as written (201, or 409 when this stack already has it)',
      (literal.status === 201 && literal.body.id === 'TZP-Mix-7') || literal.status === 409,
      literal.status,
    )
    const litGet = await call('GET', '/api/v1/products/TZP-Mix-7', { quiet: true })
    check(
      'and read back with its case intact; TZP-MIX-7 / tzp-mix-7 are not it',
      litGet.status === 200 &&
        litGet.body.id === 'TZP-Mix-7' &&
        (await call('GET', '/api/v1/products/TZP-MIX-7', { quiet: true })).status === 404,
    )
    const mixed = `TZP-Mix-${RUN}`
    const lower = `TZP-mix-${RUN}`
    const upper = `TZP-MIX-${RUN}`
    for (const [id, title] of [
      [mixed, 'Mixed case'],
      [lower, 'Lower case'],
      [upper, 'Upper case'],
    ] as const) {
      const c = await createProduct(productBody(id, `E2E ${title} ${RUN}`))
      check(
        `create ${id} -> 201 and the id is stored exactly`,
        c.status === 201 && c.body.id === id,
        { status: c.status, id: c.body?.id },
      )
      const a = await activate(id, c.body.version)
      check(`activate ${id}`, a.status === 200)
      await setPrice(id, 10000, 12000)
      await setStock(id, 5)
    }
    const m = await pub(`/v1/products/${mixed}?pin=560001`)
    check(
      'public detail echoes productId with the case preserved',
      m.body.productId === mixed,
      m.body.productId,
    )
    const u = await pub(`/v1/products/${upper}?pin=560001`)
    const l = await pub(`/v1/products/${lower}?pin=560001`)
    check(
      'the three case variants are three DIFFERENT products',
      new Set([m.body.name, u.body.name, l.body.name]).size === 3,
      [m.body.name, u.body.name, l.body.name],
    )
    const nf = await pub(`/v1/products/TZP-mIx-${RUN}`)
    check(
      'an unregistered case variant is 404, never folded to another product',
      nf.status === 404,
      nf.status,
    )
    const r = await page.goto(`/p/${mixed}`)
    check(
      'storefront /p/<mixed-case id> -> 200 with the right product',
      r?.status() === 200 &&
        (await page.locator('article.pdp').getAttribute('data-product-id')) === mixed,
    )
    const cust = await Customer.signIn()
    await cust.addAddress()
    const add = await cust.setItem(mixed, 1)
    check(
      'cart accepts the mixed-case id and keeps it exactly',
      add.status === 200 && add.body.items?.[0]?.skuId === mixed,
      add.body?.items?.[0]?.skuId,
    )
    const addLower = await cust.setItem(lower, 1)
    check(
      'and the lowercase-tail variant is a separate cart line',
      addLower.status === 200 && addLower.body.items.length === 2,
      addLower.body.items?.map((i: any) => i.skuId),
    )
    S.set('j03', { mixed, lower, upper })
  },
)

journey(
  'J04',
  'invalid product ids rejected on create, import and cart (lowercase, 41-char tail, empty, newline)',
  async ({ page }) => {
    const bad: Record<string, string> = {
      'lowercase prefix': 'tzp-1',
      '41-char tail': 'TZP-' + 'A'.repeat(41),
      'empty tail': 'TZP-',
      'empty id': '',
      'trailing newline': 'TZP-1\n',
      underscore: 'TZP-a_b',
      space: 'TZP-a b',
    }
    section('create (POST /api/v1/products)')
    for (const [name, id] of Object.entries(bad)) {
      const r = await createProduct(
        productBody(id, 'should not exist', { internalKey: `bad-${name}` }),
      )
      check(
        `create with ${name} refused with a 4xx JSON error`,
        r.status >= 400 && r.status < 500 && Boolean(r.body?.error?.code),
        { status: r.status, body: r.body },
      )
    }
    const edge = `TZP-${RUN}`.padEnd(44, 'A')
    const ok41 = await createProduct(productBody(edge, 'boundary 40 ok'))
    check(
      'the 40-char tail boundary IS accepted (grammar is {1,40})',
      ok41.status === 201 && ok41.body.id === edge,
      ok41.status,
    )

    section('synchronous import (POST /api/v1/admin/imports/products, dry run)')
    const rows = Object.values(bad).map((id, i) => ({
      ...productBody(id, 'import bad', { internalKey: `ibad-${i}` }),
    }))
    const imp = await call('POST', '/api/v1/admin/imports/products', {
      body: { dryRun: true, rows },
    })
    check(
      'import with only bad ids -> 422 INVALID_IMPORT',
      imp.status === 422 && imp.body?.error?.code === 'INVALID_IMPORT',
      { status: imp.status, code: imp.body?.error?.code },
    )
    const rowErrors = imp.body?.error?.rowErrors ?? imp.body?.rowErrors ?? []
    check('every bad row is reported (one rowError per row)', rowErrors.length === rows.length, {
      rowErrors: rowErrors.length,
      rows: rows.length,
    })

    section('async import job rows (per-row verdicts)')
    const job = await createJob(`J04 ${RUN}`)
    const csv = [
      'id,title,brand,internalKey,vertical,release,classification',
      ...Object.values(bad).map(
        (id, i) => `"${id.replace(/\n/g, '\n')}",Bad ${i},E2E,jbad-${i},TZV-000001,R1,confirmed`,
      ),
    ].join('\r\n')
    const ap = await appendCsv(job.body.id, csv)
    check(
      'CSV append accepted (ids are judged at validation, not by the reader)',
      ap.status === 200 || ap.status === 201,
      ap.status,
    )
    await jobAction(job.body.id, 'validate')
    const done = await waitJob(job.body.id, ['VALIDATED', 'REJECTED'])
    check(
      '[BUG-1] CSV job: every row INVALID, including the quoted id with a trailing newline (docs/ops/BULK_IMPORT.md)',
      done?.status === 'REJECTED' && done.counts?.invalid === Object.keys(bad).length,
      done?.counts,
    )
    const jj = await createJob(`J04 json ${RUN}`)
    const jr = await call('POST', `/api/v1/admin/imports/jobs/${jj.body.id}/rows`, {
      body: { rows: [productBody('TZP-1\n', 'json newline', { internalKey: 'jn-1' })] },
    })
    await jobAction(jj.body.id, 'validate')
    const jdone = await waitJob(jj.body.id, ['VALIDATED', 'REJECTED'])
    check(
      'JSON job: the id with a trailing newline is INVALID (row append status ' + jr.status + ')',
      jdone?.status === 'REJECTED' && jdone.counts?.invalid === 1,
      jdone?.counts,
    )
    await jobAction(jj.body.id, 'cancel')
    const ap2 = await jobAction(job.body.id, 'apply')
    check(
      'apply of a REJECTED job is refused (4xx)',
      ap2.status >= 400 && ap2.status < 500,
      ap2.status,
    )
    await jobAction(job.body.id, 'cancel')

    section('cart (backend customer API) and the storefront cart route')
    const cust = await Customer.signIn()
    await cust.addAddress()
    for (const [name, id] of Object.entries(bad)) {
      const r = await cust.req('PUT', `/v1/customer/cart/items/${encodeURIComponent(id)}`, {
        body: { quantity: 1 },
        headers: { 'If-Match': '"cart-0"' },
      })
      check(
        `backend cart PUT with ${name} refused (400/404/405, never 5xx, nothing added)`,
        [400, 404, 405].includes(r.status),
        r.status,
      )
    }
    const cart = await cust.cart()
    check('cart is still empty', cart.body.items.length === 0)
    // storefront BFF: needs a browser session + its CSRF token
    await visitor(page)
    await uiSignIn(page, undefined, '/p/TZP-E2E-RICE5')
    const reqP = page.waitForRequest('**/api/cart/add')
    await page.getByRole('button', { name: 'Add to cart' }).click()
    const csrf = (await reqP).headers()['x-tazzzo-csrf']!
    const send = (data: unknown) =>
      page.request.post('/api/cart/add', {
        data,
        headers: { 'content-type': 'application/json', 'x-tazzzo-csrf': csrf, origin: env_store() },
      })
    for (const [name, id] of Object.entries(bad)) {
      const r = await send({ productId: id, quantity: 1 })
      check(`storefront /api/cart/add with ${name} -> 400`, r.status() === 400, r.status())
    }
    for (const [name, path] of [
      ['lowercase', '/p/tzp-1'],
      ['41-char tail', '/p/TZP-' + 'A'.repeat(41)],
      ['newline', '/p/TZP-1%0A'],
    ] as const) {
      const r = await page.goto(path)
      check(
        `storefront ${path.slice(0, 24)} (${name}) -> 404 page`,
        r?.status() === 404,
        r?.status(),
      )
    }
  },
)

function env_store() {
  return process.env.E2E_STORE!
}
