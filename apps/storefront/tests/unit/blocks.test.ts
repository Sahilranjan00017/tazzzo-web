import { describe, expect, it } from 'vitest'
import { groupSections, parseHome, parseHomeBlocks, MAX_GRID, MAX_RAIL } from '@/lib/content/blocks'
import type { MediaBase } from '@/lib/media-base'

const media: MediaBase = {
  base: 'https://media.tazzzo.test/assets',
  origin: 'https://media.tazzzo.test',
}
const img = (name: string) => `${media.base}/${name}`

const banner = (over: Record<string, unknown> = {}) => ({
  blockId: 'CB_1',
  type: 'BANNER',
  title: 'Mangoes',
  altText: 'A crate of mangoes',
  imageUrl: img('m.jpg'),
  link: 'category:TZC-000001',
  ...over,
})

describe('parseHomeBlocks', () => {
  it('keeps backend order and every supported type', () => {
    const blocks = parseHomeBlocks(
      {
        blocks: [
          { blockId: 'R', type: 'PRODUCT_RAIL', title: 'Rail', ids: ['TZP-1', 'TZP-2'] },
          banner({ blockId: 'B' }),
          { blockId: 'G', type: 'CATEGORY_GRID', title: 'Grid', ids: ['TZS-000001'] },
        ],
        requestId: 'r',
      },
      media,
    )
    expect(blocks.map((b) => `${b.type}:${b.blockId}`)).toEqual([
      'PRODUCT_RAIL:R',
      'BANNER:B',
      'CATEGORY_GRID:G',
    ])
  })

  it('skips unknown types (a newer backend) and keeps the rest', () => {
    const blocks = parseHomeBlocks(
      { blocks: [{ blockId: 'V', type: 'VIDEO', title: 'x' }, banner(), { type: 'FAQ' }] },
      media,
    )
    expect(blocks.map((b) => b.blockId)).toEqual(['CB_1'])
  })

  it('skips blocks missing an id or title, or that are not objects', () => {
    const blocks = parseHomeBlocks(
      {
        blocks: [
          banner({ blockId: undefined }),
          banner({ title: '  ' }),
          banner({ title: 7 }),
          null,
          'BANNER',
          banner({ blockId: 'ok' }),
        ],
      },
      media,
    )
    expect(blocks.map((b) => b.blockId)).toEqual(['ok'])
  })

  it('maps a banner: subtitle optional, alt text falls back to the title, link to a site path', () => {
    const [full, bare] = parseHomeBlocks(
      {
        blocks: [
          banner({ subtitle: ' Fresh today ', desktopImageUrl: img('wide.jpg') }),
          banner({
            blockId: 'CB_2',
            altText: undefined,
            subtitle: undefined,
            link: 'search:mango',
          }),
        ],
      },
      media,
    )
    expect(full).toEqual({
      type: 'BANNER',
      blockId: 'CB_1',
      title: 'Mangoes',
      subtitle: 'Fresh today',
      altText: 'A crate of mangoes',
      imageUrl: img('m.jpg'),
      desktopImageUrl: img('wide.jpg'),
      href: '/c/TZC-000001',
    })
    expect(bare).toMatchObject({ altText: 'Mangoes', subtitle: null, href: '/search?q=mango' })
    expect(bare).not.toHaveProperty('desktopImageUrl')
  })

  it('keeps a banner with an out-of-grammar link, but not clickable', () => {
    const [b] = parseHomeBlocks({ blocks: [banner({ link: 'https://evil.example' })] }, media)
    expect(b).toMatchObject({ blockId: 'CB_1', href: null })
    const [missing] = parseHomeBlocks({ blocks: [banner({ link: undefined })] }, media)
    expect(missing).toMatchObject({ href: null })
  })

  it('keeps a banner whose image cannot be shown, with the placeholder (imageUrl null) and no desktop image', () => {
    for (const imageUrl of [
      undefined,
      '',
      'http://media.tazzzo.test/assets/m.jpg',
      'https://evil.example/assets/m.jpg',
      'https://media.tazzzo.test/other/m.jpg',
      '/assets/m.jpg',
      'javascript:alert(1)',
    ]) {
      const [b] = parseHomeBlocks(
        { blocks: [banner({ imageUrl, desktopImageUrl: img('w.jpg') })] },
        media,
      )
      expect(b, String(imageUrl)).toMatchObject({
        blockId: 'CB_1',
        imageUrl: null,
        href: '/c/TZC-000001',
      })
      expect(b).not.toHaveProperty('desktopImageUrl')
    }
    // No media base configured: every banner is still there, every one with the placeholder.
    expect(parseHomeBlocks({ blocks: [banner()] }, null)).toMatchObject([{ imageUrl: null }])
  })

  it('reports what was skipped or degraded, as counts only', () => {
    const { blocks, report } = parseHome(
      {
        blocks: [
          banner({ blockId: 'ok' }),
          banner({ blockId: 'B2', imageUrl: 'https://evil.example/a.jpg' }),
          banner({
            blockId: 'B3',
            desktopImageUrl: 'https://evil.example/w.jpg',
            link: 'https://x',
          }),
          banner({ blockId: 'B4', link: undefined }),
          { blockId: 'V', type: 'VIDEO', title: 'v' },
          { blockId: 'R', type: 'PRODUCT_RAIL', title: 'R', ids: ['TZP-1', 'bad', 'TZP-1'] },
          { blockId: 'G', type: 'CATEGORY_GRID', title: 'G', ids: ['nope', 'TZP-1'] },
          null,
          { type: 'BANNER' },
        ],
      },
      media,
    )
    expect(blocks.map((b) => b.blockId)).toEqual(['ok', 'B2', 'B3', 'B4', 'R'])
    expect(report).toEqual({
      unknownType: 1,
      malformed: 3, // the grid left without ids, null, the banner without id/title
      invalidIds: 3, // 'bad', 'nope', 'TZP-1' in a grid (not a node id); the duplicate is not invalid
      invalidLinks: 1, // B4 has no link at all: not counted
      imagesNotAllowed: 2,
    })
    expect(parseHome({ blocks: [banner()] }, media).report).toEqual({
      unknownType: 0,
      malformed: 0,
      invalidIds: 0,
      invalidLinks: 0,
      imagesNotAllowed: 0,
    })
  })

  it('ignores an unusable desktop image and keeps the banner', () => {
    const [b] = parseHomeBlocks(
      { blocks: [banner({ desktopImageUrl: 'https://evil.example/w.jpg' })] },
      media,
    )
    expect(b).toBeDefined()
    expect(b).not.toHaveProperty('desktopImageUrl')
  })

  it('keeps only well-formed, distinct ids for rails and grids, capped like the backend', () => {
    const [rail, grid] = parseHomeBlocks(
      {
        blocks: [
          {
            blockId: 'R',
            type: 'PRODUCT_RAIL',
            title: 'R',
            ids: [
              'TZP-1',
              'TZP-1',
              'bad',
              7,
              'TZP-2',
              ...Array.from({ length: 30 }, (_, i) => `TZP-${i + 10}`),
            ],
          },
          {
            blockId: 'G',
            type: 'CATEGORY_GRID',
            title: 'G',
            ids: ['TZC-000001', 'TZP-1', 'TZS-1'],
          },
        ],
      },
      media,
    )
    expect(rail).toMatchObject({ type: 'PRODUCT_RAIL' })
    expect((rail as { ids: string[] }).ids.slice(0, 3)).toEqual(['TZP-1', 'TZP-2', 'TZP-10'])
    expect((rail as { ids: string[] }).ids).toHaveLength(MAX_RAIL)
    expect(grid).toMatchObject({ ids: ['TZC-000001'] })
    expect(MAX_GRID).toBe(12)
  })

  it('drops rails and grids left without usable ids', () => {
    expect(
      parseHomeBlocks(
        {
          blocks: [
            { blockId: 'R', type: 'PRODUCT_RAIL', title: 'R', ids: ['nope'] },
            { blockId: 'G', type: 'CATEGORY_GRID', title: 'G' },
          ],
        },
        media,
      ),
    ).toEqual([])
  })

  it('throws on an envelope that is not a home response', () => {
    for (const body of [null, 'x', {}, { blocks: {} }]) {
      expect(() => parseHomeBlocks(body, media)).toThrow('malformed home response')
    }
    expect(parseHomeBlocks({ blocks: [] }, media)).toEqual([])
  })
})

describe('groupSections', () => {
  it('groups only CONSECUTIVE banners into one carousel and preserves order', () => {
    const blocks = parseHomeBlocks(
      {
        blocks: [
          banner({ blockId: 'B1' }),
          banner({ blockId: 'B2' }),
          { blockId: 'R', type: 'PRODUCT_RAIL', title: 'R', ids: ['TZP-1'] },
          banner({ blockId: 'B3' }),
          { blockId: 'G', type: 'CATEGORY_GRID', title: 'G', ids: ['TZS-000001'] },
        ],
      },
      media,
    )
    const sections = groupSections(blocks)
    expect(
      sections.map((s) =>
        s.kind === 'banners'
          ? `banners:${s.banners.map((b) => b.blockId).join('+')}`
          : `${s.kind}:${s.key}`,
      ),
    ).toEqual(['banners:B1+B2', 'rail:R', 'banners:B3', 'grid:G'])
  })
})
