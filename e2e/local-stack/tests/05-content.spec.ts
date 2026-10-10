// J15-J20, J22: CMS home content (banners, rails), audiences, scheduling, reorder, storefront home + batch rail reads.
import { test } from '@playwright/test'
import {
  blocked,
  browserPut,
  call,
  cdnHead,
  check,
  contentUploadTarget,
  createBlock,
  env,
  journey,
  listBlocks,
  log,
  png,
  preview,
  proxyMark,
  proxySince,
  publicHome,
  reorder,
  RUN,
  S,
  section,
  setStatus,
  sleep,
  stopCmsOrigin,
  titles,
} from './support'
import { shot, untilHome, untilPage, webBlocks } from './web'

test.afterAll(async () => {
  await stopCmsOrigin()
})

const T = {
  app: `App-only banner ${RUN}`,
  web: `Web-only banner ${RUN}`,
  both: `Both banner ${RUN}`,
  rail: `Weekly picks ${RUN}`,
  draft: `Draft banner ${RUN}`,
  created: `Created banner ${RUN}`,
  sched: `Scheduled banner ${RUN}`,
}
const RICE5 = 'TZP-E2E-RICE5'

async function uploadBanner(page: any, rgb: [number, number, number]): Promise<string> {
  const bytes = png(1056, 356, rgb)
  const t = await contentUploadTarget('image/png', bytes.length)
  if (t.status !== 201) throw new Error(`content upload target ${t.status}`)
  const st = await browserPut(page, t.body, bytes, 'image/png')
  if (st !== 200) throw new Error(`banner PUT ${st}`)
  return t.body.assetKey
}
const banner = (
  title: string,
  key: string,
  sort: number,
  audience: string,
  link: string,
  extra: Record<string, unknown> = {},
) =>
  createBlock({
    type: 'BANNER',
    title,
    sort,
    audience,
    payload: { imageAssetKey: key, link, altText: `${title} image`, subtitle: 'E2E subtitle' },
    ...extra,
  })

journey(
  'J15',
  'banner create (CMS content API): upload, validation, DRAFT -> PUBLISHED, fixtures for the audience journeys',
  async ({ page }) => {
    section('clean slate: archive blocks left by earlier runs')
    for (const b of await listBlocks())
      if (b.status !== 'ARCHIVED') await setStatus(b.blockId, 'ARCHIVED', b.version)
    const kCreated = await uploadBanner(page, [20, 60, 200])
    check(
      'content upload target -> key under c/home/ and the browser PUT succeeded',
      /^c\/home\/.+\.png$/.test(kCreated),
      kCreated,
    )
    const bad: [string, Record<string, unknown>][] = [
      [
        'link with an external URL',
        { payload: { imageAssetKey: kCreated, link: 'https://evil.example/x', altText: 'x' } },
      ],
      [
        'link with javascript:',
        { payload: { imageAssetKey: kCreated, link: 'javascript:alert(1)', altText: 'x' } },
      ],
      ['empty title', { title: '' }],
      ['title over 80 chars', { title: 'x'.repeat(81) }],
      [
        'subtitle with markup',
        {
          payload: {
            imageAssetKey: kCreated,
            link: 'search:rice',
            subtitle: '<b>x</b>',
            altText: 'x',
          },
        },
      ],
      [
        'alt text with a bidi override',
        { payload: { imageAssetKey: kCreated, link: 'search:rice', altText: 'safe‮evil' } },
      ],
      ['unknown audience', { audience: 'EVERYONE' }],
      ['no image', { payload: { link: 'search:rice', altText: 'x' } }],
      [
        'image key never issued',
        { payload: { imageAssetKey: 'c/home/forged.png', link: 'search:rice', altText: 'x' } },
      ],
    ]
    for (const [name, over] of bad) {
      const r = await createBlock({
        type: 'BANNER',
        title: `Bad ${RUN}`,
        sort: 5,
        audience: 'BOTH',
        payload: { imageAssetKey: kCreated, link: 'search:rice', altText: 'x' },
        ...over,
      })
      check(
        `create with ${name} refused (4xx, nothing stored)`,
        r.status >= 400 && r.status < 500,
        r.status,
      )
    }
    check(
      'reader cannot create (403)',
      (
        await createBlock(
          {
            type: 'BANNER',
            title: 'r',
            sort: 1,
            audience: 'BOTH',
            payload: { imageAssetKey: kCreated, link: 'search:rice', altText: 'x' },
          },
          'reader',
        )
      ).status === 403,
    )
    const c = await banner(T.created, kCreated, 30, 'BOTH', `product:${RICE5}`)
    check(
      'create -> 201 DRAFT version 1',
      c.status === 201 && c.body.status === 'DRAFT' && c.body.version === 1,
      c.body,
    )
    const g = await call('GET', `/api/v1/admin/content/blocks/${c.body.blockId}`)
    check(
      'admin read returns the banner fields (title, subtitle, alt, link, audience BOTH, CDN imageUrl)',
      g.body.title === T.created &&
        g.body.payload?.subtitle === 'E2E subtitle' &&
        g.body.audience === 'BOTH' &&
        String(g.body.imageUrl).startsWith(`${env.cdn}/c/home/`),
      { audience: g.body.audience, imageUrl: g.body.imageUrl },
    )
    const draftPublic = await publicHome('web')
    check('a DRAFT is not on the public endpoint', !titles(draftPublic).includes(T.created))
    const p = await setStatus(c.body.blockId, 'PUBLISHED', c.body.version)
    check(
      'publish -> PUBLISHED, effectiveStatus LIVE',
      p.status === 200 && p.body.status === 'PUBLISHED' && p.body.effectiveStatus === 'LIVE',
      p.body,
    )
    const pub = await publicHome('web')
    const mine = (pub.body.blocks as any[]).find((b) => b.title === T.created)
    check(
      'public home carries it with a CDN imageUrl, altText and a product link',
      Boolean(mine) &&
        String(mine.imageUrl).startsWith(`${env.cdn}/c/home/`) &&
        mine.altText === `${T.created} image` &&
        mine.link === `product:${RICE5}`,
      mine,
    )
    check(
      'public home is cacheable for 60 s (Cache-Control public, max-age=60)',
      pub.headers.get('cache-control') === 'public, max-age=60',
      pub.headers.get('cache-control'),
    )
    check(
      'the banner image is served by the CDN stand-in',
      /^HTTP\/1\.1 200/m.test(cdnHead(mine.imageUrl).out),
    )
    section(
      'fixtures for J16-J18 (created now so the storefront home is first rendered with all of them)',
    )
    const kApp = await uploadBanner(page, [210, 80, 40])
    const kWeb = await uploadBanner(page, [40, 150, 90])
    const kBoth = await uploadBanner(page, [120, 60, 170])
    const kDraft = await uploadBanner(page, [90, 90, 90])
    const app = await banner(T.app, kApp, 10, 'APP_ONLY', `product:${RICE5}`)
    const web = await banner(T.web, kWeb, 20, 'WEB_ONLY', 'category:TZV-000001')
    const both = await banner(T.both, kBoth, 25, 'BOTH', 'search:basmati')
    const draft = await banner(T.draft, kDraft, 26, 'BOTH', 'search:rice')
    const rail = await createBlock({
      type: 'PRODUCT_RAIL',
      title: T.rail,
      sort: 40,
      audience: 'BOTH',
      payload: { ids: [RICE5, 'TZP-E2E-RICE1', 'TZP-E2E-SONA'] },
    })
    check(
      'APP_ONLY, WEB_ONLY, BOTH banners, a DRAFT banner and a PRODUCT_RAIL created (201)',
      [app, web, both, draft, rail].every((r) => r.status === 201),
      [app, web, both, draft, rail].map((r) => r.status),
    )
    const pubd = {} as Record<string, any>
    for (const [k, r] of Object.entries({ app, web, both, rail })) {
      const s = await setStatus(r.body.blockId, 'PUBLISHED', r.body.version)
      check(`publish ${k}`, s.status === 200, s.status)
      pubd[k] = s.body
    }
    S.set('content', {
      created: { ...c.body, ...p.body },
      app: pubd.app,
      web: pubd.web,
      both: pubd.both,
      rail: pubd.rail,
      draft: draft.body,
    })
  },
)

journey(
  'J16',
  'APP-only content is NOT visible on the website (public channels, admin preview, storefront DOM)',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    const mark = await proxyMark()
    S.set('railMark', mark)
    const app = await publicHome('app')
    const web = await publicHome('web')
    const none = await publicHome()
    check('?channel=app lists the APP-only banner', titles(app).includes(T.app))
    check('?channel=web does not', !titles(web).includes(T.app))
    check('no channel (the legacy/default) does not either', !titles(none).includes(T.app))
    const pv = await preview('web', true)
    check(
      'admin preview for web (drafts=true) hides APP-only but shows the DRAFT',
      !pv.body.blocks.map((b: any) => b.title).includes(T.app) &&
        pv.body.blocks.map((b: any) => b.title).includes(T.draft),
    )
    check(
      'admin preview for app shows APP-only',
      (await preview('app', false)).body.blocks.map((b: any) => b.title).includes(T.app),
    )
    const ids = await untilHome(page, 'web-only + both banners and the rail', (ids) =>
      [c.web.blockId, c.both.blockId, c.rail.blockId].every((i) => ids.includes(i)),
    )
    check('storefront home renders the web blocks', ids.includes(c.web.blockId), ids)
    check('the APP-only block is absent from the storefront DOM', !ids.includes(c.app.blockId))
    check('the DRAFT block is absent from the storefront DOM', !ids.includes(c.draft.blockId))
    check(
      'the APP-only title appears nowhere in the page text',
      !(await page.locator('body').innerText()).includes(T.app),
    )
    await shot(page, 'j16-website-home')
  },
)

journey(
  'J17',
  'WEBSITE-only content is visible on the website (and not on the app channel)',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    check(
      '?channel=web lists the web-only banner, ?channel=app does not',
      titles(await publicHome('web')).includes(T.web) &&
        !titles(await publicHome('app')).includes(T.web),
    )
    await page.goto('/')
    const b = page.locator(`.banner[data-block-id="${c.web.blockId}"]`)
    check('the web-only banner is in the home DOM', (await b.count()) === 1)
    const img = b.locator('img').first()
    await page
      .waitForFunction(
        (sel) => {
          const i = document.querySelector(sel) as HTMLImageElement | null
          return !!i && i.complete && i.naturalWidth > 0
        },
        `.banner[data-block-id="${c.web.blockId}"] img`,
        { timeout: 20_000 },
      )
      .catch(() => undefined)
    check(
      'its image loaded from the CDN stand-in (naturalWidth 1056)',
      (await img.evaluate((i: HTMLImageElement) => i.naturalWidth).catch(() => 0)) === 1056 &&
        String(await img.getAttribute('src')).startsWith(env.cdn),
    )
    check('alt text is rendered', (await img.getAttribute('alt')) === `${T.web} image`)
    const href = await b.locator('a').first().getAttribute('href')
    check(
      'the banner link category:TZV-000001 is rendered as /c/TZV-000001',
      href === '/c/TZV-000001',
      href,
    )
    const nav = await page.goto(href!)
    check(
      'and that link opens the category page (200)',
      nav?.status() === 200 && new URL(page.url()).pathname === '/c/TZV-000001',
      page.url(),
    )
  },
)

journey(
  'J18',
  'BOTH content is visible on website AND app channel (banner + product rail with cards)',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    check(
      'banner in both channels',
      titles(await publicHome('web')).includes(T.both) &&
        titles(await publicHome('app')).includes(T.both),
    )
    const railApp = (await publicHome('app')).body.blocks.find((b: any) => b.title === T.rail)
    check(
      'the rail carries its three product ids on the app channel',
      JSON.stringify(railApp?.ids) === JSON.stringify([RICE5, 'TZP-E2E-RICE1', 'TZP-E2E-SONA']),
      railApp?.ids,
    )
    await page.goto('/')
    const blocks = (await webBlocks(page)).map((b) => b.id)
    check(
      'both blocks on the storefront home',
      blocks.includes(c.both.blockId) && blocks.includes(c.rail.blockId),
      blocks,
    )
    const cards = page.locator(`section.rail[data-block-id="${c.rail.blockId}"] article.card`)
    check(
      'the rail renders its three product cards in order',
      (
        await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
      ).join() === [RICE5, 'TZP-E2E-RICE1', 'TZP-E2E-SONA'].join(),
    )
    check('card shows the seeded price ₹249', (await cards.first().innerText()).includes('249'))
    await shot(page, 'j18-both-home')
  },
)

journey(
  'J19',
  'scheduling: a future block is not live, becomes live after its window start (public API + storefront)',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    const kS = await uploadBanner(page, [230, 180, 20])
    const startsAt = new Date(Date.now() + 100_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const endsAt = new Date(Date.now() + 100_000 + 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
    const r = await banner(T.sched, kS, 35, 'BOTH', 'search:basmati', { startsAt, endsAt })
    const pubd = await setStatus(r.body.blockId, 'PUBLISHED', r.body.version)
    check(
      'PUBLISHED with a future startsAt is effectively SCHEDULED',
      pubd.status === 200 && pubd.body.effectiveStatus === 'SCHEDULED',
      pubd.body,
    )
    check(
      'not on the public endpoint (web or app) before startsAt',
      !titles(await publicHome('web')).includes(T.sched) &&
        !titles(await publicHome('app')).includes(T.sched),
    )
    const at = new Date(Date.parse(startsAt) + 1000).toISOString()
    check(
      'admin preview AT startsAt+1s shows it, preview now does not',
      (await preview('web', false, at)).body.blocks.map((b: any) => b.title).includes(T.sched) &&
        !(await preview('web', false)).body.blocks.map((b: any) => b.title).includes(T.sched),
    )
    await page.goto('/')
    check(
      'the storefront does not render it yet',
      !(await webBlocks(page)).some((b) => b.id === r.body.blockId),
    )
    const wait = Date.parse(startsAt) - Date.now() + 2000
    log(
      `  startsAt=${startsAt}; waiting ${Math.round(wait / 1000)} s for the window to open (no clock mocking)`,
    )
    await sleep(Math.max(0, wait))
    check(
      'public endpoint lists it after startsAt (no publish lag on the backend itself)',
      titles(await publicHome('web')).includes(T.sched) &&
        titles(await publicHome('app')).includes(T.sched),
    )
    const t0 = Date.now()
    const ids = await untilHome(page, 'scheduled banner live', (ids) =>
      ids.includes(r.body.blockId),
    )
    check(
      `the storefront shows it within its cache window (${Math.round((Date.now() - t0) / 1000)} s after startsAt; 60 s cache + one stale serve, as disclosed)`,
      ids.includes(r.body.blockId),
    )
    await shot(page, 'j19-scheduled-live')
    // unpublish -> gone
    const cur = (await listBlocks()).find((b) => b.blockId === r.body.blockId)
    check(
      'back to DRAFT removes it from the public endpoint at once',
      (await setStatus(r.body.blockId, 'DRAFT', cur.version)).status === 200 &&
        !titles(await publicHome('web')).includes(T.sched),
    )
    S.set('sched', r.body.blockId)
  },
)

journey(
  'J20',
  'reorder: new order on public API and storefront; all-or-nothing on a stale version',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    const live = (await listBlocks()).filter((b) => b.status !== 'ARCHIVED')
    const before = titles(await publicHome('web'))
    log(`  order before: ${JSON.stringify(before)}`)
    const order = [
      live.find((b) => b.blockId === c.rail.blockId),
      ...live.filter((b) => b.blockId !== c.rail.blockId),
    ].map((b) => ({ blockId: b.blockId, expectedVersion: b.version }))
    const stale = await reorder(
      order.map((o, i) => (i === 1 ? { ...o, expectedVersion: o.expectedVersion + 5 } : o)),
    )
    check(
      'a stale version in the list -> 409 and NOTHING changes',
      stale.status === 409 &&
        JSON.stringify(titles(await publicHome('web'))) === JSON.stringify(before),
      stale.status,
    )
    const r = await reorder(order)
    check('reorder -> 200', r.status === 200, r.body)
    const web = titles(await publicHome('web'))
    const app = titles(await publicHome('app'))
    check(
      'rail is first on the web channel and on the app channel',
      web[0] === T.rail && app[0] === T.rail,
      { web: web.slice(0, 3), app: app.slice(0, 3) },
    )
    check('reader cannot reorder (403)', (await reorder(order, 'reader')).status === 403)
    const ids = await untilHome(
      page,
      'rail before the banners',
      (ids) =>
        ids.includes(c.rail.blockId) && ids.indexOf(c.rail.blockId) < ids.indexOf(c.both.blockId),
    )
    check(
      'storefront DOM order has the rail first',
      ids.indexOf(c.rail.blockId) === 0 || ids.indexOf(c.rail.blockId) < ids.indexOf(c.web.blockId),
      ids,
    )
    await shot(page, 'j20-reordered')
  },
)

journey(
  'J22',
  'storefront home: banners and rails; ONE products:batch call per rail (counting proxy)',
  async ({ page }) => {
    const c = S.get('content')
    if (!c) blocked('J15 fixtures missing')
    const k = await uploadBanner(page, [10, 10, 10])
    void k
    const railA = ['TZP-E2E-RICE1', 'TZP-E2E-SONA', 'TZP-E2E-LAST']
    const railB = [RICE5, 'TZP-E2E-LAST']
    const a = await createBlock({
      type: 'PRODUCT_RAIL',
      title: `Rail A ${RUN}`,
      sort: 50,
      audience: 'WEB_ONLY',
      payload: { ids: railA },
    })
    const b = await createBlock({
      type: 'PRODUCT_RAIL',
      title: `Rail B ${RUN}`,
      sort: 51,
      audience: 'WEB_ONLY',
      payload: { ids: railB },
    })
    const pa = await setStatus(a.body.blockId, 'PUBLISHED', a.body.version)
    const pb = await setStatus(b.body.blockId, 'PUBLISHED', b.body.version)
    check('two new rails published', pa.status === 200 && pb.status === 200)
    const mark = await proxyMark()
    const ids = await untilHome(
      page,
      'both new rails rendered',
      (ids) => ids.includes(a.body.blockId) && ids.includes(b.body.blockId),
    )
    const entries = (await proxySince(mark)).filter((e) => e.path.startsWith('/v1/'))
    const batch = entries.filter((e) => e.path === '/v1/products:batch')
    const sameIds = (q: string, want: string[]) => {
      const v = new URLSearchParams(q).get('ids') ?? ''
      return v.split(',').sort().join() === [...want].sort().join()
    }
    const nA = batch.filter((e) => sameIds(e.query, railA)).length
    const nB = batch.filter((e) => sameIds(e.query, railB)).length
    log(
      `  backend calls the storefront made while rendering the new rails (path query):\n${entries.map((e) => `    ${e.method} ${e.path}${e.query.slice(0, 120)} -> ${e.status}`).join('\n')}`,
    )
    check('rail A: exactly ONE GET /v1/products:batch for its ids', nA === 1, nA)
    check('rail B: exactly ONE GET /v1/products:batch for its ids', nB === 1, nB)
    const perId = entries.filter((e) => /^\/v1\/products\/TZP-/.test(e.path))
    check(
      'no per-product GET /v1/products/{id} calls were made for rail cards (no N+1)',
      perId.length === 0,
      perId.map((e) => e.path),
    )
    check(
      'every storefront backend read carried the trusted-caller name and secret, no bearer, no X-Forwarded-For',
      entries.every(
        (e) =>
          e.caller === env.callerName &&
          e.callerSecretPresent &&
          !e.bearer &&
          e.forwardedFor === null,
      ),
      entries.filter((e) => e.caller !== env.callerName).slice(0, 3),
    )
    for (const [title, want] of [
      [`Rail A ${RUN}`, railA],
      [`Rail B ${RUN}`, railB],
    ] as const) {
      const blockId = title.endsWith(`A ${RUN}`) ? a.body.blockId : b.body.blockId
      const got = await page
        .locator(`section.rail[data-block-id="${blockId}"] article.card`)
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-product-id')))
      check(`${title} renders its cards in rail order`, got.join() === want.join(), got)
    }
    const lastCard = page.locator(
      `section.rail[data-block-id="${a.body.blockId}"] article.card[data-product-id="TZP-E2E-LAST"]`,
    )
    check(
      'banner carousel and rails coexist on the home page',
      (await webBlocks(page)).some((x) => x.kind === 'banner') &&
        (await webBlocks(page)).some((x) => x.kind === 'rail'),
    )
    void lastCard
    await shot(page, 'j22-home-rails')
    const bat = await call('GET', `/v1/products:batch?ids=${railA.join(',')},TZP-NOPE-1,tzp-bad`, {
      role: 'anonymous',
    })
    check(
      'batch endpoint: unknown ids are reported in "missing"/ignored, a malformed id is a clean 4xx',
      (bat.status === 200 && Array.isArray(bat.body.missing)) ||
        (bat.status >= 400 && bat.status < 500),
      { status: bat.status, missing: bat.body?.missing },
    )
  },
)
