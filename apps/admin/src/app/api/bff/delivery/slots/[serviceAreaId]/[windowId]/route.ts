import type { NextRequest } from 'next/server'
import { putWindowMutation } from '@/server/bff/delivery-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/delivery/slots/[serviceAreaId]/[windowId]'>,
) {
  const { serviceAreaId, windowId } = await context.params
  return runBffMutation(putWindowMutation, request, { serviceAreaId, windowId })
}
