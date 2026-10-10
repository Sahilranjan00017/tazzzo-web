'use client'

import {
  SLOT_STATUS_TEXT,
  formatSlotDate,
  formatWindow,
  groupByDate,
  isSelectable,
  type SlotsView,
} from '@/lib/delivery/slots'

/**
 * Delivery slots for one PIN, grouped by date, as one radio group: window (and the backend's label), and for a slot
 * that cannot be taken why ("Fully booked", "Booking closed"; capacity is never a number). Controlled and
 * presentational: it reads nothing and saves nothing, so any step can use it. Native radios: arrow keys move
 * between slots, a disabled slot is skipped.
 */
export function SlotPicker({
  view,
  value,
  onChange,
  name = 'delivery-slot',
}: {
  view: SlotsView
  value: string | null
  onChange: (slotId: string) => void
  name?: string
}) {
  if (!view.serviceable) {
    return (
      <p role="status" data-testid="slots-unserviceable">
        We do not deliver to this PIN code yet, so there are no delivery slots.
      </p>
    )
  }
  if (view.slots.length === 0) {
    return (
      <p role="status" data-testid="slots-empty">
        No delivery slots are open right now. Please check again later.
      </p>
    )
  }
  const open = view.slots.some(isSelectable)
  return (
    <fieldset>
      <legend>Delivery slot</legend>
      {!open && (
        <p role="status" data-testid="slots-none-open">
          Every slot is booked or closed right now. Please check again later.
        </p>
      )}
      <div className="slot-days">
        {groupByDate(view.slots).map((day) => (
          <div
            key={day.date}
            className="slot-day"
            role="group"
            aria-label={formatSlotDate(day.date)}
          >
            <h3>{formatSlotDate(day.date)}</h3>
            <div className="slot-options">
              {day.slots.map((slot) => {
                const selectable = isSelectable(slot)
                const window = formatWindow(slot)
                return (
                  <label key={slot.slotId} className="slot-option" data-testid="slot-option">
                    <input
                      type="radio"
                      name={name}
                      value={slot.slotId}
                      disabled={!selectable}
                      checked={value === slot.slotId}
                      onChange={() => onChange(slot.slotId)}
                    />
                    <span className="slot-option__label">{slot.label}</span>
                    <span className="slot-option__note">{window}</span>
                    {slot.status !== 'AVAILABLE' && (
                      <span className="slot-option__note">{SLOT_STATUS_TEXT[slot.status]}</span>
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  )
}
