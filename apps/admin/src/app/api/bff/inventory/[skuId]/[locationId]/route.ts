import type { NextRequest } from 'next/server'
import { setInventoryMutation } from '@/server/bff/commerce-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/inventory/[skuId]/[locationId]'>,
) {
  const { skuId, locationId } = await context.params
  return runBffMutation(setInventoryMutation, request, { skuId, locationId })
}
