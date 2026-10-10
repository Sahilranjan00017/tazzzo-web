'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBadge } from '@/components/ui/primitives'
import { getBff } from '@/lib/bff-client'
import {
  MAX_EMPTY_HOPS,
  STOCK_STATE_LABEL,
  STOCK_STATE_TONE,
  editorHref,
  mergeStockRows,
  stockListFailure,
  stockPageSchema,
  stockQueryString,
  type StockListState,
  type StockPage,
  type StockRow,
} from '@/lib/stock-list'

type Filters = { location?: string; state?: StockListState }

/**
 * The stock list with keyset "Load more". The first page is read on the server; later pages come through the BFF read
 * route with the backend's opaque cursor. A page can be short or EMPTY and still carry a cursor (the backend leaves out
 * corrupt rows after reading the page), so an empty answer is followed automatically (bounded) and the end is only ever
 * a null cursor. A failed page (including a 503 LIST_TIMEOUT) keeps every row already shown and offers a retry of that
 * same page; nothing is retried automatically.
 */
export function StockList({
  initial,
  filters,
  canWrite,
}: {
  initial: StockPage
  filters: Filters
  canWrite: boolean
}) {
  const router = useRouter()
  const [rows, setRows] = useState<StockRow[]>(initial.items)
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor ?? null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ message: string; retry: boolean }>()
  const [note, setNote] = useState('')
  const focusFrom = useRef<number>(undefined)
  const table = useRef<HTMLTableElement>(null)
  const alive = useRef(true)
  const auto = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (cursor === null) return
    setLoading(true)
    setFailure(undefined)
    setNote('')
    let at: string | null = cursor
    let current = rows
    const before = rows.length
    for (let hop = 0; hop < MAX_EMPTY_HOPS && at !== null; hop++) {
      const result = await getBff<unknown>(
        `/api/bff/inventory/stock?${stockQueryString({ ...filters, cursor: at })}`,
      )
      if (!alive.current) return
      if (!result.ok) {
        if (result.status === 401) {
          router.replace('/login?error=expired')
          router.refresh()
          return
        }
        setFailure(stockListFailure(result))
        break
      }
      const page = stockPageSchema.safeParse(result.data)
      if (!page.success) {
        setFailure({ message: 'The stock list answered in an unexpected format.', retry: true })
        break
      }
      const merged = mergeStockRows(current, page.data.items)
      const gained = merged.length - current.length
      current = merged
      at = page.data.nextCursor ?? null
      setRows(merged)
      setCursor(at)
      if (gained > 0) break
    }
    const gained = current.length - before
    if (gained > 0) {
      focusFrom.current = before
      setNote(`Loaded ${gained} more row${gained === 1 ? '' : 's'}.`)
    } else if (at === null) setNote('No more rows.')
    else setNote('No rows in this stretch of the list; choose Load more to keep looking.')
    setLoading(false)
  }, [cursor, rows, filters, router])

  // An empty first page can still have a next page: follow it once, without a click.
  useEffect(() => {
    if (auto.current || initial.items.length > 0 || cursor === null) return
    auto.current = true
    void loadMore()
  }, [initial.items.length, cursor, loadMore])

  // Keyboard users keep their place: focus moves to the first newly loaded row.
  useEffect(() => {
    if (focusFrom.current === undefined) return
    table.current?.querySelectorAll<HTMLAnchorElement>('tbody th a')[focusFrom.current]?.focus()
    focusFrom.current = undefined
  }, [rows])

  const verb = canWrite ? 'Edit' : 'View'
  return (
    <div className="stack">
      {rows.length === 0 ? (
        loading ? (
          <p role="status">Loading stock…</p>
        ) : cursor === null ? (
          <div className="empty">
            <h2>No stock records</h2>
            <p className="muted">
              {filters.location || filters.state
                ? 'No stock record matches these filters.'
                : 'The backend reports no stock records yet.'}
            </p>
          </div>
        ) : null
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Stock table">
          <table className="data-table" ref={table}>
            <caption className="sr-only">
              {rows.length} stock records, ordered by product then location
            </caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Location</th>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  On hand
                </th>
                <th scope="col" className="num">
                  Reserved
                </th>
                <th scope="col" className="num">
                  Available
                </th>
                <th scope="col" className="num">
                  Low-stock at
                </th>
                <th scope="col" className="num">
                  Max per order
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.skuId}|${r.fulfillmentLocationId}`}>
                  <th scope="row">
                    <Link
                      href={editorHref(r)}
                      aria-label={`${verb} stock for ${r.skuId} at ${r.fulfillmentLocationId}`}
                    >
                      {r.skuId}
                    </Link>
                  </th>
                  <td>
                    <code>{r.fulfillmentLocationId}</code>
                  </td>
                  <td>
                    <StatusBadge tone={STOCK_STATE_TONE[r.stockState] ?? 'neutral'}>
                      {STOCK_STATE_LABEL[r.stockState] ?? r.stockState}
                    </StatusBadge>
                  </td>
                  <td className="num">{r.onHand}</td>
                  <td className="num">{r.reserved}</td>
                  <td className="num">{r.available}</td>
                  <td className="num">{r.lowStockThreshold}</td>
                  <td className="num">{r.maxPurchasable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure ? (
        <div className="panel panel-error" role="alert">
          <p>{failure.message}</p>
          {failure.retry ? (
            <button
              type="button"
              className="btn"
              onClick={() => void loadMore()}
              disabled={loading}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="pager">
        {cursor !== null && !(failure && !failure.retry) ? (
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        ) : rows.length > 0 ? (
          <span className="muted">End of the list: {rows.length} records.</span>
        ) : null}
        <span role="status" className="muted">
          {note}
        </span>
      </div>
    </div>
  )
}
