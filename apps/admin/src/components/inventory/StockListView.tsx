import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { PageHeader } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import {
  STOCK_STATES,
  STOCK_STATE_LABEL,
  stockListFailure,
  type StockListState,
  type StockPage,
} from '@/lib/stock-list'
import { StockList } from './StockList'

type Result = Exclude<BackendReadResult<StockPage>, { kind: 'unauthenticated' }>

/** Failure copy for the first page, by outcome; the 503 LIST_TIMEOUT case reads as "try again", never as "unavailable". */
function failureOf(result: Exclude<Result, { kind: 'ok' }>): {
  heading: string
  message: string
  retry: boolean
} {
  if (result.kind === 'forbidden')
    return {
      heading: 'Not permitted',
      message: stockListFailure({ status: 403 }).message,
      retry: false,
    }
  if (result.kind === 'rate_limited')
    return {
      heading: 'Too many requests',
      message: stockListFailure({ status: 429, retryAfterSeconds: result.retryAfterSeconds })
        .message,
      retry: true,
    }
  if (result.kind === 'unavailable' && result.httpStatus === 503 && result.code === 'LIST_TIMEOUT')
    return {
      heading: 'The stock list timed out',
      message: stockListFailure({ status: 503, code: 'LIST_TIMEOUT' }).message,
      retry: true,
    }
  if (result.kind === 'unavailable' && result.httpStatus === 422)
    return {
      heading: 'Filters not accepted',
      message: stockListFailure({ status: 422 }).message,
      retry: false,
    }
  return {
    heading: 'Stock list unavailable',
    message:
      result.kind === 'unavailable' && result.reason === 'shape'
        ? 'The backend answered in an unexpected format, so it was not displayed.'
        : 'The backend could not return the stock list. Nothing is shown rather than partial data.',
    retry: true,
  }
}

export function StockListView({
  result,
  filters,
  canWrite,
}: {
  result: Result
  filters: { location?: string; state?: StockListState }
  canWrite: boolean
}) {
  const filtered = Boolean(filters.location || filters.state)
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock per product and fulfilment location, in product then location order. Open a row to see or change that record."
      />
      <form method="get" className="filters" aria-label="Stock list filters">
        <label>
          Filter by location id
          <input name="location" defaultValue={filters.location ?? ''} maxLength={128} />
        </label>
        <label>
          State
          <select name="state" defaultValue={filters.state ?? ''}>
            <option value="">All</option>
            {STOCK_STATES.map((s) => (
              <option key={s} value={s}>
                {STOCK_STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn">
          Apply
        </button>
        {filtered ? (
          <Link href="/inventory" className="btn">
            Clear filters
          </Link>
        ) : null}
      </form>
      <p className="muted">
        The backend filters by location and stock state only; there is no product search. To open
        one record, enter both ids:
      </p>
      <form method="get" className="filters" aria-label="Open a stock record">
        <label>
          Product id
          <input name="sku" placeholder="TZP-…" maxLength={48} />
        </label>
        <label>
          Location of the record
          <input name="location" defaultValue={filters.location ?? ''} maxLength={128} />
        </label>
        <button type="submit" className="btn">
          Open record
        </button>
      </form>
      {!canWrite ? (
        <p className="notice" role="note">
          Read-only: changing stock needs the cms-writer role.
        </p>
      ) : null}
      {result.kind === 'ok' ? (
        <StockList
          key={`${filters.location ?? ''}|${filters.state ?? ''}`}
          initial={result.data}
          filters={filters}
          canWrite={canWrite}
        />
      ) : (
        (() => {
          const f = failureOf(result)
          const trace = 'backendRequestId' in result ? result.backendRequestId : undefined
          return (
            <div className="panel panel-error" role="alert">
              <h2>{f.heading}</h2>
              <p>{f.message}</p>
              {trace ? <p className="muted">Reference: {trace}</p> : null}
              {f.retry ? <RefreshButton label="Try again" /> : null}
            </div>
          )
        })()
      )}
    </>
  )
}
