import type { Metadata } from 'next'
import { JobsListView } from '@/components/imports/jobs/JobsListView'
import { parseJobListQuery } from '@/lib/import-jobs'
import { canWrite } from '@/lib/roles'
import { readImportJobs } from '@/server/backend/import-jobs'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Import jobs · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ImportJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const query = parseJobListQuery(await searchParams)
  return (
    <JobsListView result={await readImportJobs(query)} query={query} canWrite={canWrite(roles)} />
  )
}
