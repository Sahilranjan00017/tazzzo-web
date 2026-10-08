import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { FILTER_VALUE } from './products'

/** Staff order contract (backend main c3306b6, `StaffOrderController`). Client-safe. */
export const ORDER_ID = FILTER_VALUE
export const CURSOR = /^[A-Za-z0-9_=-]{1,128}$/

export const ORDER_STATUSES = ['CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] as const
export const PAGE_SIZE = 20

export const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirmed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
}
export const STATUS_TONE: Record<string, Tone> = {
  CONFIRMED: 'info',
  OUT_FOR_DELIVERY: 'warning',
  DELIVERED: 'success',
  CANCELLED: 'danger',
}

/** The backend state machine: CONFIRMED -> OUT_FOR_DELIVERY|CANCELLED, OUT_FOR_DELIVERY -> DELIVERED|CANCELLED. */
export type OrderTarget = 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED'
export const TRANSITIONS: Record<string, readonly OrderTarget[]> = {
  CONFIRMED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
}

/** Staff cancellation reasons (`OrderCancellation`); required for CANCELLED and forbidden otherwise. */
export const STAFF_CANCEL_REASONS = [
  'OUT_OF_STOCK',
  'CUSTOMER_UNREACHABLE',
  'DELIVERY_FAILED',
  'CUSTOMER_REQUEST',
  'ADDRESS_UNSERVICEABLE',
  'OTHER',
] as const
export const REASON_LABEL: Record<string, string> = {
  OUT_OF_STOCK: 'Out of stock',
  CUSTOMER_UNREACHABLE: 'Customer unreachable',
  DELIVERY_FAILED: 'Delivery failed',
  CUSTOMER_REQUEST: 'Customer request',
  ADDRESS_UNSERVICEABLE: 'Address unserviceable',
  OTHER: 'Other',
  CHANGED_MIND: 'Customer changed their mind',
  ORDERED_BY_MISTAKE: 'Ordered by mistake',
}

const orderLine = z.object({
  skuId: z.string(),
  title: z.string(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  lineTotalPaise: z.number().int(),
})

export const staffOrderSchema = z.object({
  orderId: z.string(),
  customerId: z.string().nullish(),
  status: z.string(),
  version: z.number().int(),
  paymentMethod: z.string().nullish(),
  paymentCondition: z.string().nullish(),
  lines: z.array(orderLine).default([]),
  itemCount: z.number().int().nullish(),
  subtotalPaise: z.number().int().nullish(),
  payablePaise: z.number().int().nullish(),
  deliveryAddress: z
    .object({
      label: z.string().nullish(),
      recipientName: z.string().nullish(),
      recipientPhone: z.string().nullish(),
      addressLine1: z.string().nullish(),
      addressLine2: z.string().nullish(),
      landmark: z.string().nullish(),
      city: z.string().nullish(),
      state: z.string().nullish(),
      postalCode: z.string().nullish(),
    })
    .nullish(),
  deliverySlot: z
    .object({
      slotId: z.string().nullish(),
      label: z.string().nullish(),
      startsAt: z.string().nullish(),
      endsAt: z.string().nullish(),
    })
    .nullish(),
  createdAt: z.string().nullish(),
  confirmedAt: z.string().nullish(),
  outForDeliveryAt: z.string().nullish(),
  deliveredAt: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  cancelledBy: z.string().nullish(),
  cancelReason: z.string().nullish(),
})
export type StaffOrder = z.infer<typeof staffOrderSchema>

export const orderListSchema = z.object({
  items: z.array(staffOrderSchema),
  nextCursor: z.string().nullish(),
})

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export interface OrderListQuery {
  status?: string
  cursor?: string
}

/** `?status=&cursor=`: invalid values are dropped, never sent (the backend refuses any unknown parameter). */
export function parseOrderListQuery(raw: Raw): OrderListQuery {
  const status = first(raw.status)
  const cursor = first(raw.cursor)
  return {
    ...(status && (ORDER_STATUSES as readonly string[]).includes(status) ? { status } : {}),
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
  }
}

export function orderListPath(q: OrderListQuery): string {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.cursor) p.set('cursor', q.cursor)
  p.set('page_size', String(PAGE_SIZE))
  return `/api/v1/admin/orders?${p.toString()}`
}

const CODE_COPY: Record<string, string> = {
  INVALID_TRANSITION:
    'That change is not allowed from the order’s current status. The latest order has been reloaded.',
  STALE_VERSION:
    'The order changed since you loaded it. The latest order has been reloaded; review it and try again.',
  ORDER_NOT_FOUND: 'This order no longer exists.',
  INVALID_REQUEST: 'The request was not valid. For a cancellation, a reason is required.',
}

export function orderErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 502)
    return 'The order service could not complete this right now. It was not retried; reload and check the order status before repeating it.'
  return bffErrorMessage(result, 'order change')
}
