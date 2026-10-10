import { isAllowedImageUrl, galleryImages, type GalleryImage } from '@/lib/images'
import type { MediaBase } from '@/lib/media-base'

/**
 * The parts of the public `ProductCard` / `ProductDetail` (docs/api/v1/openapi.yaml) the storefront renders. Prices are
 * integer paise and may be null (no location supplied, or not priced); the UI then shows no price rather than a guess.
 */
export interface ProductSummary {
  productId: string
  name: string
  brandName: string | null
  packSize: string | null
  sellingPricePaise: number | null
  mrpPaise: number | null
  /** The best allowed image for a card (thumbnail, else the first gallery image), or null for the placeholder. */
  image: GalleryImage | null
}

export type StockSignal = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN'

export interface ProductDetail extends ProductSummary {
  /** The public read's stock signal. It is read without a location, so it is normally `UNKNOWN`; never guessed. */
  stockState: StockSignal
  description: string | null
  highlights: string[]
  images: GalleryImage[]
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function paise(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function parseProductSummary(raw: unknown, media: MediaBase | null): ProductSummary | null {
  if (raw === null || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const productId = str(p.productId)
  const name = str(p.name)
  if (productId === null || name === null) return null
  return {
    productId,
    name,
    brandName: str(p.brandName),
    packSize: str(p.packSize),
    sellingPricePaise: paise(p.sellingPricePaise),
    mrpPaise: paise(p.mrpPaise),
    image: isAllowedImageUrl(p.thumbnailUrl, media)
      ? { url: p.thumbnailUrl, alt: name, width: null, height: null }
      : null,
  }
}

export function parseProductDetail(raw: unknown, media: MediaBase | null): ProductDetail | null {
  const summary = parseProductSummary(raw, media)
  if (summary === null) return null
  const p = raw as Record<string, unknown>
  const images = galleryImages(p.gallery, summary.name, p.thumbnailUrl, media)
  const highlights = Array.isArray(p.highlights)
    ? p.highlights.map(str).filter((h): h is string => h !== null)
    : []
  const stock = p.stockState
  return {
    ...summary,
    stockState:
      stock === 'IN_STOCK' || stock === 'LOW_STOCK' || stock === 'OUT_OF_STOCK' ? stock : 'UNKNOWN',
    image: summary.image ?? images[0] ?? null,
    description: str(p.description),
    highlights,
    images,
  }
}
