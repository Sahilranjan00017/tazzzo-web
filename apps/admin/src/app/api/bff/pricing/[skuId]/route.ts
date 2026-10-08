import type { NextRequest } from 'next/server'
import { setPriceMutation } from '@/server/bff/commerce-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(request: NextRequest, context: RouteContext<'/api/bff/pricing/[skuId]'>) {
  const { skuId } = await context.params
  return runBffMutation(setPriceMutation, request, { skuId })
}
