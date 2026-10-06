import type { Metadata } from 'next'
import { ProductListView } from '@/components/products/ProductListView'
import { parseProductListQuery } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { readProductList } from '@/server/backend/products'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Products · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const { query, problems } = parseProductListQuery(await searchParams)
  return (
    <ProductListView
      result={await readProductList(query)}
      query={query}
      problems={problems}
      canWrite={canWrite(roles)}
    />
  )
}
