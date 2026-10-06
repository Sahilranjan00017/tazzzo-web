import { beforeAll, describe, expect, it } from 'vitest'
import { moduleHref } from '@/lib/nav'
import {
  TRANSITIONS,
  orderErrorMessage,
  orderListPath,
  parseOrderListQuery,
  staffOrderSchema,
} from '@/lib/orders'
import { canOperateOrders, canWorkSupport } from '@/lib/roles'

describe('order list query', () => {
  it('sends only a valid status/cursor and always a page size', () => {
    expect(orderListPath(parseOrderListQuery({}))).toBe('/api/v1/admin/orders?page_size=20')
    expect(
      orderListPath(parseOrderListQuery({ status: 'CONFIRMED', cursor: 'djF8MTIzfG9yZA' })),
    ).toBe('/api/v1/admin/orders?status=CONFIRMED&cursor=djF8MTIzfG9yZA&page_size=20')
  })
  it('drops CREATED (internal), unknown statuses and malformed cursors', () => {
    expect(parseOrderListQuery({ status: 'CREATED' })).toEqual({})
    expect(parseOrderListQuery({ status: 'x', cursor: 'a b&c' })).toEqual({})
    expect(parseOrderListQuery({ cursor: 'x'.repeat(129) })).toEqual({})
  })
})

describe('state machine and roles', () => {
  it('offers only the backend edges', () => {
    expect(TRANSITIONS.CONFIRMED).toEqual(['OUT_FOR_DELIVERY', 'CANCELLED'])
    expect(TRANSITIONS.OUT_FOR_DELIVERY).toEqual(['DELIVERED', 'CANCELLED'])
    expect(TRANSITIONS.DELIVERED).toBeUndefined()
    expect(TRANSITIONS.CANCELLED).toBeUndefined()
  })
  it('order-ops operates orders; support-agent and general roles do not; support is support-agent only', () => {
    expect(canOperateOrders(['order-ops'])).toBe(true)
    expect(canOperateOrders(['support-agent', 'reader', 'cms-writer', 'audit-reader'])).toBe(false)
    expect(canWorkSupport(['support-agent'])).toBe(true)
    expect(canWorkSupport(['order-ops'])).toBe(false)
  })
  it('does not link a module to a viewer whose roles the backend refuses', () => {
    expect(moduleHref('orders', ['reader', 'cms-writer'])).toBeUndefined()
    expect(moduleHref('orders', ['order-ops'])).toBe('/orders')
  })
})

describe('staff order schema', () => {
  it('accepts the documented shape with omitted nulls', () => {
    const parsed = staffOrderSchema.parse({
      orderId: 'O-1',
      status: 'CONFIRMED',
      version: 2,
      lines: [
        { skuId: 'TZP-1', title: 'Rice', quantity: 2, unitPricePaise: 100, lineTotalPaise: 200 },
      ],
    })
    expect(parsed.deliveryAddress).toBeUndefined()
  })
  it('rejects a body without the identity fields', () => {
    expect(staffOrderSchema.safeParse({ status: 'CONFIRMED' }).success).toBe(false)
  })
})

describe('order error copy', () => {
  const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
  it('names state-machine and stale conflicts, and warns that 5xx was not retried', () => {
    expect(orderErrorMessage(f(409, 'INVALID_TRANSITION'))).toMatch(/not allowed/)
    expect(orderErrorMessage(f(409, 'STALE_VERSION'))).toMatch(/changed since you loaded/)
    expect(orderErrorMessage(f(502))).toMatch(/not retried/)
    expect(orderErrorMessage(f(403))).toMatch(/not permitted/)
  })
})

describe('order transition spec', () => {
  let a: typeof import('@/server/bff/order-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/order-actions')
  })
  const s = () => a.orderTransitionMutation
  it('cancel requires a staff reason; other targets forbid one', () => {
    expect(
      s().input.safeParse({ orderId: 'O-1', to: 'CANCELLED', expectedVersion: 2 }).success,
    ).toBe(false)
    expect(
      s().input.safeParse({
        orderId: 'O-1',
        to: 'CANCELLED',
        expectedVersion: 2,
        reason: 'OUT_OF_STOCK',
      }).success,
    ).toBe(true)
    expect(
      s().input.safeParse({
        orderId: 'O-1',
        to: 'CANCELLED',
        expectedVersion: 2,
        reason: 'CHANGED_MIND',
      }).success,
    ).toBe(false)
    expect(
      s().input.safeParse({ orderId: 'O-1', to: 'DELIVERED', expectedVersion: 3, reason: 'OTHER' })
        .success,
    ).toBe(false)
  })
  it('refuses CONFIRMED/CREATED as targets, extra keys and bad versions', () => {
    for (const to of ['CONFIRMED', 'CREATED', 'ARCHIVED'])
      expect(s().input.safeParse({ orderId: 'O-1', to, expectedVersion: 2 }).success).toBe(false)
    expect(
      s().input.safeParse({ orderId: 'O-1', to: 'DELIVERED', expectedVersion: 0 }).success,
    ).toBe(false)
    expect(
      s().input.safeParse({ orderId: 'O-1', to: 'DELIVERED', expectedVersion: 3, status: 'x' })
        .success,
    ).toBe(false)
  })
  it('sends exactly to/expectedVersion/(reason) to a fixed path', () => {
    expect(s().backend({ orderId: 'O-1', to: 'OUT_FOR_DELIVERY', expectedVersion: 2 })).toEqual({
      path: '/api/v1/admin/orders/O-1/transition',
      body: { to: 'OUT_FOR_DELIVERY', expectedVersion: 2 },
    })
    expect(
      s().backend({ orderId: 'O-1', to: 'CANCELLED', expectedVersion: 3, reason: 'OTHER' }).body,
    ).toEqual({
      to: 'CANCELLED',
      expectedVersion: 3,
      reason: 'OTHER',
    })
  })
})
