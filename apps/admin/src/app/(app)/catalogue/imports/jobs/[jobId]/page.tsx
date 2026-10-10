import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { JobDetailView } from '@/components/imports/jobs/JobDetailView'
import { JOB_ID, parseRowsFrom } from '@/lib/import-jobs'
import { canWrite } from '@/lib/roles'
import { readImportJob, readImportJobRows } from '@/server/backend/import-jobs'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Import job · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ImportJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { jobId } = await params
  if (!JOB_ID.test(jobId)) notFound()
  const access = await requireAdmin()
  const me = access.view === 'ok' ? access.me : undefined
  const from = parseRowsFrom(await searchParams)
  const [job, rows] = await Promise.all([readImportJob(jobId), readImportJobRows(jobId, from)])
  return (
    <JobDetailView
      jobId={jobId}
      job={job}
      rows={job.kind === 'ok' && job.data.rowsTotal > 0 ? rows : undefined}
      from={from}
      canWrite={canWrite(me?.roles ?? [])}
      approver={me?.email ?? 'your account'}
    />
  )
}
