import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { OrderDetailView } from '@/components/orders/OrderDetailView'
import { ORDER_ID } from '@/lib/orders'
import { canOperateOrders } from '@/lib/roles'
import { readOrder } from '@/server/backend/orders'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Order · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  if (!ORDER_ID.test(orderId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return <OrderDetailView result={await readOrder(orderId)} canOperate={canOperateOrders(roles)} />
}
