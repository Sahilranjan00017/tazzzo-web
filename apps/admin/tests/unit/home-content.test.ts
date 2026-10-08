import { describe, expect, it } from 'vitest'
import {
  LINK,
  BANNER_ASPECT,
  bannerLayouts,
  scheduleInstant,
  buildReorder,
  displayTextIssue,
  effectiveOf,
  homeErrorMessage,
  homeUpdateInput,
  homeWriteInput,
  idsIssue,
  linkIssue,
  linkOf,
  move,
  parseLink,
  parsePreviewQuery,
  reorderInput,
  scheduleText,
  splitIds,
  titleIssue,
} from '@/lib/home-content'

describe('banner link grammar (backend ContentBlock.LINK, #102 db3623c)', () => {
  it.each([
    'product:TZP-1001',
    'product:TZP-abc-9',
    'category:TZC-000123',
    'category:TZS-000001',
    'category:TZG-123456',
    'category:TZV-000009',
    'search:mango',
    'search:basmati rice 5 kg',
    'search:ताज़ा आम', // Devanagari with combining marks (nukta, vowel signs): \p{M}
    'search:ಮಾವು',
    `search:${'a'.repeat(64)}`,
  ])('accepts %s', (l) => expect(LINK.test(l)).toBe(true))
  it.each([
    'https://evil.example',
    'product:TZP-',
    'product:tzp-1001',
    `product:TZP-${'1'.repeat(41)}`,
    'category:TZX-000123',
    'category:TZC-12345',
    'category:TZC-0001234',
    'search:a',
    `search:${'a'.repeat(65)}`,
    'search:mango!',
    'search:a/b',
    'search:<b>x</b>',
    'search:mango‮',
    'search:tab\there',
    ' product:TZP-1',
    'product:TZP-1\n',
    'PRODUCT:TZP-1',
  ])('refuses %j', (l) => expect(LINK.test(l)).toBe(false))

  it('builds and explains links from the link builder', () => {
    expect(linkOf('product', ' tzp-1001 ')).toBe('product:TZP-1001')
    expect(linkOf('category', 'tzc-000123')).toBe('category:TZC-000123')
    expect(linkOf('search', '  ताज़ा आम ')).toBe('search:ताज़ा आम')
    expect(parseLink('search:basmati rice')).toEqual({ kind: 'search', value: 'basmati rice' })
    expect(parseLink(undefined)).toEqual({ kind: 'product', value: '' })
    expect(linkIssue('product', 'TZP-1')).toBeUndefined()
    expect(linkIssue('product', 'abc')).toMatch(/product id/)
    expect(linkIssue('category', 'TZC-1')).toMatch(/6 digits/)
    expect(linkIssue('search', 'x')).toMatch(/2 to 64/)
    expect(linkIssue('search', 'rice & dal')).toMatch(/no punctuation/)
    expect(linkIssue('search', 'ताज़ा आम')).toBeUndefined()
    expect(linkIssue('search', '')).toMatch(/Enter/)
  })
})

describe('text rules', () => {
  it('title: 1..80, no control characters; brackets are allowed like the backend', () => {
    expect(titleIssue('Mango season')).toBeUndefined()
    expect(titleIssue('<b>Mango</b>')).toBeUndefined()
    expect(titleIssue('  ')).toBe('required')
    expect(titleIssue('x'.repeat(81))).toBe('too_long')
    expect(titleIssue('a\tb')).toBe('control')
    expect(titleIssue('a\u007fb')).toBe('control')
  })
  it('subtitle / alt text: plain, bounded, and no C1 or invisible/bidi-control characters', () => {
    expect(displayTextIssue('Fresh every morning', 120)).toBeUndefined()
    expect(displayTextIssue('ताज़ा आम', 120)).toBeUndefined()
    expect(displayTextIssue('x'.repeat(121), 120)).toBe('too_long')
    expect(displayTextIssue('a\nb', 120)).toBe('control')
    expect(displayTextIssue('<script>', 120)).toBe('markup')
    for (const c of ['‮', '‭', '⁦', '​', '‍', '‎', '﻿', '­'])
      expect(displayTextIssue(`sale${c}50`, 120), c.codePointAt(0)!.toString(16)).toBe('invisible')
    for (const c of ['\u0080', '\u0085', '\u009f'])
      expect(displayTextIssue(`a${c}b`, 120), c.codePointAt(0)!.toString(16)).toBe('invisible')
  })
})

describe('id lists', () => {
  it('splits, normalises and bounds rails (1..20 products) and grids (1..12 nodes)', () => {
    expect(splitIds(' tzp-1, TZP-2\nTZP-3 ')).toEqual(['TZP-1', 'TZP-2', 'TZP-3'])
    expect(idsIssue('PRODUCT_RAIL', ['TZP-1'])).toBeUndefined()
    expect(idsIssue('PRODUCT_RAIL', [])).toMatch(/at least one/)
    expect(
      idsIssue(
        'PRODUCT_RAIL',
        Array.from({ length: 21 }, (_, i) => `TZP-${i}`),
      ),
    ).toMatch(/At most 20/)
    expect(idsIssue('PRODUCT_RAIL', ['TZP-1', 'TZP-1'])).toMatch(/only once/)
    expect(idsIssue('PRODUCT_RAIL', ['TZC-000001'])).toMatch(/Not a valid product id/)
    expect(idsIssue('CATEGORY_GRID', ['TZC-000001', 'TZS-000002'])).toBeUndefined()
    expect(
      idsIssue(
        'CATEGORY_GRID',
        Array.from({ length: 13 }, (_, i) => `TZC-${String(i).padStart(6, '0')}`),
      ),
    ).toMatch(/At most 12/)
    expect(idsIssue('CATEGORY_GRID', ['TZP-1'])).toMatch(/Not a valid category id/)
  })
})

describe('write schemas (strict, per type)', () => {
  const banner = {
    type: 'BANNER',
    title: 'Mango season',
    sort: 0,
    audience: 'BOTH',
    payload: { imageAssetKey: 'c/home/a.webp', link: 'search:mango' },
  }
  it('accepts each type and the optional banner fields', () => {
    expect(homeWriteInput.safeParse(banner).success).toBe(true)
    expect(
      homeWriteInput.safeParse({
        ...banner,
        payload: {
          ...banner.payload,
          desktopImageAssetKey: 'c/home/b.webp',
          subtitle: 'Fresh',
          altText: 'Mangoes in a basket',
        },
        startsAt: '2026-10-08T03:30:00.000Z',
        endsAt: '2026-10-09T03:30:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      homeWriteInput.safeParse({
        type: 'PRODUCT_RAIL',
        title: 'Bestsellers',
        sort: 10,
        audience: 'APP_ONLY',
        payload: { ids: ['TZP-1'] },
      }).success,
    ).toBe(true)
  })
  it.each([
    ['end before start', { startsAt: '2026-10-09T00:00:00Z', endsAt: '2026-10-08T00:00:00Z' }],
    ['end equal to start', { startsAt: '2026-10-09T00:00:00Z', endsAt: '2026-10-09T00:00:00Z' }],
    ['a non-UTC time', { startsAt: '2026-10-09T05:30:00+05:30' }],
    ['an unknown audience', { audience: 'EVERYONE' }],
    ['sort above 10000', { sort: 10_001 }],
    ['an untrimmed title', { title: ' Mango' }],
    ['a placement from the browser', { placement: 'HELP' }],
    ['an FAQ type', { type: 'FAQ' }],
    ['an arbitrary URL link', { payload: { imageAssetKey: 'c/home/a.webp', link: 'https://x' } }],
    ['a traversal key', { payload: { imageAssetKey: 'c/../p/x', link: 'search:mango' } }],
    ['ids on a banner', { payload: { ...banner.payload, ids: ['TZP-1'] } }],
    ['a bidi override in the subtitle', { payload: { ...banner.payload, subtitle: 'sale ‮05' } }],
  ])('refuses %s', (_n, over) =>
    expect(homeWriteInput.safeParse({ ...banner, ...over }).success).toBe(false),
  )
  it('update needs the block id and version; type only selects the payload rules', () => {
    expect(
      homeUpdateInput.safeParse({ ...banner, blockId: 'CB_abcdefghijklmnop', expectedVersion: 3 })
        .success,
    ).toBe(true)
    expect(homeUpdateInput.safeParse({ ...banner, blockId: 'CB_abcdefghijklmnop' }).success).toBe(
      false,
    )
    expect(
      homeUpdateInput.safeParse({
        ...banner,
        type: 'PRODUCT_RAIL',
        blockId: 'CB_abcdefghijklmnop',
        expectedVersion: 3,
      }).success,
    ).toBe(false)
  })
})

describe('reorder payload', () => {
  const blocks = [
    { blockId: 'CB_aaaaaaaaaaaaaaaa', status: 'PUBLISHED', version: 2 },
    { blockId: 'CB_bbbbbbbbbbbbbbbb', status: 'DRAFT', version: 5 },
    { blockId: 'CB_cccccccccccccccc', status: 'ARCHIVED', version: 9 },
    { blockId: 'CB_dddddddddddddddd', status: 'PUBLISHED', version: 1 },
  ]
  it('lists every non-archived block exactly once, in the new order, with its loaded version', () => {
    const body = buildReorder(blocks, [
      'CB_dddddddddddddddd',
      'CB_aaaaaaaaaaaaaaaa',
      'CB_bbbbbbbbbbbbbbbb',
    ])
    expect(body).toEqual({
      order: [
        { blockId: 'CB_dddddddddddddddd', expectedVersion: 1 },
        { blockId: 'CB_aaaaaaaaaaaaaaaa', expectedVersion: 2 },
        { blockId: 'CB_bbbbbbbbbbbbbbbb', expectedVersion: 5 },
      ],
    })
    expect(reorderInput.safeParse(body).success).toBe(true)
  })
  it('refuses a partial, duplicated or archived-including order', () => {
    expect(buildReorder(blocks, ['CB_aaaaaaaaaaaaaaaa', 'CB_bbbbbbbbbbbbbbbb'])).toBeUndefined()
    expect(
      buildReorder(blocks, ['CB_aaaaaaaaaaaaaaaa', 'CB_aaaaaaaaaaaaaaaa', 'CB_bbbbbbbbbbbbbbbb']),
    ).toBeUndefined()
    expect(
      buildReorder(blocks, ['CB_aaaaaaaaaaaaaaaa', 'CB_bbbbbbbbbbbbbbbb', 'CB_cccccccccccccccc']),
    ).toBeUndefined()
    expect(
      reorderInput.safeParse({
        order: [
          { blockId: 'CB_aaaaaaaaaaaaaaaa', expectedVersion: 1 },
          { blockId: 'CB_aaaaaaaaaaaaaaaa', expectedVersion: 1 },
        ],
      }).success,
    ).toBe(false)
  })
  it('moves within bounds only', () => {
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(move(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const same = ['a', 'b']
    expect(move(same, 0, -1)).toBe(same)
    expect(move(same, 1, 2)).toBe(same)
  })
})

describe('status, schedule and preview helpers', () => {
  const now = Date.parse('2026-10-08T06:00:00Z')
  it('uses the backend effectiveStatus, and derives it the same way when absent', () => {
    expect(effectiveOf({ status: 'PUBLISHED', effectiveStatus: 'EXPIRED' }, now)).toBe('EXPIRED')
    expect(effectiveOf({ status: 'PUBLISHED', startsAt: '2026-10-09T00:00:00Z' }, now)).toBe(
      'SCHEDULED',
    )
    expect(effectiveOf({ status: 'PUBLISHED', endsAt: '2026-10-08T06:00:00Z' }, now)).toBe(
      'EXPIRED',
    )
    expect(effectiveOf({ status: 'PUBLISHED' }, now)).toBe('LIVE')
    expect(effectiveOf({ status: 'DRAFT' }, now)).toBe('DRAFT')
    expect(effectiveOf({ status: 'ARCHIVED' }, now)).toBe('ARCHIVED')
  })
  it('shows schedules in IST with the zone named', () => {
    expect(scheduleText({})).toBe('Always (no window)')
    expect(scheduleText({ startsAt: '2026-10-08T03:30:00Z' })).toBe(
      '8 Oct 2026, 9:00 am → no end IST',
    )
  })
  it('parses the preview query: IST wall time -> UTC instant, invalid time flagged, safe defaults', () => {
    expect(
      parsePreviewQuery({ view: 'web-desktop', drafts: 'false', at: '2026-10-08T09:00' }),
    ).toEqual({
      view: 'web-desktop',
      drafts: false,
      atLocal: '2026-10-08T09:00',
      atUtc: '2026-10-08T03:30:00.000Z',
    })
    expect(parsePreviewQuery({})).toEqual({ view: 'app', drafts: true })
    expect(parsePreviewQuery({ view: 'tv', at: 'tomorrow' })).toEqual({
      view: 'app',
      drafts: true,
      invalidAt: true,
    })
  })
  it('banner crops match the clients: app 528:178, website 16:9, desktop 3:1 only when a whole carousel has desktop images', () => {
    expect(BANNER_ASPECT).toEqual({ app: '528 / 178', 'web-16x9': '16 / 9', 'web-3x1': '3 / 1' })
    const banner = (id: string, desktop?: boolean) => ({
      blockId: id,
      type: 'BANNER',
      imageUrl: `https://cdn/${id}-m.webp`,
      desktopImageUrl: desktop ? `https://cdn/${id}-d.webp` : undefined,
    })
    const rail = { blockId: 'R', type: 'PRODUCT_RAIL' }
    // Carousel 1 = A, B (both wide); a rail breaks it; carousel 2 = C (wide), D (no desktop image).
    const blocks = [banner('A', true), banner('B', true), rail, banner('C', true), banner('D')]
    const app = bannerLayouts('app', blocks)
    expect(app.get('A')).toEqual({ crop: 'app', src: 'https://cdn/A-m.webp' })
    expect(app.has('R')).toBe(false)
    const mobile = bannerLayouts('web-mobile', blocks)
    expect(mobile.get('A')).toEqual({ crop: 'web-16x9', src: 'https://cdn/A-m.webp' })
    const desktop = bannerLayouts('web-desktop', blocks)
    expect(desktop.get('A')).toEqual({ crop: 'web-3x1', src: 'https://cdn/A-d.webp' })
    expect(desktop.get('B')).toEqual({ crop: 'web-3x1', src: 'https://cdn/B-d.webp' })
    // All-or-nothing per carousel: one banner without a desktop image keeps the whole carousel at 16:9 (each banner
    // still loads its own desktop image when it has one, as the storefront's <picture> does).
    expect(desktop.get('C')).toEqual({ crop: 'web-16x9', src: 'https://cdn/C-d.webp' })
    expect(desktop.get('D')).toEqual({ crop: 'web-16x9', src: 'https://cdn/D-m.webp' })
    expect(bannerLayouts('web-desktop', [banner('X')]).get('X')?.src).toBe('https://cdn/X-m.webp')
  })
  it('the CSS frames carry exactly these ratios', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(`${__dirname}/../../src/app/globals.css`, 'utf8')
    for (const [crop, ratio] of Object.entries(BANNER_ASPECT))
      expect(css).toMatch(
        new RegExp(`\\.banner-${crop} \\{\\s*aspect-ratio: ${ratio.replace(/ /g, ' ')};`),
      )
  })
  it('keeps an untouched schedule instant exactly (seconds and milliseconds), converts an edited one', () => {
    const toUtc = (l: string) => `${l}:00.000Z`
    const toLocal = (iso: string | null | undefined) => (iso ? iso.slice(0, 16) : '')
    expect(scheduleInstant('2026-10-09T09:00', '2026-10-09T09:00:42.123Z', toUtc, toLocal)).toBe(
      '2026-10-09T09:00:42.123Z',
    )
    expect(scheduleInstant('2026-10-09T09:05', '2026-10-09T09:00:42.123Z', toUtc, toLocal)).toBe(
      '2026-10-09T09:05:00.000Z',
    )
    expect(scheduleInstant('', '2026-10-09T09:00:42Z', toUtc, toLocal)).toBeUndefined()
    expect(scheduleInstant('2026-10-09T09:00', undefined, toUtc, toLocal)).toBe(
      '2026-10-09T09:00:00.000Z',
    )
  })
  it('names each backend code without echoing backend text', () => {
    const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
    expect(homeErrorMessage(f(422, 'INVALID_CONTENT'))).toMatch(/rejected this content/)
    expect(homeErrorMessage(f(409, 'STALE_VERSION'))).toMatch(/Your edits are still shown/)
    expect(homeErrorMessage(f(409, 'STATE_CONFLICT'))).toMatch(/archived blocks are final/)
    expect(homeErrorMessage(f(502, 'MEDIA_STORAGE_NOT_CONFIGURED'))).toMatch(/switched off/)
    expect(homeErrorMessage(f(502, 'MEDIA_STORAGE_UNAVAILABLE'))).toMatch(/unavailable/)
    expect(homeErrorMessage(f(404))).toMatch(/no longer exists/)
  })
})
