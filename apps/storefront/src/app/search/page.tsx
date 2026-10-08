import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductGrid } from '@/components/ProductGrid'
import { Unavailable } from '@/components/Unavailable'
import { isCursor, searchProducts } from '@/server/backend/catalog'

const MIN_QUERY = 2
const MAX_QUERY = 64

function firstString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** The query as typed, trimmed and whitespace-collapsed; null when it cannot be a valid backend query. */
function normalise(raw: string | null): string | null {
  if (raw === null) return null
  const q = raw.replace(/\s+/g, ' ').trim()
  return q.length >= MIN_QUERY && q.length <= MAX_QUERY ? q : null
}

export async function generateMetadata({ searchParams }: PageProps<'/search'>): Promise<Metadata> {
  const q = normalise(firstString((await searchParams).q))
  return {
    title: q ? `Search: ${q}` : 'Search',
    alternates: { canonical: '/search' },
    robots: { index: false, follow: true },
  }
}

/**
 * Search via `GET /v1/search` (every word prefix-matches a product title or brand; results in id order, not by
 * relevance). Never cached: queries are customer input. A query the backend rejects gets a hint, not an error page.
 */
export default async function SearchPage({ searchParams }: PageProps<'/search'>) {
  const params = await searchParams
  const raw = firstString(params.q)
  const q = normalise(raw)
  const rawCursor = firstString(params.cursor)
  const cursor = isCursor(rawCursor) ? rawCursor : null
  const result = q ? await searchProducts(q, cursor) : null
  return (
    <section className="listing" aria-labelledby="search-title">
      <h1 id="search-title">{q ? `Results for “${q}”` : 'Search'}</h1>
      {q === null && (
        <p>
          {raw
            ? 'Search needs 2 to 64 characters.'
            : 'Type at least two letters to search for products.'}
        </p>
      )}
      {result === 'rejected' && (
        <p role="status">
          We couldn&apos;t search for that. Use up to five words of 2 to 32 letters or digits each.
        </p>
      )}
      {result === 'unavailable' && <Unavailable what="search results" />}
      {result !== null && result !== 'rejected' && result !== 'unavailable' && (
        <>
          {result.items.length === 0 ? (
            <p role="status">No products match “{q}”.</p>
          ) : (
            <ProductGrid products={result.items} label={`Results for ${q}`} />
          )}
          {result.nextCursor && q && (
            <p className="pager">
              <Link href={`/search?${new URLSearchParams({ q, cursor: result.nextCursor })}`}>
                More results
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  )
}
