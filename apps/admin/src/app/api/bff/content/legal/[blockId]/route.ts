import type { NextRequest } from 'next/server'
import { updateLegalMutation } from '@/server/bff/content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/content/legal/[blockId]'>,
) {
  const { blockId } = await context.params
  return runBffMutation(updateLegalMutation, request, { blockId })
}
