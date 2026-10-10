import 'server-only'
import { z } from 'zod'
import {
  ACTIONS,
  JOB_ID,
  JOB_KINDS,
  appendedSchema,
  jobSchema,
  type Appended,
  type ImportJob,
  type JobAction,
} from '@/lib/import-jobs'
import { MAX_FILE_BYTES, MAX_ROWS_PER_REQUEST, productRowSchema } from '@/lib/imports'
import type { BffMutationSpec } from './mutation'

/**
 * BFF mutations for the asynchronous import jobs. Each declares ONE fixed backend path; the browser supplies only a job id
 * (grammar-checked), a row number, a version or rows, never a path, header or approver. `apply` is the explicit approval and
 * the backend takes the approver from the bearer token (the signed-in human), so no body field can name one.
 */
const jobId = z.string().regex(JOB_ID)
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const createInput = z
  .object({ kind: z.enum(JOB_KINDS), note: z.string().trim().max(500).optional() })
  .strict()

export const createJobMutation: BffMutationSpec<
  z.infer<typeof createInput>,
  ImportJob,
  ImportJob
> = {
  routeId: 'importJobs.create',
  method: 'POST',
  input: createInput,
  backend: ({ kind, note }) => ({
    path: '/api/v1/admin/imports/jobs',
    body: { kind, ...(note ? { note } : {}) },
  }),
  output: jobSchema,
  toClient: (job) => job,
}

const appendInput = z
  .object({
    jobId,
    rows: z.array(productRowSchema).min(1).max(MAX_ROWS_PER_REQUEST),
  })
  .strict()

export const appendRowsMutation: BffMutationSpec<
  z.infer<typeof appendInput>,
  Appended,
  Appended
> = {
  routeId: 'importJobs.appendRows',
  method: 'POST',
  input: appendInput,
  backend: ({ jobId: id, rows }) => ({
    path: `/api/v1/admin/imports/jobs/${encodeURIComponent(id)}/rows`,
    body: { rows },
  }),
  output: appendedSchema,
  toClient: (appended) => appended,
  // The backend bounds every /imports/ request at 2 MiB; a chunk is stored row by row, so allow a long wait.
  maxBodyBytes: MAX_FILE_BYTES,
  timeoutMs: 60_000,
}

const correctInput = z
  .object({
    jobId,
    // Arrives as a path segment (a string): digits only, converted once.
    row: z
      .string()
      .regex(/^[0-9]{1,15}$/)
      .transform(Number),
    product: productRowSchema,
  })
  .strict()

export const correctRowMutation: BffMutationSpec<
  z.infer<typeof correctInput>,
  ImportJob,
  ImportJob
> = {
  routeId: 'importJobs.correctRow',
  method: 'PUT',
  input: correctInput,
  backend: ({ jobId: id, row, product }) => ({
    path: `/api/v1/admin/imports/jobs/${encodeURIComponent(id)}/rows/${row}`,
    body: product,
  }),
  output: jobSchema,
  toClient: (job) => job,
}

const actionInput = z.object({ jobId, version }).strict()

export function jobActionMutation(
  action: JobAction,
): BffMutationSpec<z.infer<typeof actionInput>, ImportJob, ImportJob> {
  return {
    routeId: `importJobs.${action}`,
    method: 'POST',
    input: actionInput,
    backend: ({ jobId: id, version: v }) => ({
      path: `/api/v1/admin/imports/jobs/${encodeURIComponent(id)}/${action}`,
      body: { version: v },
    }),
    output: jobSchema,
    toClient: (job) => job,
  }
}

export const isJobAction = (value: string): value is JobAction =>
  (ACTIONS as readonly string[]).includes(value)
