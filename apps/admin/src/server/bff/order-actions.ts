import 'server-only'
import { z } from 'zod'
import { ORDER_ID, STAFF_CANCEL_REASONS } from '@/lib/orders'
import type { BffMutationSpec } from './mutation'

const input = z
  .object({
    orderId: z.string().regex(ORDER_ID),
    to: z.enum(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    reason: z.enum(STAFF_CANCEL_REASONS).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.to === 'CANCELLED' && !v.reason)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'a reason is required to cancel' })
    if (v.to !== 'CANCELLED' && v.reason)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'a reason is only for cancellation',
      })
  })

const output = z.object({ orderId: z.string(), status: z.string(), version: z.number().int() })

/**
 * `POST /api/v1/admin/orders/{id}/transition`: the only order mutation (cancel is `to: CANCELLED`). Backend allows
 * order-ops only and enforces the state machine; cancelling restocks and releases the slot hold exactly once.
 * Not idempotent and never retried: a repeat after success is a 409 INVALID_TRANSITION or STALE_VERSION.
 */
export const orderTransitionMutation: BffMutationSpec<
  z.infer<typeof input>,
  z.infer<typeof output>,
  z.infer<typeof output>
> = {
  routeId: 'orders.transition',
  method: 'POST',
  input,
  backend: ({ orderId, to, expectedVersion, reason }) => ({
    path: `/api/v1/admin/orders/${encodeURIComponent(orderId)}/transition`,
    body: { to, expectedVersion, ...(reason ? { reason } : {}) },
  }),
  output,
  toClient: (o) => o,
}
