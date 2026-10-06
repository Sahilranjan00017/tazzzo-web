import type { Metadata } from 'next'
import { OrderListView } from '@/components/orders/OrderListView'
import { parseOrderListQuery } from '@/lib/orders'
import { readOrders } from '@/server/backend/orders'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Orders · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const query = parseOrderListQuery(await searchParams)
  return <OrderListView result={await readOrders(query)} query={query} />
}
