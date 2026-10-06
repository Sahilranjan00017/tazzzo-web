import type { NextRequest } from 'next/server'
import { putAreaMutation } from '@/server/bff/delivery-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/delivery/service-areas/[pincode]'>,
) {
  const { pincode } = await context.params
  return runBffMutation(putAreaMutation, request, { pincode })
}
