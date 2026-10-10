import type { NextRequest } from 'next/server'
import { JOB_ID } from '@/lib/import-jobs'
import { runBffDownload } from '@/server/bff/download'

/** GET only: the job's `errors.csv` (`downloadImportJobErrorsCsv`), streamed. */
export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/bff/imports/jobs/[jobId]/errors.csv'>,
) {
  const { jobId } = await context.params
  if (!JOB_ID.test(jobId))
    return Response.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  return runBffDownload(
    {
      routeId: 'importJobs.errorsCsv',
      path: `/api/v1/admin/imports/jobs/${encodeURIComponent(jobId)}/errors.csv`,
      filename: `${jobId}-errors.csv`,
    },
    request,
  )
}
