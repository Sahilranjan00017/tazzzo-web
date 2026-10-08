import 'server-only'
import {
  CASE_ID,
  caseListPath,
  caseListSchema,
  staffCaseSchema,
  type CaseListQuery,
} from '@/lib/support'
import { readAsAdmin } from './session-read'

export const readCases = (q: CaseListQuery) => readAsAdmin(caseListPath(q), caseListSchema)
export function readCase(id: string) {
  if (!CASE_ID.test(id)) throw new Error('invalid case id')
  return readAsAdmin(`/api/v1/admin/support/cases/${encodeURIComponent(id)}`, staffCaseSchema)
}
