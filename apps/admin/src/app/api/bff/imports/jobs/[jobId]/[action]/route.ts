import { NextResponse, type NextRequest } from 'next/server'
import { isJobAction, jobActionMutation } from '@/server/bff/import-job-actions'
import { runBffMutation } from '@/server/bff/mutation'

/** POST only: validate | apply (the explicit approval) | resume | cancel. The action picks one of four fixed backend paths. */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/imports/jobs/[jobId]/[action]'>,
) {
  const { jobId, action } = await context.params
  if (!isJobAction(action)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(jobActionMutation(action), request, { jobId })
}
