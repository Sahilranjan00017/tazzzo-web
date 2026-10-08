import 'server-only'
import { cache } from 'react'
import type { CategoryNode } from '@/lib/categories'
import { parseHomeBlocks, type HomeBlock } from '@/lib/content/blocks'
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
    try {
      return { ok: true, blocks: parseHomeBlocks(result.data, serverEnv().media) }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  },
)

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

/** `GET /v1/categories`: consumer-visible super-categories. */
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
 * Names for category node ids. The public API has no "node by id" read, so names come from the super-category list
 * and, only when needed, from those super-categories' immediate children. Deeper nodes stay unnamed (a backend gap):
 * callers skip them or fall back to a generic label.
 */
export const resolveCategoryNames = cache(async (idsKey: string): Promise<Map<string, string>> => {
  const wanted = new Set(idsKey.split(',').filter(isNodeId))
  const names = new Map<string, string>()
  const roots = await getRootCategories()
  if (roots === 'unavailable') return names
  for (const node of roots) if (wanted.has(node.id)) names.set(node.id, node.name)
  if ([...wanted].every((id) => names.has(id))) return names
  const levels = await Promise.all(roots.map((root) => getChildCategories(root.id)))
  for (const level of levels) {
    if (!Array.isArray(level)) continue
    for (const node of level) if (wanted.has(node.id)) names.set(node.id, node.name)
  }
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
