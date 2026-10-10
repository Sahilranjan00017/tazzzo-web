import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'

/** Staff support contract (backend main c3306b6, `StaffSupportController`). Client-safe. */
export const CASE_ID = /^SUP_[A-Za-z0-9_.:-]{1,100}$/
export const CURSOR = /^[A-Za-z0-9_=-]{1,128}$/
export const PAGE_SIZE = 20

export const CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const
export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
}
export const STATUS_TONE: Record<string, Tone> = {
  OPEN: 'danger',
  IN_PROGRESS: 'warning',
  RESOLVED: 'success',
  CLOSED: 'neutral',
}
export const CATEGORY_LABEL: Record<string, string> = {
  ORDER_ISSUE: 'Order issue',
  DELIVERY: 'Delivery',
  PRODUCT: 'Product',
  ACCOUNT: 'Account',
  OTHER: 'Other',
}

/** `to` values the backend accepts; OPEN is never a target. RESOLVED -> IN_PROGRESS is the staff reopen. */
export type StatusTarget = 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'
export const STATUS_TARGETS: readonly StatusTarget[] = ['IN_PROGRESS', 'RESOLVED', 'CLOSED']

/** Targets offered for a status: anything else except the same state; a CLOSED case is final. */
export function targetsFor(status: string): StatusTarget[] {
  if (status === 'CLOSED') return []
  return STATUS_TARGETS.filter((t) => t !== status)
}

export const MESSAGE_MAX = 2000
/** Reply text rules (backend): trimmed, 1..2000, no control characters except newline. */
export const replyText = z
  .string()
  .trim()
  .min(1)
  .max(MESSAGE_MAX)
  .refine((v) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v), 'no control characters')

export const caseSummarySchema = z.object({
  caseId: z.string(),
  customerId: z.string().nullish(),
  category: z.string().nullish(),
  subject: z.string(),
  status: z.string(),
  assignedTo: z.string().nullish(),
  messageCount: z.number().int().nullish(),
  version: z.number().int(),
  updatedAt: z.string().nullish(),
})
export type CaseSummary = z.infer<typeof caseSummarySchema>

export const caseListSchema = z.object({
  items: z.array(caseSummarySchema),
  nextCursor: z.string().nullish(),
})

export const staffCaseSchema = z.object({
  caseId: z.string(),
  customerId: z.string().nullish(),
  category: z.string().nullish(),
  orderId: z.string().nullish(),
  subject: z.string(),
  status: z.string(),
  assignedTo: z.string().nullish(),
  version: z.number().int(),
  messages: z
    .array(
      z.object({
        // the backend's StaffMessage.id is an int (1-based position in the case thread), never a string
        id: z.number().int(),
        author: z.string(),
        staffId: z.string().nullish(),
        text: z.string(),
        at: z.string().nullish(),
      }),
    )
    .default([]),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})
export type StaffCase = z.infer<typeof staffCaseSchema>

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export interface CaseListQuery {
  status?: string
  cursor?: string
}

export function parseCaseListQuery(raw: Raw): CaseListQuery {
  const status = first(raw.status)
  const cursor = first(raw.cursor)
  return {
    ...(status && (CASE_STATUSES as readonly string[]).includes(status) ? { status } : {}),
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
  }
}

export function caseListPath(q: CaseListQuery): string {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.cursor) p.set('cursor', q.cursor)
  p.set('page_size', String(PAGE_SIZE))
  return `/api/v1/admin/support/cases?${p.toString()}`
}

const CODE_COPY: Record<string, string> = {
  STATE_CONFLICT:
    'The case is not in a state that allows this (for example it is closed or already in that status). The latest case has been reloaded.',
  STALE_VERSION:
    'The case changed since you loaded it. The latest case has been reloaded; review it and try again.',
  MESSAGE_LIMIT: 'This case has reached the 100-message limit, so no more replies can be added.',
  NOT_FOUND: 'This case no longer exists.',
  INVALID_REQUEST: 'The request was not valid. Check the reply text (1 to 2000 characters).',
}

export function supportErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 502)
    return 'The support service could not complete this right now. It was not retried; reload and check the case before repeating it (a reply may already have been sent).'
  return bffErrorMessage(result, 'support change')
}
