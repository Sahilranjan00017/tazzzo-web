import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import {
  CLASSIFICATION_STATUSES,
  LIFECYCLES,
  LIFECYCLE_TONE,
  filterSearch,
  realValue,
  type ProductListQuery,
  type ProductSummary,
} from '@/lib/products'
import { OpenById } from './OpenById'

export type ProductListResult = Exclude<
  BackendReadResult<{ items: ProductSummary[]; nextCursor?: string | null }>,
  { kind: 'unauthenticated' }
>

/**
 * Server-rendered, bookmarkable product list. Paging is the backend's cursor (no totals, no text search exist, and
 * none is faked). Filters are plain GET parameters, so every view has a URL.
 */
export function ProductListView({
  result,
  query,
  problems,
  canWrite,
}: {
  result: ProductListResult
  query: ProductListQuery
  problems: string[]
  canWrite: boolean
}) {
  const header = (
    <PageHeader
      title="Products"
      description="Catalogue products from the backend, in id order. The backend has no text search; filter by vertical, or open a product by its id."
      actions={
        canWrite ? (
          <Link href="/catalogue/products/new" className="btn btn-primary">
            New product
          </Link>
        ) : undefined
      }
    />
  )
  const filters = (
    <form method="get" className="filters" aria-label="Product filters">
      <label>
        Vertical id
        <input name="verticalId" defaultValue={query.verticalId ?? ''} maxLength={64} />
      </label>
      <label>
        Lifecycle
        <select name="lifecycle" defaultValue={query.lifecycle ?? ''}>
          <option value="">Any</option>
          {LIFECYCLES.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Classification
        <select name="status" defaultValue={query.status ?? ''}>
          <option value="">Any</option>
          {CLASSIFICATION_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn">
        Apply
      </button>
      {query.verticalId ? (
        <Link href="/catalogue/products" className="btn">
          Clear
        </Link>
      ) : null}
    </form>
  )

  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="Products"
          subject="Products"
          forbiddenMessage="Your roles cannot read the catalogue. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const { items, nextCursor } = result.data
  const base = filterSearch(query)
  const nextHref = nextCursor
    ? `/catalogue/products?${base ? `${base}&` : ''}cursor=${encodeURIComponent(nextCursor)}`
    : undefined
  return (
    <>
      {header}
      <OpenById />
      {filters}
      {problems.map((p) => (
        <p key={p} className="notice" role="status">
          {p}
        </p>
      ))}
      {items.length === 0 ? (
        <EmptyState
          title="No products"
          message={
            query.verticalId || query.cursor
              ? 'No products match this view.'
              : 'The backend reports no products yet.'
          }
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Products table">
          <table className="data-table">
            <caption className="sr-only">
              {items.length} products{query.cursor ? ' (continued page)' : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Product id</th>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Lifecycle</th>
                <th scope="col">Brand</th>
                <th scope="col">Vertical</th>
                <th scope="col">Classification</th>
                <th scope="col" className="num">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <Link href={`/catalogue/products/${encodeURIComponent(p.id)}`}>{p.id}</Link>
                  </th>
                  <td>{p.title}</td>
                  <td>{p.productType}</td>
                  <td>
                    <StatusBadge tone={LIFECYCLE_TONE[p.lifecycle] ?? 'neutral'}>
                      {p.lifecycle}
                    </StatusBadge>
                  </td>
                  <td>{realValue(p.brandCode) ?? '—'}</td>
                  <td>{realValue(p.verticalId) ?? '—'}</td>
                  <td>{realValue(p.classificationStatus) ?? '—'}</td>
                  <td className="num">{p.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.cursor ? (
          <Link href={`/catalogue/products${base ? `?${base}` : ''}`} className="btn">
            First page
          </Link>
        ) : null}
        {nextHref ? (
          <Link href={nextHref} className="btn" rel="next">
            Next page
          </Link>
        ) : (
          <span className="muted">{items.length > 0 ? 'End of list.' : ''}</span>
        )}
      </nav>
    </>
  )
}
