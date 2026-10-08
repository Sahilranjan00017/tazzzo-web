import { describe, expect, it } from 'vitest'
import { bannerSources, galleryImages, isAllowedImageUrl } from '@/lib/images'
import { parseMediaBase, type MediaBase } from '@/lib/media-base'

const media: MediaBase = {
  base: 'https://cdn.tazzzo.test/assets',
  origin: 'https://cdn.tazzzo.test',
}

describe('isAllowedImageUrl', () => {
  it('allows only absolute URLs under the configured media base', () => {
    expect(isAllowedImageUrl('https://cdn.tazzzo.test/assets/p/a.jpg', media)).toBe(true)
    for (const url of [
      'http://cdn.tazzzo.test/assets/p/a.jpg',
      'https://cdn.tazzzo.test/assetsX/a.jpg',
      'https://cdn.tazzzo.test/other/a.jpg',
      'https://cdn.tazzzo.test.evil.example/assets/a.jpg',
      'https://user:pw@cdn.tazzzo.test/assets/a.jpg',
      'https://cdn.tazzzo.test:8443/assets/a.jpg',
      '/assets/a.jpg',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '',
      'not a url',
    ]) {
      expect(isAllowedImageUrl(url, media), url).toBe(false)
    }
    expect(isAllowedImageUrl(42, media)).toBe(false)
    expect(isAllowedImageUrl('https://cdn.tazzzo.test/assets/a.jpg', null)).toBe(false)
  })

  it('normalises traversal before checking the prefix', () => {
    expect(isAllowedImageUrl('https://cdn.tazzzo.test/assets/../secret.jpg', media)).toBe(false)
  })
})

describe('bannerSources (image source selection)', () => {
  it('uses the desktop image for wide viewports when present', () => {
    expect(bannerSources('https://c/m.jpg', 'https://c/w.jpg')).toEqual({
      narrow: 'https://c/m.jpg',
      wide: 'https://c/w.jpg',
    })
  })
  it('uses the one image everywhere when there is no desktop image', () => {
    expect(bannerSources('https://c/m.jpg', undefined)).toEqual({
      narrow: 'https://c/m.jpg',
      wide: null,
    })
  })
})

describe('galleryImages', () => {
  const u = (n: string) => `${media.base}/${n}`

  it('orders PRIMARY first, then GALLERY by order, with alt text from media metadata or the product name', () => {
    const images = galleryImages(
      [
        { url: u('c.jpg'), role: 'GALLERY', order: 2, alt: 'Back' },
        { url: u('a.jpg'), role: 'PRIMARY', order: 0, alt: 'Front', width: 800, height: 600 },
        { url: u('b.jpg'), role: 'GALLERY', order: 1, alt: null },
        { url: u('d.jpg'), role: 'GALLERY', order: 1, alt: '   ' },
      ],
      'Basmati 5 kg',
      u('thumb.jpg'),
      media,
    )
    expect(images).toEqual([
      { url: u('a.jpg'), alt: 'Front', width: 800, height: 600 },
      { url: u('b.jpg'), alt: 'Basmati 5 kg', width: null, height: null },
      { url: u('d.jpg'), alt: 'Basmati 5 kg', width: null, height: null },
      { url: u('c.jpg'), alt: 'Back', width: null, height: null },
    ])
  })

  it('drops disallowed, duplicate, unknown-role and malformed entries', () => {
    const images = galleryImages(
      [
        { url: 'https://evil.example/x.jpg', role: 'PRIMARY', order: 0 },
        { url: u('a.jpg'), role: 'GALLERY', order: 0 },
        { url: u('a.jpg'), role: 'GALLERY', order: 1 },
        { url: u('z.jpg'), role: 'VIDEO', order: 0 },
        null,
        'x',
      ],
      'P',
      null,
      media,
    )
    expect(images.map((i) => i.url)).toEqual([u('a.jpg')])
  })

  it('falls back to the thumbnail, then to nothing (placeholder)', () => {
    expect(galleryImages(undefined, 'P', u('t.jpg'), media)).toEqual([
      { url: u('t.jpg'), alt: 'P', width: null, height: null },
    ])
    expect(galleryImages([], 'P', 'https://evil.example/t.jpg', media)).toEqual([])
  })
})

describe('parseMediaBase', () => {
  it('accepts an https base with an optional port and path prefix, normalising trailing slashes', () => {
    expect(parseMediaBase('https://cdn.tazzzo.test/assets//', 'production')).toEqual({
      base: 'https://cdn.tazzzo.test/assets',
      origin: 'https://cdn.tazzzo.test',
    })
    expect(parseMediaBase('https://cdn.tazzzo.test:8443', 'production')).toEqual({
      base: 'https://cdn.tazzzo.test:8443',
      origin: 'https://cdn.tazzzo.test:8443',
    })
  })

  it('allows plain http only for loopback outside production', () => {
    expect(parseMediaBase('http://127.0.0.1:9000/media', 'development')?.origin).toBe(
      'http://127.0.0.1:9000',
    )
    expect(parseMediaBase('http://localhost:9000', 'test')).not.toBeNull()
    expect(parseMediaBase('http://127.0.0.1:9000/media', 'production')).toBeNull()
    expect(parseMediaBase('http://cdn.tazzzo.test', 'development')).toBeNull()
  })

  it('rejects credentials, query, fragment, unsafe paths and junk', () => {
    for (const v of [
      'https://u:p@cdn.tazzzo.test',
      'https://cdn.tazzzo.test/?a=1',
      'https://cdn.tazzzo.test/#x',
      'https://cdn.tazzzo.test/a%2e%2e/b',
      'https://cdn.tazzzo.test/a//b',
      'ftp://cdn.tazzzo.test',
      'javascript:alert(1)',
      'nope',
    ]) {
      expect(parseMediaBase(v, 'production'), v).toBeNull()
    }
    expect(parseMediaBase(undefined, 'production')).toBeNull()
    expect(parseMediaBase('  ', 'production')).toBeNull()
  })
})
