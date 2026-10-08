import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { statusMutation } from '@/server/bff/support-actions'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/support/[caseId]/status'>,
) {
  const { caseId } = await context.params
  return runBffMutation(statusMutation, request, { caseId })
}
