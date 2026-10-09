import type { Metadata } from 'next'
import { PricingView } from '@/components/pricing/PricingView'
import { PRODUCT_ID } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { readPrice } from '@/server/backend/commerce'
import { readProduct } from '@/server/backend/products'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Pricing · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = (await searchParams).sku
  const sku = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!sku) return <PricingView canWrite={canWrite(roles)} />
  if (!PRODUCT_ID.test(sku)) {
    return <PricingView canWrite={canWrite(roles)} invalidInput />
  }
  const [product, price] = await Promise.all([readProduct(sku), readPrice(sku)])
  return <PricingView sku={sku} product={product} price={price} canWrite={canWrite(roles)} />
}
