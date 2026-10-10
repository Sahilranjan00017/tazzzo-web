import { locationChipText, type DeliveryLocation } from '@/lib/location/model'

/**
 * The header chip's text. Its text content is exactly `locationChipText(location)`; on narrow screens CSS hides the
 * optional words (`.chip-optional`) so the chip stays one short line ("Set location", "Deliver to 560001") instead of
 * wrapping. The words are `display: none` there, so assistive technology reads what is shown.
 */
export function LocationChipLabel({ location }: { location: DeliveryLocation | null }) {
  // One wrapper element: the chip is a flex container, and whitespace at the edge of a flex item is collapsed, so the
  // words must live inside a single item or "Set delivery location" would render as "Setdeliverylocation".
  return <span>{label(location)}</span>
}

function label(location: DeliveryLocation | null) {
  if (location === null) {
    return (
      <>
        Set <span className="chip-optional">delivery </span>location
      </>
    )
  }
  if (location.serviceable === false) {
    return (
      <>
        Not delivering<span className="chip-optional"> to</span> {location.pin}
      </>
    )
  }
  return locationChipText(location)
}
