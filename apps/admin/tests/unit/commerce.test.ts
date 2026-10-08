import { beforeAll, describe, expect, it } from 'vitest'
import { stockState } from '@/lib/commerce'
import { MAX_PAISE, formatPaise, paiseToInput, parseRupees } from '@/lib/money'

describe('money', () => {
  it.each([
    ['129', 12900],
    ['129.5', 12950],
    ['129.50', 12950],
    ['0', 0],
    ['0.05', 5],
    ['10000000', MAX_PAISE],
    [' 1.01 ', 101],
  ])('parses %s as %i paise exactly', (text, paise) => {
    expect(parseRupees(text)).toEqual({ ok: true, paise })
  })
  it.each([
    '',
    'abc',
    '-1',
    '1e3',
    '1,000',
    '1.234',
    '.5',
    '1.',
    '10000000.01',
    '99999999999',
    '₹5',
    '0x10',
  ])('rejects %j', (text) => expect(parseRupees(text).ok).toBe(false))
  it('is float-safe where naive multiplication is not (e.g. 1.15, 4.35, 8.2)', () => {
    expect(parseRupees('1.15')).toEqual({ ok: true, paise: 115 })
    expect(parseRupees('4.35')).toEqual({ ok: true, paise: 435 })
    expect(parseRupees('8.2')).toEqual({ ok: true, paise: 820 })
  })
  it('round-trips paise to input text and formats rupees', () => {
    expect(paiseToInput(12950)).toBe('129.50')
    expect(paiseToInput(5)).toBe('0.05')
    expect(parseRupees(paiseToInput(123456789))).toEqual({ ok: true, paise: 123456789 })
    expect(formatPaise(12950)).toContain('129.50')
  })
})

describe('stockState', () => {
  it('uses available (on-hand minus reserved), not on-hand', () => {
    expect(stockState({ available: 0, lowStockThreshold: 5, active: true }).label).toBe(
      'Out of stock',
    )
    expect(stockState({ available: 5, lowStockThreshold: 5, active: true }).label).toBe('Low stock')
    expect(stockState({ available: 6, lowStockThreshold: 5, active: true }).label).toBe('In stock')
    expect(stockState({ available: 9, lowStockThreshold: 5, active: false }).label).toBe('Inactive')
  })
})

describe('commerce BFF specs', () => {
  let a: typeof import('@/server/bff/commerce-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/commerce-actions')
  })
  it('price: fixed INR call; create has no version, update has If-version in body; MRP >= selling enforced', () => {
    const create = a.setPriceMutation.input.parse({
      skuId: 'TZP-1',
      sellingPricePaise: 100,
      mrpPaise: 120,
    })
    expect(a.setPriceMutation.backend(create)).toEqual({
      path: '/api/v1/admin/prices/TZP-1',
      body: { sellingPricePaise: 100, mrpPaise: 120, currency: 'INR' },
    })
    const upd = a.setPriceMutation.input.parse({
      skuId: 'TZP-1',
      sellingPricePaise: 100,
      mrpPaise: 100,
      expectedVersion: 3,
    })
    expect(a.setPriceMutation.backend(upd).body).toMatchObject({ expectedVersion: 3 })
    expect(
      a.setPriceMutation.input.safeParse({ skuId: 'TZP-1', sellingPricePaise: 200, mrpPaise: 100 })
        .success,
    ).toBe(false)
    expect(
      a.setPriceMutation.input.safeParse({ skuId: 'TZP-1', sellingPricePaise: 1.5, mrpPaise: 100 })
        .success,
    ).toBe(false)
    expect(
      a.setPriceMutation.input.safeParse({
        skuId: 'TZP-1',
        sellingPricePaise: 1,
        mrpPaise: MAX_PAISE + 1,
      }).success,
    ).toBe(false)
    expect(
      a.setPriceMutation.input.safeParse({
        skuId: 'TZP-1',
        sellingPricePaise: 1,
        mrpPaise: 2,
        currency: 'USD',
      }).success,
    ).toBe(false)
  })
  it('inventory: absolute set with bounded ints; ids cannot escape the path', () => {
    const ok = a.setInventoryMutation.input.parse({
      skuId: 'TZP-1',
      locationId: 'LOC-1',
      onHand: 10,
      lowStockThreshold: 2,
      maxPurchasable: 5,
      expectedVersion: 2,
    })
    expect(a.setInventoryMutation.backend(ok)).toEqual({
      path: '/api/v1/admin/inventory/TZP-1/LOC-1',
      body: { onHand: 10, lowStockThreshold: 2, maxPurchasable: 5, expectedVersion: 2 },
    })
    const bad = (over: object) =>
      a.setInventoryMutation.input.safeParse({
        skuId: 'TZP-1',
        locationId: 'LOC-1',
        onHand: 1,
        lowStockThreshold: 0,
        maxPurchasable: 0,
        ...over,
      }).success
    expect(bad({})).toBe(true)
    expect(bad({ onHand: -1 })).toBe(false)
    expect(bad({ onHand: 1_000_001 })).toBe(false)
    expect(bad({ locationId: '../x' })).toBe(false)
    expect(bad({ reserved: 5 })).toBe(false)
  })
  it('toggle requires a version', () => {
    const t = a.inventoryToggleMutation('deactivate')
    expect(t.input.safeParse({ skuId: 'TZP-1', locationId: 'L', expectedVersion: 0 }).success).toBe(
      false,
    )
    expect(t.backend({ skuId: 'TZP-1', locationId: 'L', expectedVersion: 4 }).path).toBe(
      '/api/v1/admin/inventory/TZP-1/L/deactivate',
    )
  })
})
