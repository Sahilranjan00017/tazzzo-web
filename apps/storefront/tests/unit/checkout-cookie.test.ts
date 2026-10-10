import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADDR,
  SLOT,
  fetchMock,
  jar,
  loadEnv,
  resetFetch,
  reply,
  routeBackend,
  addressBody,
  slotsBody,
} from './checkout-fixtures'

vi.mock('next/headers', () => ({ cookies: async () => jar }))

/** The sealed checkout cookie: the delivery choice plus the attempt's quote seed. */
beforeEach(() => resetFetch([]))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('checkout cookie', () => {
  it('a delivery choice gets a fresh random seed every time it is saved', async () => {
    const r = await loadEnv()
    await r.cookies.writeCheckoutChoice({ customerId: 'CUS_1', addressId: ADDR, slotId: SLOT })
    const a = (await r.cookies.readCheckoutChoice())!.quoteKey
    await r.cookies.writeCheckoutChoice({ customerId: 'CUS_1', addressId: ADDR, slotId: SLOT })
    const b = (await r.cookies.readCheckoutChoice())!.quoteKey
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('saving the choice through the delivery route starts a new attempt', async () => {
    const r = await loadEnv()
    routeBackend({
      [`GET /v1/customer/addresses/${ADDR}`]: () => reply(200, addressBody()),
      'GET /v1/customer/delivery/slots?pin=560001': () => reply(200, slotsBody()),
    })
    const { chooseDelivery } = await import('@/server/delivery/service')
    const session = (await r.cookies.readSession())!
    await chooseDelivery(session, ADDR, SLOT)
    const a = (await r.cookies.readCheckoutChoice())!.quoteKey
    await chooseDelivery(session, ADDR, SLOT)
    expect((await r.cookies.readCheckoutChoice())!.quoteKey).not.toBe(a)
  })

  it('rotation replaces only the seed and keeps the expiry; the cookie never outlives the choice', async () => {
    const r = await loadEnv()
    await r.cookies.writeCheckoutChoice({ customerId: 'CUS_1', addressId: ADDR, slotId: SLOT })
    const before = (await r.cookies.readCheckoutChoice())!
    const later = before.expiresAt - 600_000
    await r.cookies.rotateCheckoutQuoteKey(before, later)
    const after = (await r.cookies.readCheckoutChoice())!
    expect(after).toEqual({ ...before, quoteKey: after.quoteKey })
    expect(after.quoteKey).not.toBe(before.quoteKey)
    expect(jar.set_.get('__Host-tz_checkout')!.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    })
    expect(await r.cookies.readCheckoutChoice(before.expiresAt + 1)).toBeNull()
  })

  it('a cookie without a seed (an older one) is not a choice: the customer is sent back to the delivery step', async () => {
    const r = await loadEnv()
    const { seal } = await import('@/server/session/seal')
    const { serverEnv } = await import('@/server/env')
    const expiresAt = Date.now() + 600_000
    jar.set(
      '__Host-tz_checkout',
      seal(
        'checkout',
        { customerId: 'CUS_1', addressId: ADDR, slotId: SLOT, expiresAt },
        expiresAt,
        serverEnv().sessionKeys!,
      ),
    )
    expect(await r.cookies.readCheckoutChoice()).toBeNull()
  })

  it('a seed that is not 43 URL-safe characters is not accepted', async () => {
    const r = await loadEnv()
    const { seal } = await import('@/server/session/seal')
    const { serverEnv } = await import('@/server/env')
    const expiresAt = Date.now() + 600_000
    for (const quoteKey of ['short', 'x'.repeat(44), `${'x'.repeat(42)}/`]) {
      jar.set(
        '__Host-tz_checkout',
        seal(
          'checkout',
          { customerId: 'CUS_1', addressId: ADDR, slotId: SLOT, quoteKey, expiresAt },
          expiresAt,
          serverEnv().sessionKeys!,
        ),
      )
      expect(await r.cookies.readCheckoutChoice()).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
