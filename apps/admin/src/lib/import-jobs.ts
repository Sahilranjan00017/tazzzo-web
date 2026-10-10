import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import {
  FIELDS,
  autoMap,
  buildRows,
  parseCsv,
  type BuiltRow,
  type CsvLimits,
  missingRequired,
} from './imports'

/**
 * Asynchronous import jobs (backend `ImportJobController`, `/api/v1/admin/imports/jobs`, operationIds `listImportJobs`,
 * `createImportJob`, `getImportJob`, `appendImportJobRows`, `listImportJobRows`, `correctImportJobRow`, `validateImportJob`,
 * `applyImportJob`, `cancelImportJob`, `resumeImportJob`, `downloadImportJobErrorsCsv`). Client-safe.
 *
 * Facts the UI is built on (all from the backend source and docs/ops/BULK_IMPORT.md):
 * - Only `products` jobs exist. Rows are the single-product create shape, i.e. the same row the synchronous wizard builds.
 * - Concurrency is the job `version` sent in the BODY of validate/apply/resume/cancel; a mismatch is 409 IMPORT_JOB_STATE
 *   (there is no If-Match and no 412 on this API). Appending rows and correcting a row also bump the version.
 * - `apply` is the explicit approval: the backend records the caller (from the bearer token) as `approvedBy`. The browser
 *   never names an approver.
 * - A row listing returns only the product id, the validation verdict and the apply verdict, never the rest of the row.
 * - Both lists answer with a `next` that is simply the last item's key, even on the final page, so the UI asks for one
 *   extra item to know whether more exist.
 */
export const JOB_ID = /^IMPJ-[0-9a-f]{24}$/
export const JOB_KINDS = ['products'] as const

export const JOB_STATUSES = [
  'OPEN',
  'VALIDATING',
  'VALIDATED',
  'REJECTED',
  'APPLYING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open (accepting rows)',
  VALIDATING: 'Validating',
  VALIDATED: 'Validated, ready to approve',
  REJECTED: 'Rejected (rows need fixing)',
  APPLYING: 'Applying',
  PAUSED: 'Paused (can resume)',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}
export const STATUS_TONE: Record<string, Tone> = {
  OPEN: 'info',
  VALIDATING: 'warning',
  VALIDATED: 'success',
  REJECTED: 'danger',
  APPLYING: 'warning',
  PAUSED: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
}

export const isTerminal = (status: string) => status === 'COMPLETED' || status === 'CANCELLED'
/** The states the background worker owns: the only ones that change without a person acting, so the only ones polled. */
export const isWorking = (status: string) => status === 'VALIDATING' || status === 'APPLYING'

export interface JobActions {
  append: boolean
  correct: boolean
  validate: boolean
  apply: boolean
  resume: boolean
  cancel: boolean
}

/** What a writer may start from this status (mirrors `ImportJobService`; the backend decides and may still answer 409). */
export function jobActions(status: string, rowsTotal: number): JobActions {
  return {
    append: status === 'OPEN',
    correct: status === 'OPEN' || status === 'REJECTED',
    validate: (status === 'OPEN' || status === 'REJECTED') && rowsTotal > 0,
    apply: status === 'VALIDATED',
    resume: status === 'PAUSED',
    cancel: !isTerminal(status) && (JOB_STATUSES as readonly string[]).includes(status),
  }
}

export const ACTIONS = ['validate', 'apply', 'resume', 'cancel'] as const
export type JobAction = (typeof ACTIONS)[number]

/* ---------------- backend shapes ---------------- */

const actor = z.object({ type: z.string().nullish(), id: z.string().nullish() }).nullish()
const count = z.number().int().nonnegative().default(0)

export const jobSchema = z.object({
  id: z.string().regex(JOB_ID),
  kind: z.string(),
  status: z.string(),
  note: z.string().nullish(),
  createdBy: actor,
  approvedBy: actor,
  rowsTotal: z.number().int().nonnegative(),
  nextRow: z.number().int().nonnegative(),
  counts: z
    .object({
      valid: count,
      unchanged: count,
      invalid: count,
      duplicate: count,
      applied: count,
      failed: count,
      not_attempted: count,
    })
    .default({
      valid: 0,
      unchanged: 0,
      invalid: 0,
      duplicate: 0,
      applied: 0,
      failed: 0,
      not_attempted: 0,
    }),
  attemptCount: z.number().int().nonnegative().default(0),
  lastError: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  version: z.number().int().min(0),
})
export type ImportJob = z.infer<typeof jobSchema>

export const jobListSchema = z.object({
  jobs: z.array(jobSchema),
  next: z.string().nullish(),
})

const verdict = z
  .object({
    outcome: z.string().nullish(),
    code: z.string().nullish(),
    message: z.string().nullish(),
  })
  .nullish()

export const rowViewSchema = z.object({
  row: z.number().int().nonnegative(),
  line: z.number().int().nullish(),
  id: z.string().nullish(),
  validation: verdict,
  apply: verdict,
})
export type JobRow = z.infer<typeof rowViewSchema>

export const rowsPageSchema = z.object({
  rows: z.array(rowViewSchema),
  next: z.number().int().nullish(),
})

export const appendedSchema = z.object({
  rowsAdded: z.number().int().nonnegative(),
  rowsTotal: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
})
export type Appended = z.infer<typeof appendedSchema>

/* ---------------- list / rows queries ---------------- */

export const JOBS_PAGE_SIZE = 20
export const ROWS_PAGE_SIZE = 100
const ID_CURSOR = JOB_ID

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export interface JobListQuery {
  status?: JobStatus
  after?: string
}

/** `?status=&after=`: invalid values are dropped, never sent. */
export function parseJobListQuery(raw: Raw): JobListQuery {
  const status = first(raw.status)
  const after = first(raw.after)
  return {
    ...(status && (JOB_STATUSES as readonly string[]).includes(status)
      ? { status: status as JobStatus }
      : {}),
    ...(after && ID_CURSOR.test(after) ? { after } : {}),
  }
}

/** Asks for one job more than a page so the UI knows if an older page exists (the backend's `next` always points on). */
export function jobListPath(q: JobListQuery): string {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.after) p.set('after', q.after)
  p.set('limit', String(JOBS_PAGE_SIZE + 1))
  return `/api/v1/admin/imports/jobs?${p.toString()}`
}

export function pageOf<T>(items: readonly T[], size: number): { items: T[]; more: boolean } {
  return { items: items.slice(0, size), more: items.length > size }
}

/** `?from=`: a non-negative integer row number. */
export function parseRowsFrom(raw: Raw): number {
  const v = first(raw.from)
  return v && /^\d{1,12}$/.test(v) ? Number(v) : 0
}

export function jobRowsPath(id: string, from: number): string {
  if (!JOB_ID.test(id)) throw new Error('invalid job id')
  return `/api/v1/admin/imports/jobs/${encodeURIComponent(id)}/rows?from=${from}&limit=${ROWS_PAGE_SIZE + 1}`
}

export const jobPath = (id: string): string => {
  if (!JOB_ID.test(id)) throw new Error('invalid job id')
  return `/api/v1/admin/imports/jobs/${encodeURIComponent(id)}`
}

export const OUTCOME_TONE: Record<string, Tone> = {
  VALID: 'success',
  APPLIED: 'success',
  UNCHANGED: 'neutral',
  INVALID: 'danger',
  DUPLICATE: 'danger',
  FAILED: 'danger',
  NOT_ATTEMPTED: 'warning',
}

/** The verdict that matters for a row: a negative apply verdict is the later one; otherwise apply if present, else validation. */
export function effectiveVerdict(
  row: JobRow,
): { phase: 'validation' | 'apply'; outcome: string; code?: string; message?: string } | undefined {
  const a = row.apply
  const v = row.validation
  const pick = a?.outcome
    ? { phase: 'apply' as const, v: a }
    : v?.outcome
      ? { phase: 'validation' as const, v }
      : undefined
  if (!pick || !pick.v.outcome) return undefined
  return {
    phase: pick.phase,
    outcome: pick.v.outcome,
    ...(pick.v.code ? { code: pick.v.code } : {}),
    ...(pick.v.message ? { message: pick.v.message.slice(0, 300) } : {}),
  }
}

/** A row the writer may correct while the job is OPEN or REJECTED: its validation verdict is negative. */
export const isCorrectable = (row: JobRow) =>
  row.validation?.outcome === 'INVALID' || row.validation?.outcome === 'DUPLICATE'

/* ---------------- upload: CSV -> rows -> byte-bounded chunks ---------------- */

/** A job holds up to 250,000 rows; the browser reads the file whole, so a single file is bounded well below that. */
export const JOB_FILE_LIMITS: CsvLimits = { maxChars: 20 * 1024 * 1024, maxRows: 50_000 }
/** The backend (and the BFF) bound a request body at 2 MiB; stay clear of it. */
export const CHUNK_MAX_BYTES = 1_000_000
export const CHUNK_MAX_ROWS = 200

export type PreparedUpload =
  | { ok: false; reason: string }
  | {
      ok: true
      header: string[]
      rows: string[][]
      map: Record<string, number>
    }

export function prepareUpload(text: string): PreparedUpload {
  const parsed = parseCsv(text, JOB_FILE_LIMITS)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    header: parsed.header,
    rows: parsed.rows,
    map: autoMap('products', parsed.header),
  }
}

export function buildUploadRows(rows: readonly (readonly string[])[], map: Record<string, number>) {
  const built = buildRows('products', rows, map)
  return {
    built,
    sendable: built.filter(
      (b): b is BuiltRow & { value: Record<string, unknown> } => b.value !== undefined,
    ),
    invalid: built.filter((b) => b.value === undefined),
    missing: missingRequired('products', map),
  }
}

const BYTES = new TextEncoder()

/** Splits rows into requests of at most `CHUNK_MAX_ROWS` rows and `CHUNK_MAX_BYTES` of JSON. A row never splits. */
export function chunkRows<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = BYTES.encode(JSON.stringify(item)).length + 1 // UTF-8 bytes, which is what the 2 MiB request bound counts
    if (
      current.length > 0 &&
      (current.length >= CHUNK_MAX_ROWS || bytes + size > CHUNK_MAX_BYTES)
    ) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0) out.push(current)
  return out
}

/* ---------------- row correction ---------------- */

export const CORRECTION_FIELDS = FIELDS.products
const CORRECTION_MAP = Object.fromEntries(CORRECTION_FIELDS.map((f, i) => [f.key, i])) as Record<
  string,
  number
>

/**
 * A correction REPLACES the whole row (the backend listing never returns the stored payload), so every field is entered.
 * Built and validated with the same code as an upload row, so the shared product-id grammar applies and the id is never
 * case-changed.
 */
export function buildCorrection(
  values: Record<string, string>,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const cells = CORRECTION_FIELDS.map((f) => values[f.key] ?? '')
  const [row] = buildRows('products', [cells], CORRECTION_MAP)
  return row?.value
    ? { ok: true, value: row.value }
    : { ok: false, errors: row?.errors ?? ['The row is not valid.'] }
}

/* ----------------
 * Failure copy. The wording of a FAILED CALL is ours: no backend text is ever shown in it. Different on purpose: a row's
 * verdict message (cut to 300 characters, see effectiveVerdict) and the job's worker note (`lastError`, cut to 200) are
 * written by the backend about the admin's own data and are shown as plain React text (escaped, never HTML).
 * ---------------- */

/**
 * A failure that proves the request stored NOTHING: the backend (or the BFF, before calling it) refused it with a 4xx.
 * 409 is NOT in the list for the rows endpoint: the shared code IMPORT_JOB_STATE also means "another upload holds the append
 * lock", which can be this upload's own earlier request still running after the BFF gave up on it.
 * Status 0 (network), 5xx, timeouts and anything else are AMBIGUOUS: the backend may have committed the request before the
 * answer was lost, so the outcome has to be checked on the job, never assumed.
 */
export function isDefiniteFailure(result: { status: number }): boolean {
  return [400, 403, 404, 413, 415, 422, 429].includes(result.status)
}

const CODE_COPY: Record<string, string> = {
  IMPORT_JOB_NOT_FOUND: 'This import job no longer exists.',
  INVALID_IMPORT: 'The backend rejected this request as invalid. Nothing from it was stored.',
}

/** Operator wording for a failed job call. `what` names the action, e.g. "upload" or "approval". */
export function jobErrorMessage(
  result: Extract<BffResult<unknown>, { ok: false }>,
  what = 'request',
): string {
  if (result.status === 409 && result.code === 'IMPORT_JOB_STATE')
    return `The job is not in a state that allows this ${what} (it changed since you loaded it, another upload or correction is in progress, or too many jobs are active). The latest job has been reloaded; review it and try again.`
  if (result.status === 413)
    return `The ${what} is too large for the backend. Nothing from it was stored; split the file.`
  if (result.status === 422 && result.code === 'INVALID_IMPORT')
    return `The backend rejected this ${what} as invalid, so none of it was stored. Check the file or values and try again.`
  if (result.code && CODE_COPY[result.code] && result.status !== 409) return CODE_COPY[result.code]!
  if (result.status === 403)
    return `Your role is not permitted to make this ${what}. Import jobs need the cms-writer role.`
  if (result.status === 502 || result.status === 504)
    return `The import service could not complete this ${what} right now. It was not retried; reload the job and check its state before repeating it.`
  return bffErrorMessage(result, what)
}

/* ---------------- polling schedule ---------------- */

export const POLL_START_MS = 3_000
export const POLL_MAX_MS = 15_000
export const POLL_MAX_FAILURES = 5

/** Next wait: grows 1.5x per unchanged poll up to 15 s; a failed poll doubles it. Never below 3 s, so never a tight loop. */
export function nextPollDelay(previousMs: number, failed: boolean): number {
  const grown = failed ? previousMs * 2 : previousMs * 1.5
  return Math.min(POLL_MAX_MS * (failed ? 2 : 1), Math.max(POLL_START_MS, Math.round(grown)))
}

/** Percent done for the working phases: the cursor over the stored rows. */
export function progressPercent(job: Pick<ImportJob, 'nextRow' | 'rowsTotal'>): number {
  if (job.rowsTotal <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((job.nextRow / job.rowsTotal) * 100)))
}

/** Rows that have a negative verdict in either phase, per the job's own counters (what `errors.csv` should list). */
export const negativeRowCount = (job: Pick<ImportJob, 'counts'>): number =>
  job.counts.invalid + job.counts.duplicate + job.counts.failed

/**
 * Number of CSV records (quote-aware) in a text, header included, without any row or size cap. Used only to compare an
 * errors.csv with the job's counters; the cells themselves are never interpreted.
 */
export function countCsvRecords(text: string): number {
  let records = 0
  let quoted = false
  let content = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i++
      else quoted = !quoted
      content = true
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (content) records++
      content = false
    } else content = true
  }
  return content ? records + 1 : records
}

/**
 * How long the upload waits to learn the outcome of a request whose answer was lost. Production defaults are the long,
 * conservative ones: poll every 5 s; call the job idle after 90 s without a change (the BFF gives up after 60 s); stop waiting
 * after 16 minutes (the backend's append lock lasts 15). Tests shorten them with NEXT_PUBLIC_IMPORT_UPLOAD_* (read literally
 * so Next inlines them); a value that is not a whole number of milliseconds in range falls back to the default.
 */
export interface UploadTiming {
  pollMs: number
  settleMs: number
  maxWaitMs: number
}
const num = (v: string | undefined, fallback: number, min: number, max: number) =>
  v && /^\d{1,9}$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : fallback
export function uploadTiming(): UploadTiming {
  return {
    pollMs: num(process.env.NEXT_PUBLIC_IMPORT_UPLOAD_POLL_MS, 5_000, 0, 60_000),
    settleMs: num(process.env.NEXT_PUBLIC_IMPORT_UPLOAD_SETTLE_MS, 90_000, 0, 600_000),
    maxWaitMs: num(process.env.NEXT_PUBLIC_IMPORT_UPLOAD_MAXWAIT_MS, 16 * 60_000, 1_000, 3_600_000),
  }
}
