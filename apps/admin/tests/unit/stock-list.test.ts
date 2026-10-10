import { describe, expect, it } from 'vitest'
import {
  MAX_EMPTY_HOPS,
  STOCK_PAGE_SIZE,
  editorHref,
  mergeStockRows,
  parseStockFilters,
  parseStockQuery,
  stockListFailure,
  stockListPath,
  stockPageSchema,
  stockQueryString,
  type StockRow,
} from '@/lib/stock-list'

const row = (sku: string, loc = 'LOC-1'): StockRow => ({
  skuId: sku,
  fulfillmentLocationId: loc,
  onHand: 5,
  reserved: 1,
  available: 4,
  lowStockThreshold: 2,
  maxPurchasable: 9,
  version: 3,
  active: true,
  stockState: 'IN_STOCK',
})

describe('stock list query grammar (mirrors the closed backend grammar)', () => {
  it('page filters drop invalid values instead of sending them', () => {
    expect(parseStockFilters({ location: 'LOC-1', state: 'LOW_STOCK' })).toEqual({
      location: 'LOC-1',
      state: 'LOW_STOCK',
    })
    expect(parseStockFilters({ location: 'bad location!', state: 'low' })).toEqual({})
    expect(parseStockFilters({ location: ['LOC-2', 'LOC-3'], state: [] })).toEqual({
      location: 'LOC-2',
    })
    expect(parseStockFilters({ sku: 'TZP-1', cursor: 'x' })).toEqual({})
  })

  it('the BFF query accepts exactly location, state, limit and cursor, each once and non-empty', () => {
    const ok = parseStockQuery(
      new URLSearchParams('location=LOC-1&state=OUT_OF_STOCK&limit=200&cursor=AbC_-9'),
    )
    expect(ok).toEqual({ location: 'LOC-1', state: 'OUT_OF_STOCK', limit: 200, cursor: 'AbC_-9' })
    expect(parseStockQuery(new URLSearchParams(''))).toEqual({})
    for (const bad of [
      'sku=TZP-1',
      'location=',
      'location=LOC-1&location=LOC-2',
      'state=in_stock',
      'state=ALL',
      'limit=0',
      'limit=201',
      'limit=05',
      'limit=abc',
      'cursor=has space',
      `cursor=${'a'.repeat(1401)}`,
      'page=2',
    ]) {
      expect(parseStockQuery(new URLSearchParams(bad)), bad).toBeUndefined()
    }
  })

  it('builds the backend path with a page size and the cursor only when present', () => {
    expect(stockQueryString({})).toBe(`limit=${STOCK_PAGE_SIZE}`)
    expect(stockListPath({ location: 'LOC-1', state: 'LOW_STOCK', cursor: 'abc' })).toBe(
      '/api/v1/admin/inventory?location=LOC-1&state=LOW_STOCK&limit=50&cursor=abc',
    )
  })
})

describe('stock rows', () => {
  it('parses the real page shape and tolerates a missing cursor', () => {
    expect(stockPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true)
    expect(stockPageSchema.safeParse({ items: [{ ...row('TZP-1') }] }).success).toBe(true)
    expect(stockPageSchema.safeParse({ items: [{ skuId: 'x' }] }).success).toBe(false)
  })

  it('never shows a row twice when a cursor is replayed', () => {
    const a = [row('TZP-1'), row('TZP-2')]
    expect(
      mergeStockRows(a, [row('TZP-2'), row('TZP-3'), row('TZP-2', 'LOC-2')]).map(
        (r) => `${r.skuId}|${r.fulfillmentLocationId}`,
      ),
    ).toEqual(['TZP-1|LOC-1', 'TZP-2|LOC-1', 'TZP-3|LOC-1', 'TZP-2|LOC-2'])
  })

  it('links to the existing per-SKU editor, ids encoded and never case-changed', () => {
    expect(editorHref(row('TZP-med-3', 'LOC:a/b'))).toBe(
      '/inventory?sku=TZP-med-3&location=LOC%3Aa%2Fb',
    )
  })
})

describe('failure wording', () => {
  it('turns the 503 LIST_TIMEOUT into a retry message and leaves nothing of the backend text', () => {
    const f = stockListFailure({ status: 503, code: 'LIST_TIMEOUT' })
    expect(f.retry).toBe(true)
    expect(f.message).toMatch(/took too long/)
    expect(f.message).toMatch(/narrow the list/)
  })
  it('distinguishes network, rate limit, permission, rejected and unknown failures', () => {
    expect(stockListFailure({ status: 0 }).retry).toBe(true)
    expect(stockListFailure({ status: 429, retryAfterSeconds: 7 }).message).toMatch(/7 seconds/)
    expect(stockListFailure({ status: 403 })).toMatchObject({ retry: false })
    expect(stockListFailure({ status: 422 })).toMatchObject({ retry: false })
    expect(stockListFailure({ status: 401 })).toMatchObject({ retry: false })
    expect(stockListFailure({ status: 502 }).retry).toBe(true)
    expect(stockListFailure({ status: 503 }).message).not.toMatch(/timed out|too long/)
  })
  it('bounds how many empty pages one click follows', () => {
    expect(MAX_EMPTY_HOPS).toBeGreaterThan(1)
    expect(MAX_EMPTY_HOPS).toBeLessThanOrEqual(25)
  })
})
