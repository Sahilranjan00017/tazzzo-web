import type { NextRequest } from 'next/server'
import { updateHomeBlockMutation } from '@/server/bff/home-content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/content/home/blocks/[blockId]'>,
) {
  const { blockId } = await context.params
  return runBffMutation(updateHomeBlockMutation, request, { blockId })
}
