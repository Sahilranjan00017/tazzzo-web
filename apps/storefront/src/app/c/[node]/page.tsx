import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ProductGrid } from '@/components/ProductGrid'
import { Unavailable } from '@/components/Unavailable'
import { isNodeId } from '@/lib/ids'
import {
  getCategory,
  getCategoryProducts,
  getChildCategories,
  isCursor,
} from '@/server/backend/catalog'

function firstString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** The node's own name from `GET /v1/categories/{id}` (any depth); null when it cannot be read. */
async function categoryName(id: string): Promise<string | null> {
  const node = await getCategory(id)
  return node !== null && node !== 'unavailable' ? node.name : null
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps<'/c/[node]'>): Promise<Metadata> {
  const { node } = await params
  if (!isNodeId(node)) return { title: 'Category' }
  const cursor = firstString((await searchParams).cursor)
  const name = await categoryName(node)
  return {
    title: name ?? 'Category',
    alternates: { canonical: `/c/${node}` },
    // Later pages are reachable but not separate search results.
    robots: cursor ? { index: false, follow: true } : undefined,
  }
}

/**
 * Category browse: `GET /v1/categories/{id}` (title), `GET /v1/categories/{id}/children` (sub-category links) and
 * `GET /v1/categories/{id}/products` (cursor-paged cards). A node the backend does not show (404 on children and
 * products) is a 404 here.
 */
export default async function CategoryPage({ params, searchParams }: PageProps<'/c/[node]'>) {
  const { node } = await params
  if (!isNodeId(node)) notFound()
  const rawCursor = firstString((await searchParams).cursor)
  const cursor = isCursor(rawCursor) ? rawCursor : null
  const [name, children, page] = await Promise.all([
    categoryName(node),
    getChildCategories(node),
    getCategoryProducts(node, cursor),
  ])
  if (children === null && page === null) notFound()
  return (
    <section className="listing" aria-labelledby="category-title">
      <h1 id="category-title">{name ?? 'Category'}</h1>
      {Array.isArray(children) && children.length > 0 && (
        <nav aria-label="Sub-categories">
          <ul className="chips">
            {children.map((child) => (
              <li key={child.id}>
                <Link href={`/c/${encodeURIComponent(child.id)}`} className="chip">
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {page === 'unavailable' && <Unavailable what="these products" />}
      {page !== null && page !== 'unavailable' && (
        <>
          {page.items.length === 0 ? (
            <p>No products here yet.</p>
          ) : (
            <ProductGrid products={page.items} label={`Products in ${name ?? 'this category'}`} />
          )}
          {page.nextCursor && (
            <p className="pager">
              <Link href={`/c/${node}?${new URLSearchParams({ cursor: page.nextCursor })}`}>
                More products
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  )
}
