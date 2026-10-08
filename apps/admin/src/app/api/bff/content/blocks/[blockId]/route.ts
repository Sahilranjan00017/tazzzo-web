import type { NextRequest } from 'next/server'
import { updateFaqMutation } from '@/server/bff/content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/content/blocks/[blockId]'>,
) {
  const { blockId } = await context.params
  return runBffMutation(updateFaqMutation, request, { blockId })
}
