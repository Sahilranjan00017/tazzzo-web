import type { Metadata } from 'next'
import { InventoryView } from '@/components/inventory/InventoryView'
import { StockListView } from '@/components/inventory/StockListView'
import { LOCATION_ID } from '@/lib/commerce'
import { PRODUCT_ID } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { parseStockFilters } from '@/lib/stock-list'
import { readInventory, readStockList } from '@/server/backend/commerce'
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
  const sku = one(raw.sku)
  const location = one(raw.location)
  const writer = canWrite(roles)
  if (!sku) {
    const filters = parseStockFilters(raw)
    // a filter that was in the URL but is not valid is dropped, and the person is told rather than shown a silent change
    const dropped = [
      ...(one(raw.location) && !filters.location ? ['location'] : []),
      ...(one(raw.state) && !filters.state ? ['state'] : []),
    ]
    return (
      <StockListView
        result={await readStockList(filters)}
        filters={filters}
        canWrite={writer}
        dropped={dropped}
      />
    )
  }
  if (!location || !PRODUCT_ID.test(sku) || !LOCATION_ID.test(location)) {
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
