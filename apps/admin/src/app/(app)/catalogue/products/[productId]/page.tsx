import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ProductDetailView } from '@/components/products/ProductDetailView'
import { PRODUCT_ID } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { readProduct } from '@/server/backend/products'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Product · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ProductPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params
  if (!PRODUCT_ID.test(productId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return <ProductDetailView result={await readProduct(productId)} canWrite={canWrite(roles)} />
}
