import { ProductCard } from '@/components/ProductCard'
import type { ProductSummary } from '@/lib/products'

/**
 * A titled, horizontally scrollable row of product cards. The caller passes only the products that resolved, so a
 * missing or hidden product simply is not there; a rail with no products renders nothing (no empty heading).
 */
export function ProductRail({
  blockId,
  title,
  products,
}: {
  blockId: string
  title: string
  products: ProductSummary[]
}) {
  if (products.length === 0) return null
  const headingId = `rail-${blockId}`
  return (
    <section className="rail" aria-labelledby={headingId} data-block-id={blockId}>
      <h2 id={headingId}>{title}</h2>
      <ul className="rail__list">
        {products.map((product) => (
          <li key={product.productId}>
            <ProductCard product={product} />
          </li>
        ))}
      </ul>
    </section>
  )
}
