import 'server-only'
import {
  ORDER_ID,
  orderListPath,
  orderListSchema,
  staffOrderSchema,
  type OrderListQuery,
} from '@/lib/orders'
import { readAsAdmin } from './session-read'

export const readOrders = (q: OrderListQuery) => readAsAdmin(orderListPath(q), orderListSchema)
export function readOrder(id: string) {
  if (!ORDER_ID.test(id)) throw new Error('invalid order id')
  return readAsAdmin(`/api/v1/admin/orders/${encodeURIComponent(id)}`, staffOrderSchema)
}
