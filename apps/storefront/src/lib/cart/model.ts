/**
 * The customer cart as the storefront models it, and the rules shared by the browser and the server. Mirrors the
 * backend contract (tazzzo-backend `CartResponseDto`, `CartIssue`, `CartLimitProperties`); pure and client-safe.
 *
 * The backend's cart line key is the product id (`skuId` is the same canonical `TZP-` grammar; there is one sellable
 * unit per product). Prices are integer paise at the CURRENT price, never a locked or final payable amount.
 */
export const MAX_QUANTITY_PER_ITEM = 20 // backend default `tazzzo.customer-cart.max-quantity-per-item`
export const MAX_DISTINCT_ITEMS = 50 // backend default and hard cap `max-distinct-items`

export const CART_ISSUES = [
  'PRODUCT_UNAVAILABLE',
  'PRICE_UNAVAILABLE',
  'LOCATION_REQUIRED',
  'UNSERVICEABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'STOCK_UNKNOWN',
  'ENRICHMENT_UNAVAILABLE',
  'PRICE_CHANGED',
] as const
/** `UNRECOGNISED` stands for an issue code newer than this site knows: the line is kept and treated as needing attention. */
export type CartIssue = (typeof CART_ISSUES)[number] | 'UNRECOGNISED'

export type StockState = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN'

export interface CartLine {
  productId: string
  quantity: number
  title: string | null
  brandCode: string | null
  /** Already checked against the media allowlist by the server; null shows the placeholder. */
  imageUrl: string | null
  unitPricePaise: number | null
  mrpPaise: number | null
  lineTotalPaise: number | null
  stockState: StockState
  maxOrderQuantity: number
  serviceable: boolean | null
  buyable: boolean
  issues: CartIssue[]
}

export interface Cart {
  /** The cart's optimistic-concurrency version: every mutation must present the one it last saw. */
  version: number
  lines: CartLine[]
  /** Sum of quantities. */
  itemCount: number
  subtotalPaise: number
  /** `REVALIDATE`: the cart is over 24 h old and prices/availability deserve a second look. */
  freshness: 'FRESH' | 'REVALIDATE'
}

export interface LineNote {
  /** `blocking`: the line cannot be bought as it stands. `info`: worth knowing, does not block. */
  tone: 'blocking' | 'info'
  text: string
}

/** What to tell the customer about a line, in the backend's own vocabulary (the issue codes), most important first. */
export function lineNotes(line: CartLine): LineNote[] {
  const notes: LineNote[] = []
  const has = (issue: CartIssue) => line.issues.includes(issue)
  if (has('PRODUCT_UNAVAILABLE')) {
    notes.push({ tone: 'blocking', text: 'No longer available. Remove it to continue.' })
  }
  if (has('OUT_OF_STOCK')) notes.push({ tone: 'blocking', text: 'Out of stock.' })
  if (has('INSUFFICIENT_STOCK')) {
    notes.push({
      tone: 'blocking',
      text:
        line.maxOrderQuantity > 0
          ? `Only ${line.maxOrderQuantity} available. Lower the quantity to continue.`
          : 'Not enough stock for this quantity. Lower the quantity to continue.',
    })
  }
  if (has('UNSERVICEABLE')) {
    notes.push({ tone: 'blocking', text: 'Not deliverable to your delivery location.' })
  }
  if (has('PRICE_UNAVAILABLE')) {
    notes.push({ tone: 'blocking', text: 'Price unavailable right now.' })
  }
  if (has('STOCK_UNKNOWN')) {
    notes.push({ tone: 'blocking', text: 'We could not confirm stock for this item yet.' })
  }
  if (has('ENRICHMENT_UNAVAILABLE')) {
    notes.push({
      tone: 'blocking',
      text: 'We could not refresh this item just now. Try again in a moment.',
    })
  }
  if (has('UNRECOGNISED')) {
    notes.push({ tone: 'blocking', text: 'This item needs attention before you can buy it.' })
  }
  if (has('PRICE_CHANGED')) {
    notes.push({
      tone: 'info',
      text: 'The price changed since you added this. You see the current price.',
    })
  }
  if (has('LOCATION_REQUIRED')) {
    notes.push({
      tone: 'info',
      text: 'Stock and delivery are confirmed once a delivery address is chosen.',
    })
  }
  return notes
}

/**
 * True when the line cannot be bought as it stands: a blocking issue, or `buyable: false` with no reason given. A
 * location that is merely unknown (no delivery address yet) is not blocking, though the backend then reports
 * `buyable: false` for every line.
 */
export function lineBlocked(line: CartLine): boolean {
  return (
    lineNotes(line).some((n) => n.tone === 'blocking') ||
    (!line.buyable && line.issues.length === 0)
  )
}

/** The largest quantity the stepper offers: the bound, or less when the backend reports a known lower stock cap. */
export function lineMaxQuantity(line: Pick<CartLine, 'stockState' | 'maxOrderQuantity'>): number {
  const known = line.stockState === 'IN_STOCK' || line.stockState === 'LOW_STOCK'
  return known && line.maxOrderQuantity > 0
    ? Math.min(MAX_QUANTITY_PER_ITEM, line.maxOrderQuantity)
    : MAX_QUANTITY_PER_ITEM
}

/** Lines the backend could not price, so the subtotal does not include them. */
export function unpricedCount(cart: Cart): number {
  return cart.lines.filter((l) => l.lineTotalPaise === null).length
}
