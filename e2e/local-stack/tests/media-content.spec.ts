// Phase 8 E2E-MEDIA, local: product media + CMS home content across backend, object store, CDN stand-in, website, app.
// Serial by design: each step builds on the state the previous one created. Evidence goes to
// evidence/<date>/transcript.txt (every HTTP exchange and command, redacted) and evidence/<date>/screens/*.png.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  appCheckpoint,
  browserPut,
  call,
  cdnCtl,
  cdnHead,
  contentUploadTarget,
  createBlock,
  env,
  listBlocks,
  log,
  png,
  preview,
  productUploadTarget,
  publicHome,
  putMediaSet,
  rawPut,
  reorder,
  resetTranscript,
  s3Head,
  setStatus,
  sh,
  stopCmsOrigin,
  titles,
} from './support'

test.describe.configure({ mode: 'serial' })

const RUN = new Date().toISOString().slice(11, 19).replace(/:/g, '') // unique titles per run (HHMMSS UTC)
const SKU = 'TZP-90000101'
const OTHER_SKU = 'TZP-90000102'
const T = {
  app: `App-only banner ${RUN}`,
  web: `Web-only banner ${RUN}`,
  both: `Both banner ${RUN}`,
  rail: `Weekly picks ${RUN}`,
  draft: `Draft banner ${RUN}`,
  sched: `Scheduled banner ${RUN}`,
}
const SCREENS = join(env.evidence, 'screens')
const S: Record<string, any> = {} // state shared across the serial steps

function section(name: string) {
  log(`\n==================== ${name} ====================`)
}
async function shot(page: Page, name: string) {
  mkdirSync(SCREENS, { recursive: true })
  const p = join(SCREENS, `${name}.png`)
  await page.screenshot({ path: p, fullPage: true })
  log(`  screenshot: screens/${name}.png`)
}

/** Block ids of banners / rails / grids on the storefront home, in document order. */
async function webBlocks(page: Page): Promise<{ id: string; kind: string }[]> {
  return page.$$eval(
    '.banner[data-block-id], section.rail[data-block-id], section.grid-block[data-block-id]',
    (els) =>
      els.map((e) => ({
        id: e.getAttribute('data-block-id')!,
        kind: e.classList.contains('banner')
          ? 'banner'
          : e.classList.contains('rail')
            ? 'rail'
            : 'grid',
      })),
  )
}

/**
 * Reload the storefront home until `ok(blocks)` holds (the storefront caches the home read for 60 s and serves a stale
 * copy once while revalidating, README "Caching"). Logs how long it took — that latency is part of the evidence.
 */
async function untilWeb(
  page: Page,
  what: string,
  ok: (ids: string[]) => boolean,
  timeoutMs = 180_000,
): Promise<string[]> {
  const started = Date.now()
  let ids: string[] = []
  while (Date.now() - started < timeoutMs) {
    const r = await page.goto('/', { waitUntil: 'load' })
    expect(r?.status()).toBe(200)
    ids = (await webBlocks(page)).map((b) => b.id)
    if (ok(ids)) {
      log(
        `  website: "${what}" observed after ${Math.round((Date.now() - started) / 1000)} s (storefront home cache is 60 s + one stale serve); DOM block order = ${JSON.stringify(ids)}`,
      )
      return ids
    }
    await page.waitForTimeout(5_000)
  }
  log(
    `  website: "${what}" NOT observed within ${timeoutMs / 1000} s; last DOM block order = ${JSON.stringify(ids)}`,
  )
  throw new Error(`website never showed: ${what}`)
}

async function uploadBanner(
  page: Page,
  name: string,
  rgb: [number, number, number],
): Promise<string> {
  const bytes = png(1056, 356, rgb)
  const t = await contentUploadTarget('image/png', bytes.length)
  expect(t.status).toBe(201)
  expect(t.body.assetKey).toMatch(/^c\/home\/.+\.png$/)
  expect(await browserPut(page, t.body, bytes, 'image/png')).toBe(200)
  S[`bytes:${name}`] = bytes
  return t.body.assetKey
}

async function banner(
  title: string,
  key: string,
  sort: number,
  audience: string,
  link: string,
  extra: Record<string, unknown> = {},
) {
  const r = await createBlock({
    type: 'BANNER',
    title,
    sort,
    audience,
    payload: { imageAssetKey: key, link, altText: `${title} image` },
    ...extra,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body.status).toBe('DRAFT')
  return r.body
}

async function publish(block: any) {
  const r = await setStatus(block.blockId, 'PUBLISHED', block.version)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body
}

test.beforeAll(async () => {
  rmSync(SCREENS, { recursive: true, force: true })
  resetTranscript(
    `Local E2E-MEDIA transcript — run ${RUN} — ${new Date().toISOString()}\nbackend=${env.backend} cdn=${env.cdn} storefront=${env.store} cms-origin=${env.cmsOrigin}\n` +
      `Tokens are local random values and are printed as [role]; presigned query strings are redacted.`,
  )
  section('SETUP: archive blocks left by earlier runs (admin API) so the home shows only this run')
  for (const b of await listBlocks()) {
    if (b.status !== 'ARCHIVED')
      expect((await setStatus(b.blockId, 'ARCHIVED', b.version)).status).toBe(200)
  }
})

test.afterAll(async () => {
  await stopCmsOrigin()
})

test('TEST 1-4: product image upload -> object in versitygw -> verified media set -> CDN stand-in', async ({
  page,
}) => {
  section('TEST 1: upload target (CMS BFF media.upload-request equivalent)')
  const bytes = png(800, 800, [32, 120, 200])
  const t = await productUploadTarget(SKU, 'image/png', bytes.length)
  expect(t.status).toBe(201)
  expect(t.body.assetKey).toMatch(new RegExp(`^p/product/${SKU}/.+\\.png$`))
  expect(t.body.url.startsWith('http://127.0.0.1:7070/')).toBeTruthy()
  expect(t.body.headers['If-None-Match'] ?? t.body.headers['if-none-match']).toBe('*')
  S.key = t.body.assetKey
  S.target = t.body
  S.bytes = bytes

  section('TEST 2: browser-direct presigned PUT from the CMS origin -> object in versitygw')
  expect(await browserPut(page, t.body, bytes, 'image/png')).toBe(200)
  const head = s3Head(S.key)
  expect(head.code).toBe(0)
  expect(head.out).toContain('content-type=image/png')
  expect(head.out).toContain(`content-length=${bytes.length}`)

  section(
    'TEST 3: media set referencing the key (backend verifies the stored object) — CMS media.set equivalent',
  )
  const current = await call('GET', `/api/v1/admin/media/product/${SKU}`)
  const version = current.status === 200 ? current.body.version : undefined
  const asset = {
    assetId: `img-${randomUUID()}`,
    assetKey: S.key,
    role: 'PRIMARY',
    sortOrder: 0,
    altText: 'Local E2E basmati pack',
    width: 800,
    height: 800,
    contentType: 'image/png',
  }
  const set = await putMediaSet(SKU, [asset], version)
  expect(set.status, JSON.stringify(set.body)).toBe(version ? 200 : 201)
  expect(set.body.assets[0].assetKey).toBe(S.key)
  S.url = `${env.cdn}/${S.key}`
  expect(set.body.assets[0].url).toBe(S.url)
  S.setVersion = set.body.version

  section('TEST 4: readable through the CDN stand-in (signed S3 read, immutable caching)')
  const h = cdnHead(S.url)
  expect(h.out).toMatch(/^HTTP\/1\.1 200/m)
  expect(h.out.toLowerCase()).toContain('cache-control: public, max-age=31536000, immutable')
  expect(h.out.toLowerCase()).toContain('content-type: image/png')
  const tmp = join(env.harness, 'run', 'cdn-get.png')
  sh('curl', [
    '-sS',
    '--cacert',
    env.certFile,
    '-o',
    tmp,
    '-w',
    'GET %{http_code} %{size_download} bytes\n',
    S.url,
  ])
  const same =
    createHash('sha256').update(readFileSync(tmp)).digest('hex') ===
    createHash('sha256').update(bytes).digest('hex')
  log(`  CDN body sha256 equals uploaded bytes: ${same}`)
  expect(same).toBe(true)
  const pdp = await call('GET', `/v1/products/${SKU}`, { role: 'anonymous' })
  expect(pdp.body.gallery?.[0]?.url).toBe(S.url)
})

test('MEDIA rejections: write-once, MIME, oversize, non-image bytes, missing object, foreign key, tampered size', async () => {
  section('Write-once: re-PUT on the same presigned URL')
  expect(await rawPut(S.target, S.bytes)).toBe(412)
  const unchanged = s3Head(S.key)
  expect(unchanged.out).toContain(`content-length=${S.bytes.length}`)

  section('Invalid MIME (image/gif, text/plain) -> 422')
  expect((await productUploadTarget(SKU, 'image/gif', 100)).status).toBe(422)
  expect((await productUploadTarget(SKU, 'text/plain', 100)).status).toBe(422)
  expect((await contentUploadTarget('image/svg+xml', 100)).status).toBe(422)

  section('Oversize (5 MiB + 1) -> 422; body larger than the signed Content-Length -> store 403')
  const over = await productUploadTarget(SKU, 'image/png', 5 * 1024 * 1024 + 1)
  expect(over.status).toBe(422)
  const small = png(10, 10, [200, 0, 0])
  const t = await productUploadTarget(SKU, 'image/png', small.length)
  expect(await rawPut(t.body, Buffer.concat([small, Buffer.alloc(1024)]))).toBe(403)

  section(
    'Non-image bytes under an image/png key: the store accepts (it does not sniff); the backend refuses to reference it -> 422',
  )
  const text = Buffer.from(
    'this is not a png, just text padded to the declared size.'.padEnd(64, '.'),
  )
  const tt = await productUploadTarget(SKU, 'image/png', text.length)
  expect(await rawPut(tt.body, text)).toBe(200)
  const bad = await putMediaSet(
    SKU,
    [
      {
        assetId: `img-${randomUUID()}`,
        assetKey: tt.body.assetKey,
        role: 'PRIMARY',
        sortOrder: 0,
        contentType: 'image/png',
      },
    ],
    S.setVersion,
  )
  expect(bad.status).toBe(422)
  const ct = await contentUploadTarget('image/png', text.length)
  expect(await rawPut(ct.body, text)).toBe(200)
  const badBanner = await createBlock({
    type: 'BANNER',
    title: `Bad bytes ${RUN}`,
    sort: 900,
    audience: 'BOTH',
    payload: { imageAssetKey: ct.body.assetKey, link: 'search:rice' },
  })
  expect(badBanner.status).toBe(422)

  section('Missing object (target issued, nothing uploaded) -> 422')
  const never = await productUploadTarget(SKU, 'image/png', 1234)
  const missing = await putMediaSet(
    SKU,
    [
      {
        assetId: `img-${randomUUID()}`,
        assetKey: never.body.assetKey,
        role: 'PRIMARY',
        sortOrder: 0,
        contentType: 'image/png',
      },
    ],
    S.setVersion,
  )
  expect(missing.status).toBe(422)
  const cNever = await contentUploadTarget('image/png', 1234)
  expect(
    (
      await createBlock({
        type: 'BANNER',
        title: `Missing ${RUN}`,
        sort: 900,
        audience: 'BOTH',
        payload: { imageAssetKey: cNever.body.assetKey, link: 'search:rice' },
      })
    ).status,
  ).toBe(422)

  section("Another product's key -> 422")
  const other = await call('GET', `/api/v1/admin/media/product/${OTHER_SKU}`)
  const stolen = await putMediaSet(
    OTHER_SKU,
    [
      {
        assetId: `img-${randomUUID()}`,
        assetKey: S.key,
        role: 'PRIMARY',
        sortOrder: 0,
        contentType: 'image/png',
      },
    ],
    other.status === 200 ? other.body.version : undefined,
  )
  expect(stolen.status).toBe(422)

  section('State after the rejections: the media set is unchanged')
  const after = await call('GET', `/api/v1/admin/media/product/${SKU}`)
  expect(after.body.version).toBe(S.setVersion)
  expect(after.body.assets.map((a: any) => a.assetKey)).toEqual([S.key])

  section('Bucket CORS: preflight from the CMS origin allowed, from another origin refused')
  const pre = (origin: string) =>
    sh('curl', [
      '-sS',
      '-o',
      '/dev/null',
      '-D',
      '-',
      '-X',
      'OPTIONS',
      S.target.url.split('?')[0],
      '-H',
      `Origin: ${origin}`,
      '-H',
      'Access-Control-Request-Method: PUT',
      '-H',
      'Access-Control-Request-Headers: content-type,if-none-match',
    ])
  expect(pre(env.cmsOrigin).out.toLowerCase()).toContain(
    `access-control-allow-origin: ${env.cmsOrigin}`,
  )
  expect(pre('http://evil.localhost:4000').out).toMatch(/^HTTP\/1\.1 403/m)
})

test('TEST 7: website PDP shows the uploaded image from the CDN stand-in', async ({ page }) => {
  section('TEST 7: storefront PDP')
  // The storefront caches the PDP read for 60 s (+ one stale serve): reload until the new gallery is served.
  const main = page.locator('[data-testid="product-gallery"] .gallery__main')
  const started = Date.now()
  for (;;) {
    const r = await page.goto(`/p/${SKU}`)
    expect(r?.status()).toBe(200)
    if ((await main.count()) && (await main.getAttribute('data-selected-url')) === S.url) break
    if (Date.now() - started > 180_000) throw new Error('PDP never showed the new image')
    await page.waitForTimeout(5_000)
  }
  log(
    `  website PDP: new gallery observed after ${Math.round((Date.now() - started) / 1000)} s (storefront PDP cache 60 s + one stale serve)`,
  )
  await expect(main).toHaveAttribute('data-selected-url', S.url)
  const img = main.locator('img').first()
  await expect(img).toHaveAttribute('src', S.url)
  await expect
    .poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
    .toBe(800)
  log(
    `  website PDP /p/${SKU}: gallery main img src=${S.url} naturalWidth=800 (loaded through the CDN stand-in)`,
  )
  await shot(page, 't07-website-pdp')
})

test('TEST 5: app (shared Kotlin, JVM) reads the PDP gallery and fetches the image', async () => {
  section('TEST 5: app contract checkpoint (NOT on-device rendering)')
  const r = appCheckpoint('t05-pdp', { E2E_APP_PDP: SKU, E2E_APP_EXPECT_IMAGES: 'ok' })
  expect(r.code).toBe(0)
  expect(r.out).toContain(S.url)
})

test('TEST 8/9/10 + 16: APP-only, WEB-only, BOTH banners and a draft — public channels, admin preview, website, app', async ({
  page,
}) => {
  section('Banner images: content upload targets + browser PUT from the CMS origin')
  const kApp = await uploadBanner(page, 'app', [210, 80, 40])
  const kWeb = await uploadBanner(page, 'web', [40, 150, 90])
  const kBoth = await uploadBanner(page, 'both', [120, 60, 170])
  const kDraft = await uploadBanner(page, 'draft', [90, 90, 90])

  section('Blocks (CMS content.home.create equivalent) then publish (content status equivalent)')
  S.app = await publish(await banner(T.app, kApp, 10, 'APP_ONLY', `product:${SKU}`))
  S.web = await publish(await banner(T.web, kWeb, 20, 'WEB_ONLY', 'category:TZV-000001'))
  S.both = await publish(await banner(T.both, kBoth, 30, 'BOTH', 'search:basmati'))
  const rail = await createBlock({
    type: 'PRODUCT_RAIL',
    title: T.rail,
    sort: 40,
    audience: 'BOTH',
    payload: { ids: [SKU, 'TZP-90000102', 'TZP-90000103'] },
  })
  expect(rail.status).toBe(201)
  S.rail = await publish(rail.body)
  section('TEST 16 setup: a DRAFT banner (never published)')
  S.draft = await banner(T.draft, kDraft, 25, 'BOTH', 'search:rice')

  section('TEST 8/9/10: public endpoint per channel (anonymous)')
  const app = await publicHome('app')
  const web = await publicHome('web')
  const none = await publicHome()
  expect(app.headers.get('cache-control')).toBe('public, max-age=60')
  expect(titles(app)).toEqual([T.app, T.both, T.rail])
  expect(titles(web)).toEqual([T.web, T.both, T.rail])
  expect(titles(none)).toEqual([T.both, T.rail])
  for (const b of [...app.body.blocks, ...web.body.blocks].filter(
    (b: any) => b.type === 'BANNER',
  )) {
    expect(b.imageUrl.startsWith(`${env.cdn}/c/home/`)).toBe(true)
    const h = cdnHead(b.imageUrl)
    expect(h.out).toMatch(/^HTTP\/1\.1 200/m)
  }

  section(
    'TEST 16: draft absent from both public channels, present in admin preview with drafts=true only',
  )
  expect(titles(app)).not.toContain(T.draft)
  expect(titles(web)).not.toContain(T.draft)
  const pv = await preview('web', true)
  expect(pv.body.blocks.map((b: any) => b.title)).toContain(T.draft)
  expect(pv.body.blocks.find((b: any) => b.title === T.draft).status).toBe('DRAFT')
  const pvNo = await preview('web', false)
  expect(pvNo.body.blocks.map((b: any) => b.title)).not.toContain(T.draft)
  const pvApp = await preview('app', true)
  expect(pvApp.body.blocks.map((b: any) => b.title)).toEqual(
    expect.arrayContaining([T.app, T.draft]),
  )

  section('TEST 8/9/10 website: WEB-only + BOTH + rail shown, APP-only and DRAFT absent')
  const ids = await untilWeb(page, 'web-only + both banners and the rail', (ids) =>
    [S.web.blockId, S.both.blockId, S.rail.blockId].every((i) => ids.includes(i)),
  )
  expect(ids).not.toContain(S.app.blockId)
  expect(ids).not.toContain(S.draft.blockId)
  log(
    `  website: APP-only (${S.app.blockId}) absent: true; DRAFT (${S.draft.blockId}) absent: true`,
  )
  const first = page.locator(`.banner[data-block-id="${S.web.blockId}"] img`).first()
  await expect
    .poll(() => first.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
    .toBeGreaterThan(0)
  await expect(
    page.locator(
      `section.rail[data-block-id="${S.rail.blockId}"] article.card[data-product-id="${SKU}"]`,
    ),
  ).toBeVisible()
  await shot(page, 't08-10-website-home')

  section('TEST 8/9/10 app: APP-only + BOTH + rail, WEB-only and DRAFT absent, banner images load')
  const a = appCheckpoint('t08-10-audience', {
    E2E_APP_EXPECT_ORDER: `${T.app}|${T.both}|${T.rail}`,
    E2E_APP_EXPECT_ABSENT: `${T.web}|${T.draft}`,
    E2E_APP_EXPECT_IMAGES: 'ok',
  })
  expect(a.code).toBe(0)
})

test('TEST 11a: scheduled banner — absent now, present in preview at its start', async ({
  page,
}) => {
  section('TEST 11a: BOTH banner with startsAt = now + 150 s, published')
  const key = await uploadBanner(page, 'sched', [230, 180, 20])
  S.startsAt = new Date(Date.now() + 150_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  S.sched = await publish(
    await banner(T.sched, key, 35, 'BOTH', 'search:basmati', { startsAt: S.startsAt }),
  )
  expect(S.sched.effectiveStatus).toBe('SCHEDULED')
  expect(titles(await publicHome('app'))).not.toContain(T.sched)
  expect(titles(await publicHome('web'))).not.toContain(T.sched)
  const at = new Date(Date.parse(S.startsAt) + 1000).toISOString()
  const later = await preview('web', false, at)
  expect(later.body.blocks.map((b: any) => b.title)).toContain(T.sched)
  const now = await preview('web', false)
  expect(now.body.blocks.map((b: any) => b.title)).not.toContain(T.sched)
})

test('TEST 13: reorder -> order changes on website and app', async ({ page }) => {
  section('TEST 13: reorder (every non-archived block, each with its version) — rail first')
  const blocks = (await listBlocks()).filter((b) => b.status !== 'ARCHIVED')
  const order = [
    blocks.find((b) => b.blockId === S.rail.blockId),
    ...blocks.filter((b) => b.blockId !== S.rail.blockId),
  ].map((b) => ({ blockId: b.blockId, expectedVersion: b.version }))
  const r = await reorder(order)
  expect(r.status).toBe(200)
  expect(titles(await publicHome('web'))[0]).toBe(T.rail)
  expect(titles(await publicHome('app'))[0]).toBe(T.rail)
  const ids = await untilWeb(
    page,
    'rail before the banners',
    (ids) =>
      ids.includes(S.rail.blockId) && ids.indexOf(S.rail.blockId) < ids.indexOf(S.both.blockId),
  )
  expect(ids.indexOf(S.rail.blockId)).toBeLessThan(ids.indexOf(S.web.blockId))
  await shot(page, 't13-website-reordered')
  const a = appCheckpoint('t13-reorder', {
    E2E_APP_EXPECT_ORDER: `${T.rail}|${T.app}|${T.both}`,
    E2E_APP_EXPECT_IMAGES: 'ok',
  })
  expect(a.code).toBe(0)
})

test('TEST 15: reader role cannot mutate (403) and nothing changes', async () => {
  section('TEST 15: reader token on every mutation route')
  const before = JSON.stringify(
    (await listBlocks()).map((b) => [b.blockId, b.version, b.status, b.sort]),
  )
  const mediaBefore = (await call('GET', `/api/v1/admin/media/product/${SKU}`, { role: 'reader' }))
    .body
  const codes = [
    (
      await createBlock(
        {
          type: 'BANNER',
          title: `Reader ${RUN}`,
          sort: 1,
          audience: 'BOTH',
          payload: { imageAssetKey: S.key, link: 'search:x' },
        },
        'reader',
      )
    ).status,
    (await setStatus(S.both.blockId, 'ARCHIVED', S.both.version, 'reader')).status,
    (await reorder([{ blockId: S.both.blockId, expectedVersion: 1 }], 'reader')).status,
    (await contentUploadTarget('image/png', 100, 'reader')).status,
    (await productUploadTarget(SKU, 'image/png', 100, 'reader')).status,
    (await putMediaSet(SKU, [], mediaBefore.version, 'reader')).status,
  ]
  expect(codes).toEqual([403, 403, 403, 403, 403, 403])
  const after = JSON.stringify(
    (await listBlocks()).map((b) => [b.blockId, b.version, b.status, b.sort]),
  )
  expect(after).toBe(before)
  const mediaAfter = (await call('GET', `/api/v1/admin/media/product/${SKU}`, { role: 'reader' }))
    .body
  expect(mediaAfter.version).toBe(mediaBefore.version)
  log(
    `  blocks (id, version, status, sort) identical before/after: ${after === before}; media set version ${mediaBefore.version} -> ${mediaAfter.version}`,
  )
  const anon = await call('POST', '/api/v1/admin/content/blocks', { role: 'anonymous', body: {} })
  expect(anon.status).toBe(401)
})

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.store }) // empty HTTP cache
  return ctx.newPage()
}

test('TEST 14: CDN stand-in down -> placeholders, pages still render (website and app)', async ({
  browser,
}) => {
  section('TEST 14: stop the CDN stand-in')
  cdnCtl('stop')
  expect(cdnCtl('status').out).toContain('DOWN')
  try {
    const page = await freshPage(browser)
    const home = await page.goto('/')
    expect(home?.status()).toBe(200)
    await expect(page.locator(`section.rail[data-block-id="${S.rail.blockId}"]`)).toBeVisible()
    const fallback = page.locator(
      `.banner[data-block-id="${S.web.blockId}"] [data-testid="image-fallback"]`,
    )
    await expect(fallback).toBeAttached({ timeout: 20_000 })
    log(
      `  website home: HTTP 200, rail rendered, banner ${S.web.blockId} shows data-testid=image-fallback (aria-label="${await fallback.getAttribute('aria-label')}")`,
    )
    await shot(page, 't14-website-home-cdn-down')
    const pdp = await page.goto(`/p/${SKU}`)
    expect(pdp?.status()).toBe(200)
    await expect(
      page.locator('[data-testid="product-gallery"] [data-testid="image-fallback"]').first(),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(`article.pdp[data-product-id="${SKU}"]`)).toContainText(
      'Local E2E Basmati Rice 5 kg',
    )
    log(`  website PDP: HTTP 200, title rendered, gallery shows data-testid=image-fallback`)
    await shot(page, 't14-website-pdp-cdn-down')
    const a = appCheckpoint('t14-cdn-down', {
      E2E_APP_EXPECT_ORDER: `${T.rail}|${T.app}|${T.both}`,
      E2E_APP_PDP: SKU,
      E2E_APP_EXPECT_IMAGES: 'unavailable',
    })
    expect(a.code).toBe(0)
  } finally {
    section('TEST 14: restart the CDN stand-in')
    cdnCtl('start')
  }
  expect(cdnCtl('status').out).toContain('UP')
  expect(cdnHead(S.url).out).toMatch(/^HTTP\/1\.1 200/m)
})

test('TEST 11b: the scheduled banner goes live at startsAt (public + website)', async ({
  page,
}) => {
  section('TEST 11b: wait for startsAt')
  const wait = Date.parse(S.startsAt) - Date.now() + 1500
  log(`  startsAt=${S.startsAt}; waiting ${Math.max(0, Math.round(wait / 1000))} s`)
  if (wait > 0) await page.waitForTimeout(wait)
  const web = await publicHome('web')
  expect(titles(web)).toContain(T.sched)
  expect(titles(await publicHome('app'))).toContain(T.sched)
  await untilWeb(page, 'scheduled banner live', (ids) => ids.includes(S.sched.blockId))
  await shot(page, 't11-website-scheduled-live')
})

test('TEST 12: unpublish -> disappears (public immediately, website within its cache window)', async ({
  page,
}) => {
  section('TEST 12: scheduled (now live) banner -> DRAFT')
  const cur = (await listBlocks()).find((b) => b.blockId === S.sched.blockId)
  const r = await setStatus(S.sched.blockId, 'DRAFT', cur.version)
  expect(r.status).toBe(200)
  expect(titles(await publicHome('web'))).not.toContain(T.sched)
  expect(titles(await publicHome('app'))).not.toContain(T.sched)
  await untilWeb(page, 'unpublished banner gone', (ids) => !ids.includes(S.sched.blockId))
  await shot(page, 't12-website-unpublished')
})
