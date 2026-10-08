import { describe, expect, it } from 'vitest'
import { bannerHref, hrefForTarget, parseBannerLink } from '@/lib/content/links'

describe('banner link grammar (closed, mirrors backend ContentBlock.LINK)', () => {
  it.each([
    ['product:TZP-1001', '/p/TZP-1001'],
    ['product:TZP-REF-1', '/p/TZP-REF-1'],
    ['category:TZC-000002', '/c/TZC-000002'],
    ['category:TZS-000001', '/c/TZS-000001'],
    ['category:TZV-123456', '/c/TZV-123456'],
    ['search:rice', '/search?q=rice'],
    ['search:basmati rice 5', '/search?q=basmati%20rice%205'],
    ['search:Café', '/search?q=Caf%C3%A9'],
  ])('%s -> %s', (link, href) => {
    expect(bannerHref(link)).toBe(href)
  })

  it.each([
    'https://evil.example/',
    'javascript:alert(1)',
    '//evil.example',
    '/p/TZP-1',
    'product:',
    'product:TZP-',
    'product:tzp-1',
    'product:TZP-1/../admin',
    'product:TZP-1?x=1',
    `product:TZP-${'1'.repeat(41)}`,
    'category:TZC-12345',
    'category:TZX-000001',
    'category:TZC-0000011',
    'search:a',
    `search:${'a'.repeat(65)}`,
    'search:rice&admin=1',
    'search:rice\n',
    'search:<b>x</b>',
    'Product:TZP-1',
    'product :TZP-1',
    '',
  ])('rejects %j (not clickable)', (link) => {
    expect(parseBannerLink(link)).toBeNull()
    expect(bannerHref(link)).toBeNull()
  })

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 42, {}, ['product:TZP-1']]) expect(bannerHref(v)).toBeNull()
  })

  it('counts search text in code points like java.util.regex, and keeps backend letter/digit classes', () => {
    expect(bannerHref(`search:${'😀'.repeat(2)}`)).toBeNull() // emoji is not a letter
    expect(bannerHref('search:日本')).toBe('/search?q=%E6%97%A5%E6%9C%AC')
    // Combining marks (Devanagari matras) are allowed, as in the backend grammar since db3623c.
    expect(bannerHref('search:चावल')).toBe('/search?q=%E0%A4%9A%E0%A4%BE%E0%A4%B5%E0%A4%B2')
    expect(bannerHref('search:बासमती चावल')).toBe(`/search?q=${encodeURIComponent('बासमती चावल')}`)
    // Still closed: punctuation, symbols, controls and invisible formatting characters are refused.
    for (const text of ['चावल!', 'चावल\u200d', 'चावल\u202e', 'a\u0000b', 'rice%20', 'rice/dal']) {
      expect(bannerHref(`search:${text}`), JSON.stringify(text)).toBeNull()
    }
  })

  it('encodes every target into a site-relative path', () => {
    expect(hrefForTarget({ kind: 'search', text: 'a b' })).toBe('/search?q=a%20b')
    expect(hrefForTarget({ kind: 'product', id: 'TZP-1' })).toBe('/p/TZP-1')
  })
})
