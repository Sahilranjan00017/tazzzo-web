import { bannerHref } from '@/lib/content/links'
import { isNodeId, isProductId } from '@/lib/ids'
import { isAllowedImageUrl } from '@/lib/images'
import type { MediaBase } from '@/lib/media-base'

/**
 * `GET /v1/content/home?channel=web` blocks, parsed defensively. The backend already decided WHICH blocks are live for
 * the web (channel, publication state, schedule) and in what order; this module only checks each block's SHAPE, in
 * the order received. It never filters by audience, status or time.
 *
 * - unknown `type` (a newer backend): skipped, the rest still render;
 * - a malformed block (not an object, missing id/title, rail/grid without usable ids): skipped;
 * - banner image not under the media base (or no media base configured): the banner is KEPT with the branded
 *   placeholder (`imageUrl: null`), like every other image that cannot be shown;
 * - banner `desktopImageUrl` unusable: ignored (the one `imageUrl` is used at every width);
 * - banner `link` outside the closed grammar: rendered, not clickable.
 * Everything skipped or degraded is counted in a {@link HomeParseReport}, so the server can log it.
 */
export const MAX_RAIL = 20
export const MAX_GRID = 12

export interface BannerBlock {
  type: 'BANNER'
  blockId: string
  title: string
  subtitle: string | null
  altText: string
  /** Null when the image cannot be shown (not under the media base): the placeholder stands in. */
  imageUrl: string | null
  desktopImageUrl?: string
  /** Site-relative path built from the link grammar, or null (not clickable). */
  href: string | null
}

export interface ProductRailBlock {
  type: 'PRODUCT_RAIL'
  blockId: string
  title: string
  ids: string[]
}

export interface CategoryGridBlock {
  type: 'CATEGORY_GRID'
  blockId: string
  title: string
  ids: string[]
}

export type HomeBlock = BannerBlock | ProductRailBlock | CategoryGridBlock

/** Counts only: no ids, titles or URLs, so the report is safe to log. */
export interface HomeParseReport {
  /** Blocks of a type this website does not know (skipped). */
  unknownType: number
  /** Blocks that are not objects, lack an id/title, or are rails/grids left without usable ids (skipped). */
  malformed: number
  /** Rail/grid id entries that are not well-formed product/node ids (dropped from their block). */
  invalidIds: number
  /** Banner links present but outside the closed grammar (banner rendered, not clickable). */
  invalidLinks: number
  /** Banner images (mobile or desktop) not under the media base (placeholder, or imageUrl used instead). */
  imagesNotAllowed: number
}

export function emptyReport(): HomeParseReport {
  return { unknownType: 0, malformed: 0, invalidIds: 0, invalidLinks: 0, imagesNotAllowed: 0 }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function idList(
  value: unknown,
  valid: (v: unknown) => v is string,
  max: number,
  report: HomeParseReport,
): string[] {
  if (!Array.isArray(value)) return []
  const ok = value.filter(valid)
  report.invalidIds += value.length - ok.length
  return [...new Set(ok)].slice(0, max)
}

export function parseHomeBlock(
  raw: unknown,
  media: MediaBase | null,
  report: HomeParseReport = emptyReport(),
): HomeBlock | null {
  if (raw === null || typeof raw !== 'object') {
    report.malformed++
    return null
  }
  const block = raw as Record<string, unknown>
  const blockId = text(block.blockId)
  const title = text(block.title)
  if (blockId === null || title === null) {
    report.malformed++
    return null
  }
  switch (block.type) {
    case 'BANNER': {
      const href = bannerHref(block.link)
      if (href === null && block.link !== undefined && block.link !== null) report.invalidLinks++
      const imageOk = isAllowedImageUrl(block.imageUrl, media)
      if (!imageOk) report.imagesNotAllowed++
      const banner: BannerBlock = {
        type: 'BANNER',
        blockId,
        title,
        subtitle: text(block.subtitle),
        altText: text(block.altText) ?? title,
        imageUrl: imageOk ? (block.imageUrl as string) : null,
        href,
      }
      if (block.desktopImageUrl !== undefined && block.desktopImageUrl !== null) {
        if (isAllowedImageUrl(block.desktopImageUrl, media)) {
          if (imageOk) banner.desktopImageUrl = block.desktopImageUrl
        } else {
          report.imagesNotAllowed++
        }
      }
      return banner
    }
    case 'PRODUCT_RAIL': {
      const ids = idList(block.ids, isProductId, MAX_RAIL, report)
      if (ids.length === 0) report.malformed++
      return ids.length > 0 ? { type: 'PRODUCT_RAIL', blockId, title, ids } : null
    }
    case 'CATEGORY_GRID': {
      const ids = idList(block.ids, isNodeId, MAX_GRID, report)
      if (ids.length === 0) report.malformed++
      return ids.length > 0 ? { type: 'CATEGORY_GRID', blockId, title, ids } : null
    }
    default:
      report.unknownType++
      return null
  }
}

/** The usable blocks of a home response, in backend order, with counts of what was skipped or degraded. */
export function parseHome(
  body: unknown,
  media: MediaBase | null,
): { blocks: HomeBlock[]; report: HomeParseReport } {
  if (
    body === null ||
    typeof body !== 'object' ||
    !Array.isArray((body as { blocks?: unknown }).blocks)
  ) {
    throw new Error('malformed home response')
  }
  const report = emptyReport()
  const blocks: HomeBlock[] = []
  for (const raw of (body as { blocks: unknown[] }).blocks) {
    const block = parseHomeBlock(raw, media, report)
    if (block !== null) blocks.push(block)
  }
  return { blocks, report }
}

/** The usable blocks of a home response. Throws when the envelope itself is not a home response. */
export function parseHomeBlocks(body: unknown, media: MediaBase | null): HomeBlock[] {
  return parseHome(body, media).blocks
}

/** Consecutive banners form one carousel; everything else stays a single section. Backend order is preserved. */
export type HomeSection =
  | { kind: 'banners'; key: string; banners: BannerBlock[] }
  | { kind: 'rail'; key: string; block: ProductRailBlock }
  | { kind: 'grid'; key: string; block: CategoryGridBlock }

export function groupSections(blocks: HomeBlock[]): HomeSection[] {
  const sections: HomeSection[] = []
  for (const block of blocks) {
    const last = sections.at(-1)
    if (block.type === 'BANNER') {
      if (last?.kind === 'banners') last.banners.push(block)
      else sections.push({ kind: 'banners', key: block.blockId, banners: [block] })
    } else if (block.type === 'PRODUCT_RAIL') {
      sections.push({ kind: 'rail', key: block.blockId, block })
    } else {
      sections.push({ kind: 'grid', key: block.blockId, block })
    }
  }
  return sections
}
