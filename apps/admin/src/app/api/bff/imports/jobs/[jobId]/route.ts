import type { NextRequest } from 'next/server'
import { JOB_ID, jobPath, jobSchema } from '@/lib/import-jobs'
import { runBffRead } from '@/server/bff/read'

const noStore = { 'Cache-Control': 'no-store' }

/** GET only: one job (`getImportJob`), polled by the job page while the background worker owns it. */
export async function GET(
  request: NextRequest,
  context: RouteContext<'/api/bff/imports/jobs/[jobId]'>,
) {
  const { jobId } = await context.params
  if (!JOB_ID.test(jobId))
    return Response.json({ error: 'not_found' }, { status: 404, headers: noStore })
  return runBffRead(
    { routeId: 'importJobs.get', path: jobPath(jobId), output: jobSchema, toClient: (job) => job },
    request,
  )
}
