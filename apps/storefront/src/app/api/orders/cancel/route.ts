import type { OrderError } from '@/lib/orders/messages'
import { isCancelReason, isOrderId, type CancelReason } from '@/lib/orders/model'
import { cancelMyOrder } from '@/server/orders/service'
import { orderMutation } from '@/server/checkout/route'
import { json } from '@/server/session/route'

/**
 * `POST /api/orders/cancel` `{orderId, reason}` -> `POST /v1/customer/orders/{orderId}/cancel`. The backend decides
 * whether the caller's own order may be cancelled (by default customer cancellation is closed and it answers 409
 * `CANCELLATION_WINDOW_CLOSED`, shown as `window_closed`). `reason` is one of the backend's closed customer reasons.
 */
const STATUS: Record<OrderError, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  not_cancellable: 409,
  window_closed: 409,
  rate_limited: 429,
  unavailable: 503,
}

export const POST = (request: Request) =>
  orderMutation(
    request,
    (body): { orderId: string; reason: CancelReason } | null => {
      const keys = Object.keys(body)
      if (keys.length !== 2 || !keys.includes('orderId') || !keys.includes('reason')) return null
      return isOrderId(body.orderId) && isCancelReason(body.reason)
        ? { orderId: body.orderId, reason: body.reason }
        : null
    },
    async (session, input) => {
      const outcome = await cancelMyOrder(session, input.orderId, input.reason)
      if (outcome.ok) return json(200, { ok: true, data: { status: outcome.data.status } })
      const retry: Record<string, string> =
        outcome.retryAfterSeconds !== null
          ? { 'Retry-After': String(outcome.retryAfterSeconds) }
          : {}
      return json(
        STATUS[outcome.error],
        { ok: false, error: outcome.error, retryAfterSeconds: outcome.retryAfterSeconds },
        retry,
      )
    },
  )
