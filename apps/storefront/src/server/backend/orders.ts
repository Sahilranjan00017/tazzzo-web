import 'server-only'
import { z } from 'zod'
import type { PlaceError } from '@/lib/checkout/messages'
import { isQuoteId } from '@/lib/checkout/model'
import { PRODUCT_ID } from '@/lib/ids'
import { isSlotId } from '@/lib/location/validation'
import type { OrderError } from '@/lib/orders/messages'
import {
  ORDER_ID,
  isOrderCursor,
  isOrderId,
  statusOf,
  type CancelReason,
  type Order,
  type OrderPage,
  type OrderSlot,
  type OrderSummary,
} from '@/lib/orders/model'
import { routeLabel, sendJson, type SendResult } from '@/server/backend/client'

/**
 * Typed calls over the customer order contract (tazzzo-backend `OrderController`, all bearer-authenticated; the
 * customer is ALWAYS the verified principal: no customer id is ever sent, and the backend scopes every order id to the
 * caller, so a foreign, unknown, malformed or internal order id is the same 404).
 * - `POST /v1/customer/orders` `{quoteId, paymentMethod:"COD", deliverySlotId?}`: COD is the only method. There is NO
 *   `Idempotency-Key` on placement: `(customerId, quoteId)` is unique, so a replay of the same quote returns the SAME
 *   `CONFIRMED` order (always 200) with no second reservation. The slot is reserved in the same transaction (a full or
 *   closed slot aborts the whole placement). A different quote of an already-ordered cart is 409
 *   `CART_VERSION_ALREADY_PURCHASED`.
 * - `GET /v1/customer/orders?page_size&cursor` (newest first, only those two parameters), `GET .../{orderId}`,
 *   `POST .../{orderId}/cancel` `{reason}` (idempotent; refused with 409 `CANCELLATION_WINDOW_CLOSED` while the
 *   deployment has no customer cancellation window, which is the default).
 * Success bodies are parsed with a strict schema; a body that does not match is `unavailable`, never passed on.
 * Backend text is never read: only the public error `code` and the HTTP class select a closed error.
 */
export type OrderCallResult<T> =
  { ok: true; data: T } | { ok: false; reason: OrderError; retryAfterSeconds: number | null }

export type PlaceCallResult =
  | { ok: true; data: { orderId: string; payablePaise: number | null } }
  | { ok: false; reason: PlaceError; retryAfterSeconds: number | null }

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1).max(400)
const instant = z.string().min(10).max(40)

const slotBody = z.object({
  slotId: z.string().refine(isSlotId),
  label: z.string().min(1).max(120),
  startsAt: instant,
  endsAt: instant,
})
const orderBody = z.object({
  orderId: z.string().regex(ORDER_ID),
  status: z.string().max(32),
  paymentMethod: z.string().max(16),
  paymentCondition: z.string().max(32).nullish(),
  items: z
    .array(
      z.object({
        skuId: z.string().regex(PRODUCT_ID),
        title: z.string().max(500).nullish(),
        brandCode: z.string().max(100).nullish(),
        quantity: z.number().int().min(1).max(10_000),
        unitPricePaise: paise,
        lineTotalPaise: paise,
      }),
    )
    .max(50),
  itemCount: z.number().int().min(0),
  subtotalPaise: paise,
  deliveryAddress: z.object({
    label: z.string().max(40).nullish(),
    recipientName: text,
    recipientPhone: z.string().min(1).max(32),
    addressLine1: text,
    addressLine2: z.string().max(400).nullish(),
    landmark: z.string().max(400).nullish(),
    city: text,
    state: text,
    postalCode: z.string().min(1).max(12),
  }),
  createdAt: instant,
  confirmedAt: instant.nullish(),
  money: z
    .object({
      merchandiseSubtotalPaise: paise,
      benefitDiscountPaise: paise,
      payablePaise: paise,
    })
    .nullish(),
  deliverySlot: slotBody.nullish(),
  cancelledAt: instant.nullish(),
  outForDeliveryAt: instant.nullish(),
  deliveredAt: instant.nullish(),
})
const summaryBody = z.object({
  orderId: z.string().regex(ORDER_ID),
  status: z.string().max(32),
  itemCount: z.number().int().min(0),
  subtotalPaise: paise,
  payablePaise: paise.nullish(),
  createdAt: instant,
  deliverySlot: slotBody.nullish(),
  cancelledAt: instant.nullish(),
})
const pageBody = z.object({
  items: z.array(summaryBody).max(50),
  nextCursor: z.string().refine(isOrderCursor).nullish(),
})

const slot = (s: z.infer<typeof slotBody> | null | undefined): OrderSlot | null =>
  s ? { slotId: s.slotId, label: s.label, startsAt: s.startsAt, endsAt: s.endsAt } : null

/** The order, or null when the body contradicts itself (lines that do not add up, money that does not follow). */
export function toOrder(body: z.infer<typeof orderBody>): Order | null {
  const lineSum = body.items.reduce((sum, l) => sum + l.lineTotalPaise, 0)
  if (lineSum !== body.subtotalPaise) return null
  const money = body.money ?? null
  if (
    money !== null &&
    (money.benefitDiscountPaise > money.merchandiseSubtotalPaise ||
      money.payablePaise !== money.merchandiseSubtotalPaise - money.benefitDiscountPaise)
  ) {
    return null
  }
  const a = body.deliveryAddress
  return {
    orderId: body.orderId,
    status: statusOf(body.status),
    paymentMethod: body.paymentMethod,
    paymentCondition: body.paymentCondition ?? null,
    lines: body.items.map((l) => ({
      productId: l.skuId,
      title: l.title?.trim() || null,
      brandCode: l.brandCode ?? null,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
      lineTotalPaise: l.lineTotalPaise,
    })),
    itemCount: body.itemCount,
    subtotalPaise: body.subtotalPaise,
    address: {
      label: a.label ?? null,
      recipientName: a.recipientName,
      recipientPhone: a.recipientPhone,
      addressLine1: a.addressLine1,
      addressLine2: a.addressLine2 ?? null,
      landmark: a.landmark ?? null,
      city: a.city,
      state: a.state,
      postalCode: a.postalCode,
    },
    createdAt: body.createdAt,
    confirmedAt: body.confirmedAt ?? null,
    money,
    slot: slot(body.deliverySlot),
    cancelledAt: body.cancelledAt ?? null,
    outForDeliveryAt: body.outForDeliveryAt ?? null,
    deliveredAt: body.deliveredAt ?? null,
  }
}

const toSummary = (s: z.infer<typeof summaryBody>): OrderSummary => ({
  orderId: s.orderId,
  status: statusOf(s.status),
  itemCount: s.itemCount,
  subtotalPaise: s.subtotalPaise,
  payablePaise: s.payablePaise ?? null,
  createdAt: s.createdAt,
  slot: slot(s.deliverySlot),
  cancelledAt: s.cancelledAt ?? null,
})

/** The backend's public error code (and HTTP class) as one closed `OrderError`. */
function readFailure(result: Extract<SendResult, { ok: false }>): OrderCallResult<never> {
  const base = { ok: false, retryAfterSeconds: result.retryAfterSeconds } as const
  switch (result.kind) {
    case 'unauthenticated':
      return { ...base, reason: 'unauthenticated' }
    case 'rate_limited':
      return { ...base, reason: 'rate_limited' }
    case 'rejected':
      return { ...base, reason: 'bad_request' }
    default:
      switch (result.code) {
        case 'NOT_FOUND':
          return { ...base, reason: 'not_found' }
        case 'ORDER_NOT_CANCELLABLE':
          return { ...base, reason: 'not_cancellable' }
        case 'CANCELLATION_WINDOW_CLOSED':
          return { ...base, reason: 'window_closed' }
        default:
          return { ...base, reason: 'unavailable' }
      }
  }
}

function parseOrder(data: unknown, path: string): OrderCallResult<Order> {
  const parsed = orderBody.safeParse(data)
  const order = parsed.success ? toOrder(parsed.data) : null
  if (order === null) {
    console.warn(`storefront_backend_malformed path=${routeLabel(path)}`)
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  return { ok: true, data: order }
}

const orderPath = (orderId: string) => {
  // Canonical grammar only, and never case-folded: the id reaches the backend path exactly as validated.
  if (!isOrderId(orderId)) throw new Error('canonical order ids only')
  return `/v1/customer/orders/${encodeURIComponent(orderId)}`
}

/** `GET /v1/customer/orders/{orderId}`: 404 for an id that is not the caller's (or not a customer-visible order). */
export async function getOrder(
  accessToken: string,
  orderId: string,
): Promise<OrderCallResult<Order>> {
  const result = await sendJson('GET', orderPath(orderId), { bearer: accessToken })
  if (!result.ok) return readFailure(result)
  return parseOrder(result.data, '/v1/customer/orders/{id}')
}

/** `GET /v1/customer/orders?page_size=&cursor=`: the caller's own orders, newest first. */
export async function listOrders(
  accessToken: string,
  options: { cursor: string | null; pageSize: number },
): Promise<OrderCallResult<OrderPage>> {
  if (options.cursor !== null && !isOrderCursor(options.cursor))
    throw new Error('canonical cursors only')
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
    throw new Error('page size 1..50')
  }
  const query = `page_size=${options.pageSize}${options.cursor ? `&cursor=${options.cursor}` : ''}`
  const result = await sendJson('GET', `/v1/customer/orders?${query}`, { bearer: accessToken })
  if (!result.ok) return readFailure(result)
  const parsed = pageBody.safeParse(result.data)
  if (!parsed.success) {
    console.warn('storefront_backend_malformed path=/v1/customer/orders')
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  return {
    ok: true,
    data: { orders: parsed.data.items.map(toSummary), nextCursor: parsed.data.nextCursor ?? null },
  }
}

/** `POST /v1/customer/orders/{orderId}/cancel`: idempotent (a second cancel returns the cancelled order). */
export async function cancelOrder(
  accessToken: string,
  orderId: string,
  reason: CancelReason,
): Promise<OrderCallResult<Order>> {
  const result = await sendJson('POST', `${orderPath(orderId)}/cancel`, {
    bearer: accessToken,
    body: { reason },
  })
  if (!result.ok) return readFailure(result)
  return parseOrder(result.data, '/v1/customer/orders/{id}/cancel')
}

/**
 * `POST /v1/customer/orders`. Every refusal that is a definite "nothing was created" has its own closed error. What is
 * NOT definite (a 5xx, the internal-defect 500, a timeout or network failure, a body that is not the order) is
 * `unknown`: the placement may have committed, and the caller must say so and retry with the SAME quote, which can
 * only ever return that one order.
 */
export async function placeCodOrder(
  accessToken: string,
  input: { quoteId: string; deliverySlotId: string },
): Promise<PlaceCallResult> {
  if (!isQuoteId(input.quoteId) || !isSlotId(input.deliverySlotId)) {
    throw new Error('canonical quote and slot ids only')
  }
  const result = await sendJson('POST', '/v1/customer/orders', {
    bearer: accessToken,
    body: { quoteId: input.quoteId, paymentMethod: 'COD', deliverySlotId: input.deliverySlotId },
  })
  if (!result.ok) {
    const base = { ok: false, retryAfterSeconds: result.retryAfterSeconds } as const
    switch (result.kind) {
      case 'unauthenticated':
        return { ...base, reason: 'unauthenticated' }
      case 'rate_limited':
        return { ...base, reason: 'rate_limited' }
      case 'rejected':
        return { ...base, reason: 'bad_request' }
      default:
        switch (result.code) {
          case 'NOT_FOUND':
          case 'QUOTE_EXPIRED':
            return { ...base, reason: 'quote_expired' }
          case 'ADDRESS_CHANGED':
            return { ...base, reason: 'address_changed' }
          case 'NOT_SERVICEABLE':
            return { ...base, reason: 'unserviceable' }
          case 'PRICE_CHANGED':
            return { ...base, reason: 'price_changed' }
          case 'PRODUCT_UNAVAILABLE':
          case 'STOCK_UNAVAILABLE':
            return { ...base, reason: 'items_unavailable' }
          case 'RESERVATION_EXPIRED':
            return { ...base, reason: 'hold_expired' }
          case 'CART_VERSION_ALREADY_PURCHASED':
            return { ...base, reason: 'already_ordered' }
          case 'DELIVERY_SLOT_UNAVAILABLE':
            return { ...base, reason: 'slot_unavailable' }
          default:
            return { ...base, reason: 'unknown' }
        }
    }
  }
  const parsed = orderBody.safeParse(result.data)
  const order = parsed.success ? toOrder(parsed.data) : null
  if (order === null) {
    console.warn('storefront_backend_malformed path=/v1/customer/orders')
    return { ok: false, reason: 'unknown', retryAfterSeconds: null }
  }
  return {
    ok: true,
    data: { orderId: order.orderId, payablePaise: order.money?.payablePaise ?? null },
  }
}
