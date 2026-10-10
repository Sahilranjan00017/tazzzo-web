import { describe, expect, it } from 'vitest'
import {
  PLACE_ACTION,
  isPlaceError,
  placeErrorMessage,
  type PlaceError,
} from '@/lib/checkout/messages'
import { orderErrorMessage } from '@/lib/orders/messages'
import {
  ITEM_REASONS,
  ITEM_REASON_TEXT,
  isQuoteId,
  itemReasonOf,
  quotePayablePaise,
} from '@/lib/checkout/model'

/** The closed vocabularies the screens speak: every code has one message and one next step; unknown input has neither a hole nor a leak. */
describe('placing an order: the closed set of outcomes', () => {
  const ALL = Object.keys(PLACE_ACTION) as PlaceError[]

  it('every outcome has its own non-empty message, and none repeats another', () => {
    const messages = ALL.map((e) => placeErrorMessage(e))
    expect(messages.every((m) => m.length > 20)).toBe(true)
    expect(new Set(messages).size).toBe(ALL.length)
  })

  it('an outcome this site does not know reads as the generic "no order was placed" message, never as the raw code', () => {
    for (const odd of ['PRICE_CHANGED', 'secret internal detail', '', 'constructor', '__proto__']) {
      const text = placeErrorMessage(odd)
      expect(text).toContain('No order was placed')
      expect(text).not.toContain(odd || 'never-empty')
      expect(isPlaceError(odd)).toBe(false)
    }
  })

  it('only "unknown" admits the order may exist; every other message says nothing was ordered or asks to review', () => {
    expect(placeErrorMessage('unknown')).toContain(
      'could not confirm whether your order was placed',
    )
    expect(placeErrorMessage('unknown')).toContain('Check your orders')
    for (const e of ALL.filter((x) => x !== 'unknown')) {
      expect(placeErrorMessage(e)).not.toContain('could not confirm whether')
    }
  })

  it('the next step is: sign in, re-render, back to delivery, orders, or the same retry', () => {
    expect(PLACE_ACTION).toEqual({
      unauthenticated: 'signin',
      forbidden: 'retry',
      bad_request: 'refresh',
      choice_changed: 'refresh',
      cart_changed: 'refresh',
      quote_expired: 'refresh',
      price_changed: 'refresh',
      items_unavailable: 'refresh',
      slot_unavailable: 'delivery',
      address_changed: 'delivery',
      unserviceable: 'delivery',
      already_ordered: 'orders',
      hold_expired: 'retry',
      rate_limited: 'retry',
      unavailable: 'retry',
      unknown: 'retry',
    })
  })

  it('a rate limit says how long to wait, in the customer’s units', () => {
    expect(placeErrorMessage('rate_limited', null)).toContain('a moment')
    expect(placeErrorMessage('rate_limited', 42)).toContain('42 seconds')
    expect(placeErrorMessage('rate_limited', 120)).toContain('2 minutes')
  })
})

describe('order read and cancel messages', () => {
  it('window_closed is the graceful "cancelling is not available" (the backend default), not an error code', () => {
    expect(orderErrorMessage('window_closed')).toContain('not available')
    expect(orderErrorMessage('window_closed')).not.toContain('CANCELLATION')
    expect(orderErrorMessage('not_cancellable')).toContain('can no longer be cancelled')
    expect(orderErrorMessage('not_found')).toBe('We could not find that order.')
    expect(orderErrorMessage('INTERNAL')).toContain('try again')
  })
})

describe('quote model', () => {
  it('quote ids follow the backend grammar', () => {
    expect(isQuoteId('CHKQ_abcdef')).toBe(true)
    for (const bad of ['', 'CHKQ_abc', 'CHKQ_../x', 'chkq_abcdefgh', 'ORD_abcdefgh', null]) {
      expect(isQuoteId(bad)).toBe(false)
    }
  })
  it('every item reason has text; a reason from a newer backend fails closed to "cannot be bought"', () => {
    for (const reason of ITEM_REASONS) expect(ITEM_REASON_TEXT[reason].length).toBeGreaterThan(5)
    expect(itemReasonOf('OUT_OF_STOCK')).toBe('OUT_OF_STOCK')
    expect(itemReasonOf('WAREHOUSE_ON_FIRE')).toBe('NOT_BUYABLE')
  })
  it('a quote with no money has no payable', () => {
    expect(quotePayablePaise({ money: null })).toBeNull()
    expect(
      quotePayablePaise({
        money: { merchandiseSubtotalPaise: 5, benefitDiscountPaise: 1, payablePaise: 4 },
      }),
    ).toBe(4)
  })
})
