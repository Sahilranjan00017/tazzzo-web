import type { NextRequest } from 'next/server'
import { orderTransitionMutation } from '@/server/bff/order-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/orders/[orderId]/transition'>,
) {
  const { orderId } = await context.params
  return runBffMutation(orderTransitionMutation, request, { orderId })
}
