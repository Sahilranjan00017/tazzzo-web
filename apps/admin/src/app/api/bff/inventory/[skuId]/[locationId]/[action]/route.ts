import { NextResponse, type NextRequest } from 'next/server'
import {
  INVENTORY_ACTIONS,
  inventoryToggleMutation,
  type InventoryAction,
} from '@/server/bff/commerce-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/inventory/[skuId]/[locationId]/[action]'>,
) {
  const { skuId, locationId, action } = await context.params
  if (!(INVENTORY_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(inventoryToggleMutation(action as InventoryAction), request, {
    skuId,
    locationId,
  })
}
