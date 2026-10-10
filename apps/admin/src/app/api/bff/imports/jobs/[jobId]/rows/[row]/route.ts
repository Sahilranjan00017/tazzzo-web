import type { NextRequest } from 'next/server'
import { correctRowMutation } from '@/server/bff/import-job-actions'
import { runBffMutation } from '@/server/bff/mutation'

/** PUT only: replace one row of an OPEN or REJECTED job (`correctImportJobRow`). */
export async function PUT(
  request: NextRequest,
  context: RouteContext<'/api/bff/imports/jobs/[jobId]/rows/[row]'>,
) {
  const { jobId, row } = await context.params
  return runBffMutation(correctRowMutation, request, { jobId, row })
}
