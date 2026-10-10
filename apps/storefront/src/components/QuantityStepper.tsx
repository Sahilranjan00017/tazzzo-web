'use client'

interface Props {
  value: number
  min?: number
  max: number
  /** The product's name, for the accessible names of the buttons. */
  label: string
  /** A change is in flight: further presses are ignored (the buttons stay focusable, so keyboard focus is not lost). */
  busy?: boolean
  onChange: (next: number) => void
}

/**
 * A quantity stepper. The buttons use `aria-disabled` rather than `disabled` at a bound or while busy, so a keyboard
 * user pressing "+" keeps focus on it when the value reaches the limit or the request is in flight.
 */
export function QuantityStepper({ value, min = 1, max, label, busy = false, onChange }: Props) {
  const atMin = value <= min
  const atMax = value >= max
  return (
    <div className="stepper" role="group" aria-label={`Quantity of ${label}`}>
      <button
        type="button"
        className="stepper__button"
        aria-label={`Decrease quantity of ${label}`}
        aria-disabled={busy || atMin}
        onClick={() => {
          if (!busy && !atMin) onChange(value - 1)
        }}
      >
        <span aria-hidden="true">−</span>
      </button>
      <output className="stepper__value" aria-live="off" aria-label={`Quantity ${value}`}>
        {value}
      </output>
      <button
        type="button"
        className="stepper__button"
        aria-label={`Increase quantity of ${label}`}
        aria-disabled={busy || atMax}
        onClick={() => {
          if (!busy && !atMax) onChange(value + 1)
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
    </div>
  )
}
