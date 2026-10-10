import 'server-only'
import {
  jobListPath,
  jobListSchema,
  jobPath,
  jobRowsPath,
  jobSchema,
  rowsPageSchema,
  type JobListQuery,
} from '@/lib/import-jobs'
import { readAsAdmin } from './session-read'

/** Server-side reads for the import-job pages (`listImportJobs`, `getImportJob`, `listImportJobRows`). */
export const readImportJobs = (q: JobListQuery) => readAsAdmin(jobListPath(q), jobListSchema)
export const readImportJob = (id: string) => readAsAdmin(jobPath(id), jobSchema)
export const readImportJobRows = (id: string, from: number) =>
  readAsAdmin(jobRowsPath(id, from), rowsPageSchema)
