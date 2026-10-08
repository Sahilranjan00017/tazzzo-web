import 'server-only'
import { z } from 'zod'
import { CASE_ID, STATUS_TARGETS, replyText } from '@/lib/support'
import type { BffMutationSpec } from './mutation'

const caseOut = z.object({
  caseId: z.string(),
  status: z.string(),
  version: z.number().int(),
  assignedTo: z.string().nullish(),
})
type CaseOut = z.infer<typeof caseOut>
const toClient = ({ caseId, status, version }: CaseOut) => ({ caseId, status, version })
type CaseClient = ReturnType<typeof toClient>
const version = z.number().int().min(1).max(2_147_483_647)
const base = (id: string) => `/api/v1/admin/support/cases/${encodeURIComponent(id)}`

const replyInput = z.object({ caseId: z.string().regex(CASE_ID), message: replyText }).strict()

/**
 * `POST .../cases/{id}/messages` with exactly `{message}`. The backend has no version check or idempotency key here, so a
 * network failure after sending can leave a reply posted; the UI says so and the BFF never retries. support-agent only.
 */
export const replyMutation: BffMutationSpec<z.infer<typeof replyInput>, CaseOut, CaseClient> = {
  routeId: 'support.reply',
  method: 'POST',
  input: replyInput,
  backend: ({ caseId, message }) => ({ path: `${base(caseId)}/messages`, body: { message } }),
  output: caseOut,
  toClient,
}

const assignInput = z
  .object({ caseId: z.string().regex(CASE_ID), expectedVersion: version })
  .strict()

/** `POST .../assign`: assigns to the CALLER only (the backend has no assign-to-other or unassign). */
export const assignMutation: BffMutationSpec<z.infer<typeof assignInput>, CaseOut, CaseClient> = {
  routeId: 'support.assign',
  method: 'POST',
  input: assignInput,
  backend: ({ caseId, expectedVersion }) => ({
    path: `${base(caseId)}/assign`,
    body: { expectedVersion },
  }),
  output: caseOut,
  toClient,
}

const statusInput = z
  .object({
    caseId: z.string().regex(CASE_ID),
    to: z.enum(STATUS_TARGETS),
    expectedVersion: version,
  })
  .strict()

/** `POST .../status` to IN_PROGRESS | RESOLVED | CLOSED (OPEN is never a target). RESOLVED notifies the customer. */
export const statusMutation: BffMutationSpec<z.infer<typeof statusInput>, CaseOut, CaseClient> = {
  routeId: 'support.status',
  method: 'POST',
  input: statusInput,
  backend: ({ caseId, to, expectedVersion }) => ({
    path: `${base(caseId)}/status`,
    body: { to, expectedVersion },
  }),
  output: caseOut,
  toClient,
}
