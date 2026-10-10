import 'server-only'
import { cache } from 'react'
import { z } from 'zod'
import type { CategoryNode } from '@/lib/categories'
import { parseHome, type HomeBlock, type HomeParseReport } from '@/lib/content/blocks'
import { PRODUCT_ID, isNodeId, isProductId } from '@/lib/ids'
import { isPin } from '@/lib/location/validation'
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
 * 60 s data cache in `client.ts`. Product, list and search reads carry the visitor's `pin` when one is known to be
 * serviceable (`catalogPin()`): the backend then answers stock, serviceability and ETA for it, and the data cache is
 * keyed by the full URL, so it holds one copy per serviceable PIN. Without a PIN the answers are the same for
 * everyone. Home content and category names never carry a location.
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

/** `?pin=` for a canonical PIN, else nothing (any other value never reaches a backend URL). */
function pinQuery(pin: string | null): string {
  return pin !== null && isPin(pin) ? `?pin=${pin}` : ''
}

/** `GET /v1/products/{id}[?pin=]`. Null for a missing/hidden product (one flat 404 by design) or a malformed body. */
export const getProduct = cache(
  async (id: string, pin: string | null = null): Promise<ProductDetail | null | 'unavailable'> => {
    if (!isProductId(id)) return null
    const result = await getJson(`/v1/products/${encodeURIComponent(id)}${pinQuery(pin)}`)
    if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
    return parseProductDetail(result.data, serverEnv().media)
  },
)

/** The backend's cap on ids per `GET /v1/products:batch` (duplicates count; more is a flat 400). */
export const PRODUCT_BATCH_MAX_IDS = 50

/**
 * `ProductBatchResponse` (docs/api/v1/openapi.yaml): only the fields that are read are checked. Cards are parsed one by
 * one afterwards (`parseProductSummary`) so a single malformed card is skipped, like a malformed single read.
 */
const batchBody = z.object({
  resolvedReleaseId: z.string().min(1),
  items: z.array(z.unknown()).max(PRODUCT_BATCH_MAX_IDS),
  missing: z.array(z.string().regex(PRODUCT_ID)).max(PRODUCT_BATCH_MAX_IDS),
})

export type ProductBatchResult =
  | {
      ok: true
      /** Cards in the order the ids were given (first occurrence of a duplicate), without gallery or attributes. */
      items: ProductSummary[]
      /** Ids with no card: invalid ids (never sent), and the backend's `missing` (no reason is ever given). */
      missing: string[]
    }
  | { ok: false; reason: 'unavailable' }

/** One batch request for at most 50 distinct canonical ids. A failed or malformed answer is `null`. */
const fetchBatchChunk = cache(
  async (
    idsKey: string,
    pin: string | null,
  ): Promise<{ cards: ProductSummary[]; missing: string[] } | null> => {
    const ids = idsKey.split(',')
    // Commas and the id alphabet need no escaping (URLSearchParams would send `%2C`, three chars per separator).
    const path = `/v1/products:batch?ids=${idsKey}${pin !== null && isPin(pin) ? `&pin=${pin}` : ''}`
    const result = await getJson(path)
    if (!result.ok) {
      // 400 cannot happen for validated ids (it would mean contract drift); it is not retried with single reads.
      if (result.kind === 'bad_request') console.warn('storefront_backend_batch_rejected')
      return null
    }
    const parsed = batchBody.safeParse(result.data)
    if (!parsed.success) {
      console.warn('storefront_backend_malformed path=/v1/products:batch')
      return null
    }
    const requested = new Set(ids)
    const missing = new Set(parsed.data.missing.filter((id) => requested.has(id)))
    const byId = new Map<string, ProductSummary>()
    const media = serverEnv().media
    for (const raw of parsed.data.items) {
      const card = parseProductSummary(raw, media)
      // Only a card for an id that was asked for, once, and not also reported missing, is ever shown.
      if (card === null || !requested.has(card.productId)) continue
      if (missing.has(card.productId) || byId.has(card.productId)) continue
      byId.set(card.productId, card)
    }
    const cards = ids.flatMap((id) => byId.get(id) ?? [])
    return { cards, missing: ids.filter((id) => !byId.has(id)) }
  },
)

/**
 * `GET /v1/products:batch?ids=&pin=` (operationId `getProductsBatch`): up to 50 product cards in one call.
 *
 * - Ids are validated against the canonical grammar first (`^TZP-[A-Za-z0-9-]{1,40}$`, exact case, nothing folded or
 *   trimmed); an invalid one is never sent (one bad id would make the backend refuse the whole batch) and is reported
 *   in `missing`. Duplicates collapse to their first position; more than 50 distinct ids are split into chunks of 50.
 * - Same transport as every public read (`getJson`: trusted-caller headers, 5 s timeout, 60 s data cache keyed by the
 *   full URL, so one copy per ids list and per serviceable PIN; a non-canonical PIN is dropped, never sent).
 * - Cards equal the single read's minus gallery/attributes. A merged id is NOT followed to its survivor and a missing
 *   id carries no reason (unknown, draft, archived and ineligible look alike).
 * - Any failure (429, 5xx, timeout, network, 400, malformed body) in any chunk is `unavailable` for the whole call. It
 *   is never answered with N single reads: that would defeat the batch's rate-limit cost (1 + distinct ids).
 */
export async function getProductsBatch(
  ids: readonly string[],
  { pin = null }: { pin?: string | null } = {},
): Promise<ProductBatchResult> {
  const valid = [...new Set(ids.filter(isProductId))]
  const invalid = [...new Set(ids.filter((id) => !isProductId(id)))]
  const chunks: string[][] = []
  for (let i = 0; i < valid.length; i += PRODUCT_BATCH_MAX_IDS) {
    chunks.push(valid.slice(i, i + PRODUCT_BATCH_MAX_IDS))
  }
  const answers = await Promise.all(chunks.map((chunk) => fetchBatchChunk(chunk.join(','), pin)))
  const items: ProductSummary[] = []
  const missing: string[] = []
  for (const answer of answers) {
    if (answer === null) return { ok: false, reason: 'unavailable' }
    items.push(...answer.cards)
    missing.push(...answer.missing)
  }
  return { ok: true, items, missing: [...missing, ...invalid] }
}

/**
 * Cards for a product rail, in the rail's order: ONE `getProductsBatch` call per rail (rails hold at most 20 ids), so
 * a rail costs the backend `1 + distinct ids` admission units in a single request instead of 20 single reads.
 * Missing ids (unknown, hidden, merged, invalid) are skipped silently, as failed single reads were. If the batch
 * fails the rail is empty and renders nothing (the same as a rail whose every product failed before); it is never
 * retried as single reads.
 */
export async function getRailProducts(
  ids: string[],
  pin: string | null = null,
): Promise<ProductSummary[]> {
  const result = await getProductsBatch(ids, { pin })
  return result.ok ? result.items : []
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
 * Names for category node ids, one cached `GET /v1/categories/{id}` per distinct id (a grid has at most 12; the backend has no
 * categories batch read, a known N+1 documented in the README). A node
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
  pin: string | null = null,
): Promise<ProductPage | null | 'unavailable' | 'stale_cursor'> {
  if (!isNodeId(id)) return null
  const query = new URLSearchParams({ page_size: String(PAGE_SIZE) })
  if (cursor !== null) query.set('cursor', cursor)
  if (pin !== null && isPin(pin)) query.set('pin', pin)
  const result = await getJson(`/v1/categories/${encodeURIComponent(id)}/products?${query}`, {
    cache: cursor === null,
  })
  // A cursor is bound to the location it started under: after a PIN change the backend refuses it (400).
  if (!result.ok && result.kind === 'bad_request' && cursor !== null) return 'stale_cursor'
  if (!result.ok) return result.kind === 'unavailable' ? 'unavailable' : null
  return parsePage(result.data) ?? 'unavailable'
}

/** `GET /v1/search`, never cached (the backend says so, and queries are customer input). 400 = query not accepted. */
export async function searchProducts(
  q: string,
  cursor: string | null,
  pin: string | null = null,
): Promise<ProductPage | 'rejected' | 'unavailable' | 'stale_cursor'> {
  const query = new URLSearchParams({ q, page_size: String(PAGE_SIZE) })
  if (cursor !== null) query.set('cursor', cursor)
  if (pin !== null && isPin(pin)) query.set('pin', pin)
  const result = await getJson(`/v1/search?${query}`, { cache: false })
  if (!result.ok && result.kind === 'bad_request' && cursor !== null) return 'stale_cursor'
  if (!result.ok) return result.kind === 'bad_request' ? 'rejected' : 'unavailable'
  return parsePage(result.data) ?? 'unavailable'
}
