import { isSlotId } from '@/lib/location/validation'

/**
 * Delivery slots as the storefront models them (tazzzo-backend `DeliverySlotController`): a slot is one window on one
 * date, with a status only (AVAILABLE / FULL / CLOSED), never a capacity count. Times arrive as ISO offset date-times
 * and are shown in the backend's delivery time zone. Pure; client-safe.
 */
export type SlotStatus = 'AVAILABLE' | 'FULL' | 'CLOSED'

export interface Slot {
  slotId: string
  /** `yyyy-MM-dd` in the delivery time zone. */
  date: string
  startsAt: string
  endsAt: string
  label: string
  status: SlotStatus
}

export interface SlotsView {
  serviceable: boolean
  timezone: string
  slots: Slot[]
}

export const SLOT_STATUS_TEXT: Record<Exclude<SlotStatus, 'AVAILABLE'>, string> = {
  FULL: 'Fully booked',
  CLOSED: 'Booking closed',
}

export function isSelectable(slot: Slot): boolean {
  return slot.status === 'AVAILABLE' && isSlotId(slot.slotId)
}

/** Slots grouped by date, in the order given (the backend sorts by start time). */
export function groupByDate(slots: Slot[]): Array<{ date: string; slots: Slot[] }> {
  const groups: Array<{ date: string; slots: Slot[] }> = []
  for (const slot of slots) {
    const last = groups[groups.length - 1]
    if (last && last.date === slot.date) last.slots.push(slot)
    else groups.push({ date: slot.date, slots: [slot] })
  }
  return groups
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * "Tuesday, 14 October" for a `yyyy-MM-dd` date (a calendar date, no zone shift). Written out by hand rather than with
 * `Intl`: the server and the browser ship different ICU data, and a differing string is a hydration mismatch.
 */
export function formatSlotDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d || m > 12) return date
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${d} ${MONTHS[m - 1]}`
}

const CLOCK = /T([01][0-9]|2[0-3]):([0-5][0-9])/

function clock(iso: string): string | null {
  const match = CLOCK.exec(iso)
  if (!match) return null
  const hour = Number(match[1])
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${match[2]} ${hour < 12 ? 'am' : 'pm'}`
}

/**
 * "9:00 am to 11:00 am". The backend writes `startsAt`/`endsAt` as ISO offset date-times in its delivery time zone
 * (`timezone` in the answer, Asia/Kolkata by default), so the wall-clock part IS the delivery-zone time; reading it
 * directly is deterministic on server and browser alike.
 */
export function formatWindow(slot: Pick<Slot, 'startsAt' | 'endsAt'>): string {
  const start = clock(slot.startsAt)
  const end = clock(slot.endsAt)
  return start && end ? `${start} to ${end}` : ''
}
