import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import { LOCATION_ID } from './commerce'

/**
 * Stock list contract (backend `InventoryAdminListController`, operationId `listStock`):
 * `GET /api/v1/admin/inventory?location=&state=&limit=&cursor=`. Client-safe.
 *
 * The query grammar is CLOSED on the backend: only these four names, each at most once and never empty; a typo is refused
 * (422 INVALID_INVENTORY), never ignored. Rows come in (skuId, locationId) order with an opaque keyset cursor. There is no
 * product-id search and no location registry. A page can be SHORT or EMPTY and still carry a `nextCursor` (rows that break
 * the stock-record invariants are left out after the page is read), so a client keeps following the cursor until it is null.
 */
export const STOCK_STATES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'INACTIVE'] as const
export type StockListState = (typeof STOCK_STATES)[number]

export const STOCK_STATE_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock',
  LOW_STOCK: 'Low stock',
  OUT_OF_STOCK: 'Out of stock',
  INACTIVE: 'Inactive',
}
export const STOCK_STATE_TONE: Record<string, Tone> = {
  IN_STOCK: 'success',
  LOW_STOCK: 'warning',
  OUT_OF_STOCK: 'danger',
  INACTIVE: 'neutral',
}

export const STOCK_PAGE_SIZE = 50
export const STOCK_MAX_LIMIT = 200
/** Opaque base64url cursor; the backend refuses anything longer than 1,400 characters. */
export const STOCK_CURSOR = /^[A-Za-z0-9_-]{1,1400}$/
/** An empty/short page with a cursor is followed automatically, but never more than this many hops in one click. */
export const MAX_EMPTY_HOPS = 10

export const stockRowSchema = z.object({
  skuId: z.string(),
  fulfillmentLocationId: z.string(),
  onHand: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  lowStockThreshold: z.number().int(),
  maxPurchasable: z.number().int(),
  version: z.number().int(),
  active: z.boolean(),
  stockState: z.string(),
})
export type StockRow = z.infer<typeof stockRowSchema>

export const stockPageSchema = z.object({
  items: z.array(stockRowSchema),
  nextCursor: z.string().nullish(),
})
export type StockPage = z.infer<typeof stockPageSchema>

export interface StockQuery {
  location?: string
  state?: StockListState
  cursor?: string
  limit?: number
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

/** Page `?location=&state=` filters: invalid values are dropped, never sent (the backend refuses unknown input). */
export function parseStockFilters(raw: Raw): { location?: string; state?: StockListState } {
  const location = first(raw.location)
  const state = first(raw.state)
  return {
    ...(location && LOCATION_ID.test(location) ? { location } : {}),
    ...(state && (STOCK_STATES as readonly string[]).includes(state)
      ? { state: state as StockListState }
      : {}),
  }
}

/** Strict parse of the BFF query: `undefined` when it carries an unknown or malformed parameter (answered 400). */
export function parseStockQuery(params: URLSearchParams): StockQuery | undefined {
  const query: StockQuery = {}
  const seen = new Set<string>()
  for (const [name, value] of params) {
    if (seen.has(name) || value === '') return undefined
    seen.add(name)
    if (name === 'location') {
      if (!LOCATION_ID.test(value)) return undefined
      query.location = value
    } else if (name === 'state') {
      if (!(STOCK_STATES as readonly string[]).includes(value)) return undefined
      query.state = value as StockListState
    } else if (name === 'cursor') {
      if (!STOCK_CURSOR.test(value)) return undefined
      query.cursor = value
    } else if (name === 'limit') {
      if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > STOCK_MAX_LIMIT) return undefined
      query.limit = Number(value)
    } else return undefined
  }
  return query
}

export function stockQueryString(q: StockQuery): string {
  const p = new URLSearchParams()
  if (q.location) p.set('location', q.location)
  if (q.state) p.set('state', q.state)
  p.set('limit', String(q.limit ?? STOCK_PAGE_SIZE))
  if (q.cursor) p.set('cursor', q.cursor)
  return p.toString()
}

export const stockListPath = (q: StockQuery) => `/api/v1/admin/inventory?${stockQueryString(q)}`

/** Rows already shown are never shown twice (a cursor replayed after a retry cannot duplicate a row). */
export function mergeStockRows(current: readonly StockRow[], incoming: readonly StockRow[]) {
  const seen = new Set(current.map((r) => `${r.skuId}|${r.fulfillmentLocationId}`))
  return [...current, ...incoming.filter((r) => !seen.has(`${r.skuId}|${r.fulfillmentLocationId}`))]
}

export const editorHref = (r: Pick<StockRow, 'skuId' | 'fulfillmentLocationId'>) =>
  `/inventory?sku=${encodeURIComponent(r.skuId)}&location=${encodeURIComponent(r.fulfillmentLocationId)}`

/** Operator wording for a failed stock-list read. Never includes backend messages. */
export function stockListFailure(failure: {
  status: number
  code?: string
  retryAfterSeconds?: number
}): { message: string; retry: boolean } {
  if (failure.status === 503 && failure.code === 'LIST_TIMEOUT')
    return {
      message:
        'The stock list took too long to read and was stopped. Nothing is wrong with the rows already shown. Try again, or narrow the list with a location or state filter.',
      retry: true,
    }
  switch (failure.status) {
    case 0:
      return {
        message: 'Could not reach the CMS. Check your connection and try again.',
        retry: true,
      }
    case 400:
    case 422:
      return {
        message: 'The backend did not accept this list request. Reload the page to start again.',
        retry: false,
      }
    case 401:
      return { message: 'Your session has ended. Please sign in again.', retry: false }
    case 403:
      return {
        message: 'Your roles cannot read stock. The backend allows it for reader and cms-writer.',
        retry: false,
      }
    case 429:
      return {
        message: failure.retryAfterSeconds
          ? `Too many requests. Try again in ${failure.retryAfterSeconds} seconds.`
          : 'Too many requests. Try again shortly.',
        retry: true,
      }
    default:
      return {
        message: 'The stock list could not be read right now. Try again in a moment.',
        retry: true,
      }
  }
}
