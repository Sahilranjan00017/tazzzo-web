import type { NextRequest } from 'next/server'
import { blockStatusMutation } from '@/server/bff/content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/content/blocks/[blockId]/status'>,
) {
  const { blockId } = await context.params
  return runBffMutation(blockStatusMutation, request, { blockId })
}
