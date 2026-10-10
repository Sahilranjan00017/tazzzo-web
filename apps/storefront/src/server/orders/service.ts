import 'server-only'
import type { OrderError } from '@/lib/orders/messages'
import {
  ORDER_PAGE_SIZE,
  cancelOffered,
  isOrderCursor,
  isOrderId,
  type CancelReason,
  type Order,
  type OrderPage,
} from '@/lib/orders/model'
import { cancelOrder, getOrder, listOrders, type OrderCallResult } from '@/server/backend/orders'
import { serverEnv } from '@/server/env'
import { withAccessToken } from '@/server/session/access'
import type { CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

/**
 * Order history, detail and cancellation for the pages and `/api/orders/cancel`. What a caller learns is a closed
 * outcome: the order(s) or an `OrderError`. The customer id is never an input anywhere: the backend takes it from the
 * bearer token and scopes every order id to it (another customer's order is the same 404 as an unknown one), and an id
 * that is not in the backend's grammar never reaches a path (it is `not_found` without a call). Nothing here logs.
 */
export type OrderOutcome<T> =
  { ok: true; data: T } | { ok: false; error: OrderError; retryAfterSeconds: number | null }

const fail = <T>(error: OrderError, retryAfterSeconds: number | null = null): OrderOutcome<T> => ({
  ok: false,
  error,
  retryAfterSeconds,
})

const toOutcome = <T>(result: OrderCallResult<T>): OrderOutcome<T> =>
  result.ok ? result : fail(result.reason, result.retryAfterSeconds)

/**
 * Page reads: no cookie can be written there, so an access token that is (nearly) expired is `unauthenticated` and the
 * PAGE sends the browser through `/api/auth/refresh`.
 */
export async function pageOrders(
  session: CustomerSession,
  cursor: string | null,
): Promise<OrderOutcome<OrderPage>> {
  if (!accessTokenUsable(session)) return fail('unauthenticated')
  if (cursor !== null && !isOrderCursor(cursor)) return fail('bad_request')
  return toOutcome(await listOrders(session.accessToken, { cursor, pageSize: ORDER_PAGE_SIZE }))
}

export async function pageOrder(
  session: CustomerSession,
  orderId: string,
): Promise<OrderOutcome<Order>> {
  if (!isOrderId(orderId)) return fail('not_found')
  if (!accessTokenUsable(session)) return fail('unauthenticated')
  return toOutcome(await getOrder(session.accessToken, orderId))
}

/** Route handlers only (they can set cookies): cancels the caller's own order; the backend decides if it may be. */
export async function cancelMyOrder(
  session: CustomerSession,
  orderId: string,
  reason: CancelReason,
): Promise<OrderOutcome<Order>> {
  if (!isOrderId(orderId)) return fail('not_found')
  return withAccessToken<OrderOutcome<Order>>(
    session,
    async (token) => toOutcome(await cancelOrder(token, orderId, reason)),
    {
      unauthenticated: () => fail('unauthenticated'),
      unavailable: () => fail('unavailable'),
      isUnauthenticated: (o) => !o.ok && o.error === 'unauthenticated',
    },
  )
}

/** Whether to OFFER a Cancel control on this order (see `cancelOffered`; the backend still decides every request). */
export function cancelOfferedFor(order: Order, now = Date.now()): boolean {
  return cancelOffered(order, serverEnv().orderCancelWindowSeconds, now)
}
