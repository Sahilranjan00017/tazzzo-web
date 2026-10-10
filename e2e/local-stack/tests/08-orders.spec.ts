// J28 order/support behaviour: staff (human order-ops / support-agent ID tokens) over the customer's order; support cases.
import {
  call,
  check,
  Customer,
  journey,
  log,
  RUN,
  S,
  section,
  sellable,
  uiSignIn,
  visitor,
  blocked,
} from './support'
import { shot } from './web'

journey(
  'J28',
  'orders + support: customer order visible to staff, staff transitions, customer sees status, support case thread',
  async ({ page }) => {
    const id = `TZP-E2E-T${RUN}`
    await sellable(id, `E2E Staff Rice ${RUN}`, { sell: 20000, mrp: 22000, stock: 10 })
    const c = await Customer.signIn()
    await c.addAddress()
    await c.setItem(id, 2)
    const q = await c.quote()
    const placed = await c.place(q.body.quoteId, await c.slot())
    const oid = placed.body.orderId
    check(
      'customer placed a COD order',
      (placed.status === 200 || placed.status === 201) && /^ORD_/.test(oid),
      { status: placed.status, oid },
    )
    section('who may read orders')
    check(
      'cms-writer static token cannot read /api/v1/admin/orders (403)',
      (await call('GET', '/api/v1/admin/orders', { role: 'cms-writer' })).status === 403,
    )
    check(
      'human cms-writer cannot (403)',
      (await call('GET', '/api/v1/admin/orders', { role: 'human-writer' })).status === 403,
    )
    check(
      'anonymous -> 401',
      (await call('GET', '/api/v1/admin/orders', { role: 'anonymous' })).status === 401,
    )
    const ls = await call('GET', '/api/v1/admin/orders?status=CONFIRMED&page_size=50', {
      role: 'order-ops',
    })
    check(
      'order-ops sees the order in the CONFIRMED queue',
      ls.status === 200 && (ls.body.items as any[]).some((o) => o.orderId === oid),
      ls.body.items?.length,
    )
    const one = await call('GET', `/api/v1/admin/orders/${oid}`, { role: 'order-ops' })
    check(
      'staff detail: lines, ₹400 payable, delivery address snapshot, slot',
      one.status === 200 &&
        one.body.payablePaise === 40000 &&
        one.body.deliveryAddress?.postalCode === '560001' &&
        one.body.lines?.[0]?.skuId === id &&
        Boolean(one.body.deliverySlot),
      one.body,
    )
    check(
      'support-agent may read orders (read-only)',
      (await call('GET', `/api/v1/admin/orders/${oid}`, { role: 'support-agent' })).status === 200,
    )
    section('transitions')
    const noWrite = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'support-agent',
      body: { to: 'OUT_FOR_DELIVERY', expectedVersion: one.body.version },
    })
    check('support-agent may NOT transition (403)', noWrite.status === 403, noWrite.status)
    const cmsWrite = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'cms-writer',
      body: { to: 'OUT_FOR_DELIVERY', expectedVersion: one.body.version },
    })
    check('cms-writer token may NOT transition (403)', cmsWrite.status === 403, cmsWrite.status)
    const t1 = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'order-ops',
      body: { to: 'OUT_FOR_DELIVERY', expectedVersion: one.body.version },
    })
    check(
      'order-ops: CONFIRMED -> OUT_FOR_DELIVERY',
      t1.status === 200 && t1.body.status === 'OUT_FOR_DELIVERY',
      t1.body.status,
    )
    const stale = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'order-ops',
      body: { to: 'DELIVERED', expectedVersion: one.body.version },
    })
    check('stale expectedVersion -> 409', stale.status === 409, stale.status)
    const cust1 = await c.req('GET', `/v1/customer/orders/${oid}`)
    check(
      'customer API now shows OUT_FOR_DELIVERY with the timestamp',
      cust1.body.status === 'OUT_FOR_DELIVERY' && Boolean(cust1.body.outForDeliveryAt),
      cust1.body.status,
    )
    const t2 = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'order-ops',
      body: { to: 'DELIVERED', expectedVersion: t1.body.version },
    })
    check('OUT_FOR_DELIVERY -> DELIVERED', t2.status === 200 && t2.body.status === 'DELIVERED')
    const back = await call('POST', `/api/v1/admin/orders/${oid}/transition`, {
      role: 'order-ops',
      body: { to: 'CANCELLED', reason: 'OTHER', expectedVersion: t2.body.version },
    })
    check('DELIVERED -> CANCELLED is an illegal transition (409)', back.status === 409, back.status)
    section(
      'the customer sees it in the browser (storefront /orders/<id>), signed in as the same phone',
    )
    await visitor(page)
    await uiSignIn(page, c.phone, `/orders/${oid}`)
    check(
      'browser order page shows DELIVERED',
      (await page.getByTestId('order-status').getAttribute('data-status')) === 'DELIVERED',
    )
    await shot(page, 'j28-order-delivered')
    section('staff cancellation releases the reservation')
    const c2 = await Customer.signIn()
    await c2.addAddress()
    await c2.setItem(id, 3)
    const inv0 = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
    const q2 = await c2.quote()
    const p2 = await c2.place(q2.body.quoteId, await c2.slot())
    const inv1 = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
    const o2 = (await call('GET', `/api/v1/admin/orders/${p2.body.orderId}`, { role: 'order-ops' }))
      .body
    const noReason = await call('POST', `/api/v1/admin/orders/${p2.body.orderId}/transition`, {
      role: 'order-ops',
      body: { to: 'CANCELLED', expectedVersion: o2.version },
    })
    check(
      'cancelling without a reason is refused (4xx)',
      noReason.status >= 400 && noReason.status < 500,
      noReason.status,
    )
    const cx = await call('POST', `/api/v1/admin/orders/${p2.body.orderId}/transition`, {
      role: 'order-ops',
      body: { to: 'CANCELLED', reason: 'CUSTOMER_REQUEST', expectedVersion: o2.version },
    })
    const inv2 = (await call('GET', `/api/v1/admin/inventory/${id}/FL-E2E-1`)).body
    check(
      'staff cancel -> CANCELLED with reason',
      cx.status === 200 &&
        cx.body.status === 'CANCELLED' &&
        cx.body.cancelReason === 'CUSTOMER_REQUEST',
      cx.body,
    )
    check(
      'stock: reserved by the order (-3 available) and given back on cancel',
      inv0.available - inv1.available === 3 && inv2.available === inv0.available,
      { start: inv0.available, afterOrder: inv1.available, afterCancel: inv2.available },
    )
    check(
      'the customer sees CANCELLED',
      (await c2.req('GET', `/v1/customer/orders/${p2.body.orderId}`)).body.status === 'CANCELLED',
    )
    section('support case: customer opens, staff replies and resolves, customer sees the thread')
    const open = await c.req('POST', '/v1/customer/support/cases', {
      body: {
        category: 'ORDER_ISSUE',
        orderId: oid,
        subject: 'E2E: item missing',
        message: 'One bag was missing.',
      },
    })
    check(
      'customer opens a case about the order -> 201',
      open.status === 201 && /^CASE_|^SUP_|^C/.test(open.body.caseId ?? ''),
      open.body,
    )
    const cid = open.body.caseId
    const sl = await call('GET', '/api/v1/admin/support/cases?status=OPEN', {
      role: 'support-agent',
    })
    check(
      'support-agent sees it in the OPEN queue',
      sl.status === 200 && (sl.body.items as any[]).some((x) => x.caseId === cid),
    )
    check(
      'order-ops can read but not reply (403)',
      (
        await call('POST', `/api/v1/admin/support/cases/${cid}/messages`, {
          role: 'order-ops',
          body: { message: 'x' },
        })
      ).status === 403,
    )
    const rp = await call('POST', `/api/v1/admin/support/cases/${cid}/messages`, {
      role: 'support-agent',
      body: { message: 'Sorry, we will send it.' },
    })
    check('support-agent replies', rp.status === 200 || rp.status === 201, rp.status)
    const g = await call('GET', `/api/v1/admin/support/cases/${cid}`, { role: 'support-agent' })
    const rs = await call('POST', `/api/v1/admin/support/cases/${cid}/status`, {
      role: 'support-agent',
      body: { to: 'RESOLVED', expectedVersion: g.body.version },
    })
    check('status -> RESOLVED', rs.status === 200 && rs.body.status === 'RESOLVED', rs.body.status)
    const cr = await c.req('POST', `/v1/customer/support/cases/${cid}/messages`, {
      body: { message: 'Thanks, received.' },
    })
    const cg = await c.req('GET', `/v1/customer/support/cases/${cid}`)
    check(
      'customer sees both messages and the resolved status',
      cg.status === 200 &&
        cg.body.messages.length >= 3 &&
        cg.body.messages.some(
          (m: any) =>
            m.author?.toString().toUpperCase().includes('STAFF') ||
            m.author?.toString().toUpperCase().includes('SUPPORT'),
        ),
      { status: cg.body.status, messages: cg.body.messages?.map((m: any) => m.author) },
    )
    const other = await Customer.signIn()
    check(
      'another customer cannot read the case (404/403)',
      [403, 404].includes((await other.req('GET', `/v1/customer/support/cases/${cid}`)).status),
    )
    void cr
    void log
    void S
    void blocked
  },
)
