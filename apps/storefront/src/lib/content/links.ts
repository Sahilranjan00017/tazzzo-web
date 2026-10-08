import { isNodeId, isProductId } from '@/lib/ids'

/**
 * Banner deep links use the backend's CLOSED grammar (`ContentBlock.LINK`):
 * `product:<id>` | `category:<node id>` | `search:<letters, combining marks, digits and spaces, 2..64>`
 * (tazzzo-backend db3623c: combining marks so Indic search banners, e.g. Devanagari with matras, can be authored).
 * Anything else, including any URL, is not clickable. The website never renders a link it did not build itself.
 */
export type BannerTarget =
  | { kind: 'product'; id: string }
  | { kind: 'category'; id: string }
  | { kind: 'search'; text: string }

// `u`: \p{L}/\p{M}/\p{N} are the Unicode letter/mark/number classes and the quantifier counts code points, like
// java.util.regex.
const SEARCH_TEXT = /^[\p{L}\p{M}\p{N} ]{2,64}$/u

export function parseBannerLink(link: unknown): BannerTarget | null {
  if (typeof link !== 'string') return null
  const colon = link.indexOf(':')
  if (colon < 0) return null
  const scheme = link.slice(0, colon)
  const value = link.slice(colon + 1)
  if (scheme === 'product' && isProductId(value)) return { kind: 'product', id: value }
  if (scheme === 'category' && isNodeId(value)) return { kind: 'category', id: value }
  if (scheme === 'search' && SEARCH_TEXT.test(value)) return { kind: 'search', text: value }
  return null
}

/** The site-relative path for a target. Always one of /p/<id>, /c/<node> or /search?q=<encoded>. */
export function hrefForTarget(target: BannerTarget): string {
  switch (target.kind) {
    case 'product':
      return `/p/${encodeURIComponent(target.id)}`
    case 'category':
      return `/c/${encodeURIComponent(target.id)}`
    case 'search':
      return `/search?q=${encodeURIComponent(target.text)}`
  }
}

export function bannerHref(link: unknown): string | null {
  const target = parseBannerLink(link)
  return target ? hrefForTarget(target) : null
}
