import { describe, expect, it } from 'vitest'
import { cartErrorMessage, signInUrl } from '@/lib/cart/messages'
import {
  lineBlocked,
  lineMaxQuantity,
  lineNotes,
  unpricedCount,
  type Cart,
  type CartIssue,
  type CartLine,
} from '@/lib/cart/model'
import {
  ifMatch,
  isCartVersion,
  isQuantity,
  parseAdd,
  parseClear,
  parseRemove,
  parseSet,
} from '@/lib/cart/validation'

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: 'TZP-1001',
  quantity: 2,
  title: 'Basmati Rice 5 kg',
  brandCode: null,
  imageUrl: null,
  unitPricePaise: 49900,
  mrpPaise: 59900,
  lineTotalPaise: 99800,
  stockState: 'UNKNOWN',
  maxOrderQuantity: 0,
  serviceable: null,
  buyable: false,
  issues: [],
  ...over,
})
const withIssues = (...issues: CartIssue[]) => line({ issues })

describe('quantity and version bounds', () => {
  it('accepts exactly the integers 1..20', () => {
    for (const ok of [1, 2, 19, 20]) expect(isQuantity(ok), String(ok)).toBe(true)
    for (const bad of [0, -1, 21, 100, 1.5, NaN, Infinity, '2', null, undefined, [2], {}]) {
      expect(isQuantity(bad), String(bad)).toBe(false)
    }
  })

  it('accepts cart versions 0..10^15-1 (the backend If-Match allows 15 digits) and nothing else', () => {
    for (const ok of [0, 1, 999_999_999_999_999]) expect(isCartVersion(ok)).toBe(true)
    for (const bad of [-1, 1e15, 1.2, NaN, '3', null]) expect(isCartVersion(bad)).toBe(false)
    expect(ifMatch(7)).toBe('"cart-7"')
  })
})

describe('request bodies', () => {
  it('parses exactly the expected fields', () => {
    expect(parseAdd({ productId: 'TZP-1001', quantity: 3 })).toEqual({
      productId: 'TZP-1001',
      quantity: 3,
    })
    expect(parseSet({ productId: 'TZP-1001', quantity: 20, version: 4 })).toEqual({
      productId: 'TZP-1001',
      quantity: 20,
      version: 4,
    })
    expect(parseRemove({ productId: 'TZP-1001', version: 0 })).toEqual({
      productId: 'TZP-1001',
      version: 0,
    })
    expect(parseClear({ version: 9 })).toEqual({ version: 9 })
  })

  it('refuses a missing, extra or mistyped field (no price, customer or cart id can ride along)', () => {
    expect(parseAdd({ productId: 'TZP-1001' })).toBeNull()
    expect(parseAdd({ productId: 'TZP-1001', quantity: 1, price: 1 })).toBeNull()
    expect(parseAdd({ productId: 'TZP-1001', quantity: 1, customerId: 'CUS_x' })).toBeNull()
    expect(parseAdd({ productId: 'TZP-1001', quantity: '1' })).toBeNull()
    expect(parseSet({ productId: 'TZP-1001', quantity: 1 })).toBeNull()
    expect(parseRemove({ productId: 'TZP-1001', version: -1 })).toBeNull()
    expect(parseClear({})).toBeNull()
    expect(parseClear({ version: 1, extra: true })).toBeNull()
  })

  it('applies the canonical product id grammar without any case change', () => {
    expect(parseAdd({ productId: 'TZP-Mix-7', quantity: 1 })?.productId).toBe('TZP-Mix-7')
    for (const bad of [
      'tzp-1',
      'Tzp-1',
      'TZP-',
      'TZP-' + 'A'.repeat(41),
      'TZP-1 ',
      ' TZP-1',
      'TZP-1\n',
      'TZP-a/b',
      'TZP-%2e',
      'TZS-000001',
      '../cart',
      '',
      7,
      null,
    ]) {
      expect(parseAdd({ productId: bad, quantity: 1 }), String(bad)).toBeNull()
      expect(parseRemove({ productId: bad, version: 1 }), String(bad)).toBeNull()
    }
    expect(parseAdd({ productId: 'TZP-' + 'A'.repeat(40), quantity: 1 })).not.toBeNull()
  })
})

describe('messages', () => {
  it('has a safe sentence for every code, and never echoes backend text', () => {
    for (const code of [
      'unauthenticated',
      'forbidden',
      'bad_request',
      'conflict',
      'not_found',
      'item_limit',
      'quantity_limit',
      'rate_limited',
      'unavailable',
      'anything-else',
    ]) {
      expect(cartErrorMessage(code)).toMatch(/^[A-Z].*\.$/)
    }
    expect(cartErrorMessage('rate_limited', 42)).toBe(
      'Too many requests. Please wait 42 seconds and try again.',
    )
    expect(cartErrorMessage('bad_request')).toContain('between 1 and 20')
    expect(cartErrorMessage('not_found; stack trace at com.tazzzo')).not.toContain('com.tazzzo')
  })

  it('builds a sign-in link carrying an encoded return path', () => {
    expect(signInUrl('/p/TZP-1')).toBe('/login?next=%2Fp%2FTZP-1')
  })
})

describe('line states, exactly as the backend reports them', () => {
  it('shows each blocking issue and blocks the line', () => {
    const cases: Array<[CartIssue, RegExp]> = [
      ['PRODUCT_UNAVAILABLE', /No longer available/],
      ['OUT_OF_STOCK', /Out of stock/],
      ['INSUFFICIENT_STOCK', /Lower the quantity/],
      ['UNSERVICEABLE', /Not deliverable/],
      ['PRICE_UNAVAILABLE', /Price unavailable/],
      ['STOCK_UNKNOWN', /could not confirm stock/],
      ['ENRICHMENT_UNAVAILABLE', /could not refresh/],
      ['UNRECOGNISED', /needs attention/],
    ]
    for (const [issue, text] of cases) {
      const l = withIssues(issue)
      expect(lineNotes(l)[0], issue).toMatchObject({ tone: 'blocking' })
      expect(lineNotes(l)[0]?.text, issue).toMatch(text)
      expect(lineBlocked(l), issue).toBe(true)
    }
  })

  it('names the available quantity on INSUFFICIENT_STOCK', () => {
    const l = line({ issues: ['INSUFFICIENT_STOCK'], maxOrderQuantity: 2, stockState: 'IN_STOCK' })
    expect(lineNotes(l)[0]?.text).toBe('Only 2 available. Lower the quantity to continue.')
  })

  it('treats PRICE_CHANGED and LOCATION_REQUIRED as information that does not block', () => {
    const l = withIssues('PRICE_CHANGED', 'LOCATION_REQUIRED')
    expect(lineNotes(l).map((n) => n.tone)).toEqual(['info', 'info'])
    expect(lineBlocked(l)).toBe(false)
  })

  it('blocks a line the backend calls not buyable without saying why, but not a clean buyable one', () => {
    expect(lineBlocked(line({ buyable: false, issues: [] }))).toBe(true)
    expect(lineBlocked(line({ buyable: true, issues: [] }))).toBe(false)
    expect(lineNotes(line({ buyable: true }))).toEqual([])
  })

  it('caps the stepper at the known stock, never above 20, and ignores the 0 reported for unknown stock', () => {
    expect(lineMaxQuantity({ stockState: 'UNKNOWN', maxOrderQuantity: 0 })).toBe(20)
    expect(lineMaxQuantity({ stockState: 'IN_STOCK', maxOrderQuantity: 5 })).toBe(5)
    expect(lineMaxQuantity({ stockState: 'LOW_STOCK', maxOrderQuantity: 50 })).toBe(20)
    expect(lineMaxQuantity({ stockState: 'OUT_OF_STOCK', maxOrderQuantity: 0 })).toBe(20)
  })

  it('counts lines the subtotal leaves out', () => {
    const cart: Cart = {
      version: 1,
      lines: [line(), line({ lineTotalPaise: null })],
      itemCount: 4,
      subtotalPaise: 99800,
      freshness: 'FRESH',
    }
    expect(unpricedCount(cart)).toBe(1)
  })
})
