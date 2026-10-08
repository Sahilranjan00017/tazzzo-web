import type { MediaBase } from '@/lib/media-base'

/**
 * An image URL is rendered only when it is an absolute URL under the configured media base (https in production; see
 * `parseMediaBase`). Anything else (another host, a relative path, `javascript:`/`data:`, credentials) is treated as
 * a missing image and gets the placeholder, so the CSP `img-src` and this check always agree.
 */
export function isAllowedImageUrl(value: unknown, media: MediaBase | null): value is string {
  if (media === null || typeof value !== 'string' || value === '') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.origin !== media.origin) return false
  const basePath = media.base.slice(media.origin.length)
  return url.pathname.startsWith(`${basePath}/`)
}

/** `<picture>` sources for a banner: the wide desktop image when present, else the one image for every width. */
export interface BannerSources {
  /** Shown below the desktop breakpoint, and everywhere when `wide` is null. */
  narrow: string
  wide: string | null
}

export function bannerSources(
  imageUrl: string,
  desktopImageUrl: string | undefined,
): BannerSources {
  return { narrow: imageUrl, wide: desktopImageUrl ?? null }
}

export interface ProductImageInput {
  url?: unknown
  role?: unknown
  order?: unknown
  alt?: unknown
  width?: unknown
  height?: unknown
}

export interface GalleryImage {
  url: string
  alt: string
  width: number | null
  height: number | null
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * The product gallery as the backend describes it: PRIMARY first, then GALLERY, each by `order`. Alt text comes from
 * the media metadata, falling back to the product name. Disallowed or duplicate URLs are dropped; when nothing
 * remains the card thumbnail (if allowed) stands in, so a product always shows its best available image.
 */
export function galleryImages(
  gallery: unknown,
  productName: string,
  thumbnailUrl: unknown,
  media: MediaBase | null,
): GalleryImage[] {
  const items = Array.isArray(gallery) ? (gallery as ProductImageInput[]) : []
  const rank = (role: unknown) => (role === 'PRIMARY' ? 0 : role === 'GALLERY' ? 1 : 2)
  const sorted = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item !== null && typeof item === 'object' && rank(item.role) < 2)
    .sort((a, b) => {
      const byRole = rank(a.item.role) - rank(b.item.role)
      if (byRole !== 0) return byRole
      const ao = typeof a.item.order === 'number' ? a.item.order : Number.MAX_SAFE_INTEGER
      const bo = typeof b.item.order === 'number' ? b.item.order : Number.MAX_SAFE_INTEGER
      return ao - bo || a.index - b.index
    })
  const seen = new Set<string>()
  const out: GalleryImage[] = []
  for (const { item } of sorted) {
    if (!isAllowedImageUrl(item.url, media) || seen.has(item.url)) continue
    seen.add(item.url)
    const alt =
      typeof item.alt === 'string' && item.alt.trim() !== '' ? item.alt.trim() : productName
    out.push({
      url: item.url,
      alt,
      width: positiveInt(item.width),
      height: positiveInt(item.height),
    })
  }
  if (out.length === 0 && isAllowedImageUrl(thumbnailUrl, media)) {
    out.push({ url: thumbnailUrl, alt: productName, width: null, height: null })
  }
  return out
}
