import type { NextRequest } from 'next/server'
import { appendRowsMutation } from '@/server/bff/import-job-actions'
import { runBffMutation } from '@/server/bff/mutation'

/** POST only: append product rows to an OPEN job (`appendImportJobRows`, JSON form). Each request is atomic on the backend. */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/imports/jobs/[jobId]/rows'>,
) {
  const { jobId } = await context.params
  return runBffMutation(appendRowsMutation, request, { jobId })
}
