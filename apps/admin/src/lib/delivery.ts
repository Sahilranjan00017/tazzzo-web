import { z } from 'zod'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'

/** Serviceability + delivery-slot contracts (backend main c3306b6). Client-safe. */
export const PINCODE = /^[1-9][0-9]{5}$/
/** `serviceAreaId` is a free grouping label (<=128, no `|`); we accept a safe subset for anything put in a URL. */
export const AREA_ID = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/
export const WINDOW_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
export const LOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
export const MAX_ROUTES = 20
export const AREA_PAGE = 50

export const routeSchema = z.object({
  fulfillmentLocationId: z.string(),
  priority: z.number().int(),
  active: z.boolean(),
})
export const areaSchema = z.object({
  pincode: z.string(),
  serviceAreaId: z.string(),
  active: z.boolean(),
  version: z.number().int(),
  routes: z.array(routeSchema).default([]),
})
export type ServiceArea = z.infer<typeof areaSchema>
export const areaListSchema = z.object({
  items: z.array(areaSchema),
  nextCursor: z.string().nullish(),
})

export const windowSchema = z.object({
  serviceAreaId: z.string(),
  windowId: z.string(),
  label: z.string(),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  cutoffMinutes: z.number().int(),
  capacity: z.number().int(),
  days: z.array(z.number().int()),
  active: z.boolean(),
  version: z.number().int(),
})
export type SlotWindow = z.infer<typeof windowSchema>
export const windowListSchema = z.object({ items: z.array(windowSchema) })

export const DAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 7, label: 'Sun' },
] as const

/** minute-of-day <-> `HH:MM` (24 h). The backend stores minutes in the delivery zone (Asia/Kolkata by default). */
export function minuteToTime(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
export function timeToMinute(text: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match) return Number(match[1]) * 60 + Number(match[2])
  return text === '24:00' ? 1440 : undefined
}

/** `HH:MM–HH:MM` plus 12-hour wording for the table. */
export function formatWindow(w: Pick<SlotWindow, 'startMinute' | 'endMinute'>): string {
  return `${minuteToTime(w.startMinute)}–${minuteToTime(w.endMinute)}`
}

export function formatDays(days: readonly number[]): string {
  if (days.length === 7) return 'Every day'
  return DAYS.filter((d) => days.includes(d.n))
    .map((d) => d.label)
    .join(', ')
}

export const routeInput = z
  .object({
    fulfillmentLocationId: z.string().regex(LOCATION_ID),
    priority: z.number().int().min(0).max(2_147_483_647),
    active: z.boolean(),
  })
  .strict()

/** Whole-replace area write. Locations and priorities must each be unique (backend rule), at most 20 routes. */
export const areaWriteInput = z
  .object({
    pincode: z.string().regex(PINCODE),
    serviceAreaId: z.string().regex(AREA_ID),
    routes: z.array(routeInput).max(MAX_ROUTES),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const locs = new Set<string>()
    const prios = new Set<number>()
    v.routes.forEach((r, i) => {
      if (locs.has(r.fulfillmentLocationId))
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'fulfillmentLocationId'],
          message: 'duplicate location',
        })
      if (prios.has(r.priority))
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'priority'],
          message: 'duplicate priority',
        })
      locs.add(r.fulfillmentLocationId)
      prios.add(r.priority)
    })
  })

export const windowWriteInput = z
  .object({
    serviceAreaId: z.string().regex(AREA_ID),
    windowId: z.string().regex(WINDOW_ID),
    label: z.string().trim().min(1).max(60),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    cutoffMinutes: z.number().int().min(0).max(10080),
    capacity: z.number().int().min(1).max(100000),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.startMinute >= v.endMinute)
      ctx.addIssue({ code: 'custom', path: ['endMinute'], message: 'end must be after start' })
    if (new Set(v.days).size !== v.days.length)
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'duplicate day' })
  })

const CODE_COPY: Record<string, string> = {
  STALE_VERSION:
    'This record changed since you loaded it (or it already exists / does not exist). It has been reloaded; review it and try again.',
  INVALID_SERVICE_AREA:
    'The backend rejected the service area (check pincode, routes, duplicate locations or priorities).',
  INVALID_DELIVERY_WINDOW:
    'The backend rejected the delivery window (check times, capacity, days and the area id).',
}

export function deliveryErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 404) return 'That record or its service area does not exist.'
  return bffErrorMessage(result, 'change')
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()
export function parseAreaListQuery(raw: Raw): { after?: string } {
  const after = first(raw.after)
  return after && PINCODE.test(after) ? { after } : {}
}
export function areaListPath(q: { after?: string }): string {
  const p = new URLSearchParams({ limit: String(AREA_PAGE) })
  if (q.after) p.set('after', q.after)
  return `/api/v1/admin/service-areas?${p.toString()}`
}
