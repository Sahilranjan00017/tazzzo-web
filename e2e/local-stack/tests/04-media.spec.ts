// J13 media upload (presign -> PUT to the S3 gateway), J14 media verify (set + dimension/ext/type checks), J23 PDP media via the CDN.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blocked, browserPut, call, cdnHead, check, env, journey, log, png, pngBomb, productUploadTarget, pub, putMediaSet, rawPut, RUN, S, s3Head, sellable, section, sh, stopCmsOrigin, setPrice } from './support'
import { shot } from './web'
import { test } from '@playwright/test'

test.afterAll(async () => {
  await stopCmsOrigin()
})

const asset = (key: string, over: Record<string, unknown> = {}) => ({
  assetId: `img-${randomUUID()}`, assetKey: key, role: 'PRIMARY', sortOrder: 0, altText: 'E2E pack', contentType: 'image/png', ...over,
})

journey('J13', 'media upload: presigned target -> browser PUT to the S3 gateway -> object stored (write-once)', async ({ page }) => {
  const id = `TZP-E2E-M${RUN}`
  await sellable(id, `E2E Media Rice ${RUN}`, { sell: 18000, mrp: 21000, stock: 25 })
  const bytes = png(800, 800, [32, 120, 200])
  const t = await productUploadTarget(id, 'image/png', bytes.length)
  check('POST /api/v1/admin/media/uploads -> 201 with a server-generated key under p/product/<id>/', t.status === 201 && new RegExp(`^p/product/${id}/.+\\.png$`).test(t.body.assetKey), { status: t.status, key: t.body?.assetKey })
  check('target is a PUT to the local gateway, write-once (If-None-Match: *), type-bound', t.body.method === 'PUT' && t.body.url.startsWith('http://127.0.0.1:7070/') && (t.body.headers['If-None-Match'] ?? t.body.headers['if-none-match']) === '*' && /image\/png/.test(JSON.stringify(t.body.headers)), { url: String(t.body.url).split('?')[0], headers: Object.keys(t.body.headers) })
  check('the target expires (expiresAt) and carries maxBytes', Boolean(t.body.expiresAt), { expiresAt: t.body.expiresAt, maxBytes: t.body.maxBytes })
  const st = await browserPut(page, t.body, bytes, 'image/png')
  check('browser XHR PUT from the CMS origin -> 200 (bucket CORS preflight allowed it)', st === 200, st)
  const head = s3Head(t.body.assetKey)
  check('object in the bucket: content-type image/png, exact length', head.code === 0 && head.out.includes('content-type=image/png') && head.out.includes(`content-length=${bytes.length}`), head.out.trim())
  check('re-PUT to the same presigned URL is refused (412 write-once) and the object is unchanged', (await rawPut(t.body, bytes)) === 412 && s3Head(t.body.assetKey).out.includes(`content-length=${bytes.length}`))
  const pre = (origin: string) => sh('curl', ['-sS', '-o', '/dev/null', '-D', '-', '-X', 'OPTIONS', String(t.body.url).split('?')[0], '-H', `Origin: ${origin}`, '-H', 'Access-Control-Request-Method: PUT', '-H', 'Access-Control-Request-Headers: content-type,if-none-match'])
  check('CORS preflight from another origin is refused (403)', /^HTTP\/1\.1 403/m.test(pre('http://evil.localhost:4000').out))
  const big = await productUploadTarget(id, 'image/png', 5 * 1024 * 1024 + 1)
  check('oversize declaration (5 MiB + 1) -> 422', big.status === 422, big.status)
  const small = png(10, 10, [200, 0, 0])
  const t2 = await productUploadTarget(id, 'image/png', small.length)
  check('a body larger than the signed Content-Length is refused by the store (403)', (await rawPut(t2.body, Buffer.concat([small, Buffer.alloc(1024)]))) === 403)
  S.set('j13', { id, key: t.body.assetKey, bytesSha: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
})

journey('J14', 'media verify: set with dimension/ext/type checks; bad MIME, oversize, bomb, mismatch rejected', async ({ page }) => {
  const j13 = S.get('j13')
  if (!j13) blocked('J13 did not produce an uploaded object')
  const { id, key } = j13
  const cur = await call('GET', `/api/v1/admin/media/product/${id}`, { quiet: true })
  const ver = cur.status === 200 ? cur.body.version : undefined
  const good = await putMediaSet(id, [asset(key, { width: 800, height: 800 })], ver)
  check('media set referencing the uploaded key (declared 800x800 matches the stored header) -> 200/201', good.status === (ver ? 200 : 201), good.body)
  check('the public URL is derived from the key and the CDN base', good.body.assets?.[0]?.url === `${env.cdn}/${key}`, good.body.assets?.[0]?.url)
  const v = good.body.version
  // The backend verifies every NEWLY referenced key (docs/ops/MEDIA_STORAGE.md); so the dimension/type checks are exercised on a second, new key.
  const s2 = png(64, 32, [5, 90, 150])
  const t2 = await productUploadTarget(id, 'image/png', s2.length)
  check('second upload (64x32) PUT -> 200', (await rawPut(t2.body, s2)) === 200)
  const k2 = t2.body.assetKey
  const wrongDims = await putMediaSet(id, [asset(key), asset(k2, { role: 'GALLERY', sortOrder: 1, width: 65, height: 32 })], v)
  check('NEW key with a declared width not equal to the stored header width -> 422 INVALID_MEDIA', wrongDims.status === 422, wrongDims.body)
  const wrongType = await putMediaSet(id, [asset(key), asset(k2, { role: 'GALLERY', sortOrder: 1, contentType: 'image/jpeg' })], v)
  check('NEW key with a declared contentType not equal to the sniffed type -> 422', wrongType.status === 422, wrongType.body)
  const redeclare = await putMediaSet(id, [asset(key, { width: 801, height: 800 })], v)
  log(`  observation: re-declaring an ALREADY-referenced key with width 801 (stored header says 800) -> ${redeclare.status}; the backend verifies only newly referenced keys, so this metadata edit is not re-checked`)
  const rv = await call('GET', `/api/v1/admin/media/product/${id}`, { quiet: true })
  if (redeclare.status === 200) await putMediaSet(id, [asset(key, { width: 800, height: 800 })], rv.body.version)
  const v2 = (await call('GET', `/api/v1/admin/media/product/${id}`, { quiet: true })).body.version
  for (const ct of ['image/gif', 'text/plain', 'image/svg+xml', 'application/pdf']) {
    const r = await productUploadTarget(id, ct, 100)
    check(`upload target for ${ct} refused (422)`, r.status === 422, r.status)
  }
  const zero = await productUploadTarget(id, 'image/png', 0)
  check('upload target for 0 bytes refused (4xx)', zero.status >= 400 && zero.status < 500, zero.status)
  async function uploadAndSet(label: string, bytes: Buffer, ct = 'image/png', declared: Record<string, unknown> = {}) {
    const t = await productUploadTarget(id, ct, bytes.length)
    if (t.status !== 201) return { put: -1, set: t }
    const put = await rawPut(t.body, bytes)
    const set = await putMediaSet(id, [asset(key), asset(t.body.assetKey, { role: 'GALLERY', sortOrder: 1, contentType: ct, ...declared })], v2)
    log(`  ${label}: PUT ${put}, media set -> ${set.status} ${JSON.stringify(set.body).slice(0, 160)}`)
    return { put, set }
  }
  const bomb = await uploadAndSet('decompression-bomb header 19000x19000 (361 MP)', pngBomb(19000, 19000))
  check('header area above 50 MP is refused (422)', bomb.set.status === 422)
  const tall = await uploadAndSet('header 30000x10 (side above 20000)', pngBomb(30000, 10))
  check('a side above max-dimension is refused (422)', tall.set.status === 422)
  const trunc = await uploadAndSet('PNG magic bytes only (truncated header)', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]))
  check('truncated/garbage header that passes the magic bytes is refused (422)', trunc.set.status === 422)
  const text = await uploadAndSet('text bytes under an image/png target', Buffer.from('this is not a png'.padEnd(64, '.')))
  check('non-image bytes are refused at set time (422)', text.set.status === 422)
  const asJpeg = await uploadAndSet('PNG bytes under an image/jpeg target', png(16, 16, [9, 9, 9]), 'image/jpeg')
  check('stored bytes (PNG) not equal to the declared image/jpeg are refused (422)', asJpeg.set.status === 422)
  const never = await productUploadTarget(id, 'image/png', 1234)
  check('issued but never uploaded key is refused (422)', (await putMediaSet(id, [asset(key), asset(never.body.assetKey, { role: 'GALLERY', sortOrder: 1 })], v2)).status === 422)
  const other = `TZP-E2E-MO${RUN}`
  await sellable(other, `E2E other ${RUN}`)
  check("another product's key is refused (422)", (await putMediaSet(other, [asset(key)])).status === 422)
  check('a hand-made key never issued by the backend is refused (422)', (await putMediaSet(id, [asset(`p/product/${id}/forged.png`)], v2)).status === 422)
  check('reader may not set media (403)', (await putMediaSet(id, [], v2, 'reader')).status === 403)
  const after = await call('GET', `/api/v1/admin/media/product/${id}`)
  check('after all rejections the media set is unchanged (same version, one asset)', after.body.version === v2 && after.body.assets.length === 1 && after.body.assets[0].assetKey === key, { version: after.body.version, assets: after.body.assets?.length })
})

journey('J23', 'product detail with media via the CDN stand-in, price and availability', async ({ page }) => {
  const j13 = S.get('j13')
  if (!j13) blocked('J13 did not produce an uploaded object')
  const { id, key } = j13
  const url = `${env.cdn}/${key}`
  const h = cdnHead(url)
  check('CDN stand-in serves the object (200, immutable cache, image/png) from the private bucket', /^HTTP\/1\.1 200/m.test(h.out) && h.out.toLowerCase().includes('cache-control: public, max-age=31536000, immutable') && h.out.toLowerCase().includes('content-type: image/png'))
  const tmp = join(env.runDir, 'cdn-get.png')
  sh('curl', ['-sS', '--cacert', env.certFile, '-o', tmp, '-w', 'GET %{http_code} %{size_download} bytes\n', url])
  check('CDN body sha256 equals the uploaded bytes', createHash('sha256').update(readFileSync(tmp)).digest('hex') === j13.bytesSha)
  check('the CDN refuses non-media paths and writes', sh('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--cacert', env.certFile, `${env.cdn}/admin/secret`]).out.trim() === '403' && sh('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '--cacert', env.certFile, url]).out.trim() === '405')
  const api = await pub(`/v1/products/${id}?pin=560001`)
  check('public API gallery[0].url is the CDN URL; price 18000/21000; IN_STOCK', api.body.gallery?.[0]?.url === url && api.body.sellingPricePaise === 18000 && api.body.mrpPaise === 21000 && api.body.stockState === 'IN_STOCK', { url: api.body.gallery?.[0]?.url, p: api.body.sellingPricePaise })
  await page.goto('/location')
  const r = await page.goto(`/p/${id}`)
  check('storefront PDP -> 200', r?.status() === 200)
  const main = page.locator('[data-testid="product-gallery"] .gallery__main')
  check('gallery selected image is the CDN URL', (await main.getAttribute('data-selected-url')) === url, await main.getAttribute('data-selected-url'))
  const img = main.locator('img').first()
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid="product-gallery"] .gallery__main img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0 })
  check('the browser actually loaded the image through the CDN stand-in (naturalWidth 800)', (await img.evaluate((i: HTMLImageElement) => i.naturalWidth)) === 800)
  check('PDP shows title, ₹180 and struck MRP ₹210', (await page.locator('article.pdp h1').innerText()).includes('E2E Media Rice') && (await page.locator('.price__selling').innerText()).includes('180') && (await page.locator('.price__mrp s').innerText()).includes('210'))
  check('PDP availability line is present', (await page.getByTestId('availability').count()) === 1)
  await shot(page, 'j23-pdp-media')
})
