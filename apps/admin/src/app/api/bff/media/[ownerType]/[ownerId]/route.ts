import type { NextRequest } from 'next/server'
import { putMediaSetMutation } from '@/server/bff/media-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/media/[ownerType]/[ownerId]'>,
) {
  const { ownerType, ownerId } = await context.params
  return runBffMutation(putMediaSetMutation, request, { ownerType, ownerId })
}
