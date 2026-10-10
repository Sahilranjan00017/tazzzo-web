#!/usr/bin/env node
// Seed the local backend THROUGH ITS ADMIN API only (no direct database writes), the way the CMS BFF would:
//   taxonomy release R1 (open + publish; LOCAL_DEVELOPMENT.md section 2), service areas (PIN -> area -> fulfilment location),
//   delivery windows, 4 products (POST /api/v1/products, activate), their prices and stock.
// Idempotent: existing rows are left as they are. Auth is the backend's static local cms-writer token (run/stack.env).
const B = process.env.E2E_BACKEND.replace('localhost', '127.0.0.1')
const H = { Authorization: `Bearer ${process.env.E2E_CMS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' }

async function call(method, path, body, extra = {}) {
  const r = await fetch(B + path, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep null */ }
  console.log(`${method} ${path} -> ${r.status}`)
  return { status: r.status, body: json }
}
const ok = (r, what, allow = [200, 201]) => {
  if (!allow.includes(r.status)) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.body)}`)
  return r
}

// taxonomy
const rel = await call('POST', '/api/v1/taxonomy/releases', { releaseId: 'R1', basedOn: null })
ok(rel, 'open release R1', [200, 201, 409])
ok(await call('POST', '/api/v1/taxonomy/releases/R1/publish'), 'publish R1', [200, 409])

// serviceability: three PINs in one area (one fulfilment location); 400001 is deliberately not served
for (const pin of ['560001', '560002', '560003']) {
  const cur = await call('GET', `/api/v1/admin/service-areas/${pin}`)
  if (cur.status === 200) continue
  ok(await call('PUT', `/api/v1/admin/service-areas/${pin}`, {
    serviceAreaId: 'SA-E2E-BLR', routes: [{ fulfillmentLocationId: 'FL-E2E-1', priority: 1, active: true }] }), `area ${pin}`)
}
// delivery windows (ISO weekdays 1..7; minutes after local midnight, Asia/Kolkata)
for (const [id, label, start, end] of [['morning', 'Morning', 540, 720], ['evening', 'Evening', 1020, 1200]]) {
  const cur = await call('GET', `/api/v1/admin/delivery-slots/SA-E2E-BLR/${id}`)
  if (cur.status === 200) continue
  ok(await call('PUT', `/api/v1/admin/delivery-slots/SA-E2E-BLR/${id}`, {
    label, startMinute: start, endMinute: end, cutoffMinutes: 30, capacity: 200, days: [1, 2, 3, 4, 5, 6, 7] }), `window ${id}`)
}

// catalogue
const PRODUCTS = [
  { id: 'TZP-E2E-RICE5', title: 'E2E Basmati Rice 5 kg', vertical: 'TZV-000001', sell: 24900, mrp: 29900, stock: 50 },
  { id: 'TZP-E2E-RICE1', title: 'E2E Brown Basmati 1 kg', vertical: 'TZV-000001', sell: 15900, mrp: 17900, stock: 50 },
  { id: 'TZP-E2E-SONA', title: 'E2E Sona Masoori 10 kg', vertical: 'TZV-000004', sell: 89900, mrp: 99900, stock: 8 },
  { id: 'TZP-E2E-LAST', title: 'E2E Last Unit Special', vertical: 'TZV-000001', sell: 10000, mrp: 12000, stock: 1 },
]
for (const p of PRODUCTS) {
  let cur = await call('GET', `/api/v1/products/${p.id}`)
  if (cur.status === 404) {
    ok(await call('POST', '/api/v1/products', { id: p.id, productType: 'single', identityType: 'internal', internalKey: p.id.toLowerCase(),
      brandCode: 'E2E', title: p.title, verticalId: p.vertical, releaseId: 'R1', classificationStatus: 'confirmed' }), `create ${p.id}`)
    cur = await call('GET', `/api/v1/products/${p.id}`)
  }
  if (cur.body?.lifecycle === 'draft')
    ok(await call('POST', `/api/v1/products/${p.id}/activate`, undefined, { 'If-Match': String(cur.body.version) }), `activate ${p.id}`)
  if ((await call('GET', `/api/v1/admin/prices/${p.id}`)).status !== 200)
    ok(await call('PUT', `/api/v1/admin/prices/${p.id}`, { sellingPricePaise: p.sell, mrpPaise: p.mrp, currency: 'INR' }), `price ${p.id}`)
  if ((await call('GET', `/api/v1/admin/inventory/${p.id}/FL-E2E-1`)).status !== 200)
    ok(await call('PUT', `/api/v1/admin/inventory/${p.id}/FL-E2E-1`, { onHand: p.stock, lowStockThreshold: 3, maxPurchasable: Math.min(10, p.stock) }), `stock ${p.id}`)
}

// wait for the card projection (grid/rail cards) to include the seeded products
let n = 0
for (let i = 0; i < 60; i++) {
  const r = await fetch(`${B}/v1/categories/TZV-000001/products?page_size=24&pin=560001`)
  n = ((await r.json()).items ?? []).length
  if (n >= 3) break
  await new Promise((r) => setTimeout(r, 1000))
}
console.log(`TZV-000001 list has ${n} products`)
if (n < 3) throw new Error('card projection did not catch up')
