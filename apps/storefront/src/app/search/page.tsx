import type { Metadata } from 'next'
import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ProductGrid } from '@/components/ProductGrid'
import { PageSkeleton } from '@/components/Skeleton'
import { HelpfulLinks } from '@/components/StaticPageNav'
import { PopularCategories } from '@/app/_sections/PopularCategories'
import { Unavailable } from '@/components/Unavailable'
import { isCursor, searchProducts } from '@/server/backend/catalog'
import { catalogPin } from '@/server/location/service'

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

async function SearchResults({ q, cursor }: { q: string; cursor: string | null }) {
  const result = await searchProducts(q, cursor, await catalogPin())
  // The delivery location changed since this page was opened: its cursor no longer fits, start again.
  if (result === 'stale_cursor') redirect(`/search?${new URLSearchParams({ q })}`)
  if (result === 'rejected') {
    return (
      <>
        <p role="status">
          We couldn&apos;t search for that. Use up to five words of 2 to 32 letters or digits each.
        </p>
        <HelpfulLinks search />
      </>
    )
  }
  if (result === 'unavailable') return <Unavailable what="search results" />
  return (
    <>
      {result.items.length === 0 ? (
        <>
          <p role="status">No products match “{q}”.</p>
          <p>Check the spelling, or try fewer or more general words.</p>
          <HelpfulLinks search />
          <PopularCategories />
        </>
      ) : (
        <ProductGrid products={result.items} label={`Results for ${q}`} />
      )}
      {result.nextCursor && (
        <p className="pager">
          <Link href={`/search?${new URLSearchParams({ q, cursor: result.nextCursor })}`}>
            More results
          </Link>
        </p>
      )}
    </>
  )
}

/**
 * Search via `GET /v1/search` (every word prefix-matches a product title or brand; results in id order, not by
 * relevance). Never cached: queries are customer input. A query the backend rejects gets a hint, not an error page.
 * The heading renders at once and the results stream in behind a skeleton (a route-level `loading.tsx` is not used:
 * see docs/storefront/LAUNCH_SCOPE.md).
 */
export default async function SearchPage({ searchParams }: PageProps<'/search'>) {
  const params = await searchParams
  const raw = firstString(params.q)
  const q = normalise(raw)
  const rawCursor = firstString(params.cursor)
  const cursor = isCursor(rawCursor) ? rawCursor : null
  return (
    <section className="listing" aria-labelledby="search-title">
      <h1 id="search-title">{q ? `Results for “${q}”` : 'Search'}</h1>
      {q === null ? (
        <>
          <p>
            {raw
              ? 'Search needs 2 to 64 characters.'
              : 'Type at least two letters to search for products.'}
          </p>
          <HelpfulLinks />
          <PopularCategories />
        </>
      ) : (
        <Suspense
          key={`${q}|${cursor ?? ''}`}
          fallback={<PageSkeleton label="Searching" titleBar={false} />}
        >
          <SearchResults q={q} cursor={cursor} />
        </Suspense>
      )}
    </section>
  )
}
