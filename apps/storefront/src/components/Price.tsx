import { formatPaise } from '@/lib/format'

/** Selling price, with the MRP struck through only when it is higher. Nothing at all when the price is unknown. */
export function Price({
  sellingPaise,
  mrpPaise,
}: {
  sellingPaise: number | null
  mrpPaise: number | null
}) {
  const selling = formatPaise(sellingPaise)
  if (selling === null) return null
  const mrp =
    mrpPaise !== null && sellingPaise !== null && mrpPaise > sellingPaise
      ? formatPaise(mrpPaise)
      : null
  return (
    <p className="price">
      <span className="price__selling">{selling}</span>
      {mrp && (
        <span className="price__mrp">
          <span className="visually-hidden">MRP </span>
          <s>{mrp}</s>
        </span>
      )}
    </p>
  )
}
