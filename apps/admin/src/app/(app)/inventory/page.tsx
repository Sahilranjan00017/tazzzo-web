import type { Metadata } from 'next'
import { InventoryView } from '@/components/inventory/InventoryView'
import { LOCATION_ID } from '@/lib/commerce'
import { PRODUCT_ID } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { readInventory } from '@/server/backend/commerce'
import { readProduct } from '@/server/backend/products'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Inventory · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = await searchParams
  const sku = one(raw.sku)?.toUpperCase()
  const location = one(raw.location)
  const writer = canWrite(roles)
  if (!sku && !location) return <InventoryView canWrite={writer} />
  if (!sku || !location || !PRODUCT_ID.test(sku) || !LOCATION_ID.test(location)) {
    return <InventoryView canWrite={writer} invalidInput />
  }
  const [product, stock] = await Promise.all([readProduct(sku), readInventory(sku, location)])
  return (
    <InventoryView
      sku={sku}
      location={location}
      product={product}
      stock={stock}
      canWrite={writer}
    />
  )
}
