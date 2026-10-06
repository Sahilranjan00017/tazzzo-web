import { z } from 'zod'

/** `GET /api/v1/admin/dashboard/summary` (backend main c3306b6, DashboardController). Readable by reader/cms-writer only. */
export const DASHBOARD_PATH = '/api/v1/admin/dashboard/summary'

/** A bounded count. `capped` means the true number is AT LEAST `value` (backend cap), never an exact total. */
const count = z.object({ value: z.number().int().nonnegative(), capped: z.boolean() })

export const dashboardSchema = z.object({
  orders: z.object({
    open_confirmed: count,
    open_out_for_delivery: count,
    last24h_confirmed: count,
    last24h_out_for_delivery: count,
    last24h_delivered: count,
    last24h_cancelled: count,
  }),
  inventory: z.object({ out_of_stock: count, low_stock: count }),
  catalog: z.object({ products_total: count, active: count, draft: count }),
  serviceability: z.object({ service_areas_total: count, active: count }),
  support: z.object({ open: count, in_progress: count }),
  notifications: z.object({ pending: count, failed: count }),
  generatedAt: z.string(),
  bounds: z.object({
    cap: z.number().int().positive(),
    maxTimeMs: z.number().int().positive(),
    recentWindowHours: z.number().int().positive(),
  }),
})

export type DashboardSummary = z.infer<typeof dashboardSchema>
export type Count = z.infer<typeof count>
