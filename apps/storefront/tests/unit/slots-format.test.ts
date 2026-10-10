import { describe, expect, it } from 'vitest'
import { formatSlotDate, formatWindow, groupByDate, isSelectable } from '@/lib/delivery/slots'

describe('slot formatting is deterministic (no Intl: server and browser must render the same text)', () => {
  it('dates', () => {
    expect(formatSlotDate('2026-10-11')).toBe('Sunday, 11 October')
    expect(formatSlotDate('2026-12-31')).toBe('Thursday, 31 December')
    expect(formatSlotDate('2028-02-29')).toBe('Tuesday, 29 February')
    expect(formatSlotDate('garbage')).toBe('garbage')
    expect(formatSlotDate('2026-13-01')).toBe('2026-13-01')
  })
  it('windows read the delivery-zone wall clock from the ISO offset time', () => {
    const w = (a: string, b: string) => formatWindow({ startsAt: a, endsAt: b })
    expect(w('2026-10-11T09:00:00+05:30', '2026-10-11T11:00:00+05:30')).toBe('9:00 am to 11:00 am')
    expect(w('2026-10-11T00:00:00+05:30', '2026-10-11T12:30:00+05:30')).toBe('12:00 am to 12:30 pm')
    expect(w('2026-10-11T18:05:00+05:30', '2026-10-11T23:59:00+05:30')).toBe('6:05 pm to 11:59 pm')
    expect(w('nonsense', '2026-10-11T11:00:00+05:30')).toBe('')
  })
  it('groups consecutive dates and only AVAILABLE well-formed slots are selectable', () => {
    const slot = (
      slotId: string,
      date: string,
      status: 'AVAILABLE' | 'FULL' | 'CLOSED' = 'AVAILABLE',
    ) => ({
      slotId,
      date,
      startsAt: '',
      endsAt: '',
      label: 'x',
      status,
    })
    const slots = [
      slot('a~2026-10-11', '2026-10-11'),
      slot('b~2026-10-11', '2026-10-11', 'FULL'),
      slot('a~2026-10-12', '2026-10-12'),
    ]
    expect(groupByDate(slots).map((g) => [g.date, g.slots.length])).toEqual([
      ['2026-10-11', 2],
      ['2026-10-12', 1],
    ])
    expect(slots.map(isSelectable)).toEqual([true, false, true])
    expect(isSelectable(slot('BAD', '2026-10-11'))).toBe(false)
  })
})
