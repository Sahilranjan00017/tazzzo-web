import { beforeAll, describe, expect, it } from 'vitest'
import {
  AREA_ID,
  PINCODE,
  WINDOW_ID,
  areaListPath,
  areaWriteInput,
  deliveryErrorMessage,
  formatDays,
  formatWindow,
  minuteToTime,
  parseAreaListQuery,
  timeToMinute,
  windowWriteInput,
} from '@/lib/delivery'

describe('delivery lib', () => {
  it('converts minute-of-day and HH:MM both ways, including the 24:00 end', () => {
    expect(minuteToTime(0)).toBe('00:00')
    expect(minuteToTime(1080)).toBe('18:00')
    expect(minuteToTime(1439)).toBe('23:59')
    expect(timeToMinute('18:30')).toBe(1110)
    expect(timeToMinute('24:00')).toBe(1440)
    for (const bad of ['', '7:00', '25:00', '12:60', 'ab:cd', '12:5'])
      expect(timeToMinute(bad)).toBeUndefined()
    expect(formatWindow({ startMinute: 1080, endMinute: 1200 })).toBe('18:00–20:00')
  })
  it('formats days', () => {
    expect(formatDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day')
    expect(formatDays([6, 7])).toBe('Sat, Sun')
  })
  it('validates identifiers that go into URLs', () => {
    expect(PINCODE.test('560047')).toBe(true)
    for (const bad of ['060047', '56004', '5600477', 'abcdef'])
      expect(PINCODE.test(bad)).toBe(false)
    expect(AREA_ID.test('Ejipura 1')).toBe(true)
    for (const bad of ['a|b', '../x', '', 'a/b']) expect(AREA_ID.test(bad)).toBe(false)
    expect(WINDOW_ID.test('evening-1')).toBe(true)
    for (const bad of ['Evening', '-x', 'a'.repeat(33), 'a b'])
      expect(WINDOW_ID.test(bad)).toBe(false)
  })
  it('area list path: pincode cursor only, bounded limit', () => {
    expect(areaListPath(parseAreaListQuery({}))).toBe('/api/v1/admin/service-areas?limit=50')
    expect(areaListPath(parseAreaListQuery({ after: '560047' }))).toBe(
      '/api/v1/admin/service-areas?limit=50&after=560047',
    )
    expect(parseAreaListQuery({ after: 'x' })).toEqual({})
  })
  it('error copy', () => {
    const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
    expect(deliveryErrorMessage(f(422, 'INVALID_DELIVERY_WINDOW'))).toMatch(/delivery window/)
    expect(deliveryErrorMessage(f(409, 'STALE_VERSION'))).toMatch(/changed since you loaded/)
    expect(deliveryErrorMessage(f(404))).toMatch(/does not exist/)
  })
})

describe('area write schema', () => {
  const ok = {
    pincode: '560047',
    serviceAreaId: 'Ejipura',
    routes: [
      { fulfillmentLocationId: 'LOC-1', priority: 0, active: true },
      { fulfillmentLocationId: 'LOC-2', priority: 1, active: false },
    ],
  }
  it('accepts unique routes, empty routes, and a version', () => {
    expect(areaWriteInput.safeParse(ok).success).toBe(true)
    expect(areaWriteInput.safeParse({ ...ok, routes: [] }).success).toBe(true)
    expect(areaWriteInput.safeParse({ ...ok, expectedVersion: 3 }).success).toBe(true)
  })
  it('rejects duplicate locations/priorities, >20 routes, bad ids and unknown keys', () => {
    const dupLoc = {
      ...ok,
      routes: [ok.routes[0]!, { ...ok.routes[1]!, fulfillmentLocationId: 'LOC-1' }],
    }
    const dupPri = { ...ok, routes: [ok.routes[0]!, { ...ok.routes[1]!, priority: 0 }] }
    const many = {
      ...ok,
      routes: Array.from({ length: 21 }, (_, i) => ({
        fulfillmentLocationId: `L${i}`,
        priority: i,
        active: true,
      })),
    }
    for (const bad of [
      dupLoc,
      dupPri,
      many,
      { ...ok, pincode: '000000' },
      { ...ok, serviceAreaId: 'a|b' },
      { ...ok, active: true },
    ])
      expect(areaWriteInput.safeParse(bad).success).toBe(false)
  })
})

describe('window write schema', () => {
  const ok = {
    serviceAreaId: 'Ejipura',
    windowId: 'evening',
    label: 'Evening',
    startMinute: 1080,
    endMinute: 1200,
    cutoffMinutes: 60,
    capacity: 20,
    days: [1, 2, 3],
  }
  it('accepts a valid window', () => expect(windowWriteInput.safeParse(ok).success).toBe(true))
  it.each([
    ['end before start', { startMinute: 1200, endMinute: 1080 }],
    ['end equals start', { startMinute: 600, endMinute: 600 }],
    ['capacity 0', { capacity: 0 }],
    ['capacity too big', { capacity: 100001 }],
    ['cutoff too big', { cutoffMinutes: 10081 }],
    ['no days', { days: [] }],
    ['day 8', { days: [8] }],
    ['duplicate days', { days: [1, 1] }],
    ['blank label', { label: '  ' }],
    ['long label', { label: 'x'.repeat(61) }],
    ['bad window id', { windowId: 'Bad Id' }],
    ['start 1440', { startMinute: 1440 }],
  ])('rejects %s', (_n, patch) =>
    expect(windowWriteInput.safeParse({ ...ok, ...patch }).success).toBe(false),
  )
  it('allows an end of 24:00', () =>
    expect(windowWriteInput.safeParse({ ...ok, startMinute: 1380, endMinute: 1440 }).success).toBe(
      true,
    ))
})

describe('delivery BFF specs', () => {
  let a: typeof import('@/server/bff/delivery-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/delivery-actions')
  })
  it('area put: fixed path, whole-replace body, no `active`, version only when given', () => {
    const input = a.putAreaMutation.input.parse({
      pincode: '560047',
      serviceAreaId: 'E',
      routes: [],
    })
    expect(a.putAreaMutation.backend(input)).toEqual({
      path: '/api/v1/admin/service-areas/560047',
      body: { serviceAreaId: 'E', routes: [] },
    })
    const upd = a.putAreaMutation.input.parse({
      pincode: '560047',
      serviceAreaId: 'E',
      routes: [],
      expectedVersion: 2,
    })
    expect(a.putAreaMutation.backend(upd).body).toMatchObject({ expectedVersion: 2 })
  })
  it('window put: path carries area and window, body has no ids', () => {
    const input = a.putWindowMutation.input.parse({
      serviceAreaId: 'Ejipura 1',
      windowId: 'am',
      label: 'AM',
      startMinute: 360,
      endMinute: 480,
      cutoffMinutes: 30,
      capacity: 5,
      days: [1],
    })
    const call = a.putWindowMutation.backend(input)
    expect(call.path).toBe('/api/v1/admin/delivery-slots/Ejipura%201/am')
    expect(call.body).not.toHaveProperty('windowId')
    expect(call.body).not.toHaveProperty('serviceAreaId')
  })
  it('toggles need a version and build fixed paths', () => {
    expect(
      a.areaToggleMutation('deactivate').backend({ pincode: '560047', expectedVersion: 3 }),
    ).toEqual({
      path: '/api/v1/admin/service-areas/560047/deactivate',
      body: { expectedVersion: 3 },
    })
    expect(
      a
        .windowToggleMutation('activate')
        .input.safeParse({ serviceAreaId: 'E', windowId: 'am', expectedVersion: 0 }).success,
    ).toBe(false)
  })
})
