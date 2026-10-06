import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { replyMutation } from '@/server/bff/support-actions'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/support/[caseId]/messages'>,
) {
  const { caseId } = await context.params
  return runBffMutation(replyMutation, request, { caseId })
}
