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

function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: timezone })
    return timezone
  } catch {
    return 'Asia/Kolkata'
  }
}

/** "Tuesday, 14 October" for a `yyyy-MM-dd` date (a calendar date, shown without any zone shift). */
export function formatSlotDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** "9:00 am to 11:00 am" in the delivery time zone. */
export function formatWindow(slot: Pick<Slot, 'startsAt' | 'endsAt'>, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: safeZone(timezone),
  })
  const start = new Date(slot.startsAt)
  const end = new Date(slot.endsAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return ''
  return `${fmt.format(start)} to ${fmt.format(end)}`
}
