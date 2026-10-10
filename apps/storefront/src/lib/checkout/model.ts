import type { Address } from '@/lib/address/model'

/**
 * The checkout quote as the storefront models it, and the rules shared by the browser and the server. Mirrors the
 * backend contract (tazzzo-backend `CheckoutQuoteDto`, `CheckoutItemReason`). Pure; client-safe.
 *
 * A quote is a validated snapshot, NOT a reservation and NOT a price lock: its `moneyPreview` is advisory, and the
 * order placement computes the authoritative money and may differ. The backend adds no delivery fee, tax or tip to
 * it (`payable = merchandise subtotal - benefit discount`), so none is shown.
 */
export const QUOTE_ID = /^CHKQ_[A-Za-z0-9_-]{6,64}$/

export const isQuoteId = (value: unknown): value is string =>
  typeof value === 'string' && QUOTE_ID.test(value)

export interface QuoteLine {
  productId: string
  quantity: number
  unitPricePaise: number
  lineTotalPaise: number
}

export interface Quote {
  quoteId: string
  cartVersion: number
  addressId: string
  lines: QuoteLine[]
  itemCount: number
  subtotalPaise: number
  /** The quote's end of life (ms since epoch), or null when the backend sent something unreadable. */
  expiresAt: number | null
  /** The advisory Benefits result; null on a quote that carries none (NOT the same as "not applied"). */
  benefit: { applied: boolean; discountPaise: number; discountBps: number } | null
  /** The advisory money; null on a quote that carries none (NEVER a zero payable). */
  money: {
    merchandiseSubtotalPaise: number
    benefitDiscountPaise: number
    payablePaise: number
  } | null
}

/** What the customer would owe on delivery according to the quote, or null when the quote carries no money. */
export const quotePayablePaise = (quote: Pick<Quote, 'money'>): number | null =>
  quote.money?.payablePaise ?? null

/** The closed reasons a cart line blocks a quote (`CheckoutItemReason`); anything newer reads as `NOT_BUYABLE`. */
export const ITEM_REASONS = [
  'PRODUCT_UNAVAILABLE',
  'PRICE_UNAVAILABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'STOCK_UNKNOWN',
  'NOT_BUYABLE',
] as const
export type ItemReason = (typeof ITEM_REASONS)[number]

export function itemReasonOf(code: string): ItemReason {
  return (ITEM_REASONS as readonly string[]).includes(code) ? (code as ItemReason) : 'NOT_BUYABLE'
}

export const ITEM_REASON_TEXT: Record<ItemReason, string> = {
  PRODUCT_UNAVAILABLE: 'No longer available.',
  PRICE_UNAVAILABLE: 'Price unavailable right now.',
  OUT_OF_STOCK: 'Out of stock.',
  INSUFFICIENT_STOCK: 'Not enough stock for this quantity.',
  STOCK_UNKNOWN: 'We could not confirm stock for this item.',
  NOT_BUYABLE: 'This item cannot be bought right now.',
}

/** One line of the review: the quote's line (price, quantity) with the cart's title, image and MRP for display. */
export interface ReviewLine {
  productId: string
  title: string | null
  imageUrl: string | null
  quantity: number
  unitPricePaise: number
  /** From the cart's current enrichment; shown struck through only when higher than the price. */
  mrpPaise: number | null
  lineTotalPaise: number
}

/** Everything the review screen shows, all taken from backend answers; the customer supplies none of it. */
export interface ReviewView {
  quoteId: string
  cartVersion: number
  addressId: string
  slotId: string
  lines: ReviewLine[]
  itemCount: number
  subtotalPaise: number
  discountPaise: number
  /** The advisory payable amount; null when the quote carries no money (never shown as zero). */
  payablePaise: number | null
  expiresAt: number | null
  address: Address
  slot: { slotId: string; label: string; date: string; window: string }
}

/** A cart line the quote refused, with the closed reason. */
export interface BlockedLine {
  productId: string
  title: string | null
  imageUrl: string | null
  quantity: number
  reason: ItemReason
}
