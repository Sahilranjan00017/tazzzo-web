import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { publishReleaseMutation } from '@/server/bff/taxonomy-actions'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/catalog/taxonomy/releases/[releaseId]/publish'>,
) {
  const { releaseId } = await context.params
  return runBffMutation(publishReleaseMutation, request, { releaseId })
}
