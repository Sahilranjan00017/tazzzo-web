/**
 * Orders as the storefront models them (tazzzo-backend `CustomerOrderDto`, `OrderId`, `OrderLifecycleService`). Pure;
 * client-safe. Prices are integer paise taken from the order's own immutable snapshot, never recomputed here.
 */

/** The backend's order id grammar (`OrderId`): opaque, `ORD_` and 6-64 URL-safe characters. */
export const ORDER_ID = /^ORD_[A-Za-z0-9_-]{6,64}$/
export const isOrderId = (value: unknown): value is string =>
  typeof value === 'string' && ORDER_ID.test(value)

/**
 * The history cursor the backend mints and accepts (`OrderLifecycleService.decodeCursor`: unpadded base64url of
 * `v1|<epoch ms>|<order id>`, at most 128 characters). Only the alphabet and length are checked here; the backend
 * decodes it strictly and refuses anything else, and it only ever positions within the caller's own orders.
 */
export const isOrderCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export const ORDER_PAGE_SIZE = 10 // backend default 20, maximum 50

export const ORDER_STATUSES = ['CONFIRMED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] as const
/** `UNKNOWN` stands for a status newer than this site knows: it is shown neutrally, never guessed. */
export type OrderStatus = (typeof ORDER_STATUSES)[number] | 'UNKNOWN'

export const STATUS_TEXT: Record<OrderStatus, string> = {
  CONFIRMED: 'Confirmed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'In progress',
}

export function statusOf(raw: string): OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(raw) ? (raw as OrderStatus) : 'UNKNOWN'
}

export interface OrderLine {
  productId: string
  title: string | null
  brandCode: string | null
  quantity: number
  unitPricePaise: number
  lineTotalPaise: number
}

/** The address snapshot taken when the order was placed (what the backend stored, not the current saved address). */
export interface OrderAddress {
  label: string | null
  recipientName: string
  recipientPhone: string
  addressLine1: string
  addressLine2: string | null
  landmark: string | null
  city: string
  state: string
  postalCode: string
}

export interface OrderSlot {
  slotId: string
  label: string
  startsAt: string
  endsAt: string
}

export interface OrderMoney {
  merchandiseSubtotalPaise: number
  benefitDiscountPaise: number
  payablePaise: number
}

export interface Order {
  orderId: string
  status: OrderStatus
  /** `COD` is the only method that exists. */
  paymentMethod: string
  /** `COD_DUE` while payment is owed on delivery; absent on a cancelled order. */
  paymentCondition: string | null
  lines: OrderLine[]
  itemCount: number
  subtotalPaise: number
  address: OrderAddress
  createdAt: string
  confirmedAt: string | null
  /** Absent on an order created before the money model: NEVER read that as a zero payable. */
  money: OrderMoney | null
  slot: OrderSlot | null
  cancelledAt: string | null
  outForDeliveryAt: string | null
  deliveredAt: string | null
}

/** One row of the history (`CustomerOrderDto.Summary`): no address, no lines. */
export interface OrderSummary {
  orderId: string
  status: OrderStatus
  itemCount: number
  subtotalPaise: number
  payablePaise: number | null
  createdAt: string
  slot: OrderSlot | null
  cancelledAt: string | null
}

export interface OrderPage {
  orders: OrderSummary[]
  nextCursor: string | null
}

/** The closed reasons a customer may give when cancelling (`OrderCancellation.CUSTOMER_REASONS`). */
export const CANCEL_REASONS = ['CHANGED_MIND', 'ORDERED_BY_MISTAKE', 'OTHER'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]
export const CANCEL_REASON_TEXT: Record<CancelReason, string> = {
  CHANGED_MIND: 'I changed my mind',
  ORDERED_BY_MISTAKE: 'I ordered by mistake',
  OTHER: 'Another reason',
}
export const isCancelReason = (value: unknown): value is CancelReason =>
  typeof value === 'string' && (CANCEL_REASONS as readonly string[]).includes(value)

/** The most the backend lets a deployment configure (`tazzzo.orders.customer-cancel-window-seconds`: 0..7 days). */
export const MAX_CANCEL_WINDOW_SECONDS = 7 * 24 * 3600

/**
 * Whether to OFFER cancellation: the order is confirmed and still inside the cancellation window this deployment says
 * the backend has (0 = customer cancellation is disabled, which is the backend's default). The backend decides every
 * cancel request regardless; this only keeps a control from being offered where the backend will refuse.
 */
export function cancelOffered(
  order: Pick<Order, 'status' | 'confirmedAt'>,
  windowSeconds: number,
  now: number,
): boolean {
  if (windowSeconds <= 0 || order.status !== 'CONFIRMED' || order.confirmedAt === null) return false
  const confirmed = Date.parse(order.confirmedAt)
  return Number.isFinite(confirmed) && now <= confirmed + windowSeconds * 1000
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const IST_OFFSET_MS = 5.5 * 3_600_000

/**
 * "11 Oct 2026, 3:42 pm" for an ISO instant, in the delivery time zone (Asia/Kolkata, UTC+05:30, no daylight saving).
 * Written out by hand rather than with `Intl` so the server and the browser can never disagree. Empty when unreadable.
 */
export function formatInstant(iso: string | null): string {
  if (iso === null) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + IST_OFFSET_MS)
  const hour = d.getUTCHours()
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const minute = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h12}:${minute} ${hour < 12 ? 'am' : 'pm'}`
}

/** The calendar date of a slot id `<window>~<yyyy-MM-dd>`, or null. */
export function slotDate(slotId: string): string | null {
  const date = slotId.split('~')[1]
  return date !== undefined && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ? date : null
}
