import 'server-only'
import { z } from 'zod'
import {
  MAX_FILE_BYTES,
  MAX_ROWS_PER_REQUEST,
  importReportSchema,
  inventoryRowSchema,
  priceRowSchema,
  productRowSchema,
  safeRowErrors,
  type ImportKind,
  type ImportReport,
} from '@/lib/imports'
import type { BffMutationSpec } from './mutation'

const REPORT_MESSAGE_MAX = 200

/** Bounded copy of the backend report: row messages are trimmed and nothing else is passed through. */
function toClient(report: ImportReport): ImportReport {
  return {
    ...report,
    results: report.results.slice(0, MAX_ROWS_PER_REQUEST).map((r) => ({
      ...r,
      message: r.message ? r.message.slice(0, REPORT_MESSAGE_MAX) : r.message,
    })),
  }
}

function spec<Row extends z.ZodType>(
  kind: ImportKind,
  row: Row,
): BffMutationSpec<{ dryRun: boolean; rows: z.infer<Row>[] }, ImportReport, ImportReport> {
  const input = z
    .object({ dryRun: z.boolean(), rows: z.array(row).min(1).max(MAX_ROWS_PER_REQUEST) })
    .strict() as unknown as z.ZodType<{ dryRun: boolean; rows: z.infer<Row>[] }>
  return {
    routeId: `import.${kind}`,
    method: 'POST',
    input,
    backend: ({ dryRun, rows }) => ({
      path: `/api/v1/admin/imports/${kind}`,
      body: { dryRun, rows },
    }),
    output: importReportSchema,
    toClient,
    // Backend allows a 2 MiB body and applies rows one by one: the default 16 KiB / 5 s would break real files.
    maxBodyBytes: MAX_FILE_BYTES,
    timeoutMs: 60_000,
    errorDetail: (body) => safeRowErrors(body),
  }
}

export const importMutations: Record<ImportKind, ReturnType<typeof spec>> = {
  products: spec('products', productRowSchema) as ReturnType<typeof spec>,
  prices: spec('prices', priceRowSchema) as ReturnType<typeof spec>,
  inventory: spec('inventory', inventoryRowSchema) as ReturnType<typeof spec>,
}
