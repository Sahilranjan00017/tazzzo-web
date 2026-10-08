import { describe, expect, it } from 'vitest'
import { formatPaise } from '@/lib/format'
import { parseProductDetail, parseProductSummary } from '@/lib/products'
import type { MediaBase } from '@/lib/media-base'

const media: MediaBase = { base: 'https://cdn.tazzzo.test', origin: 'https://cdn.tazzzo.test' }

describe('formatPaise', () => {
  it('formats integer paise as rupees', () => {
    expect(formatPaise(49900)).toBe('₹499')
    expect(formatPaise(15950)).toBe('₹159.50')
    expect(formatPaise(12345678)).toBe('₹1,23,456.78')
    expect(formatPaise(0)).toBe('₹0')
  })
  it('returns null for anything that is not a non-negative integer amount', () => {
    for (const v of [null, undefined, -1, 1.5, '100', Number.NaN, 2 ** 60])
      expect(formatPaise(v)).toBeNull()
  })
})

describe('product parsing', () => {
  it('requires a product id and a name', () => {
    expect(parseProductSummary({ name: 'x' }, media)).toBeNull()
    expect(parseProductSummary({ productId: 'TZP-1', name: ' ' }, media)).toBeNull()
    expect(parseProductSummary(null, media)).toBeNull()
  })

  it('keeps unknown prices as null and only allowed thumbnails', () => {
    const p = parseProductSummary(
      {
        productId: 'TZP-1',
        name: 'Dal',
        sellingPricePaise: null,
        mrpPaise: -5,
        thumbnailUrl: 'https://evil.example/t.jpg',
      },
      media,
    )
    expect(p).toMatchObject({ sellingPricePaise: null, mrpPaise: null, image: null })
  })

  it('uses the first gallery image for the card when there is no thumbnail', () => {
    const p = parseProductDetail(
      {
        productId: 'TZP-1',
        name: 'Dal',
        gallery: [
          { url: 'https://cdn.tazzzo.test/a.jpg', role: 'PRIMARY', order: 0, alt: 'Front' },
        ],
        highlights: ['A', 3, ' '],
        description: 'Text',
      },
      media,
    )
    expect(p?.image).toEqual({
      url: 'https://cdn.tazzzo.test/a.jpg',
      alt: 'Front',
      width: null,
      height: null,
    })
    expect(p?.highlights).toEqual(['A'])
  })
})
