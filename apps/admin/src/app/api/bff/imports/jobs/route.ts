import type { NextRequest } from 'next/server'
import { createJobMutation } from '@/server/bff/import-job-actions'
import { runBffMutation } from '@/server/bff/mutation'

/** POST only: create an import job (`createImportJob`). */
export function POST(request: NextRequest) {
  return runBffMutation(createJobMutation, request)
}
