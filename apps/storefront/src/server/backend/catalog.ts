import 'server-only'
import { cache } from 'react'
import type { CategoryNode } from '@/lib/categories'
import { parseHome, type HomeBlock, type HomeParseReport } from '@/lib/content/blocks'
import { isNodeId, isProductId } from '@/lib/ids'
import {
  parseProductDetail,
  parseProductSummary,
  type ProductDetail,
  type ProductSummary,
} from '@/lib/products'
import { getJson } from '@/server/backend/client'
import { serverEnv } from '@/server/env'

/**
 * Typed reads over the public `/v1` contract (tazzzo-backend docs/api/v1/openapi.yaml). Each read is wrapped in React
 * `cache()` so a page and its `generateMetadata` share one call per render, and every fetch goes through the shared
 * 60 s data cache in `client.ts`. No location (`pin`) is ever sent, so responses are the same for every visitor.
 */
export type Unavailable = { ok: false; reason: 'unavailable' }

/** `GET /v1/content/home?channel=web`: the backend filters channel, publication and schedule; we only parse. */
export const getHomeBlocks = cache(
  async (): Promise<{ ok: true; blocks: HomeBlock[] } | Unavailable> => {
    const result = await getJson('/v1/content/home?channel=web')
    if (!result.ok) return { ok: false, reason: 'unavailable' }
    const media = serverEnv().media
    try {
      const { blocks, report } = parseHome(result.data, media)
      logHomeReport(report, media !== null)
      return { ok: true, blocks }
    } catch {
      console.warn('storefront_home_malformed_envelope')
      return { ok: false, reason: 'unavailable' }
    }
  },
)

const HOME_REPORT_LOG_INTERVAL_MS = 60_000
let lastHomeReport: { key: string; at: number } | undefined

/**
 * One warning line with COUNTS ONLY (no ids, titles or URLs) when home blocks were skipped or degraded. Every page view
 * re-parses the cached response, so the line is logged when the counts change or at most once a minute.
 */
export function logHomeReport(
  report: HomeParseReport,
  mediaConfigured: boolean,
  now = Date.now(),
): void {
  if (Object.values(report).every((n) => n === 0)) return
  const key =
    `unknown_type=${report.unknownType} malformed=${report.malformed} invalid_ids=${report.invalidIds} ` +
    `invalid_links=${report.invalidLinks} images_not_allowed=${report.imagesNotAllowed} ` +
    `media_base=${mediaConfigured ? 'configured' : 'unset'}`
  if (lastHomeReport?.key === key && now - lastHomeReport.at < HOME_REPORT_LOG_INTERVAL_MS) return
  lastHomeReport = { key, at: now }
  console.warn(`storefront_home_blocks_degraded ${key}`)
}

/** `GET /v1/products/{id}`. Null for a missing/hidden product (one flat 404 by design) or a malformed body. */
export const getProduct = cache(
  async (id: string): Promise<ProductDetail | null | 'unavailable'> => {
    if (!isProductId(id)) return null
    const result = await getJson(`/v1/products/${encodeURIComponent(id)}`)
    if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
    return parseProductDetail(result.data, serverEnv().media)
  },
)

/**
 * Cards for a product rail, in the rail's order. There is no public batch read, so each id is one cached
 * `GET /v1/products/{id}` (admission cost 1 each). Missing, hidden or failing products are skipped silently.
 */
export async function getRailProducts(ids: string[]): Promise<ProductSummary[]> {
  const results = await Promise.all(ids.map((id) => getProduct(id)))
  return results.filter((p): p is ProductDetail => p !== null && p !== 'unavailable')
}

function parseNodes(data: unknown): CategoryNode[] | null {
  const items = (data as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return null
  const out: CategoryNode[] = []
  for (const item of items) {
    const node = item as { id?: unknown; name?: unknown } | null
    if (node && isNodeId(node.id) && typeof node.name === 'string' && node.name.trim() !== '') {
      out.push({ id: node.id, name: node.name.trim() })
    }
  }
  return out
}

/** `GET /v1/categories`: consumer-visible super-categories (the sitemap). */
export const getRootCategories = cache(async (): Promise<CategoryNode[] | 'unavailable'> => {
  const result = await getJson('/v1/categories')
  if (!result.ok) return 'unavailable'
  return parseNodes(result.data) ?? 'unavailable'
})

/** `GET /v1/categories/{id}/children`. Null when the node is not consumer-visible (404). */
export const getChildCategories = cache(
  async (id: string): Promise<CategoryNode[] | null | 'unavailable'> => {
    if (!isNodeId(id)) return null
    const result = await getJson(`/v1/categories/${encodeURIComponent(id)}/children`)
    if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
    return parseNodes(result.data) ?? 'unavailable'
  },
)

/**
 * `GET /v1/categories/{id}`: one consumer-visible node at any depth (`{id, name, resolvedReleaseId, requestId}`).
 * Null when the node is not consumer-visible (unknown, hidden or consumer-empty: one flat 404, exactly when `children`
 * would 404); `unavailable` on a failure or a body that does not name the node that was asked for.
 */
export const getCategory = cache(
  async (id: string): Promise<CategoryNode | null | 'unavailable'> => {
    if (!isNodeId(id)) return null
    const result = await getJson(`/v1/categories/${encodeURIComponent(id)}`)
    if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
    const body = result.data as { id?: unknown; name?: unknown } | null
    if (!body || body.id !== id || typeof body.name !== 'string' || body.name.trim() === '') {
      return 'unavailable'
    }
    return { id, name: body.name.trim() }
  },
)

/**
 * Names for category node ids, one cached `GET /v1/categories/{id}` per distinct id (a grid has at most 12). A node
 * that is not visible, or whose read fails, is left out: callers skip it or fall back to a generic label.
 */
export const resolveCategoryNames = cache(async (idsKey: string): Promise<Map<string, string>> => {
  const wanted = [...new Set(idsKey.split(',').filter(isNodeId))]
  const nodes = await Promise.all(wanted.map((id) => getCategory(id)))
  const names = new Map<string, string>()
  for (const node of nodes)
    if (node !== null && node !== 'unavailable') names.set(node.id, node.name)
  return names
})

export interface ProductPage {
  items: ProductSummary[]
  nextCursor: string | null
}

const PAGE_SIZE = 24
/** The signed cursor is opaque; only its size and alphabet are bounded before it is passed back unchanged. */
const CURSOR = /^[A-Za-z0-9._~:+/=-]{1,1024}$/

export function isCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR.test(value)
}

function parsePage(data: unknown): ProductPage | null {
  const body = data as { items?: unknown; nextCursor?: unknown; hasMore?: unknown } | null
  if (!body || !Array.isArray(body.items)) return null
  const media = serverEnv().media
  const items = body.items
    .map((item) => parseProductSummary(item, media))
    .filter((p): p is ProductSummary => p !== null)
  const nextCursor = body.hasMore === true && isCursor(body.nextCursor) ? body.nextCursor : null
  return { items, nextCursor }
}

/**
 * `GET /v1/categories/{id}/products`. The first page is cached; a cursor page is fetched fresh (cursors are
 * unbounded in number and the backend marks this read `private, no-store`).
 */
export async function getCategoryProducts(
  id: string,
  cursor: string | null,
): Promise<ProductPage | null | 'unavailable'> {
  if (!isNodeId(id)) return null
  const query = new URLSearchParams({ page_size: String(PAGE_SIZE) })
  if (cursor !== null) query.set('cursor', cursor)
  const result = await getJson(`/v1/categories/${encodeURIComponent(id)}/products?${query}`, {
    cache: cursor === null,
  })
  if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
  return parsePage(result.data) ?? 'unavailable'
}

/** `GET /v1/search`, never cached (the backend says so, and queries are customer input). 400 = query not accepted. */
export async function searchProducts(
  q: string,
  cursor: string | null,
): Promise<ProductPage | 'rejected' | 'unavailable'> {
  const query = new URLSearchParams({ q, page_size: String(PAGE_SIZE) })
  if (cursor !== null) query.set('cursor', cursor)
  const result = await getJson(`/v1/search?${query}`, { cache: false })
  if (!result.ok) return result.kind === 'bad_request' ? 'rejected' : 'unavailable'
  return parsePage(result.data) ?? 'unavailable'
}
