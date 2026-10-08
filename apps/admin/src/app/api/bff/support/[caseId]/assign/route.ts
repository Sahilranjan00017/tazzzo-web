import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { assignMutation } from '@/server/bff/support-actions'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/support/[caseId]/assign'>,
) {
  const { caseId } = await context.params
  return runBffMutation(assignMutation, request, { caseId })
}
